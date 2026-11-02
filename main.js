'use strict';
/* ============================================================
   Rekzora — Screen Recorder for Windows
   Main process: windows, IPC, capture permissions, storage,
   tray, global shortcuts, float & region overlays.
   ============================================================ */

const {
  app, BrowserWindow, ipcMain, desktopCapturer, dialog,
  globalShortcut, Tray, Menu, nativeImage, shell, screen, session, powerMonitor
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { spawn } = require('node:child_process');
const os = require('node:os');
const clipboard = require('electron').clipboard;

const isDev = !app.isPackaged;
const APP_NAME = 'Rekzora';
const APP_VERSION = app.getVersion();

/* Proper taskbar identity on Windows: groups all Rekzora windows/processes
   under one taskbar entry and shows the Rekzora icon in notifications. */
app.setAppUserModelId('com.neurontslabs.rekzora');

/* ---------------- Settings store (JSON, no deps) ---------------- */
class Store {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = Object.assign({}, defaults, this._read());
  }
  _read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { return {}; }
  }
  get(key) { return this.data[key]; }
  set(patch) {
    Object.assign(this.data, patch || {});
    this._write();
    return this.data;
  }
  remove(key) {
    delete this.data[key];
    this._write();
  }
  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) { console.error('[store] write failed', e); }
  }
}

function getDefaultSaveDir() {
  try {
    const videos = app.getPath('videos');
    if (videos) return path.join(videos, 'Rekzora Recordings');
  } catch { /* fall through */ }
  try { return path.join(app.getPath('documents'), 'Rekzora Recordings'); } catch { /* ignore */ }
  return path.join(app.getPath('userData'), 'Recordings');
}

const settings = new Store(
  path.join(app.getPath('userData'), 'settings.json'),
  {
    theme: 'light',
    themeMigrated: false,
    mode: 'fullscreen',           // fullscreen | window | region
    fps: 30,                      // 24 | 30 | 60
    quality: 'high',              // low | medium | high | ultra
    resolution: 'auto',           // auto | 240p | 360p | 480p | 720p | 1080p | 1440p | 2160p
    countdown: 3,                 // 0 | 3 | 5
    mic: true,
    sysAudio: true,
    webcam: false,
    saveDir: null,                // resolved at startup
    hotkeyToggle: 'F9',
    hotkeyPause: 'F10',
    closeToTray: true,
    eulaAccepted: false           // first-run Privacy Policy / EULA consent
  }
);

/* Metadata database — lives in AppData so recordings folders stay clean
   (previously we dropped a `.json` sidecar next to every video). */
const libDb = new Store(
  path.join(app.getPath('userData'), 'library.json'),
  {}
);
function libSet(p, meta) { libDb.set({ [p]: meta }); }
function libGet(p) { return libDb.data[p] || null; }
function libRemove(p) { libDb.remove(p); }

function cleanLibMeta(raw) {
  if (!raw) return null;
  return {
    title: raw.title || null,
    fileName: raw.fileName || null,
    created: raw.created || null,
    durationMs: raw.durationMs || 0,
    thumb: raw.thumb || null,
    type: raw.type || 'screen',
    sourceName: raw.sourceName || null,
    fps: raw.fps || null,
    quality: raw.quality || null,
    resolution: raw.resolution || null,
    mic: !!raw.mic,
    systemAudio: raw.systemAudio !== undefined ? !!raw.systemAudio : false,
    webcam: !!raw.webcam,
    region: raw.region || null
  };
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
const writeHandles = new Map(); // tempPath -> fs.FileHandle

/* ---------------- Helpers ---------------- */
function log(...a) { console.log(`[main] ${new Date().toISOString().slice(11, 19)}`, ...a); }

function ensureDirs() {
  saveDir = settings.get('saveDir') || getDefaultSaveDir();
  tmpDir = path.join(app.getPath('userData'), 'recordings-tmp');
  for (const d of [saveDir, tmpDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { console.error('[dirs]', e); }
  }
  settings.set({ saveDir });
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
      sandbox: false,              // mild relaxation so the preload can use small Node APIs
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

  // DevTools on F12 in dev builds
  mainWin.webContents.on('before-input-event', (_e, input) => {
    if (isDev && input.type === 'keyDown' && input.key === 'F12') {
      mainWin.webContents.toggleDevTools();
    }
  });
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
      backgroundThrottling: false
    }
  });
  floatWin.setAlwaysOnTop(true, 'screen-saver');
  floatWin.loadFile(path.join(__dirname, 'src', 'floating', 'index.html'));
  floatWin.on('closed', () => { floatWin = null; });
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
        nodeIntegration: false
      }
    });
    regionWin.setAlwaysOnTop(true, 'screen-saver');
    regionWin.loadFile(path.join(__dirname, 'src', 'region', 'index.html'));
    regionWin.on('closed', () => { regionWin = null; });
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

