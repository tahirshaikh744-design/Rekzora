'use strict';
/* ============================================================
   Rekzora — Screen Recorder for Windows
   Main process: windows, IPC, capture permissions, storage,
   tray, global shortcuts, float & region overlays.
   ============================================================ */

const {
  app, BrowserWindow, ipcMain, desktopCapturer, dialog,
  globalShortcut, Tray, Menu, nativeImage, shell, screen, session, powerMonitor,
  protocol
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const os = require('node:os');
const crypto = require('node:crypto');
const clipboard = require('electron').clipboard;

/* Recording IPC trust boundary, share launch registry, WebM validation,
   crash-recovery manifests and the centralized IPC guard all live in the
   lib/ modules so the regression suite can exercise them without Electron. */
const { STATE, RegistryError, createRegistry, validateFinishMeta } = require('./lib/recording-session');
const { createShareLauncher, validateLibraryId, isPlausibleExecutable, ShareError } = require('./lib/share-registry');
const { checkWebM } = require('./lib/webm-check');
const { createManifestStore } = require('./lib/manifest');
const { ROLES, GuardError, createGuard, ROLE_CHANNELS } = require('./lib/ipc-guard');
const { createJsonStore } = require('./lib/json-store');
const { DEFAULT_SETTINGS, validatePatch, sanitizeStored } = require('./lib/settings-schema');

/* The player loads recordings through this custom, main-owned protocol:
   rekzora-video://<libraryId>/v.webm → resolved via the library index, so a
   renderer can point a <video> at arbitrary files. Range requests are
   honored so seeking is instant. Must be registered before app ready. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'rekzora-video',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: false }
  }
]);

const isDev = !app.isPackaged;
const APP_NAME = 'Rekzora';
const APP_VERSION = app.getVersion();

/* Proper taskbar identity on Windows: groups all Rekzora windows/processes
   under one taskbar entry and shows the Rekzora icon in notifications. */
app.setAppUserModelId('com.neurontslabs.rekzora');

/* ---------------- Settings store (atomic JSON, no deps) ----------------
   Persistence rules (v1.1 Phase E): atomic temp+rename writes, .bak
   rotation with first-write seeding, corrupt-primary recovery from the
   backup (never a silent reset), schema-validated settings via
   DEFAULT_SETTINGS/sanitizeStored so a broken renderer cannot poison
   the stored values. Library metadata gets the same durability with a
   thumb-size clamp as its sanitizer. */
function sanitizeLibDb(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [p, meta] of Object.entries(raw)) {
    if (!meta || typeof meta !== 'object') continue;         // drop corrupt entries, keep the rest
    if (typeof meta.thumb === 'string' && !(meta.thumb.startsWith('data:image/jpeg;base64,') && meta.thumb.length <= 512 * 1024)) {
      meta.thumb = null;                                     // never store unbounded blobs in the db
    }
    out[p] = meta;
  }
  return out;
}

function storeError(m) { console.error('[store]', m); log(m); }

function getDefaultSaveDir() {
  try {
    const videos = app.getPath('videos');
    if (videos) return path.join(videos, 'Rekzora Recordings');
  } catch { /* fall through */ }
  try { return path.join(app.getPath('documents'), 'Rekzora Recordings'); } catch { /* ignore */ }
  return path.join(app.getPath('userData'), 'Recordings');
}

const settings = createJsonStore({
  file: path.join(app.getPath('userData'), 'settings.json'),
  defaults: DEFAULT_SETTINGS,
  sanitize: sanitizeStored,
  onError: storeError
});

/* Save-dir provisioning (v1.1 Phase E): a directory that only accepts the
   mkdir must not be trusted to hold recordings — probe with a real file. */
function provisionSaveDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.rekzora-write-test-${process.pid}`);
    fs.writeFileSync(probe, '.', 'utf8');        // throws on read-only/network-restricted dirs
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    log('save dir not usable:', dir, e && e.message);
    return { ok: false, reason: e && e.message };
  }
}

/* Metadata database — lives in AppData so recordings folders stay clean
   (previously we dropped a `.json` sidecar next to every video). */
const libDb = createJsonStore({
  file: path.join(app.getPath('userData'), 'library.json'),
  defaults: {},
  sanitize: sanitizeLibDb,
  onError: storeError
});
function libSet(p, meta) { libDb.set({ [p]: meta }); }
function libGet(p) { return libDb.data[p] || null; }
function libRemove(p) { libDb.remove(p); }

function cleanLibMeta(raw) {
  if (!raw) return null;
  /* (Phase E) thumbs are 512 KB-capped jpeg data URLs from our own capture
     pipeline — a corrupt or hostile raw source (old sidecars, tampered
     library.json) yields null, never an unbounded blob */
  const thumbOk = typeof raw.thumb === 'string'
    && raw.thumb.startsWith('data:image/jpeg;base64,')
    && raw.thumb.length <= 512 * 1024;
  return {
    title: raw.title || null,
    fileName: raw.fileName || null,
    created: raw.created || null,
    durationMs: raw.durationMs || 0,
    thumb: thumbOk ? raw.thumb : null,
    type: raw.type || 'screen',
    sourceName: raw.sourceName || null,
    fps: raw.fps || null,
    quality: raw.quality || null,
    resolution: raw.resolution || null,
    mic: !!raw.mic,
    systemAudio: raw.systemAudio !== undefined ? !!raw.systemAudio : false,
    webcam: !!raw.webcam,
    region: raw.region || null,
    /* v1.1 additions: opaque record id + partial-recording honesty */
    id: raw.id || null,
    partial: raw.partial === true,
    partialReason: raw.partialReason || null,
    recovered: raw.recovered === true
  };
}

/* ---- opaque library record ids ----
   The library key remains the absolute path (the main process's truth), but
   the renderer receives and speaks only stable random ids. An id is valid
   only while its recording actually exists inside the save directory. */
function isLibraryId(value) {
  return typeof value === 'string' && /^r_[a-z0-9]{12}$/.test(value);
}
function grantLibId(filePath) {
  let id = libPaths.get(filePath);
  if (id) return id;
  /* 12 base36-ish chars from crypto randomness, checked for uniqueness */
  for (let i = 0; i < 8; i++) {
    const candidate = ('r_' + crypto.randomBytes(9).toString('base64url').toLowerCase()
      .replace(/[^a-z0-9]/g, '').padEnd(12, '0')).slice(0, 14);
    id = [...libIds.keys()].includes(candidate) ? null : candidate;
    if (id) break;
  }
  if (!id) id = 'r_' + crypto.randomBytes(6).toString('hex'); // virtually impossible to need
  libIds.set(id, filePath);
  libPaths.set(filePath, id);
  return id;
}
function revokeLibPath(filePath) {
  const id = libPaths.get(filePath);
  if (id) { libIds.delete(id); libPaths.delete(filePath); }
  return id || null;
}
function resolveLibId(id) {
  if (!isLibraryId(id)) return null;
  const filePath = libIds.get(id);
  if (!filePath) return null;
  /* the mapping must resolve to a *current* recording inside the save dir */
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}
/* Rebuild the id index from the library database at startup. */
function rebuildLibIdIndex() {
  libIds.clear();
  libPaths.clear();
  for (const [key, meta] of Object.entries(libDb.data)) {
    if (!key || typeof key !== 'string') continue;
    let id = (meta && meta.id) ? String(meta.id) : null;
    if (!id || libIds.has(id)) {
      id = grantLibId(key);
      libSet(key, { ...cleanLibMeta(meta), id });
    } else {
      libIds.set(id, key);
      libPaths.set(key, id);
    }
  }
}

/* One-time migration: absorb legacy `<video>.json` sidecars into the DB,
   then delete them so the recordings folder is clean. */
async function migrateSidecars() {
  try {
    const files = await fsp.readdir(saveDir);
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      const sidecar = path.join(saveDir, f);
      const videoPath = sidecar.slice(0, -5); // strip ".json"
      if (!videoPath.toLowerCase().endsWith('.webm')) continue;
      let raw = null;
      try {
        raw = JSON.parse(await fsp.readFile(sidecar, 'utf8'));
      } catch { /* unreadable */ }
      if (!raw || !('durationMs' in raw)) continue; // not ours, leave it alone
      if (fs.existsSync(videoPath)) {
        const st = await fsp.stat(videoPath);
        libSet(videoPath, cleanLibMeta({ ...raw, size: st.size }));
      }
      await fsp.rm(sidecar, { force: true });
      log('migrated sidecar:', f);
    }
  } catch (e) { log('sidecar migration skipped', e && e.message); }
}

let saveDir, tmpDir;

/* ---------------- App state ---------------- */
let mainWin = null;
let floatWin = null;
let regionWin = null;
let tray = null;
let quitting = false;   // set in before-quit so the close handler stops hiding to tray
let recActive = false;
let pendingSource = null;       // DesktopCapturerSource chosen for next getDisplayMedia
let regionCtx = null;           // { bounds, scaleFactor, sourceId }

/* ---- main-process-owned security surface (created in whenReady) ---- */
let guard = null;            // ipc-guard: window registry + sender authorization
let recRegistry = null;      // recording sessions: ids, states, ownership
let manifestStore = null;    // crash-recovery manifests
let shareLauncher = null;    // trusted share-app launcher
const writeHandles = new Map(); // recordingId -> fs.FileHandle

/* Library: path → {id, ...}. The renderer never sees paths from the list
   and never sends them back; it speaks in opaque record ids only. */
const libIds = new Map();    // recordingId -> absolute path
const libPaths = new Map();  // absolute path -> recordingId</think><tool_call>edit<arg_key>newString</arg_key><arg_value>/* ---------------- Helpers ---------------- */
function log(...a) { console.log(`[main] ${new Date().toISOString().slice(11, 19)}`, ...a); }

function trustedUrlPrefix() {
  try {
    return require('node:url').pathToFileURL(__dirname).href + '/';
  } catch {
    return 'file://' + __dirname.replace(/\\/g, '/') + '/';
  }
}

function ensureDirs() {
  const configured = settings.get('saveDir');
  const usable = configured ? provisionSaveDir(configured).ok : false;
  if (configured && !usable) {
    /* never record into a dead folder for this run — use the default, log
       and notify, but KEEP the user's stored choice for next time */
    log('configured recordings folder is not writable right now — using the default for this run');
    sendToMain('recordings:changed', { saveDirFallback: true });
  }
  saveDir = usable ? configured : getDefaultSaveDir();
  tmpDir = path.join(app.getPath('userData'), 'recordings-tmp');
  for (const d of [saveDir, tmpDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { console.error('[dirs]', e); }
  }
  /* Persist the resolved default only for a genuine first run (fresh
     settings.json) so the UI can show it; a fallback must not overwrite
     the user's stored choice. */
  if (!configured && saveDir && settings.get('saveDir') !== saveDir) {
    settings.set({ saveDir });
  }
}

function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function sanitizeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 120) || 'Untitled';
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return candidate;
}

function isInsideDir(filePath, dir) {
  const rel = path.relative(dir, filePath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sendToMain(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

/* ---------------- Main window ---------------- */
function createMainWindow() {
  const dark = settings.get('theme') !== 'light';
  mainWin = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 940,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: dark ? '#0b0b0f' : '#f5f5f7',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,               // preload only uses contextBridge/ipcRenderer
      additionalArguments: ['--rekzora-role=MAIN'],   // role signal for the preload
      backgroundThrottling: false, // critical: timers keep running while minimized/recording
      spellcheck: false
    }
  });

  mainWin.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  mainWin.once('ready-to-show', () => mainWin.show());

  mainWin.on('close', (e) => {
    if (!quitting && (settings.get('closeToTray') || recActive)) {
      e.preventDefault();
      mainWin.hide();
    }
  });

  mainWin.on('closed', () => { mainWin = null; });

  /* Navigation policy: the app content is static, local, and trusted —
     any in-frame navigation away from it is refused, and popups are
     denied outright (external links go through app:open-external). */
  mainWin.webContents.on('will-navigate', (e, url) => {
    if (!guardIsTrustedUrl(url)) { e.preventDefault(); log('navigation blocked:', url.slice(0, 100)); }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    log('window.open blocked:', url.slice(0, 100));
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-attach-webview', (e) => { e.preventDefault(); });

  guard.register(mainWin.webContents, ROLES.MAIN);

  // DevTools on F12 in dev builds
  mainWin.webContents.on('before-input-event', (_e, input) => {
    if (isDev && input.type === 'keyDown' && input.key === 'F12') {
      mainWin.webContents.toggleDevTools();
    }
  });
}

/* Navigation/src checks shared by every window */
function guardIsTrustedUrl(url) {
  try {
    const prefix = trustedUrlPrefix();
    return url === prefix || (typeof url === 'string' && url.startsWith(prefix));
  } catch {
    return false;
  }
}

/* ---------------- Floating control bar ---------------- */
function ensureFloatWin() {
  if (floatWin && !floatWin.isDestroyed()) return floatWin;
  floatWin = new BrowserWindow({
    width: 300,
    height: 64,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    show: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: ['--rekzora-role=FLOATING'],
      backgroundThrottling: false
    }
  });
  floatWin.setAlwaysOnTop(true, 'screen-saver');
  floatWin.loadFile(path.join(__dirname, 'src', 'floating', 'index.html'));
  floatWin.on('closed', () => { floatWin = null; });
  floatWin.webContents.on('will-navigate', (e, url) => {
    if (!guardIsTrustedUrl(url)) e.preventDefault();
  });
  floatWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  guard && guard.register(floatWin.webContents, ROLES.FLOATING);
  return floatWin;
}

function showFloat(bounds) {
  const win = ensureFloatWin();
  const disp = bounds
    ? screen.getAllDisplays().find(d => d.bounds.x === bounds.x && d.bounds.y === bounds.y && d.bounds.width === bounds.width && d.bounds.height === bounds.height)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const d = disp || screen.getPrimaryDisplay();
  const db = d.workArea;
  win.setPosition(Math.round(db.x + (db.width - 300) / 2), Math.round(db.y + db.height - 64 - 46));
  win.showInactive();
}

function hideFloat() {
  if (floatWin && !floatWin.isDestroyed()) floatWin.hide();
}

/* ---------------- Region selection overlay ---------------- */
function showRegionOverlay(bounds, scaleFactor) {
  if (!regionWin || regionWin.isDestroyed()) {
    regionWin = new BrowserWindow({
      x: bounds.x, y: bounds.y,
      width: bounds.width, height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: ['--rekzora-role=REGION']
      }
    });
    regionWin.setAlwaysOnTop(true, 'screen-saver');
    regionWin.loadFile(path.join(__dirname, 'src', 'region', 'index.html'));
    regionWin.on('closed', () => { regionWin = null; });
    regionWin.webContents.on('will-navigate', (e, url) => {
      if (!guardIsTrustedUrl(url)) e.preventDefault();
    });
    regionWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    guard && guard.register(regionWin.webContents, ROLES.REGION);
    regionWin.webContents.once('did-finish-load', () => {
      if (regionWin && !regionWin.isDestroyed()) {
        regionWin.setBounds(bounds);
        regionWin.show();
        regionWin.focus();
        log('region overlay shown on', bounds.width + 'x' + bounds.height);
      }
    });
  } else {
    regionWin.setBounds(bounds);
  }
}

function closeRegionOverlay() {
  if (regionWin && !regionWin.isDestroyed()) regionWin.close();
  regionWin = null;
}

/* ---------------- Desktop capture permission handler ----------------
   The renderer calls navigator.mediaDevices.getDisplayMedia().
   We hand back the pre-approved source + system audio loopback. */
function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const src = pendingSource;
    pendingSource = null;
    const wantAudio = request.audioRequested && process.platform === 'win32';
    if (src) {
      callback({ video: src, audio: wantAudio ? 'loopback' : undefined });
      return;
    }
    // Fallback: primary display
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .then(sources => callback({
        video: sources[0],
        audio: wantAudio ? 'loopback' : undefined
      }))
      .catch(() => callback({}));
  });
}

/* ---------------- Permission handlers (v1.1 Phase D) ----------------
   Deny-by-default: media capture is the only permission this app has any
   reason to grant, and only to its own windows (offline file: content).
   Everything else — notifications, geolocation, clipboard reads, MIDI… —
   is refused; renderer code never needs it (clipboard writes go through
   the guarded app:clipboard-write IPC channel in the main process). */
const GRANTED_PERMISSIONS = new Set(['media', 'desktopCapturer', 'display-capture']);

function permissionDecision(permission, wc) {
  try {
    if (!GRANTED_PERMISSIONS.has(permission)) return false;
    if (!wc || typeof wc.getURL !== 'function' || wc.isDestroyed()) return false;
    return guardIsTrustedUrl(wc.getURL());
  } catch {
    return false;
  }
}

function setupPermissionHandlers() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const grant = permissionDecision(permission, wc);
    if (!grant) log('permission refused:', permission, 'from', (wc && !wc.isDestroyed() ? wc.getURL() : '?').slice(0, 80));
    callback(grant);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    /* sync counterpart: navigator.permissions.query / internal checks must
       agree with the request handler, same trusted-origin rule */
    let trusted = true;
    try {
      trusted = guardIsTrustedUrl(requestingOrigin);
      if (wc && typeof wc.getURL === 'function' && !wc.isDestroyed()) {
        trusted = trusted && guardIsTrustedUrl(wc.getURL());
      }
    } catch { trusted = false; }
    return trusted && GRANTED_PERMISSIONS.has(permission);
  });
}

/* ---------------- Tray ---------------- */
function trayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon-32.png'));
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: recActive ? '⏺ Recording…' : 'Rekzora — Ready', enabled: false },
    { type: 'separator' },
    { label: 'Open Rekzora', click: () => showMainWindow() },
    { label: 'Open Recordings Folder', click: () => shell.openPath(saveDir) },
    { type: 'separator' },
    { label: 'Quit Rekzora', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(recActive ? 'Rekzora — Recording' : 'Rekzora — Ready');
}

function showMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  mainWin.show();
  mainWin.focus();
}

/* ---------------- Global shortcuts ---------------- */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const toggle = settings.get('hotkeyToggle');
  const pause = settings.get('hotkeyPause');
  const status = [];
  try {
    if (toggle) {
      const ok = globalShortcut.register(toggle, () => sendToMain('recorder:action', { action: 'hotkey-toggle' }));
      log('hotkey', toggle, ok ? 'registered' : 'FAILED (in use by another app)');
      status.push({ key: toggle, ok });
    }
    if (pause) {
      const ok = globalShortcut.register(pause, () => sendToMain('recorder:action', { action: 'hotkey-pause' }));
      log('hotkey', pause, ok ? 'registered' : 'FAILED (in use by another app)');
      status.push({ key: pause, ok });
    }
  } catch (e) { log('hotkey error', e); }
  if (status.some(s => !s.ok)) {
    sendToMain('recorder:action', { action: 'hotkeys-status', status });
  }
}

/* ---------------- Recording file I/O (session-owned) ----------------
   The renderer only ever sees an opaque recordingId. Temp paths, handles
   and the final destination are generated and used inside this module.
   ---------------------------------------------------------------------- */
const sessionQueues = new Map();   // recordingId → write-chain promise
const WRITE_ERRORS_SOFT_STOP = 5;

function senderOf(event) {
  return { wcId: event.sender.id, role: (guard && guard.roleOf(event.sender.id)) || 'MAIN' };
}

/* ---- crash recovery scan (§6.5 B4) ----
   Every manifest that still describes an existing temp file is a candidate
   the user gets offered — with an honest playable/broken verdict. */
const dismissedRecovery = new Set(); // session-scoped "don't show again"

async function scanRecoverables() {
  try {
    if (!manifestStore) return [];
    const manifests = await manifestStore.listAll();
    const out = [];
    for (const m of manifests) {
      if (m.finalization === 'completed' || m.finalization === 'partial') continue;
      if (dismissedRecovery.has(m.sessionId)) continue;
      const tempPath = path.join(tmpDir, m.tempFileName);
      if (!isInsideDir(tempPath, tmpDir) || !fs.existsSync(tempPath)) {
        /* manifest without a file: swap gone → drop quietly */
        await manifestStore.remove(m.sessionId).catch(() => {});
        continue;
      }
      const stat = await fsp.stat(tempPath).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      let playable = false;
      let webmReason = '';
      try {
        const head = await readHeadForCheck(tempPath, 4 * 1024 * 1024);
        const webm = checkWebM(head);
        playable = !!webm.hasCluster && !!webm.webm;
        webmReason = webm.reason;
      } catch (e) { webmReason = e && e.message; }
      if (stat.size === 0) {
        /* empty temp with a manifest: nothing to recover, clean both */
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        await manifestStore.remove(m.sessionId).catch(() => {});
        continue;
      }
      out.push({
        id: m.sessionId,
        bytes: stat.size,
        chunks: m.chunksCommitted,
        writeFailures: m.writeFailures,
        startedAt: m.startTime,
        lastWriteAt: m.lastWriteAt,
        playable,
        webmReason
      });
    }
    return out;
  } catch (e) {
    log('recovery scan failed:', e && e.message);
    return [];
  }
}

/* Retention policy (§6.4): a temp file is "abandoned" only if it has no
   manifest AND zero content. Files with a manifest are ride crash-recovery
   candidates — the recovery UI decides their fate, never this cleanup. */
async function cleanupAbandonedTemps() {
  try {
    const files = await fsp.readdir(tmpDir);
    for (const f of files) {
      if (!/^rec-[0-9a-f]{32}\.webm$/i.test(f)) continue;
      const p = path.join(tmpDir, f);
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isFile() || st.size > 0) continue;
      const m = manifestStore && await manifestStore.load(f.slice(4, -5)).catch(() => null);
      if (!m) {
        await fsp.rm(p, { force: true }).catch(() => {});
        log('cleaned empty abandoned temp', f);
      } else if (m.finalization === 'discarded') {
        await fsp.rm(p, { force: true }).catch(() => {});
        await manifestStore.remove(f.slice(4, -5)).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}

/* Begin → session id + private temp file + first manifest. */
async function beginRecordingSession(event) {
  ensureDirs();
  await cleanupAbandonedTemps();
  const session = recRegistry.create({
    wcId: event.sender.id,
    role: (guard && guard.roleOf(event.sender.id)) || 'MAIN'
  });
  try {
    const handle = await fsp.open(session.tempTarget, 'w');
    writeHandles.set(session.recordingId, handle);
  } catch (e) {
    try { recRegistry.transit(session, STATE.FAILED); recRegistry.forget(session.recordingId); } catch { /* */ }
    log('rec begin failed:', e && e.message);
    throw new Error('Could not create the recording file (disk write error)');
  }
  try {
    await manifestStore.saveNow(session.recordingId, {
      sessionId: session.recordingId,
      tempFileName: path.basename(session.tempTarget),
      state: session.state,
      bytesCommitted: 0,
      chunksCommitted: 0
    });
  } catch (e) { log('manifest write failed (recording still fine):', e && e.message); }
  return { recordingId: session.recordingId };
}

/* Per-session serialized writes (order matters for a webm stream) */
function enqueueChunkWrite(session, buf) {
  const prev = sessionQueues.get(session.recordingId) || Promise.resolve();
  const next = prev.then(
    () => writeChunkToDisk(session.recordingId, buf),
    () => writeChunkToDisk(session.recordingId, buf) // keep the chain alive
  );
  sessionQueues.set(session.recordingId, next);
  return next;
}

async function writeChunkToDisk(recordingId, buf) {
  const handle = writeHandles.get(recordingId);
  if (!handle) throw new Error('recording file is closed');
  if (buf && buf.byteLength > 0) await handle.write(buf);
  return buf ? buf.byteLength : 0;
}

let manifestTick = 0;
async function maybeManifestProgress(session) {
  /* durable progress every 8 committed chunks; the store's internal
     debounce (750 ms) keeps consecutive calls from stampeding the disk */
  if (session.chunks === 0 || session.chunks % 8 !== 0) return;
  manifestTick++;
  try {
    await manifestStore.save(session.recordingId, {
      sessionId: session.recordingId,
      tempFileName: path.basename(session.tempTarget),
      state: session.state,
      bytesCommitted: session.bytes,
      chunksCommitted: session.chunks,
      writeFailures: session.writeErrors,
      lastWriteAt: Date.now()
    }, { debounceMs: 750 });
  } catch { /* best-effort */ }
}

/* Drain pending writes before finalization (bounded, never hangs forever) */
async function drainSession(session, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (session.pendingWrites > 0 && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return session.pendingWrites === 0;
}

/* Finalization: validate the temp container, then commit it atomically.
   - uniquePath saves us from ever overwriting an existing recording
   - renames are retried (AV/indexer can hold EBUSY/EPERM locks briefly)
   - cross-volume moves go copy → verify → rename, never a silent truncate */
function isTransientFsError(e) {
  return e && ['EBUSY', 'EPERM', 'EACCES', 'EDEADLK', 'EAGAIN'].includes(e.code);
}
async function finalizeMove(tempPath, finalPath) {
  let delay = 150;
  for (let i = 0; i < 4; i++) {
    try { await fsp.rename(tempPath, finalPath); return true; }
    catch (e) {
      if (e && e.code === 'EXDEV') break;             // different volume
      if (!isTransientFsError(e)) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  /* cross-volume fallback: copy to `finalPath.part`, byte-verify, rename */
  const partPath = finalPath + '.part-' + crypto.randomBytes(4).toString('hex');
  await fsp.copyFile(tempPath, partPath);
  const a = await fsp.stat(tempPath);
  const b = await fsp.stat(partPath);
  if (b.size !== a.size) throw new Error('copy verification failed');
  try {
    await fsp.rename(partPath, finalPath);
  } catch (e) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw e;
  }
  await fsp.rm(tempPath, { force: true }).catch(() => {});
  return true;
}

async function readHeadForCheck(tempPath, max) {
  const handle = await fsp.open(tempPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(max, 16 * 1024 * 1024));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function finalizeSession(session, { durationMs, meta }) {
  const id = session.recordingId;
  const tempPath = session.tempTarget;

  const handle = writeHandles.get(id);
  if (handle) {
    writeHandles.delete(id);
    try { await handle.close(); } catch { /* already closed */ }
  }
  sessionQueues.delete(id);

  /* outcome by evidence: empty or cluster-less temp is NOT a recording */
  let status = STATE.COMPLETED;
  let partialReason = null;
  let keptTemp = false;
  const stat = await fsp.stat(tempPath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size === 0) {
    status = STATE.FAILED;
    partialReason = 'the recording is empty (nothing was written)';
  } else {
    try {
      const head = await readHeadForCheck(tempPath, 4 * 1024 * 1024);
      const webm = checkWebM(head);
      if (!webm.hasCluster) {
        status = STATE.FAILED;
        partialReason = 'the container is broken (no playable media found)';
      } else if (session.writeErrors > 0) {
        status = STATE.PARTIAL;
        partialReason = `${session.writeErrors} chunk write failure(s) — the video may be truncated`;
      }
    } catch (e) {
      status = STATE.PARTIAL;
      partialReason = `container check could not run (${e && e.message})`;
    }
  }

  const finalBase = sanitizeName(`Screen Recording ${dateStamp()}`);
  const finalPath = uniquePath(saveDir, finalBase, '.webm');

  try {
    if (status === STATE.FAILED) {
      if (!stat || stat.size === 0) {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        await manifestStore.remove(id).catch(() => {});
        recRegistry.transit(session, STATE.FAILED);
        recRegistry.forget(id);
        return { status: 'failed', reason: partialReason, recordingId: id };
      }
      /* non-empty garbage: keep the file + manifest; the recovery UI lets
         the user inspect/delete it. Never silently destroyed. */
      keptTemp = true;
      await manifestStore.saveNow(id, {
        sessionId: id,
        tempFileName: path.basename(tempPath),
        state: 'FAILED',
        bytesCommitted: stat.size,
        chunksCommitted: session.chunks,
        writeFailures: session.writeErrors,
        finalization: 'failed',
        lastWriteAt: Date.now()
      });
      recRegistry.transit(session, STATE.FAILED);
      recRegistry.forget(id);
      return { status: 'failed', reason: partialReason, recordingId: id };
    }

    await finalizeMove(tempPath, finalPath);
    const st = await fsp.stat(finalPath);
    const gid = grantLibId(finalPath);
    libSet(finalPath, cleanLibMeta({
      title: path.basename(finalPath, '.webm'),
      fileName: path.basename(finalPath),
      created: st.birthtimeMs,
      durationMs: durationMs || 0,
      size: st.size,
      partial: status === STATE.PARTIAL,
      partialReason,
      id: gid,
      ...meta
    }));
    await manifestStore.remove(id).catch(() => {});
    recRegistry.transit(session, status);
    recRegistry.forget(id);
    broadcastRecordingsChanged();
    return {
      status: status === STATE.PARTIAL ? 'partial' : 'completed',
      reason: partialReason,
      recordingId: id,
      id: gid,
      path: finalPath,
      fileName: path.basename(finalPath),
      size: st.size,
      durationMs: durationMs || 0
    };
  } catch (e) {
    log('finalization failed:', e && (e.stack || e.message));
    /* finalization error → keep temp + manifest, mark failed; the next launch
       scans it as a recovery candidate (nothing user-visible is destroyed) */
    try {
      await manifestStore.saveNow(id, {
        sessionId: id,
        tempFileName: path.basename(tempPath),
        state: 'FAILED',
        bytesCommitted: session.bytes,
        chunksCommitted: session.chunks,
        writeFailures: session.writeErrors,
        finalization: 'failed',
        lastWriteAt: Date.now()
      });
    } catch { /* best effort */ }
    recRegistry.transit(session, STATE.FAILED);
    recRegistry.forget(id);
    return { status: 'failed', reason: `saving failed (${e && e.message})`, recordingId: id };
  }
}

/* Discard: renderer decides to throw the take away. Chunk writes may still
   be in flight → drain first, then destroy the temp. */
async function discardSession(event, recordingId) {
  const session = recRegistry.authorizeDiscard(recordingId, senderOf(event));
  const id = session.recordingId;
  await drainSession(session, 5000);
  const handle = writeHandles.get(id);
  if (handle) {
    writeHandles.delete(id);
    try { await handle.close(); } catch { /* */ }
  }
  sessionQueues.delete(id);
  const tempPath = session.tempTarget;
  if (tempPath && isInsideDir(tempPath, tmpDir)) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
  await manifestStore.remove(id).catch(() => {});
  if (session.state !== STATE.DISCARDED) recRegistry.transit(session, STATE.DISCARDED);
  recRegistry.forget(id);
  return true;
}

function broadcastRecordingsChanged() {
  sendToMain('recordings:changed', { t: Date.now() });
}

/* ---------------- Player media protocol ----------------
   rekzora-video://<libraryId>/video serves one thing: the bytes of the
   library recording that id resolves to. Byte-range support keeps
   seeking instant. Any other id/path is a hard 404. */
function setupPlaybackProtocol() {
  protocol.handle('rekzora-video', async (request) => {
    try {
      const u = new URL(request.url);
      const recordingId = u.hostname;
      const filePath = resolveLibId(recordingId);
      if (!filePath || !isInsideDir(filePath, saveDir) || path.dirname(filePath) !== saveDir ||
          !/\.webm$/i.test(filePath)) {
        return new Response('not found', { status: 404 });
      }
      let stat;
      try { stat = await fsp.stat(filePath); } catch { return new Response('gone', { status: 404 }); }
      if (!stat.isFile()) return new Response('not a file', { status: 404 });

      const fileSize = stat.size;
      const range = request.headers.get('range');
      const baseHeaders = {
        'Content-Type': 'video/webm',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      };
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
        if (!m) return new Response('bad range', { status: 416 });
        let start = m[1] === '' ? null : parseInt(m[1], 10);
        let end = m[2] === '' ? null : parseInt(m[2], 10);
        if (start === null && end !== null) { start = Math.max(0, fileSize - end); end = fileSize - 1; }
        if (start === null) start = 0;
        if (end === null || end >= fileSize) end = fileSize - 1;
        if (start > end || start >= fileSize) {
          return new Response('range not satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` }
          });
        }
        const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
        return new Response(stream, {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': String(end - start + 1)
          }
        });
      }
      const stream = Readable.toWeb(fs.createReadStream(filePath));
      return new Response(stream, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(fileSize) }
      });
    } catch (e) {
      log('playback error:', e && e.message);
      return new Response('error', { status: 500 });
    }
  });
}

