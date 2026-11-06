'use strict';
/* ============================================================
   Rekzora JSON store (v1.1 Phase E)
   Small-file settings/metadata storage with the durability rules
   P2 requires: every write is atomic (temp file + rename), the
   previous good state is kept as a .bak first-read-then-rotate
   backup, corrupted primaries are recovered from the backup
   (never silently reset), and rename is retried with a short
   backoff so transient Windows file locks (AV scanners) do not
   drop a save. No Electron imports — fully unit-testable.
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');

const RETRIES = 4;

/* Synchronous sleep that works in every Node context we use. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return; // woke up by timeout
  } catch {
    /* environments that refuse Atomics.wait (browser-like main threads) */
    const end = Date.now() + Math.min(ms, 50);
    while (Date.now() < end) { /* busy spin (short, bounded) */ }
  }
}

function renameWithRetry(tmp, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return true;
    } catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (!transient || attempt >= RETRIES - 1) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      sleepSync(15 * (attempt + 1));
    }
  }
}

/* Validate/purge hook applied to freshly loaded data. Must be pure. */
function applySanitize(sanitize, defaults, loaded) {
  if (typeof sanitize === 'function') return sanitize(loaded);
  /* default policy: drop unknown primitive junk for defaults-shaped stores */
  if (typeof defaults === 'object' && defaults !== null && Object.keys(defaults).length > 0) {
    const out = { ...defaults };
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      for (const k of Object.keys(defaults)) if (k in loaded) out[k] = loaded[k];
    }
    return out;
  }
  return (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) ? loaded : {};
}

function createJsonStore({ file, backupFile, defaults = {}, sanitize, onError }) {
  const bak = backupFile || `${file}.bak`;
  const tmp = `${file}.tmp`;

  function parseCarefully(text) {
    /* JSON.parse failures must look like "empty" — but distinguish
       corrupt-but-present from nothing-there for the recovery path */
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, empty: true };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, empty: false };
    }
  }

  function load() {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* mkdir below may still fail */ }
    let primary = null;
    try {
      primary = parseCarefully(fs.readFileSync(file, 'utf8'));
    } catch {
      primary = { ok: false, empty: true };
    }

    if (primary && primary.ok) {
      return applySanitize(sanitize, defaults, primary.data);
    }

    /* Primary unreadable: recover the last known-good state from the
       backup — with an honest report, not a silent reset. */
    let bakRes = null;
    try { bakRes = parseCarefully(fs.readFileSync(bak, 'utf8')); } catch {
      bakRes = { ok: false, empty: true };
    }
    if (bakRes && bakRes.ok) {
      const recovered = applySanitize(sanitize, defaults, bakRes.data);
      onError && onError(`settings file was unreadable (${primary && primary.empty ? 'empty file' : 'corrupt JSON'}) — recovered previous state from backup`);
      writeNow(recovered, { rotate: false }); // repair the primary; replacing a CORRUPT primary must never copy it over the good backup
      return recovered;
    }

    /* Neither file is salvageable: log loudly once and start from the
       defaults (still never destroying what's on disk until we write). */
    onError && onError(`settings file unusable (${primary && primary.empty ? 'empty/missing' : 'corrupt'}) and no valid backup — starting from defaults`);
    return applySanitize(sanitize, defaults, defaults);
  }

  function rotateBackup(currentData) {
    try {
      if (fs.existsSync(file)) {
        /* keep the last known-good version; if it does not parse we still
           let the rename overwrite it (dead files must not block writes) */
        fs.copyFileSync(file, bak);
      }
    } catch { /* backup is best-effort */ }
  }

  function writeNow(data, { rotate = true } = {}) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (rotate) rotateBackup();
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8' });
      renameWithRetry(tmp, file);
      /* Seed the backup the first time this instance writes: without it a
         store would have NO backup until its second-ever write, and a crash
         right after the first write would leave the recovery path empty. */
      if (rotate && !bakSeeded) {
        try {
          if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
        } catch { /* seed is best-effort */ }
        bakSeeded = true;
      }
      return true;
    } catch (e) {
      (onError || ((m) => console.error('[store]', m)))('write failed: ' + (e && e.message));
      return false;
    }
  }

  let bakSeeded = false;
  const data = load();

  return {
    get data() { return data; },
    get(key) { return data[key]; },
    has(key) { return Object.prototype.hasOwnProperty.call(data, key); },
    set(patch) {
      Object.assign(data, patch || {});
      writeNow(data);
      return data;
    },
    remove(key) {
      delete data[key];
      writeNow(data);
    },
    reload() {
      const fresh = load();
      for (const k of Object.keys(data)) delete data[k];
      Object.assign(data, fresh);
      return data;
    }
  };
}

module.exports = { createJsonStore };
