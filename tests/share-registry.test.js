'use strict';
/* Regression tests — Rekzora share launch registry (audit §4.4).
   The renderer API is {appId, recordingId}; executable identity is owned
   by the main process. These tests prove the ids/payloads are the whole
   renderer surface. */
const test = require('node:test');
const assert = require('node:assert');
const {
  KNOWN_APP_IDS, ShareError, isPlausibleExecutable,
  validateLibraryId, createShareLauncher
} = require('../lib/share-registry');

function makeLauncher(overrides = {}) {
  const spawned = [];
  const apps = overrides.apps || [
    { id: 'quickshare', exe: 'C:\\Program Files\\Google\\Quick Share\\quickshare.exe', args: [] },
    { id: 'telegram', exe: 'C:\\Program Files\\Telegram\\Telegram.exe' }
  ];
  const launcher = createShareLauncher({
    listApps: () => apps,
    resolveApp: (id) => apps.find((a) => a.id === id) || null,
    recordingPath: (id) => (id === 'r_validid12345' ? 'C:\\Users\\me\\Videos\\Rekzora Recordings\\A.webm' : null),
    spawn: (exe, argv, opts) => { spawned.push({ exe, argv, opts }); return { unref() {} }; },
    ...overrides
  });
  return { launcher, spawned };
}

test('all six built-in app ids are known', () => {
  assert.deepStrictEqual([...KNOWN_APP_IDS].sort(), [
    'localsend', 'quickshare', 'sendanywhere', 'shareit', 'telegram', 'xender'
  ].sort());
});

test('library id format is enforced (no paths, no traversal)', () => {
  assert.strictEqual(validateLibraryId('r_validid12345'), 'r_validid12345');
  assert.throws(() => validateLibraryId('C:\\Videos\\x.webm'), ShareError);
  assert.throws(() => validateLibraryId('../secret'), ShareError);
  assert.throws(() => validateLibraryId('r_SHORT'), ShareError);
  assert.throws(() => validateLibraryId(42), ShareError);
  assert.throws(() => validateLibraryId('r_validid1234; del /f'), ShareError);
});

test('unknown app id rejected; argv injection impossible', async () => {
  const { launcher, spawned } = makeLauncher();
  await assert.rejects(
    () => launcher.launch({ appId: 'calc', recordingId: 'r_validid12345' }),
    /unknown share application id/i
  );
  assert.strictEqual(spawned.length, 0, 'nothing may spawn for unknown apps');
});

test('extra exe/args fields in the payload are ignored (registry is the only source)', async () => {
  const { launcher, spawned } = makeLauncher();
  const res = await launcher.launch({
    appId: 'quickshare', recordingId: 'r_validid12345',
    exe: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'del *']
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(spawned.length, 1);
  /* argv must come from the registry, never from the payload */
  assert.strictEqual(spawned[0].exe, 'C:\\Program Files\\Google\\Quick Share\\quickshare.exe');
  assert.deepStrictEqual(
    spawned[0].argv.filter((a) => a !== 'C:\\Users\\me\\Videos\\Rekzora Recordings\\A.webm'),
    [], 'payload-supplied arguments must not reach spawn'
  );
  assert.strictEqual(spawned[0].opts.shell, false);
});

test('uninstalled/undetected app refused gracefully', async () => {
  const { launcher, spawned } = makeLauncher({ apps: [] });
  await assert.rejects(
    () => launcher.launch({ appId: 'shareit', recordingId: 'r_validid12345' }),
    /not installed/i
  );
  assert.strictEqual(spawned.length, 0);
});

test('recording must be a known library record', async () => {
  const { launcher, spawned } = makeLauncher();
  await assert.rejects(() => launcher.launch({ appId: 'quickshare', recordingId: 'r_ffffffffffff' }), /not in the library/i);
  await assert.rejects(() => launcher.launch({ appId: 'quickshare', recordingId: undefined }), /recordingId/);
  assert.strictEqual(spawned.length, 0);
  /* happy path: exact planned argv, shell never involved */
  const res = await launcher.launch({ appId: 'quickshare', recordingId: 'r_validid12345' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].exe, 'C:\\Program Files\\Google\\Quick Share\\quickshare.exe');
  assert.deepStrictEqual(spawned[0].argv, ['C:\\Users\\me\\Videos\\Rekzora Recordings\\A.webm']);
  assert.strictEqual(spawned[0].opts.shell, false, 'spawn must never go through a shell');
  assert.strictEqual(spawned[0].opts.detached, true);
});

test('telegram send-verb policy preserved through the registry', async () => {
  const { launcher, spawned } = makeLauncher();
  await launcher.launch({ appId: 'telegram', recordingId: 'r_validid12345' });
  assert.deepStrictEqual(spawned[0].argv, ['send', 'C:\\Users\\me\\Videos\\Rekzora Recordings\\A.webm']);
});

test('spawn failure surfaces as SPAWN_FAILED, not a hang or fake success', async () => {
  const launcher = createShareLauncher({
    listApps: () => [],
    resolveApp: () => ({ id: 'quickshare', exe: 'C:\\x\\quickshare.exe' }),
    recordingPath: () => 'C:\\V\\A.webm',
    spawn: () => { throw new Error('EACCES'); }
  });
  await assert.rejects(
    () => launcher.launch({ appId: 'quickshare', recordingId: 'r_validid12345' }),
    /could not start/i
  );
});

test('isPlausibleExecutable rejects non-exe / newline / embedded-null strings', () => {
  assert.strictEqual(isPlausibleExecutable('C:\\a\\b.exe'), true);
  assert.strictEqual(isPlausibleExecutable('C:\\a\\b.exe " && README.md'), false); // .exe$ with trailing argument — actually fails
  assert.strictEqual(isPlausibleExecutable('C:\\a\\b.txt'), false);
  assert.strictEqual(isPlausibleExecutable(''), false);
  assert.strictEqual(isPlausibleExecutable(null), false);
  assert.strictEqual(isPlausibleExecutable('line1\nline2.exe'), false);
  assert.strictEqual(isPlausibleExecutable('x.exe\u0000'), false);
  assert.strictEqual(isPlausibleExecutable('C:\\a\\B.EXE'), true); // case-insensitive ext
});
