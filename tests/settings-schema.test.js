'use strict';
/* Tests for lib/settings-schema.js — renderer-supplied settings patches
   must be schema-checked, coerced, and stripped of unknown keys. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { SETTINGS_SCHEMA, validatePatch, sanitizeStored } = require('../lib/settings-schema');

test('schema covers every default key', () => {
  for (const k of Object.keys(SETTINGS_SCHEMA)) assert.ok('default' in SETTINGS_SCHEMA[k], k);
});

test('valid patch passes through unchanged', () => {
  const res = validatePatch({ fps: 60, quality: 'ultra', closeToTray: false });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { fps: 60, quality: 'ultra', closeToTray: false });
  assert.deepEqual(res.errors, []);
});

test('unknown keys are dropped and reported', () => {
  const res = validatePatch({ fps: 24, saveDir: 'C:\\tmp', evil: __filename, __proto__: {} });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { fps: 24, saveDir: 'C:\\tmp' });
  assert.ok(res.errors.some((e) => e.includes('"evil"')));
  assert.ok(res.errors.length >= 1);
});

test('wrong-typed values coerce to nothing — never stored', () => {
  const res = validatePatch({ fps: 'banana', countdown: -1, quality: 42, mic: 'true' });
  assert.equal(res.ok, false);
  assert.equal(res.data, null);
  assert.ok(res.errors.filter((e) => e.includes('invalid value')).length >= 4);
});

test('enum validation matches the shipped domains', () => {
  assert.equal(validatePatch({ theme: 'dark' }).ok, true);
  assert.equal(validatePatch({ theme: 'chartreuse' }).ok, false);
  assert.equal(validatePatch({ resolution: '1080p' }).ok, true);
  assert.equal(validatePatch({ resolution: '999p' }).ok, false);
  assert.equal(validatePatch({ mode: 'region' }).ok, true);
  assert.equal(validatePatch({ countdown: 5 }).ok, true);
  assert.equal(validatePatch({ countdown: 7 }).ok, false);
});

test('hotkeys accept function keys only', () => {
  assert.equal(validatePatch({ hotkeyToggle: 'F12' }).ok, true);
  assert.equal(validatePatch({ hotkeyPause: 'F10' }).ok, true);
  assert.equal(validatePatch({ hotkeyToggle: 'foo(bar' }).ok, false);
  assert.equal(validatePatch({ hotkeyToggle: '' }).ok, false);
  assert.equal(validatePatch({ hotkeyPause: 'Ctrl+Shift+R' }).ok, true);
});

test('saveDir accepts absolute paths, resets, and rejects junk', () => {
  assert.equal(validatePatch({ saveDir: null }).ok, true);
  /* empty string normalizes to "unset" (null) per the schema contract */
  assert.equal(validatePatch({ saveDir: '' }).ok, true);
  assert.deepEqual(validatePatch({ saveDir: '' }).data, { saveDir: null });
  assert.equal(validatePatch({ saveDir: 'C:\\Users\\x\\Videos' }).ok, true);
  assert.equal(validatePatch({ saveDir: 'C:\\bad\0path' }).ok, false);
  assert.equal(validatePatch({ saveDir: 12345 }).ok, false);
  assert.equal(validatePatch({ saveDir: 'relative/path' }).ok, false);
});

test('booleans are strict', () => {
  assert.equal(validatePatch({ eulaAccepted: true }).ok, true);
  assert.equal(validatePatch({ eulaAccepted: 1 }).ok, false);
  assert.equal(validatePatch({ themeMigrated: 'yes' }).ok, false);
});

test('sanitizeStored rebuilds a full valid defaults object', () => {
  const dirty = {
    theme: 'dark',                 // keep
    fps: 999,                      // invalid → default 30
    quality: 'nope',               // → 'high'
    madeUpKey: true,               // unknown → dropped
    countdown: 0,                  // keep (valid)
    saveDir: 'D:\\Recordings'
  };
  const clean = sanitizeStored(dirty);
  assert.equal(clean.theme, 'dark');
  assert.equal(clean.fps, 30);
  assert.equal(clean.quality, 'high');
  assert.equal(clean.countdown, 0);
  assert.equal(clean.saveDir, 'D:\\Recordings');
  assert.equal('madeUpKey' in clean, false);
  /* every known key present with the correct type */
  for (const k of Object.keys(SETTINGS_SCHEMA)) assert.ok(k in clean, k);
});

test('sanitizeStored survives non-object junk', () => {
  assert.equal(sanitizeStored(null).theme, 'light');
  assert.equal(sanitizeStored('junk').fps, 30);
  assert.deepEqual(sanitizeStored([]).quality, 'high');
});
