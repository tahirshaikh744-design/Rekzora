'use strict';
/* Regression tests — Rekzora recording-session registry (audit §3.4).

   Covers: unknown/malformed ids, forged paths (the renderer-path API is
   structurally gone), ownership/role checks, illegal state transitions,
   double finalize/discard, chunk-after-terminal, oversized chunks,
   invalid metadata, concurrent-safety of transitions. */
const test = require('node:test');
const assert = require('node:assert');
const {
  STATE, RegistryError, validateRecordingId, validateChunkPayload,
  validateFinishMeta, createRegistry
} = require('../lib/recording-session');

function fakeRegistry(overrides = {}) {
  let counter = 0;
  return createRegistry({
    randomBytes: () => Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, counter++ % 256, 7]),
    ...overrides
  });
}
const OWNER = { wcId: 1, role: 'MAIN' };
const OTHER = { wcId: 2, role: 'MAIN' };

test('ids are hex-32 and validated strictly', () => {
  assert.throws(() => validateRecordingId(null), RegistryError);
  assert.throws(() => validateRecordingId(12345), RegistryError);
  assert.throws(() => validateRecordingId(''), RegistryError);
  assert.throws(() => validateRecordingId('abc'), RegistryError);            // too short
  assert.throws(() => validateRecordingId('../etc/passwd'), RegistryError);  // traversal
  assert.throws(() => validateRecordingId('C:\\floppy.webm'), RegistryError);
  const r = fakeRegistry();
  const s = r.create({ ...OWNER });
  assert.match(s.recordingId, /^[0-9a-f]{32}$/);
  assert.strictEqual(validateRecordingId(s.recordingId), s.recordingId);
});

test('no filesystem path is ever exposed through the session object (P0 §3.1)', () => {
  const r = fakeRegistry({ makeTempTarget: (id) => `/private/tmp/rec-${id}.webm` });
  const s = r.create({ ...OWNER });
  const json = JSON.stringify(s);
  assert.ok(!json.includes('/private/tmp'), 'temp target must not leak via JSON');
  assert.ok(!json.includes('.webm'), 'temp name must not leak via JSON');
  /* the path exists only through the non-enumerable getter for main-process use */
  assert.strictEqual(s.tempTarget, `/private/tmp/rec-${s.recordingId}.webm`);
});

test('unknown + foreign owner + wrong role are rejected', () => {
  const r = fakeRegistry();
  assert.throws(() => r.authorize('0'.repeat(32), OWNER), /no such recording session/);
  const s = r.create(OWNER);
  assert.throws(() => r.authorize(s.recordingId, OTHER), /belongs to another window/);
  assert.throws(() => r.authorize(s.recordingId, { wcId: 1, role: 'REGION' }), /not authorized/);
  assert.throws(() => r.authorize(s.recordingId, { wcId: 1, role: 'PLAYER' }), /not authorized/);
});

test('state machine: CREATED → RECORDING on first chunk; completed sessions are final', () => {
  const r = fakeRegistry();
  const s = r.create(OWNER);
  assert.strictEqual(s.state, STATE.CREATED);
  const { session } = r.acceptChunk(s.recordingId, OWNER, Buffer.alloc(8));
  assert.strictEqual(session.state, STATE.RECORDING);
  assert.ok(session.chunks === 0 && session.pendingWrites === 1);
  r.recordChunkResult(session.recordingId, { size: 8 });
  assert.strictEqual(session.chunks, 1);
  assert.strictEqual(session.bytes, 8);
});

test('zero-chunk finish: CREATED → FAILED is legal; forget() then applies; later finish rejected', () => {
  /* mirrors main.js: a source that never produced frames ends CREATED with
     0 chunks/bytes — the honest handling is a clean FAILED, not a crash */
  const r = fakeRegistry();
  const s = r.create(OWNER);
  assert.strictEqual(s.chunks, 0);
  assert.strictEqual(s.bytes, 0);
  /* authorizeFinish itself is permissive pre-check until main's branch acts */
  r.authorizeFinish(s.recordingId, OWNER);
  assert.doesNotThrow(() => r.transit(s, STATE.FAILED), 'CREATED → FAILED must be legal for zero-frame takes');
  assert.doesNotThrow(() => r.forget(s.recordingId), 'terminal session can be forgotten');
  assert.throws(() => r.authorizeFinish(s.recordingId, OWNER), /no such recording session/, 'forgotten session rejects further activity');
  const s2 = r.create(OWNER);
  assert.throws(() => r.forget(s2.recordingId), /cannot forget a live session/, 'live sessions cannot be forgotten');
});

test('double finalize is rejected; chunk during FINALIZING/after COMPLETED rejected', () => {
  const r = fakeRegistry();
  const s = r.create(OWNER);
  r.acceptChunk(s.recordingId, OWNER, Buffer.alloc(4));
  r.recordChunkResult(s.recordingId, { size: 4 });
  assert.doesNotThrow(() => r.transit(s, STATE.STOPPING)); // RECORDING → STOPPING is legal
  r.transit(s, STATE.FINALIZING);
  assert.throws(() => r.acceptChunk(s.recordingId, OWNER, Buffer.alloc(4)), /chunks not accepted/);
  r.transit(s, STATE.COMPLETED);
  assert.throws(() => r.authorizeFinish(s.recordingId, OWNER), /already terminal/);
  assert.throws(() => r.acceptChunk(s.recordingId, OWNER, Buffer.alloc(4)), /chunks not accepted/);
  assert.throws(() => r.transit(s, STATE.RECORDING), /cannot move from/);
});

