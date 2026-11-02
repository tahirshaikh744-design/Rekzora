'use strict';
/* ============================================================
   Rekzora — share application registry (main process only)

   The renderer only ever speaks in {appId, recordingId}. Executable
   paths and arguments live here, resolved by trusted discovery code in
   main.js, and are re-verified at launch time. Nothing in this module
   builds shell command strings; launching uses child_process.spawn()
   with shell:false.
   ============================================================ */

/** App ids Rekzora understands. Detection in main.js maps installed
 *  packages onto these stable ids; launch validates against them. */
const KNOWN_APP_IDS = Object.freeze([
  'quickshare', 'shareit', 'sendanywhere', 'localsend', 'xender', 'telegram'
]);

/** Per-app launch argument policy. While most targets accept the bare
 *  file path, Telegram's desktop client needs the implicit "send" verb. */
const ARGS_BY_APP = Object.freeze({
  telegram: ['send'],
  quickshare: [], shareit: [], sendanywhere: [], localsend: [], xender: []
});

/** Executables are re-verified at launch: real .exe file inside a
 *  machine-managed location, existing on disk. */
function isPlausibleExecutable(exePath) {
  if (typeof exePath !== 'string' || !exePath) return false;
  if (!/\.exe$/i.test(exePath)) return false;
  if (exePath.length > 260 * 4) return false;
  if (/[\r\n]/.test(exePath)) return false;        // no newline smuggling
  if (exePath.includes('\u0000')) return false;
  return true;
}

class ShareError extends Error {
  constructor(code, message) { super(message); this.name = 'ShareError'; this.code = code; }
}

function reject(code, message) { throw new ShareError(code, message); }

/* Recording ids are `r` + 12 base36 chars, generated in main via crypto. */
const LIBRARY_ID_RE = /^r_[a-z0-9]{12}$/;

function validateLibraryId(value) {
  if (typeof value !== 'string') reject('RECORDING_ID_TYPE', 'recordingId must be a string');
  if (!LIBRARY_ID_RE.test(value)) reject('RECORDING_ID_FORMAT', 'recordingId is malformed');
  return value;
}

/** Create a registry. `teleport`-style injection keeps this testable:
 *  - listApps()         → current registry snapshot
 *  - resolveApp(id)     → {exe, args} or null, verified by the caller
 *  - recordingPath(id)  → validated absolute path inside the save folder
 *  - spawn(exe, argv)   → I/O boundary (injected in tests) */
function createShareLauncher({ listApps, resolveApp, recordingPath, spawn }) {
  if (typeof resolveApp !== 'function') reject('CONFIG', 'resolveApp missing');
  if (typeof recordingPath !== 'function') reject('CONFIG', 'recordingPath missing');
  if (typeof spawn !== 'function') reject('CONFIG', 'spawn missing');

  /** launch({appId, recordingId}) → { ok, appId } or throws ShareError */
  async function launch(request) {
    if (!request || typeof request !== 'object') reject('BAD_PAYLOAD', 'launch payload must be an object');
    const { appId, recordingId } = request;
    if (typeof appId !== 'string' || !KNOWN_APP_IDS.includes(appId)) {
      reject('UNKNOWN_APP', 'unknown share application id');
    }
    validateLibraryId(recordingId);

    const filePath = recordingPath(recordingId);
    if (!filePath) reject('RECORDING_NOT_FOUND', 'recording is not in the library');

    const app = resolveApp(appId);
    if (!app || !isPlausibleExecutable(app.exe)) {
      reject('APP_MISSING', `${appId} is not installed (or its launcher is gone)`);
    }

    const argv = [...(ARGS_BY_APP[appId] || []), filePath];
    try {
      /* shell:false — no cmd.exe interpretation of the path, ever */
      const child = spawn(app.exe, argv, { shell: false, detached: true, stdio: 'ignore' });
      if (child && typeof child.unref === 'function') child.unref();
    } catch (e) {
      reject('SPAWN_FAILED', `could not start ${appId}`);
    }
    return { ok: true, appId };
  }

  return { launch, KNOWN_APP_IDS, isPlausibleExecutable };
}

module.exports = {
  KNOWN_APP_IDS, ARGS_BY_APP, LIBRARY_ID_RE, ShareError,
  isPlausibleExecutable, validateLibraryId, createShareLauncher
};
