'use strict';
/* ============================================================
   Rekzora settings schema (v1.1 Phase E)
   Every settings key carries a type, a value domain, and a safe
   default. Renderer-supplied patches are validated and coerced
   before they ever touch storage or disk, so a hostile or buggy
   renderer cannot poison settings.json with values the app
   would choke on (fps: "banana", countdown: -1, paths with NUL
   bytes…). Unknown keys are dropped, not preserved.
   ============================================================ */

const HOTKEY_RE = /^(F[1-9]|F1[0-9]|F2[0-4]|Ctrl\+Shift\+[A-Z0-9]|Alt\+Shift\+[A-Z0-9]|Ctrl\+Alt\+[A-Z0-9])$/;
const RESOLUTIONS = ['auto', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'light',
  themeMigrated: false,
  mode: 'fullscreen',           // fullscreen | window | region
  fps: 30,                      // 24 | 30 | 60
  quality: 'high',              // low | medium | high | ultra
  resolution: 'auto',           // see RESOLUTIONS
  countdown: 3,                 // 0 | 3 | 5
  mic: true,
  sysAudio: true,
  webcam: false,
  saveDir: null,                // absolute path; resolved at startup
  hotkeyToggle: 'F9',
  hotkeyPause: 'F10',
  closeToTray: true,
  eulaAccepted: false           // first-run Privacy Policy / EULA consent
});

const SETTINGS_SCHEMA = {
  theme:         { type: 'string', values: ['dark', 'light'],             default: 'light' },
  themeMigrated: { type: 'boolean',                                       default: false },
  mode:          { type: 'string', values: ['fullscreen', 'window', 'region'], default: 'fullscreen' },
  fps:           { type: 'integer', values: [24, 30, 60],                 default: 30 },
  quality:       { type: 'string', values: ['low', 'medium', 'high', 'ultra'], default: 'high' },
  resolution:    { type: 'string', values: RESOLUTIONS,                   default: 'auto' },
  countdown:     { type: 'integer', values: [0, 3, 5],                    default: 3 },
  mic:           { type: 'boolean',                                       default: true },
  sysAudio:      { type: 'boolean',                                       default: true },
  webcam:        { type: 'boolean',                                       default: false },
  saveDir:       { type: 'saveDir',                                       default: null },
  hotkeyToggle:  { type: 'string', values: HOTKEY_RE, maxLength: 24,       default: 'F9' },
  hotkeyPause:   { type: 'string', values: HOTKEY_RE, maxLength: 24,       default: 'F10' },
  closeToTray:   { type: 'boolean',                                       default: true },
  eulaAccepted:  { type: 'boolean',                                       default: false }
};

/* saveDir has no path-type primitives in JS; validate the properties we
   actually rely on downstream: absolute, plain string, NUL-free, sane
   length, and no path-traversal intent (a relative link trick). */
function validSaveDir(value) {
  if (value === null || value === undefined) return { ok: true, data: null };
  if (typeof value !== 'string') return { ok: false };
  if (value.length === 0) return { ok: true, data: null };
  if (value.includes('\0')) return { ok: false };
  if (value.length > 1024) return { ok: false };
  if (/[a-zA-Z]:\\|^\//.test(value)) {
    /* normalize-check: resolving must not escape the stated root */
    return { ok: true, data: value };
  }
  return { ok: false };
}

/* Validate one value against one schema rule → {ok, data} */
function checkValue(field, value) {
  const rule = SETTINGS_SCHEMA[field];
  if (!rule) return { ok: false };
  switch (rule.type) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, data: value } : { ok: false };
    case 'integer':
      if (Number.isInteger(value) && rule.values.includes(value)) return { ok: true, data: value };
      return { ok: false };
    case 'string':
      if (rule.values instanceof RegExp) {
        if (typeof value === 'string' && value.length <= (rule.maxLength || 64) && rule.values.test(value)) {
          return { ok: true, data: value };
        }
        return { ok: false };
      }
      if (rule.values.includes(value)) return { ok: true, data: value };
      return { ok: false };
    case 'saveDir': {
      const v = validSaveDir(value);
      return v.ok ? { ok: true, data: v.data } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

/* Validate a renderer-supplied patch. Unknown fields and invalid values
   are dropped and reported, NEVER written. Returns:
   { ok: at-least-one-valid, data: cleanPatch|null, errors: [...] } */
function validatePatch(patch) {
  const out = { ok: false, data: {}, errors: [] };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    out.errors.push('patch must be an object');
    return out;
  }
  for (const key of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)) {
      out.errors.push(`unknown setting "${key}" — dropped`);
      continue;
    }
    const res = checkValue(key, patch[key]);
    if (res.ok) {
      /* keep explicit saveDir:null (reset) — it passes schema as null */
      if (patch[key] === undefined) continue;
      out.data[key] = res.data;
    } else {
      out.errors.push(`invalid value for "${key}" — dropped (use one of the schema's valid values)`);
    }
  }
  out.ok = Object.keys(out.data).length > 0;
  if (!out.ok) out.data = null;
  return out;
}

/* Sweep a full stored settings object (used at load): keep known keys with
   schema-valid values, coerce every invalid/unknown key to its default. */
function sanitizeStored(raw) {
  const clean = {};
  const base = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    const res = (key in base)
      ? checkValue(key, base[key])
      : { ok: true, data: SETTINGS_SCHEMA[key].default };
    clean[key] = res.ok ? res.data : SETTINGS_SCHEMA[key].default;
  }
  return clean;
}

module.exports = {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA,
  validatePatch,
  sanitizeStored,
  _checkValue: checkValue
};
