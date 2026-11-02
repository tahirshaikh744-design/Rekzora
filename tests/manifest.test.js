'use strict';
/* Regression tests — crash-recovery manifest store (audit §6.1).
   Atomic writes, corruption tolerance, listing, and quit-time flush. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createManifestStore, sanitizeManifest, manifestFileName, SCHEMA_VERSION } = require('../lib/manifest');

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rekzora-manifest-'));
  return d;
}

test('save/load round-trip writes one JSON file with the schema', async () => {
  const dir = tmpdir();
  const store = createManifestStore({ dir });
  const id = 'a'.repeat(32);
  await store.saveNow(id, { sessionId: id, tempFileName: `rec-${id}.webm`, state: 'RECORDING', bytesCommitted: 100 });
  const file = path.join(dir, manifestFileName(id));
  assert.ok(fs.existsSync(file));
  const loaded = await store.load(id);
  assert.ok(loaded);
  assert.strictEqual(loaded.sessionId, id);
  assert.strictEqual(loaded.v, SCHEMA_VERSION);
  assert.strictEqual(loaded.bytesCommitted, 100);
  assert.strictEqual(loaded.finalization, 'pending');
});

test('atomic write leaves no temp residue on success', async () => {
  const dir = tmpdir();
  const store = createManifestStore({ dir });
  const id = 'b'.repeat(32);
  await store.saveNow(id, { sessionId: id, tempFileName: `rec-${id}.webm`, state: 'STOPPING' });
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

test('corrupt manifest is treated as absent (startup must not crash)', async () => {
  const dir = tmpdir();
  const id = 'c'.repeat(32);
  fs.writeFileSync(path.join(dir, manifestFileName(id)), '{ not json', 'utf8');
  const store = createManifestStore({ dir });
  assert.strictEqual(await store.load(id), null);
  const all = await store.listAll();
  assert.deepStrictEqual(all, [], 'corrupt manifests are skipped, not surfaced');
});

test('foreign/v0/renamed manifests rejected by sanitizer', () => {
  assert.strictEqual(sanitizeManifest({ v: 0 }, 'x'.repeat(32)), null);
  assert.strictEqual(sanitizeManifest({ v: SCHEMA_VERSION, sessionId: 'other' }, 'x'.repeat(32)), null);
  assert.strictEqual(sanitizeManifest({ v: SCHEMA_VERSION, sessionId: 'x'.repeat(32), tempFileName: 'a\\b' }, 'x'.repeat(32)), null);
  assert.strictEqual(sanitizeManifest(null, 'x'.repeat(32)), null);
  const ok = sanitizeManifest({ v: SCHEMA_VERSION, sessionId: 'x'.repeat(32), tempFileName: 'rec-x.webm', chunksCommitted: -5 }, 'x'.repeat(32));
  assert.strictEqual(ok.chunksCommitted, 0, 'negative numbers normalize to defaults');
});

test('listAll returns only valid manifests', async () => {
  const dir = tmpdir();
  const store = createManifestStore({ dir });
  const a = '1'.repeat(32), b = '2'.repeat(32);
  await store.saveNow(a, { sessionId: a, tempFileName: `rec-a.webm`, state: 'RECORDING' });
  await store.saveNow(b, { sessionId: b, tempFileName: `rec-b.webm`, state: 'RECORDING' });
  fs.writeFileSync(path.join(dir, 'notahexname.json'), '{}');                 // ignored (bad name)
  fs.writeFileSync(path.join(dir, `${a.slice(0, 4)}.json`), '{}');             // ignored (bad name)
  const all = await store.listAll();
  assert.strictEqual(all.length, 2);
  const ids = all.map((m) => m.sessionId).sort();
  assert.deepStrictEqual(ids, [a, b].sort());
});

test('remove deletes the manifest and is idempotent', async () => {
  const dir = tmpdir();
  const store = createManifestStore({ dir });
  const id = 'f'.repeat(32);
  await store.saveNow(id, { sessionId: id, tempFileName: `rec-${id}.webm`, state: 'FAILED', finalization: 'failed' });
  assert.notStrictEqual(await store.load(id), null);
  await store.remove(id);
  assert.strictEqual(await store.load(id), null);
  await store.remove(id); // no throw
});

test('debounced save flushes on quit via flushPending', async () => {
  const dir = tmpdir();
  const store = createManifestStore({ dir });
  const id = '9'.repeat(32);
  /* no await: the write is debounced 50 ms out — flushPending must still land it */
  store.save(id, { sessionId: id, tempFileName: `rec-${id}.webm`, state: 'RECORDING', bytesCommitted: 5 }, { debounceMs: 50_000 });
  assert.strictEqual(await store.load(id), null);
  await store.flushPending();
  const m = await store.load(id);
  assert.ok(m && m.bytesCommitted === 5);
});

test('an invalid session id is refused loudly', async () => {
  const dir = tmpdir();
  const store = createManifestStore({ dir });
  await assert.rejects(() => store.saveNow('../../etc/passwd', {}), /invalid session id/);
  await assert.rejects(() => store.saveNow('NOTHEX' + 'x'.repeat(26), {}), /invalid session id/);
});
