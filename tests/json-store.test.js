'use strict';
/* Tests for lib/json-store.js — atomic writes, .bak rotation, and
   corrupt-file recovery must behave exactly as documented. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { createJsonStore } = require('../lib/json-store');

async function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rekzora-store-${name}-`));
  return path.join(dir, 'store.json');
}

test('set() writes valid JSON that a fresh store reads back', async () => {
  const file = await tmpdir('roundtrip');
  const s = createJsonStore({ file, defaults: { a: 1, b: 2 } });
  s.set({ a: 42 });
  assert.equal(s.get('a'), 42);
  const s2 = createJsonStore({ file, defaults: { a: 1, b: 2 } });
  assert.equal(s2.get('a'), 42);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).a, 42);
});

test('writes are atomic: no .tmp residue, no torn file', async () => {
  const file = await tmpdir('atomic');
  const s = createJsonStore({ file, defaults: {} });
  for (let i = 0; i < 25; i++) s.set({ [`k${i}`]: 'x'.repeat(64) });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(parsed).length, 25);
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'temp file must not linger');
});

test('corrupt primary is recovered from the .bak (never silent reset)', async () => {
  const file = await tmpdir('recover');
  const s = createJsonStore({
    file,
    defaults: { theme: 'light', fps: 30 },
    onError: () => {}
  });
  s.set({ theme: 'dark', fps: 60 });          // good state lands in primary + .bak
  fs.writeFileSync(file, '{"theme": "d', 'utf8'); // simulate corruption

  const errors = [];
  const s2 = createJsonStore({ file, defaults: { theme: 'light', fps: 30 }, onError: (m) => errors.push(m) });
  assert.equal(s2.get('theme'), 'dark', 'state must come back from backup');
  assert.equal(s2.get('fps'), 60);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('recovered'));
});

test('recovery must keep a VALID .bak (corrupt primary never overwrites it)', async () => {
  const file = await tmpdir('bak-intact');
  const s = createJsonStore({ file, defaults: { n: 1 }, onError: () => {} });
  s.set({ n: 10 });                            // .bak now holds {"n":1}; primary {"n":10}
  fs.writeFileSync(file, '%%%not json%%%', 'utf8');

  const s2 = createJsonStore({ file, defaults: { n: 1 }, onError: () => {} });
  assert.equal(s2.get('n'), 10, 'recovered from bak');
  s2.set({ n: 20 });                           // rotates: .bak = repaired {"n":10}

  /* corrupt the primary AGAIN: the backup must still be good */
  fs.writeFileSync(file, '@@@garble@@@', 'utf8');
  const errors = [];
  const s3 = createJsonStore({ file, defaults: { n: 1 }, onError: (m) => errors.push(m) });
  assert.equal(s3.get('n'), 10, 'second recovery stands on a backup that still parses');
});

test('corrupt primary and no valid backup → defaults, loud report, no crash', async () => {
  const file = await tmpdir('double-bad');
  const errors = [];
  const s = createJsonStore({
    file,
    defaults: { theme: 'light', fps: 30 },
    onError: (m) => errors.push(m)
  });
  assert.equal(s.get('theme'), 'light');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('defaults'), 'must confess the fallback');
  /* and it must be usable + writable afterwards */
  s.set({ fps: 24 });
  assert.equal(createJsonStore({ file, defaults: { theme: 'light', fps: 30 }, onError: () => {} }).get('fps'), 24);
});

test('remove() persists deletion (defaults-free store shape)', async () => {
  const file = await tmpdir('remove');
  const s = createJsonStore({ file, defaults: {} });
  s.set({ keep: true, drop: true });
  s.remove('drop');
  assert.equal(s.has('drop'), false);
  const s2 = createJsonStore({ file, defaults: {}, onError: () => {} });
  assert.equal(s2.has('drop'), false, 'removal must survive a reload');
  assert.equal(s2.get('keep'), true);
});

test('defaults-shaped store: removed defaults keys fall back to the default value', async () => {
  const file = await tmpdir('defaults-shape');
  const s = createJsonStore({ file, defaults: { theme: 'light' }, onError: () => {} });
  s.set({ theme: 'dark' });
  s.remove('theme');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).theme, undefined, 'file no longer carries the key');
  /* the settings contract: a key missing from the file yields the DEFAULT,
     not stale data — nothing was "resurrected" from the backup either */
  const s2 = createJsonStore({ file, defaults: { theme: 'light' }, onError: () => {} });
  assert.equal(s2.get('theme'), 'light');
});

test('unknown keys are sanitized away on load when defaults shape is given', async () => {
  const file = await tmpdir('sanitize');
  fs.writeFileSync(file, JSON.stringify({ legit: 5, sneaky: { hacky: true } }), 'utf8');
  const s = createJsonStore({ file, defaults: { legit: 1 }, onError: () => {} });
  assert.equal(s.get('legit'), 5);
  assert.equal('sneaky' in s.data, false);
});

test('explicit sanitize hook runs on load and repair', async () => {
  const file = await tmpdir('sanitize-hook');
  const sanitize = (raw) => (raw && typeof raw === 'object' ? { mode: raw.mode === 'region' ? 'region' : 'fullscreen' } : { mode: 'fullscreen' });
  const s = createJsonStore({ file, defaults: { mode: 'fullscreen' }, sanitize, onError: () => {} });
  s.set({ mode: 'region' });
  fs.writeFileSync(file, '((', 'utf8');
  const errors = [];
  const s2 = createJsonStore({ file, defaults: { mode: 'fullscreen' }, sanitize, onError: (m) => errors.push(m) });
  assert.equal(s2.get('mode'), 'region');
  assert.equal(errors.length, 1);
});

test('concurrent-looking writes keep one consistent final state', async () => {
  const file = await tmpdir('busy');
  const s = createJsonStore({ file, defaults: {} });
  const ops = [];
  for (let i = 0; i < 60; i++) ops.push(() => s.set({ [`r${i}`]: i }));
  ops.sort(() => 0.5 - Math.random()).forEach((op) => op());
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(parsed).length, 60);
  for (let i = 0; i < 60; i++) assert.equal(parsed[`r${i}`], i);
});

test('instance mutation is in-memory-live for sequential readers', async () => {
  const file = await tmpdir('liveness');
  const s = createJsonStore({ file, defaults: { n: 0 } });
  s.set({ n: 7 });
  const s2 = createJsonStore({ file, defaults: { n: 0 }, onError: () => {} });
  s2.set({ n: 9 });
  s.reload();
  assert.equal(s.get('n'), 9, 'reload() picks up file state changed by another store instance');
});