async function listRecordings() {
  ensureDirs();
  let entries = [];
  let files = [];
  try { files = await fsp.readdir(saveDir); } catch { return []; }
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.webm')) continue;
    const p = path.join(saveDir, f);
    try {
      const st = await fsp.stat(p);
      if (!st.isFile()) continue;
      const stored = libGet(p) || {};
      if (!stored.id) libSet(p, { ...stored, id: grantLibId(p) });
      const meta = cleanLibMeta(libGet(p)) || {};
      entries.push({
        id: meta.id || grantLibId(p),
        fileName: f,
        title: meta.title || path.basename(f, '.webm'),
        size: st.size,
        created: meta.created || st.birthtimeMs || st.mtimeMs,
        durationMs: meta.durationMs || 0,
        thumb: meta.thumb || null,
        type: meta.type || 'screen',
        sourceName: meta.sourceName || null,
        fps: meta.fps || null,
        quality: meta.quality || null,
        resolution: meta.resolution || null,
        mic: !!meta.mic,
        systemAudio: !!meta.systemAudio,
        webcam: !!meta.webcam,
        partial: !!meta.partial,
        recovered: !!meta.recovered
      });
    } catch { /* skip unreadable */ }
  }
  entries.sort((a, b) => b.created - a.created);
  /* Drop stale DB entries (files deleted outside the app) — and forget
     their opaque ids, which die with the recording. */
  for (const key of Object.keys(libDb.data)) {
    if (key.toLowerCase().endsWith('.webm') && !fs.existsSync(key)) {
      revokeLibPath(key);
      libRemove(key);
    }
  }
  return entries;
}