/* ---------------- Recording file I/O ---------------- */
async function beginRecordingFile() {
  ensureDirs();
  // Clean stale temps older than 24h
  try {
    const files = await fsp.readdir(tmpDir);
    for (const f of files) {
      const p = path.join(tmpDir, f);
      const st = await fsp.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 86_400_000) await fsp.rm(p, { force: true }).catch(() => {});
    }
  } catch { /* ignore */ }

  const tempPath = path.join(tmpDir, `rec-${Date.now()}-${Math.floor(Math.random() * 1e6)}.webm`);
  const handle = await fsp.open(tempPath, 'w');
  writeHandles.set(tempPath, handle);
  return { tempPath };
}

async function appendChunk(tempPath, data) {
  const handle = writeHandles.get(tempPath);
  if (!handle) throw new Error('No open file for chunk');
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  await handle.write(buf);
  return true;
}

async function finishRecordingFile({ tempPath, durationMs, meta }) {
  const handle = writeHandles.get(tempPath);
  if (handle) { try { await handle.close(); } catch {} writeHandles.delete(tempPath); }

  const base = sanitizeName(`Screen Recording ${dateStamp()}`);
  const finalPath = uniquePath(saveDir, base, '.webm');
  try {
    await fsp.rename(tempPath, finalPath);
  } catch (e) {
    // Cross-device fallback: copy + delete
    await fsp.copyFile(tempPath, finalPath);
    await fsp.rm(tempPath, { force: true });
  }
  const st = await fsp.stat(finalPath);
  libSet(finalPath, cleanLibMeta({
    title: path.basename(finalPath, '.webm'),
    fileName: path.basename(finalPath),
    created: st.birthtimeMs,
    durationMs: durationMs || 0,
    size: st.size,
    ...meta
  }));
  broadcastRecordingsChanged();
  return { path: finalPath, fileName: path.basename(finalPath), size: st.size, durationMs };
}

async function discardRecordingFile(tempPath) {
  const handle = writeHandles.get(tempPath);
  if (handle) { try { await handle.close(); } catch {} writeHandles.delete(tempPath); }
  if (tempPath && isInsideDir(tempPath, tmpDir)) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
  return true;
}