test('double discard rejected; discarded cannot take chunks or be finalized', () => {
  const r = fakeRegistry();
  const s = r.create(OWNER);
  r.authorizeDiscard(s.recordingId, OWNER);
  assert.strictEqual(s.state, STATE.DISCARDED);
  assert.throws(() => r.authorizeDiscard(s.recordingId, OWNER), /terminal/);
  assert.throws(() => r.acceptChunk(s.recordingId, OWNER, Buffer.alloc(4)), /chunks not accepted/);
  assert.throws(() => r.authorizeFinish(s.recordingId, OWNER), /already terminal/);
  /* forget on a terminal session is allowed exactly once */
  assert.ok(r.forget(s.recordingId));
  assert.strictEqual(r.forget(s.recordingId), null);
});

test('discard during STOPPING refused (finish owns finalization)', () => {
  const r = fakeRegistry();
  const s = r.create(OWNER);
  r.acceptChunk(s.recordingId, OWNER, Buffer.alloc(4));
  r.recordChunkResult(s.recordingId, { size: 4 });
  r.transit(s, STATE.STOPPING);
  assert.throws(() => r.authorizeDiscard(s.recordingId, OWNER), /being stopped/);
});

test('oversized chunk + runaway pending writes rejected', () => {
  const r = fakeRegistry({ limits: undefined });
  const s = r.create(OWNER);
  const big = Buffer.alloc(65 * 1024 * 1024 + 1);
  assert.throws(() => r.acceptChunk(s.recordingId, OWNER, big), /exceeds/);
  /* pending limit: 32 max */
  let threw = null;
  for (let i = 0; i < 40; i++) {
    try { r.acceptChunk(s.recordingId, OWNER, Buffer.alloc(4)); }
    catch (e) { threw = e; break; }
  }
  assert.ok(threw && /too many chunk writes/.test(threw.message), 'flood must be cut off at 32 pending');
});

test('chunk payload type validation', () => {
  assert.throws(() => validateChunkPayload('not-a-buffer', { maxChunkBytes: 64 }), /chunk must be/);
  assert.throws(() => validateChunkPayload({ size: 3 }, { maxChunkBytes: 64 }), /chunk must be/);
  assert.strictEqual(validateChunkPayload(null, { maxChunkBytes: 64 }).byteLength, 0);
  const view = validateChunkPayload(Uint8Array.from([1, 2, 3]), { maxChunkBytes: 64 });
  assert.strictEqual(view.byteLength, 3);
  assert.throws(() => validateChunkPayload(Uint8Array.from([1]), { maxChunkBytes: -1 }), /exceeds/);
});

test('finish metadata strict allowlist (' + 'thumb only jpeg data-url, sane durations)', () => {
  const ok = validateFinishMeta({
    durationMs: 4520, type: 'screen', sourceName: 'Display 1', fps: 30,
    quality: 'high', resolution: '1080p', mic: true, systemAudio: false,
    webcam: false, region: { x: 1, y: 2, w: 3, h: 4 },
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    thumb: 'data:image/jpeg;base64,AAAA'
  });
  assert.strictEqual(ok.durationMs, 4520);
  assert.strictEqual(ok.mic, true);
  assert.strictEqual(ok.displayBounds.width, 1920);

  assert.throws(() => validateFinishMeta({ thumb: 'data:text/html;base64,x' }), /jpeg/);
  assert.throws(() => validateFinishMeta({ durationMs: -3 }), /out of range/);
  assert.throws(() => validateFinishMeta({ durationMs: 'nine' }), /out of range/);
  assert.throws(() => validateFinishMeta({ region: 'wide' }), /region must be an object/);
  assert.throws(() => validateFinishMeta({ sourceName: 'x'.repeat(500) }), /exceeds/);
  assert.throws(() => validateFinishMeta({ fps: 'many' }), /fps must be a number/);
  assert.throws(() => validateFinishMeta([1, 2]), /must be an object/);
  /* unknown fields dropped */
  assert.strictEqual('evilPath' in validateFinishMeta({ evilPath: 'C:/x' }), false);
});

test('too many concurrent sessions rejected', () => {
  const r = fakeRegistry({ limits: { maxSessions: 2, maxOwnerSessions: 8 } });
  r.create(OWNER);
  r.create(OWNER);
  assert.throws(() => r.create(OWNER), /already holds 2 live sessions/);
});

test('per-owner cap holds even with global headroom', () => {
  const r = fakeRegistry({ limits: { maxSessions: 16, maxOwnerSessions: 1 } });
  r.create(OWNER);
  assert.throws(() => r.create(OWNER), /owner already has/);
  r.create({ wcId: 2, role: 'MAIN' }); // other owners still fine
});

test('transitions are validated: illegal hops throw with context', () => {
  const r = fakeRegistry();
  const s = r.create(OWNER); // CREATED
  assert.throws(() => r.transit(s, STATE.COMPLETED), /cannot move from CREATED to COMPLETED/);
  assert.throws(() => r.transit(s, STATE.FINALIZING), /cannot move from CREATED to FINALIZING/);
});