/* ---------------- Share apps detection (registry + Start Menu) ---------------- */
/* ---------------- Share apps detection (registry + Start Menu) ---------------- */
let shareAppsCache = { t: 0, apps: null };

function existsSync(p) { try { return !!p && fs.existsSync(p); } catch { return false; } }

const SHARE_KEYWORD = 'quick[ _-]?shares?|nearby[ _-]?share|shareit|localsend|send[ _-]?anywhere|xender|telegram';

const SHARE_PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$kws = [regex]'(?i)${SHARE_KEYWORD}'
$entries = @()
foreach ($hive in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
  if (Test-Path $hive) {
    Get-ChildItem $hive | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath
      if ($p.DisplayName -and "$($p.DisplayName)" -match $kws) {
        $entries += [pscustomobject]@{ name = "$($p.DisplayName)"; icon = "$($p.DisplayIcon)"; loc = "$($p.InstallLocation)" }
      }
    }
  }
}
$lnks = @()
foreach ($dir in @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")) {
  if (Test-Path $dir) {
    $items = Get-ChildItem $dir -Recurse -Filter *.lnk | Where-Object { $_.BaseName -match $kws } | Select-Object -First 12
    foreach ($i in $items) {
      $sh = New-Object -ComObject WScript.Shell
      $t = $sh.CreateShortcut($i.FullName).TargetPath
      if ($t) { $lnks += [pscustomobject]@{ name = $i.BaseName; target = $t } }
    }
  }
}
@{ uninstall = $entries; lnks = $lnks } | ConvertTo-Json -Depth 3
`;

function runPowerShell(script, timeoutMs = 6000) {
  return new Promise((resolve) => {
    try {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      let out = '', err = '';
      const done = (timedOut) => {
        clearTimeout(timer);
        resolve({ out, err, timedOut });
      };
      const timer = setTimeout(() => { try { p.kill(); } catch { /* */ } done(true); }, timeoutMs);
      p.stdout.on('data', d => { out += d.toString(); });
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('close', () => done(false));
      p.on('error', () => done(true));
    } catch {
      resolve({ out: '', err: '', timedOut: true });
    }
  });
}

function asId(name) {
  const n = String(name || '').toLowerCase();
  if (/quick[ _-]?shares?|nearby[ _-]?share/.test(n)) return 'quickshare';
  if (/shareit/.test(n)) return 'shareit';
  if (/localsend/.test(n)) return 'localsend';
  if (/send[ _-]?anywhere/.test(n)) return 'sendanywhere';
  if (/xender/.test(n)) return 'xender';
  if (/telegram/.test(n)) return 'telegram';
  return null;
}

const SHARE_ICON_BY_ID = {
  quickshare: '📡', shareit: '⚡', sendanywhere: '🚀',
  localsend: '💻', xender: '🔁', telegram: '✈️'
};

function exeFromResult(candidate) {
  if (!candidate) return null;
  const p = candidate.split(',')[0].trim();
  if (p && /\.exe$/i.test(p) && existsSync(p)) return p;
  return null;
}

function findExeInDir(dir, exeRegex, depth = 2) {
  if (!dir || depth < 0) return null;
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          const r = findExeInDir(full, exeRegex, depth - 1);
          if (r) return r;
        } else if (/\.exe$/i.test(f) && exeRegex.test(f)) {
          return full;
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return null;
}

async function detectShareApps(force = false) {
  const now = Date.now();
  if (!force && shareAppsCache.apps && now - shareAppsCache.t < 300_000) return shareAppsCache.apps;

  const apps = [];
  const seen = new Set();
  const push = (id, name, exe, args) => {
    if (!id || !exe || seen.has(id)) return;
    seen.add(id);
    apps.push({
      id, name,
      ico: SHARE_ICON_BY_ID[id] || '📤',
      exe, args: args || []
    });
  };

  /* 1. Registry uninstall entries + Start Menu shortcut targets */
  const res = await runPowerShell(SHARE_PS_SCRIPT);
  let data = null;
  try { data = JSON.parse(res.out); } catch { /* falls through to filesystem scan */ }
  if (data && !Array.isArray(data)) data = [data];

  if (data && data[0]) {
    const u = Array.isArray(data[0].uninstall) ? data[0].uninstall : (data[0].uninstall ? [data[0].uninstall] : []);
    const l = Array.isArray(data[0].lnks) ? data[0].lnks : [];
    const order = ['quickshare', 'shareit', 'sendanywhere', 'localsend', 'xender', 'telegram'];
    const exeRegexByApp = {
      quickshare: /quick[ _-]?shares?|nearby[ _-]?share/i,
      shareit: /shareit/i,
      localsend: /localsend/i,
      sendanywhere: /send[ _-]?anywhere/i,
      xender: /xender/i,
      telegram: /telegram/i
    };

    for (const rank of order) {
      const key = exeRegexByApp[rank];
      // Start Menu shortcut targets know the exe directly
      for (const lnk of l) {
        if (asId(lnk.target || lnk.name) === rank) {
          const t = lnk.target;
          if (t && /\.exe$/i.test(t) && existsSync(t)) {
            push(rank, lnk.name, t, rank === 'telegram' ? ['send'] : []);
            break;
          }
        }
      }
      if (seen.has(rank)) continue;
      for (const e of u) {
        if (asId(e.name) !== rank) continue;
        const exe = exeFromResult(e.icon) || (e.loc && existsSync(e.loc) ? findExeInDir(e.loc, key, 2) : null);
        if (exe) {
          push(rank, e.name, exe, rank === 'telegram' ? ['send'] : []);
          break;
        }
      }
    }
  }

  /* 2. Filesystem fallback: Google folder scan (Quick Share lives here).
     Known exe names first (the launcher is the proper entry point). */
  const PF = process.env.ProgramFiles || 'C:\\Program Files';
  const LA = path.join(os.homedir(), 'AppData', 'Local');
  const QSR = path.join(os.homedir(), 'AppData', 'Roaming');
  const QS_NAMES = [
    'quicksharelauncher.exe', 'quickshare.exe', 'googlequickshare.exe',
    'nearby_share_launcher.exe', 'nearbyshare.exe',
    'nearbysharelauncher.exe', 'nearby_share.exe'
  ];
  outer: for (const n of QS_NAMES) {
    const rex = new RegExp('^' + n.replace(/[.]/g, '\\.') + '$', 'i');
    for (const root of [path.join(PF, 'Google'), path.join(LA, 'Google')]) {
      if (!existsSync(root)) continue;
      const exe = findExeInDir(root, rex, 2);
      if (exe) { push('quickshare', 'Quick Share', exe, []); break outer; }
    }
  }
  if (!seen.has('quickshare')) {
    for (const root of [path.join(PF, 'Google'), path.join(LA, 'Google')]) {
      if (!existsSync(root)) continue;
      const exe = findExeInDir(root, /quick[ _-]?shares?|nearby[ _-]?share/i, 2);
      if (exe) { push('quickshare', 'Quick Share', exe, []); break; }
    }
  }

  shareAppsCache = { t: now, apps };
  return apps;
}

/* ---------------- IPC ----------------
   Every channel is registered through H()/ON(), which run the centralized
   sender authorization (registered window + role + main frame + trusted
   URL) before the handler body — see lib/ipc-guard.js. */
function registerIpc() {
  /** authorized ipcMain.handle — handler signature: (args, event) */
  const H = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      guard.authorize(event.sender, channel);
      return handler(args, event);
    });
  };
  /** authorized ipcMain.on */
  const ON = (channel, handler) => {
    ipcMain.on(channel, (event, ...args) => {
      try { guard.authorize(event.sender, channel); }
      catch (e) { log('ipc denied', channel, e && e.message); return; }
      handler(args, event);
    });
  };

  /* settings */
  H('settings:get', () => ({ ...settings.data, appVersion: APP_VERSION }));
  H('settings:set', ([patch]) => {
    /* (Phase E) schema-validated, coerced, unknown keys dropped — the
       returned object is always the authoritative full settings */
    const check = validatePatch(patch);
    if (check.errors.length) log('settings:set rejected fields:', check.errors.join(' | '));
    if (check.ok && check.data) {
      if (check.data.saveDir !== undefined) {
        /* a non-writable folder must never be persisted as the recordings
           home — recordings would go there and then fail to finalize */
        const dir = check.data.saveDir && check.data.saveDir.length
          ? path.resolve(check.data.saveDir)
          : null;
        if (dir && !provisionSaveDir(dir).ok) {
          log('saveDir rejected (not writable), keeping:', settings.get('saveDir'));
          return { ...settings.data, appVersion: APP_VERSION, error: 'That folder is not writable — the recordings folder was not changed.' };
        }
        check.data.saveDir = dir;
      }
      settings.set(check.data);
      if ('hotkeyToggle' in check.data || 'hotkeyPause' in check.data) registerHotkeys();
    }
    return { ...settings.data, appVersion: APP_VERSION };
  });

  /* sources */
  H('sources:get', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 448, height: 252 },
      fetchWindowIcons: true
    });
    const displays = screen.getAllDisplays();
    const out = [];
    for (const s of sources) {
      const isScreen = s.id.startsWith('screen:');
      const display = displays.find(d => String(d.id) === String(s.display_id));
      out.push({
        id: s.id,
        type: isScreen ? 'screen' : 'window',
        name: s.name || (isScreen ? 'Display' : 'Window'),
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
        bounds: display ? display.bounds : null,
        scaleFactor: display ? display.scaleFactor : 1,
        primary: display ? display.id === screen.getPrimaryDisplay().id : false
      });
    }
    // Screens first
    return out.sort((a, b) => (a.type === b.type ? 0 : a.type === 'screen' ? -1 : 1));
  });

  H('capture:select-source', async ([sourceId]) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 }
      });
      const found = sources.find(s => s.id === sourceId);
      if (!found) return false;
      pendingSource = found;
      return true;
    } catch (e) { log('select-source err', e); return false; }
  });

  /* Fast path for hotkey starts: primary screen only, 1x1 thumbnails, no
     window enumeration — returns in milliseconds instead of seconds. */
  H('screen:primary-fast', async () => {
    try {
      const pd = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ['screen'], thumbnailSize: { width: 1, height: 1 }
      });
      const src = sources.find(s => String(s.display_id) === String(pd.id)) || sources[0];
      if (!src) return null;
      return {
        id: src.id,
        type: 'screen',
        name: 'Display ' + (screen.getAllDisplays().indexOf(
          screen.getAllDisplays().find(d => String(d.id) === String(pd.id))
        ) + 1),
        thumbnail: null,
        appIcon: null,
        bounds: pd.bounds,
        scaleFactor: pd.scaleFactor,
        primary: true
      };
    } catch (e) { log('primary-fast err', e); return null; }
  });

  /* recording file pipeline — renderer speaks ONLY in opaque session ids; all
     paths/permissions live here (P0 fix for the renderer-tempPath issue). */
  H('rec:begin', (args, event) => beginRecordingSession(event));

  H('rec:chunk', async (args, event) => {
    const [recordingId, data] = args;
    const { session, data: buf } = recRegistry.acceptChunk(recordingId, senderOf(event), data);
    try {
      const size = await enqueueChunkWrite(session, buf);
      recRegistry.recordChunkResult(session.recordingId, { size });
      maybeManifestProgress(session).catch(() => {});
      return { ok: true };
    } catch (e) {
      recRegistry.recordChunkResult(session.recordingId, { failed: true });
      if (session.writeErrors >= WRITE_ERRORS_SOFT_STOP) {
        /* tell the renderer to wrap up gracefully; chunks are already on
           disk for the seconds it captured so far */
        sendToMain('recorder:action', { action: 'write-failure' });
        session.writeErrors = -1; // notify once per flood
      }
      throw e;
    }
  });

  H('rec:finish', async (args, event) => {
    const [payload] = args;
    const senderInfo = senderOf(event);
    if (!payload || typeof payload !== 'object') throw new Error('finish payload must be an object');
    const safeMeta = validateFinishMeta({
      durationMs: payload.durationMs,
      type: payload.meta?.type, sourceName: payload.meta?.sourceName,
      fps: payload.meta?.fps, quality: payload.meta?.quality,
      resolution: payload.meta?.resolution, mic: payload.meta?.mic,
      systemAudio: payload.meta?.systemAudio, webcam: payload.meta?.webcam,
      region: payload.meta?.region, displayBounds: payload.meta?.displayBounds,
      thumb: payload.meta?.thumb
    });
    const session = recRegistry.authorizeFinish(payload.recordingId, senderInfo);
    recRegistry.transit(session, STATE.STOPPING);
    try {
      await manifestStore.saveNow(session.recordingId, {
        sessionId: session.recordingId,
        tempFileName: path.basename(session.tempTarget),
        state: session.state,
        bytesCommitted: session.bytes,
        chunksCommitted: session.chunks,
        writeFailures: session.writeErrors,
        finalization: 'pending',
        lastWriteAt: Date.now()
      });
    } catch { /* best-effort */ }
    /* all dispatched chunks must be on disk before the temp handle closes */
    await drainSession(session);
    recRegistry.transit(session, STATE.FINALIZING);
    return finalizeSession(session, { durationMs: safeMeta.durationMs || 0, meta: safeMeta });
  });

  H('rec:discard', (args, event) => discardSession(event, args[0]));

  ON('rec:state', ([state]) => {
    recActive = ['recording', 'paused', 'stopping'].includes(state?.state);
    if (tray) rebuildTrayMenu();
    if (floatWin && !floatWin.isDestroyed()) floatWin.webContents.send('float:state', state);
  });

  /* recordings library — the renderer uses opaque ids; paths never cross IPC */
  H('recordings:list', () => listRecordings());
  H('recording:delete', async ([id]) => {
    const filePath = resolveLibId(id);
    if (!filePath) throw new Error('Unknown recording');
    if (!isInsideDir(filePath, saveDir) || path.dirname(filePath) !== saveDir) throw new Error('Invalid recording');
    await fsp.rm(filePath, { force: true }).catch(() => {});
    libRemove(filePath);
    revokeLibPath(filePath);
    broadcastRecordingsChanged();
    return true;
  });
  H('recording:rename', async ([id, newName]) => {
    const filePath = resolveLibId(id);
    if (!filePath) throw new Error('Unknown recording');
    if (!isInsideDir(filePath, saveDir) || path.dirname(filePath) !== saveDir) throw new Error('Invalid recording');
    const base = sanitizeName(newName);
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath) || '.webm';
    const target = uniquePath(dir, base, ext);
    if (target !== filePath) {
      try {
        await fsp.rename(filePath, target);
      } catch (e) {
        if (!isTransientFsError(e)) throw e;
        await new Promise((r) => setTimeout(r, 250));
        await fsp.rename(filePath, target);
      }
    }
    const st = await fsp.stat(target);
    const meta = libGet(filePath) || {};
    const keepId = revokeLibPath(filePath) || grantLibId(target); // ids survive renames
    libRemove(filePath);
    if (keepId) { libIds.set(keepId, target); libPaths.set(target, keepId); }
    libSet(target, {
      ...meta,
      title: path.basename(target, ext),
      fileName: path.basename(target),
      size: st.size,
      partial: meta.partial === true,
      id: keepId
    });
    broadcastRecordingsChanged();
    return keepId;
  });
  H('recording:open', ([id]) => {
    const filePath = resolveLibId(id);
    if (!filePath) throw new Error('Unknown recording');
    shell.showItemInFolder(filePath);
    return true;
  });
  /* deliberate reverse channel: the UI's "Copy file path" action needs the
     real path for the clipboard; the renderer gets it only as a reply to an
     explicit user gesture on a library-owned id */
  H('recording:path', ([id]) => {
    const filePath = resolveLibId(id);
    if (!filePath || path.dirname(filePath) !== saveDir) throw new Error('Unknown recording');
    return filePath;
  });
  H('recordings:folder-pick', async () => {
    const res = await dialog.showOpenDialog(mainWin, {
      title: 'Choose recordings folder',
      defaultPath: saveDir,
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = path.resolve(res.filePaths[0]);
    if (!provisionSaveDir(dir).ok) {
      log('picked folder is not writable; keeping:', saveDir);
      return { error: 'That folder is not writable — the recordings folder was not changed.' };
    }
    settings.set({ saveDir: dir });
    ensureDirs();
    return settings.get('saveDir');
  });
  H('recordings:folder-open', () => { shell.openPath(saveDir); return true; });

  /* region overlay */
  H('region:begin', ([payload]) => {
    const { sourceId, bounds, scaleFactor } = payload || {};
    if (!bounds || typeof bounds !== 'object' ||
        ![bounds.x, bounds.y, bounds.width, bounds.height].every((v) => Number.isFinite(v)) ||
        bounds.width < 8 || bounds.height < 8 ||
        bounds.width > 16384 || bounds.height > 16384) {
      throw new GuardError('SCHEMA', 'region bounds out of range');
    }
    regionCtx = { sourceId, bounds, scaleFactor: scaleFactor || 1 };
    showRegionOverlay(bounds, scaleFactor);
    return true;
  });
  H('region:get-bounds', () => regionCtx);
  ON('region:done', ([rect]) => {
    closeRegionOverlay();
    sendToMain('region:result', { rect: validRegionRect(rect) });
  });
  ON('region:cancel', () => {
    closeRegionOverlay();
    sendToMain('region:result', { rect: null });
  });

  /* float */
  H('float:show', ([bounds]) => { showFloat(validRegionRect(bounds) || undefined); return true; });
  H('float:hide', () => { hideFloat(); return true; });
  ON('float:action', ([action]) => {
    if (typeof action !== 'string' || !/^[a-z-]{2,24}$/.test(action)) return;
    sendToMain('recorder:action', { source: 'float', action });
  });

  /* window controls */
  ON('app:window', ([cmd]) => {
    if (!mainWin || mainWin.isDestroyed()) return;
    switch (cmd) {
      case 'minimize': mainWin.minimize(); break;
      case 'maximize':
        mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize();
        break;
      case 'close':
        mainWin.close(); // respects close-to-tray logic in the close handler
        break;
      case 'show': mainWin.show(); break;
    }
  });

  H('app:version', () => ({ version: APP_VERSION, platform: process.platform }));

  /* Hard quit — used by the first-run Privacy Policy dialog ("I Disagree"). */
  ON('app:quit', () => {
    log('quit requested (EULA declined)');
    try { if (tray) tray.destroy(); } catch { /* */ }
    for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch { /* */ } }
    app.exit(0);
  });

  /* renderer logging (for smoke tests & debugging) */
  ON('app:log', ([args]) => {
    try { console.log('[renderer]', ...(Array.isArray(args) ? args.slice(0, 10).map(String) : ['(bad payload)'])); } catch { /* ignore */ }
  });

  /* open external links — https only (audit C5: http: dropped on purpose; the
     EULA/notice links inside the app are all https) */
  ON('app:open-external', ([url]) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url) && url.length <= 2048) shell.openExternal(url);
  });

  /* clipboard */
  H('app:clipboard-write', ([text]) => {
    clipboard.writeText(String(text ?? '').slice(0, 8192));
    return true;
  });

  /* native OS drag-out: drag a LIBRARY recording into other apps
     (Quick Share / SHAREit / WhatsApp / Explorer / any drop zone)
     — id-based, so only real records can ever be dragged (P0 fix). */
  let dragIcon = null;
  ON('app:drag-start', (args, event) => {
    try {
      const [recordingId] = args;
      const filePath = resolveLibId(recordingId);
      if (!filePath) { log('drag denied: unknown recording id'); return; }
      if (!existsSync(filePath) || path.dirname(filePath) !== saveDir) return;
      if (!dragIcon || dragIcon.isEmpty()) {
        dragIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))
          .resize({ width: 32, height: 32 });
      }
      event.sender.startDrag({ file: filePath, icon: dragIcon });
      log('drag started:', path.basename(filePath));
    } catch (e) { log('drag start failed', e); }
  });

  /* share — detection keeps exe paths in the main process; the renderer gets
     ids + display names, and launching takes {appId, recordingId} (P0 fix). */
  H('share:apps', async ([opts]) => {
    const apps = await detectShareApps(!!(opts && opts.force));
    /* strip resolver-only fields: no exe/args leak across IPC */
    return apps.map((a) => ({ id: a.id, name: a.name, ico: a.ico, available: !!a.exe }));
  });
  H('share:launch', ([payload]) => shareLauncher.launch(payload));
  H('share:openwith', ([recordingId]) => {
    const filePath = resolveLibId(recordingId);
    if (!filePath) throw new Error('Unknown recording');
    if (path.dirname(filePath) !== saveDir) throw new Error('Invalid recording');
    try {
      const child = spawn('OpenWith.exe', [filePath], { shell: false, detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch (e) { log('openwith failed', e); return false; }
  });

  /* crash recovery (§6.5 B4): the renderer speaks in manifest session ids */
  H('recovery:list', () => scanRecoverables());
  H('recovery:recover', async ([sessionId]) => {
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(sessionId)) throw new GuardError('SCHEMA', 'bad recovery id');
    const m = await manifestStore.load(sessionId);
    if (!m) throw new Error('No such recovery entry');
    const tempPath = path.join(tmpDir, m.tempFileName);
    if (!isInsideDir(tempPath, tmpDir) || !fs.existsSync(tempPath)) throw new Error('The recoverable file is gone');
    const head = await readHeadForCheck(tempPath, 4 * 1024 * 1024);
    const webm = checkWebM(head);
    if (!webm.hasCluster) {
      /* offer deletion instead of a corrupt file masquerading as footage */
      throw new GuardError('RECOVERY_BROKEN', 'This footage is broken (container has no media) — use Delete.');
    }
    ensureDirs();
    const finalPath = uniquePath(saveDir, sanitizeName(`Recovered Recording ${dateStamp()}`), '.webm');
    await finalizeMove(tempPath, finalPath);
    const st = await fsp.stat(finalPath);
    const gid = grantLibId(finalPath);
    libSet(finalPath, cleanLibMeta({
      title: path.basename(finalPath, '.webm'),
      fileName: path.basename(finalPath),
      created: Date.now(),
      durationMs: 0,   // unknown for crashed takes; measured metadata comes in Phase F
      size: st.size,
      recovered: true,
      partial: (m.writeFailures || 0) > 0,
      partialReason: (m.writeFailures || 0) > 0 ? `${m.writeFailures} chunk write failure(s) during the original recording` : null,
      id: gid
    }));
    await manifestStore.remove(sessionId).catch(() => {});
    dismissedRecovery.delete(sessionId);
    broadcastRecordingsChanged();
    return { ok: true, id: gid, fileName: path.basename(finalPath), size: st.size };
  });
  H('recovery:delete', async ([sessionId]) => {
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(sessionId)) throw new GuardError('SCHEMA', 'bad recovery id');
    const m = await manifestStore.load(sessionId);
    if (m) {
      const tempPath = path.join(tmpDir, m.tempFileName);
      if (isInsideDir(tempPath, tmpDir)) await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
    await manifestStore.remove(sessionId).catch(() => {});
    dismissedRecovery.delete(sessionId);
    return true;
  });
  H('recovery:dismiss', ([sessionId]) => {
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(sessionId)) throw new GuardError('SCHEMA', 'bad recovery id');
    /* hides it from THIS session's banner only; the file + manifest survive */
    dismissedRecovery.add(sessionId);
    return true;
  });
}

/* region/float bounds sanity: numbers clamped into sane desktop ranges */
function validRegionRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const n = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null);
  const x = n(rect.x, -16384, 16384), y = n(rect.y, -16384, 16384);
  const w = n(rect.width ?? rect.w, 1, 16384), h = n(rect.height ?? rect.h, 1, 16384);
  if (w === null || h === null) return null;
  return { x: x ?? 0, y: y ?? 0, width: w, height: h, w, h };
}

/* ---------------- Headless smoke test ---------------- */
/* Exit semantics (§15.1): SUCCESS ONLY after every assertion passes; any
   failure exits non-zero. The 3 s fallback quit is not unconditional exit(0). */
async function runSmokeTest() {
  let smokeFailed = false;
  try {
    log('[smoke] armed, waiting 2.5s');
    await new Promise(r => setTimeout(r, 2500));
    const wc = mainWin.webContents;
    log('[smoke] dispatching to renderer');
    const res = await wc.executeJavaScript(`(new Promise((resolve) => {
      const P = (m) => { try { window.rekzora.log('[smkdbg] ' + m); } catch (_) {} };
      P('listener wired');
      window.addEventListener('rekzora:recorder-saved', (e) => { P('saved event arrived'); resolve({ ok: true, detail: e.detail }); }, { once: true });
      (async () => {
        P('querying sources');
        const srcs = await window.rekzora.sources.list();
        P('sources=' + srcs.length + ' screens=' + srcs.filter((s) => s.type === 'screen').length);
        const scr = srcs.find((s) => s.type === 'screen');
        if (!scr) { resolve({ ok: false, why: 'no screen source' }); return; }
        P('picked ' + (scr.id || '?'));
        const started = window.RekzoraRecorder.start({
          source: scr,
          sourceType: 'screen',
          displayBounds: { width: scr.bounds.width, height: scr.bounds.height },
          region: null,
          fps: 30, quality: 'medium', resolution: 'auto',
          mic: false, sysAudio: false, webcam: false
        });
        P('start() called, awaiting');
        await started;
        P('start() resolved');
        setTimeout(() => { P('stopping now'); window.RekzoraRecorder.stop(); }, 3000);
      })().catch((e) => { P('inner error: ' + String(e && e.message || e)); resolve({ ok: false, why: String(e && e.message || e) }); });
    }))`, true);
    log('[smoke] result:', JSON.stringify(res));

    const detail = res && res.detail;
    if (!res || !res.ok) {
      log('[smoke] FAILED: renderer start/stop flow reported failure:', res && res.why);
      smokeFailed = true;
    } else if (!detail || detail.discarded || detail.status !== 'completed') {
      log('[smoke] FAILED: recording did not complete cleanly:', JSON.stringify(detail || null));
      smokeFailed = true;
    } else {
      /* evidence checks: file exists, non-empty, structurally valid WebM,
         library has the entry, duration sane for a 3 s recording */
      const exists = detail.path && fs.existsSync(detail.path);
      if (!exists) {
        log('[smoke] FAILED: finalized file is missing on disk');
        smokeFailed = true;
      } else {
        const size = fs.statSync(detail.path).size;
        if (size < 10 * 1024) {
          log('[smoke] FAILED: file suspiciously small (' + size + ' B)');
          smokeFailed = true;
        } else {
          const head = await (async () => {
            const fh = await fsp.open(detail.path, 'r');
            try {
              const b = Buffer.alloc(Math.min(2 * 1024 * 1024, size));
              const { bytesRead } = await fh.read(b, 0, b.length, 0);
              return b.subarray(0, bytesRead);
            } finally { await fh.close().catch(() => {}); }
          })();
          const webm = checkWebM(head);
          if (!webm.valid || !webm.hasCluster) {
            log('[smoke] FAILED: not a structurally valid WebM:', webm.reason);
            smokeFailed = true;
          }
          if (!(detail.durationMs >= 2000 && detail.durationMs <= 12000)) {
            log('[smoke] FAILED: duration out of tolerance:', detail.durationMs, 'ms');
            smokeFailed = true;
          }
          const listing = await listRecordings();
          const entry = listing.find((li) => li.id === detail.id) || listing.find((li) => li.fileName === detail.fileName);
          if (!entry) {
            log('[smoke] FAILED: no library entry for the saved recording');
            smokeFailed = true;
          }
          log('[smoke] file:', exists, '| size:', size, '| webm ok:', webm.valid,
            '| duration:', detail.durationMs, 'ms | library entry:', !!entry);

          /* playback probe (v1.1): resolve the library id to rekzora-video://,
             load it in a fresh <video> element from the MAIN window, and wait
             for metadata — exercises protocol.handle + streaming on whatever
             Electron is installed, end to end. */
          let playback = null;
          try {
            playback = await wc.executeJavaScript(`(new Promise((resolve) => {
              const P = (m) => { try { window.rekzora.log('[smkdbg] ' + m); } catch (_) {} };
              const v = document.createElement('video');
              v.preload = 'metadata';
              const done = (r) => { try { v.removeAttribute('src'); v.load(); v.remove(); } catch (_) {} resolve(r); };
              v.addEventListener('loadedmetadata', () => {
                P('playback metadata');
                done({ ok: true, w: v.videoWidth, h: v.videoHeight, dur: Math.round(v.duration * 1000) });
              }, { once: true });
              v.addEventListener('error', () => {
                P('playback media error');
                done({ ok: false, why: 'media error' });
              }, { once: true });
              v.src = 'rekzora-video://' + ${JSON.stringify(String(detail.id))} + '/video';
              P('playback probe src set');
              setTimeout(() => done({ ok: false, why: 'timeout' }), 8000);
            }))`, true);
          } catch (e) { playback = { ok: false, why: 'executeJavaScript failed: ' + (e && e.message) }; }
          log('[smoke] playback:', JSON.stringify(playback));
          if (!playback || !playback.ok) {
            log('[smoke] FAILED: playback over rekzora-video:// did not work');
            smokeFailed = true;
          }
        }
        // clean up the test artifact (own recording only)
        try {
          await fsp.rm(detail.path, { force: true });
          if (detail.id) {
            const p = resolveLibId(detail.id);
            if (p && p === detail.path) { libRemove(p); revokeLibPath(p); }
          }
        } catch { /* cleanup is best-effort */ }
      }
    }
  } catch (e) {
    log('[smoke] FAILED:', e && (e.stack || e.message));
    smokeFailed = true;
  }
  /* Quit gracefully so before-quit runs (tray cleanup). The fallback uses the
     collected exit code — failure must NEVER be masked by exit 0. */
  process.exitCode = smokeFailed ? 1 : 0;
  log('[smoke] result:', smokeFailed ? 'FAIL (exit 1)' : 'PASS (exit 0)');
  setTimeout(() => app.quit(), 500);
  setTimeout(() => app.exit(process.exitCode || 0), 3000);
}

/* ---------------- Lifecycle ---------------- */
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    ensureDirs();

    /* main-process-owned security surface (P0) */
    guard = createGuard({ trustedUrlPrefixes: [trustedUrlPrefix()], logger: (m, ...a) => log('guard', m, ...a) });
    recRegistry = createRegistry({
      makeTempTarget: (id) => path.join(tmpDir, `rec-${id}.webm`),
      onEvent: (kind, session, prev) => {
        if (kind === 'state' || kind === 'created') {
          /* manifest updates on transitions are handled at the call sites;
             this hook only feeds the (phase C) recovery telemetry */
        }
      }
    });
    manifestStore = createManifestStore({ dir: path.join(tmpDir, 'manifests') });
    shareLauncher = createShareLauncher({
      listApps: () => shareAppsCache.apps || [],
      resolveApp: (appId) => {
        const apps = shareAppsCache.apps || [];
        return apps.find((a) => a.id === appId && a.exe && isPlausibleExecutable(a.exe)) || null;
      },
      recordingPath: (recordingId) => {
        const p = resolveLibId(recordingId);
        if (!p) return null;
        if (!isInsideDir(p, saveDir) || path.dirname(p) !== saveDir) return null;
        if (!/\.webm$/i.test(p)) return null;
        return p;
      },
      spawn
    });
    rebuildLibIdIndex();

    /* Player media server: rekzora-video://<libraryId>/video */
    setupPlaybackProtocol();

    /* early visibility of recoverable takes (the renderer re-queries live) */
    scanRecoverables().then((rows) => {
      if (rows.length) log('recovery candidates from a previous session:', rows.length);
    }).catch(() => {});

    /* One-time migration: existing installs get the new light default */
    if (!settings.get('themeMigrated')) {
      settings.set({ theme: 'light', themeMigrated: true });
      log('theme migrated to light (new default)');
    }
    migrateSidecars();
    setupDisplayMediaHandler();
    setupPermissionHandlers();
    registerIpc();
    createMainWindow();

    // Tray
    tray = new Tray(trayIcon());
    rebuildTrayMenu();
    tray.on('click', () => showMainWindow());

    registerHotkeys();

    // warm the share-detection cache so launches resolve instantly
    detectShareApps().catch(() => {});

    // Headless self-test: REKZORA_SMOKE=1 records 3s of the primary screen,
    // verifies the file, prints the result and quits.
    if (process.env.REKZORA_SMOKE === '1') runSmokeTest();

    // Pause recording when the machine suspends
    powerMonitor.on('suspend', () => sendToMain('recorder:action', { action: 'system-suspend' }));

    app.on('activate', () => showMainWindow());
  });

  app.on('window-all-closed', () => {
    if (!recActive && !settings.get('closeToTray')) app.quit();
  });

  /* ---- quit handshake (§6.5 B3) ----
     Quitting while a recording is live must not shred the take: hold the
     quit once, ask the user, then wait a bounded time for the recording to
     finish. If the user confirms a hard stop we flush recovery manifests
     and proceed — the temp file + manifest survive for the recovery UI,
     nothing is silently destroyed either way. */
  const quitGuard = { held: false, forced: false };
  function flushAllManifests() {
    try { if (manifestStore) manifestStore.flushPending().catch(() => {}); } catch { /* ignore */ }
  }
  app.on('before-quit', (e) => {
    quitting = true;
    globalShortcut.unregisterAll();
    try { if (tray) { tray.destroy(); tray = null; } } catch { /* ignore */ }

    if (quitGuard.forced || !recActive) {
      flushAllManifests();          // no recording: just land debounced writes
      return;
    }
    e.preventDefault();
    if (quitGuard.held) return;     // a dialog is already up; it owns the loop
    quitGuard.held = true;

    let answer = null;              // synchronous modal — the only safe choice here
    try {
      answer = dialog.showMessageBoxSync(mainWin && !mainWin.isDestroyed() ? mainWin : {}, {
        type: 'question',
        buttons: ['Stop & save, then quit', 'Quit without saving', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Recording in progress',
        message: 'A recording is still in progress.',
        detail: 'Stop & save finalizes what has been recorded so far. Quit without saving keeps the captured footage as a recoverable file.'
      });
    } catch { answer = 1; }

    if (answer === 0) {
      /* ask the recorder to stop; wait bounded for completion */
      try { sendToMain('recorder:action', { action: 'stop' }); } catch { /* */ }
      const t0 = Date.now();
      const wait = setInterval(() => {
        if (!recActive || Date.now() - t0 > 15000) {
          clearInterval(wait);
          quitGuard.forced = true;
          flushAllManifests();
          app.quit();
        }
      }, 150);
    } else if (answer === 1) {
      quitGuard.forced = true;
      flushAllManifests();
      app.quit();
    } else {
      /* user cancelled — release the guard so quitting stays possible later */
      quitGuard.held = false;
      quitting = false;
    }
  });

  process.on('uncaughtException', (e) => console.error('[uncaught]', e));
}