function broadcastRecordingsChanged() {
  sendToMain('recordings:changed', { t: Date.now() });
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
      const meta = cleanLibMeta(libGet(p)) || {};
      entries.push({
        path: p,
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
        systemAudio: !!meta.systemAudio
      });
    } catch { /* skip unreadable */ }
  }
  entries.sort((a, b) => b.created - a.created);
  // Drop stale DB entries (files deleted outside the app)
  const alive = new Set(entries.map(e => e.path));
  for (const key of Object.keys(libDb.data)) {
    if (key.startsWith(saveDir) && !alive.has(key)) libRemove(key);
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

/* ---------------- IPC ---------------- */
function registerIpc() {
  /* settings */
  ipcMain.handle('settings:get', () => ({ ...settings.data, appVersion: APP_VERSION }));
  ipcMain.handle('settings:set', (_e, patch) => {
    const clean = {};
    const allowed = ['theme', 'themeMigrated', 'mode', 'fps', 'quality', 'resolution', 'countdown', 'mic', 'sysAudio', 'webcam',
      'saveDir', 'hotkeyToggle', 'hotkeyPause', 'closeToTray', 'eulaAccepted'];
    for (const k of allowed) if (k in (patch || {})) clean[k] = patch[k];
    if (clean.saveDir) {
      clean.saveDir = path.resolve(clean.saveDir);
      try { fs.mkdirSync(clean.saveDir, { recursive: true }); } catch {}
    }
    settings.set(clean);
    if (clean.hotkeyToggle !== undefined || clean.hotkeyPause !== undefined) registerHotkeys();
    return { ...settings.data, appVersion: APP_VERSION };
  });

  /* sources */
  ipcMain.handle('sources:get', async () => {
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

  ipcMain.handle('capture:select-source', async (_e, sourceId) => {
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
  ipcMain.handle('screen:primary-fast', async () => {
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

  /* recording file pipeline */
  ipcMain.handle('rec:begin', () => beginRecordingFile());
  ipcMain.handle('rec:chunk', (_e, tempPath, data) => appendChunk(tempPath, data));
  ipcMain.handle('rec:finish', (_e, payload) => finishRecordingFile(payload));
  ipcMain.handle('rec:discard', (_e, tempPath) => discardRecordingFile(tempPath));

  ipcMain.on('rec:state', (_e, state) => {
    recActive = ['recording', 'paused', 'stopping'].includes(state?.state);
    if (tray) rebuildTrayMenu();
    if (floatWin && !floatWin.isDestroyed()) floatWin.webContents.send('float:state', state);
  });

  /* recordings library */
  ipcMain.handle('recordings:list', () => listRecordings());
  ipcMain.handle('recording:delete', async (_e, filePath) => {
    if (!isInsideDir(filePath, saveDir)) throw new Error('Invalid path');
    await fsp.rm(filePath, { force: true }).catch(() => {});
    libRemove(filePath);
    broadcastRecordingsChanged();
    return true;
  });
  ipcMain.handle('recording:rename', async (_e, { path: filePath, newName }) => {
    if (!isInsideDir(filePath, saveDir)) throw new Error('Invalid path');
    const base = sanitizeName(newName);
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath) || '.webm';
    const target = uniquePath(dir, base, ext);
    if (target !== filePath) await fsp.rename(filePath, target);
    const meta = libGet(filePath) || {};
    const st = await fsp.stat(target);
    libRemove(filePath);
    libSet(target, cleanLibMeta({
      ...meta,
      title: path.basename(target, ext),
      fileName: path.basename(target),
      size: st.size
    }));
    broadcastRecordingsChanged();
    return target;
  });
  ipcMain.handle('recording:open', (_e, filePath) => {
    shell.showItemInFolder(filePath);
    return true;
  });
  ipcMain.handle('recordings:folder-pick', async () => {
    const res = await dialog.showOpenDialog(mainWin, {
      title: 'Choose recordings folder',
      defaultPath: saveDir,
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    settings.set({ saveDir: res.filePaths[0] });
    ensureDirs();
    return settings.get('saveDir');
  });
  ipcMain.handle('recordings:folder-open', () => { shell.openPath(saveDir); return true; });

  /* region overlay */
  ipcMain.handle('region:begin', async (_e, { sourceId, bounds, scaleFactor }) => {
    regionCtx = { sourceId, bounds, scaleFactor: scaleFactor || 1 };
    showRegionOverlay(bounds, scaleFactor);
    return true;
  });
  ipcMain.handle('region:get-bounds', () => regionCtx);
  ipcMain.on('region:done', (_e, rect) => {
    closeRegionOverlay();
    sendToMain('region:result', { rect });
  });
  ipcMain.on('region:cancel', () => {
    closeRegionOverlay();
    sendToMain('region:result', { rect: null });
  });

  /* float */
  ipcMain.handle('float:show', (_e, bounds) => { showFloat(bounds); return true; });
  ipcMain.handle('float:hide', () => { hideFloat(); return true; });
  ipcMain.on('float:action', (_e, action) => {
    sendToMain('recorder:action', { source: 'float', action });
  });

  /* window controls */
  ipcMain.on('app:window', (_e, cmd) => {
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

  ipcMain.handle('app:version', () => ({ version: APP_VERSION, platform: process.platform }));

  /* Hard quit — used by the first-run Privacy Policy dialog ("I Disagree"). */
  ipcMain.on('app:quit', () => {
    log('quit requested (EULA declined)');
    try { if (tray) tray.destroy(); } catch { /* */ }
    for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch { /* */ } }
    app.exit(0);
  });

  /* renderer logging (for smoke tests & debugging) */
  ipcMain.on('app:log', (_e, args) => {
    try { console.log('[renderer]', ...args); } catch { /* ignore */ }
  });

  /* open external links */
  ipcMain.on('app:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });

  /* clipboard */
  ipcMain.handle('app:clipboard-write', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  /* native OS drag-out: drag files from Lumin into other apps
     (Quick Share / SHAREit / WhatsApp / Explorer / any drop zone) */
  let dragIcon = null;
  ipcMain.on('app:drag-start', (event, filePath) => {
    try {
      if (typeof filePath !== 'string' || !existsSync(filePath)) return;
      if (!dragIcon || dragIcon.isEmpty()) {
        dragIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))
          .resize({ width: 32, height: 32 });
      }
      event.sender.startDrag({ file: filePath, icon: dragIcon });
      log('drag started:', path.basename(filePath));
    } catch (e) { log('drag start failed', e); }
  });

  /* share */
  ipcMain.handle('share:apps', (_e, opts) => detectShareApps(!!(opts && opts.force)));
  ipcMain.handle('share:launch', (_e, { exe, args }) => {
    try {
      if (!exe || !existsSync(exe)) return false;
      const child = spawn(exe, args || [], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch (e) { log('share launch failed', e); return false; }
  });
  ipcMain.handle('share:openwith', (_e, filePath) => {
    try {
      const child = spawn('OpenWith.exe', [filePath], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch (e) { log('openwith failed', e); return false; }
  });
}

/* ---------------- Headless smoke test ---------------- */
async function runSmokeTest() {
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
    if (res && res.ok && res.detail && res.detail.path) {
      const exists = fs.existsSync(res.detail.path);
      const listing = await listRecordings();
      const sidecars = (await fsp.readdir(saveDir)).filter(f => f.endsWith('.json'));
      log('[smoke] file exists:', exists, '| library entries:', listing.length, '| sidecar jsons:', sidecars.length);
      // clean up the test artifact
      if (exists) await fsp.rm(res.detail.path, { force: true });
      libRemove(res.detail.path);
    }
  } catch (e) {
    log('[smoke] FAILED:', e && (e.stack || e.message));
  }
  /* Quit gracefully so before-quit runs (tray cleanup); hard fallback in
     case app.quit() is ever blocked — a CI run must always terminate. */
  setTimeout(() => app.quit(), 500);
  setTimeout(() => app.exit(0), 3000);
}

/* ---------------- Lifecycle ---------------- */
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    ensureDirs();
    /* One-time migration: existing installs get the new light default */
    if (!settings.get('themeMigrated')) {
      settings.set({ theme: 'light', themeMigrated: true });
      log('theme migrated to light (new default)');
    }
    migrateSidecars();
    setupDisplayMediaHandler();
    registerIpc();
    createMainWindow();

    // Tray
    tray = new Tray(trayIcon());
    rebuildTrayMenu();
    tray.on('click', () => showMainWindow());

    registerHotkeys();

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

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    /* Destroy the tray icon explicitly — otherwise Windows cleans up the
       notification icon lazily, leaving ghost icons in the tray area until
       the mouse is moved over them (especially after force-killed runs). */
    try { if (tray) { tray.destroy(); tray = null; } } catch { /* ignore */ }
  });

  process.on('uncaughtException', (e) => console.error('[uncaught]', e));
}
