'use strict';
/* ============================================================
   Rekzora — recording session registry (main process only)

   Owns the recording lifecycle trust boundary:
   - session IDs are generated here (crypto random, never by the renderer)
   - the temp file path is generated here and NEVER leaves this module
   - every session records the owning WebContents id + window role
   - an explicit state machine gates every operation

   This module deliberately imports nothing (no Electron, no Node crypto
   hard-wired) so it can be exercised by the regression test suite with a
   deterministic fake RNG.
   ============================================================ */

const STATE = Object.freeze({
  CREATED: 'CREATED',
  RECORDING: 'RECORDING',
  STOPPING: 'STOPPING',
  FINALIZING: 'FINALIZING',
  COMPLETED: 'COMPLETED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  DISCARDED: 'DISCARDED'
});

/* Legal transitions: [fromSet, toSet]. A state name → Set of allowed next states. */
const TRANSITIONS = Object.freeze({
  [STATE.CREATED]: new Set([STATE.RECORDING, STATE.DISCARDED, STATE.FAILED]),
  [STATE.RECORDING]: new Set([STATE.RECORDING, STATE.STOPPING, STATE.DISCARDED, STATE.FAILED]),
  [STATE.STOPPING]: new Set([STATE.FINALIZING, STATE.FAILED]),
  [STATE.FINALIZING]: new Set([STATE.COMPLETED, STATE.PARTIAL, STATE.FAILED]),
  [STATE.COMPLETED]: new Set([]),
  [STATE.PARTIAL]: new Set([]),
  [STATE.FAILED]: new Set([]),
  [STATE.DISCARDED]: new Set([])
});

const TERMINAL_STATES = new Set([
  STATE.COMPLETED, STATE.PARTIAL, STATE.FAILED, STATE.DISCARDED
]);

/* States that still accept chunk writes. STOPPING rejects NEW chunks on
   purpose (per §3.3 step 4 of the audit plan) — every chunk the renderer
   sends before calling finish() is already inside the main process at
   that point (dataavailable strictly precedes the recorder 'stop' event
   and the renderer awaits its write chain), so nothing is lost; anything
   arriving after that is either a bug or an attack, and is refused. */
const CHUNK_ACCEPTING_STATES = new Set([STATE.CREATED, STATE.RECORDING]);

const RECORDING_ID_RE = /^[0-9a-f]{32}$/;

/* honourable defaults, overridable via createRegistry() */
const DEFAULT_LIMITS = Object.freeze({
  maxSessions: 8,                 // concurrent live sessions across the app
  maxOwnerSessions: 4,            // concurrent live sessions per window
  maxChunkBytes: 64 * 1024 * 1024, // 64 MB — a 1 s chunk at 4K/Ultra is ~10 MB
  maxSessionBytes: 24 * 1024 * 1024 * 1024, // 24 GB total per session
  maxSessionChunks: 1_000_000,
  maxPendingWrites: 32            // a runaway renderer cannot flood the write queue
});

class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

function reject(code, message) { throw new RegistryError(code, message); }

/* --- payload validators (pure, reused by IPC layer + tests) --- */

function validateRecordingId(value) {
  if (typeof value !== 'string') reject('RECORDING_ID_TYPE', 'recordingId must be a string');
  if (!RECORDING_ID_RE.test(value)) reject('RECORDING_ID_FORMAT', 'recordingId is malformed');
  return value;
}

function validateChunkPayload(data, limits) {
  if (data === null || data === undefined) return Buffer.alloc(0);
  if (typeof data !== 'object') reject('CHUNK_BAD_TYPE', 'chunk must be an ArrayBuffer or typed array');
  let buf;
  if (Buffer.isBuffer(data)) {
    buf = data;
  } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    buf = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data.buffer ?? data);
    /* typed-array views may be offset/length-limited — re-extract precisely */
    if (ArrayBuffer.isView(data) && !(data instanceof Uint8Array)) {
      buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
  } else {
    reject('CHUNK_BAD_TYPE', 'chunk must be an ArrayBuffer or typed array');
  }
  const byteLen = buf.byteLength;
  if (!Number.isSafeInteger(byteLen) || byteLen < 0) {
    reject('CHUNK_BAD_SIZE', 'chunk has an invalid byte length');
  }
  if (byteLen > limits.maxChunkBytes) {
    reject('CHUNK_TOO_LARGE', `chunk exceeds ${limits.maxChunkBytes} bytes`);
  }
  return buf;
}

function validateString(value, maxLen, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') reject('META_BAD_TYPE', `${name} must be a string`);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (clean.length > maxLen) reject('META_TOO_LONG', `${name} exceeds ${maxLen} chars`);
  return clean;
}

/* metadata the renderer may attach to a finished recording — strict allowlist,
   strict shapes. Everything else is ignored (and never reaches the library). */
function validateFinishMeta(input) {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) reject('META_BAD_TYPE', 'meta must be an object');

  const num = (v, name) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) reject('META_BAD_TYPE', `${name} must be a number`);
    return v;
  };
  const bool = (v) => (v === undefined || v === null) ? false : v === true;
  const optObj = (v, name, keys) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) reject('META_BAD_TYPE', `${name} must be an object`);
    return keys.reduce((o, k) => ({ ...o, [k]: num(v[k], `${name}.${k}`) }), {});
  };

  const meta = {
    type: validateString(input.type, 40, 'type'),
    sourceName: validateString(input.sourceName, 200, 'sourceName'),
    fps: num(input.fps, 'fps'),
    quality: validateString(input.quality, 20, 'quality'),
    resolution: validateString(input.resolution, 20, 'resolution'),
    mic: bool(input.mic),
    systemAudio: bool(input.systemAudio),
    webcam: bool(input.webcam),
    region: optObj(input.region, 'region', ['x', 'y', 'w', 'h']),
    displayBounds: optObj(input.displayBounds, 'displayBounds', ['x', 'y', 'width', 'height'])
  };

  /* thumb: only a jpeg data URL from our own toDataURL pipeline, size-capped */
  if (typeof input.thumb === 'string' && input.thumb.length > 0) {
    if (!/^data:image\/jpeg;base64,/.test(input.thumb)) {
      reject('META_BAD_THUMB', 'thumb must be a jpeg data URL');
    }
    if (input.thumb.length > 512 * 1024) reject('META_THUMB_TOO_LARGE', 'thumb exceeds 512 KB');
    meta.thumb = input.thumb;
  } else {
    meta.thumb = null;
  }

  /* durationMs: renderer may lie a little, must stay in a sane envelope */
  if (typeof input.durationMs !== 'undefined') {
    const d = input.durationMs;
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0 || d > 48 * 60 * 60 * 1000) {
      reject('META_BAD_DURATION', 'durationMs out of range');
    }
    meta.durationMs = Math.round(d);
  } else {
    meta.durationMs = 0;
  }

  return meta;
}

/* --- registry --- */

function createRegistry(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const randomBytes = options.randomBytes || (() => {
    const { randomBytes: rb } = require('node:crypto');
    return rb(16);
  });

  const sessions = new Map();     // recordingId → session
  const byOwner = new Map();      // wcId → Set(recordingId)

  function nextId() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = randomBytes().toString('hex');
      if (!sessions.has(id)) return id;
    }
    reject('SESSION_ID_EXHAUSTED', 'could not allocate a unique recording id');
  }

  function create({ wcId, role, tempDir = null, now = Date.now() }) {
    if (!Number.isInteger(wcId)) reject('OWNER_MISSING', 'owner WebContents id missing');
    if (typeof role !== 'string' || !role) reject('ROLE_MISSING', 'owner window role missing');

    const liveByOwner = [...(byOwner.get(wcId) || [])].filter(
      (id) => !TERMINAL_STATES.has(sessions.get(id).state)
    ).length;
    if (liveByOwner >= limits.maxOwnerSessions) {
      reject('TOO_MANY_SESSIONS', `owner already has ${liveByOwner} live recording sessions`);
    }
    const liveTotal = [...sessions.values()].filter((s) => !TERMINAL_STATES.has(s.state)).length;
    if (liveTotal >= limits.maxSessions) {
      reject('TOO_MANY_SESSIONS', `registry already holds ${liveTotal} live sessions`);
    }

    const id = nextId();
    const session = {
      recordingId: id,
      ownerWcId: wcId,
      role,
      state: STATE.CREATED,
      createdAt: now,
      startedAt: null,
      bytes: 0,
      chunks: 0,
      writeErrors: 0,
      pendingWrites: 0,
      finalization: null,   // filled by main.js at finish
      endedAt: null,
      lastWriteAt: null
    };
    /* internal temp path kept in a closure so nothing can read it via the
       session object; main.js asks for it with an explicit accessor only
       when it actually needs to touch the disk. */
    let tempTarget = options.makeTempTarget
      ? options.makeTempTarget(id)
      : (tempDir ? require('node:path').join(tempDir, `rec-${id}.webm`) : null);
    Object.defineProperty(session, 'tempTarget', {
      get: () => tempTarget,
      enumerable: false,
      configurable: false
    });

    sessions.set(id, session);
    if (!byOwner.has(wcId)) byOwner.set(wcId, new Set());
    byOwner.get(wcId).add(id);
    emit('created', session, null);
    return session;
  }

  function emit(kind, session, prev) {
    if (typeof options.onEvent === 'function') {
      try { options.onEvent(kind, session, prev); } catch { /* listener errors must not break the registry */ }
    }
  }

  /* atomic transition: state check + assignment happen in one synchronous
     turn, so concurrent IPC handler invocations cannot interleave. */
  function transit(session, to, allowSelfTransition = false) {
    const allowed = TRANSITIONS[session.state];
    if (!allowed) reject('STATE_UNKNOWN', `unknown session state ${session.state}`);
    if (session.state === to) {
      if (allowSelfTransition) return session;
      reject('STATE_ILLEGAL', `session already in ${to}`);
    }
    if (!allowed.has(to)) {
      reject('STATE_ILLEGAL', `cannot move from ${session.state} to ${to}`);
    }
    const prev = session.state;
    session.state = to;
    if (to === STATE.RECORDING && !session.startedAt) session.startedAt = Date.now();
    if (TERMINAL_STATES.has(to)) session.endedAt = Date.now();
    emit('state', session, prev);
    return session;
  }

  /* ownership check used by every privileged channel */
  function authorize(id, senderInfo) {
    validateRecordingId(id);
    const session = sessions.get(id);
    if (!session) reject('SESSION_NOT_FOUND', 'no such recording session');
    const { wcId, role } = senderInfo || {};
    if (Number.isInteger(wcId) && session.ownerWcId !== wcId) {
      reject('OWNER_MISMATCH', 'session belongs to another window');
    }
    if (role && session.role !== role) {
      reject('ROLE_MISMATCH', 'window role is not authorized for this session');
    }
    return session;
  }

  /* chunk acceptance: CREATED auto-promotes to RECORDING, then bounds are enforced */
  function acceptChunk(id, senderInfo, data) {
    const session = authorize(id, senderInfo);
    if (!CHUNK_ACCEPTING_STATES.has(session.state)) {
      reject('CHUNK_STATE', `chunks not accepted in state ${session.state}`);
    }
    if (session.pendingWrites >= limits.maxPendingWrites) {
      reject('TOO_MANY_PENDING', 'too many chunk writes still in flight');
    }
    const validated = validateChunkPayload(data, limits);
    const byteLen = validated === null ? 0 : (validated.byteLength ?? validated.size ?? 0);
    if (session.bytes + byteLen > limits.maxSessionBytes) {
      reject('SESSION_TOO_LARGE', 'recording exceeds the maximum tracked size');
    }
    if (session.chunks >= limits.maxSessionChunks) {
      reject('TOO_MANY_CHUNKS', 'recording exceeds the maximum chunk count');
    }
    if (session.state === STATE.CREATED) transit(session, STATE.RECORDING, true);
    session.pendingWrites += 1;
    return { session, data: validated };
  }

  function recordChunkResult(id, { size = 0, failed = false } = {}) {
    const session = sessions.get(id);
    if (!session) return null;
    session.pendingWrites = Math.max(0, session.pendingWrites - 1);
    if (failed) {
      session.writeErrors += 1;
    } else {
      session.bytes += size;
      session.chunks += 1;
      session.lastWriteAt = Date.now();
    }
    emit('write', session, null);
    return session;
  }

  function notePartialWriteFailure(id) {
    const session = sessions.get(id);
    if (session) session.writeErrors += 1;
    return session;
  }

  /* finish authorization: session must be live, must belong to the caller */
  function authorizeFinish(id, senderInfo) {
    const session = authorize(id, senderInfo);
    if (TERMINAL_STATES.has(session.state)) {
      reject('STATE_ILLEGAL', `session already terminal (${session.state})`);
    }
    if (session.state === STATE.FINALIZING) {
      reject('CHUNK_STATE', 'finalization already started');
    }
    return session;
  }

  function authorizeDiscard(id, senderInfo) {
    const session = authorize(id, senderInfo);
    if (TERMINAL_STATES.has(session.state)) {
      reject('STATE_ILLEGAL', `session already terminal (${session.state})`);
    }
    if (session.state === STATE.FINALIZING) {
      reject('CHUNK_STATE', 'finalization already started');
    }
    if (session.state === STATE.STOPPING) {
      reject('CHUNK_STATE', 'session is being stopped — discard refused');
    }
    transit(session, STATE.DISCARDED); // legal from CREATED and RECORDING
    return session;
  }

  function dropFromOwnerIndex(session) {
    const set = byOwner.get(session.ownerWcId);
    if (set) {
      set.delete(session.recordingId);
      if (!set.size) byOwner.delete(session.ownerWcId);
    }
  }

  function forget(id) {
    const session = sessions.get(id);
    if (!session) return null;
    if (!TERMINAL_STATES.has(session.state)) {
      reject('STATE_ILLEGAL', 'cannot forget a live session');
    }
    sessions.delete(id);
    dropFromOwnerIndex(session);
    return session;
  }

  function get(id) { return sessions.get(validateRecordingId(id)) || null; }
  function liveCount() { return [...sessions.values()].filter((s) => !TERMINAL_STATES.has(s.state)).length; }
  function forOwner(wcId) {
    const set = byOwner.get(wcId);
    return set ? [...set].map((id) => sessions.get(id)) : [];
  }
  function all() { return [...sessions.values()]; }

  return {
    STATE, TERMINAL_STATES,
    limits,
    create, transit, authorize, acceptChunk, recordChunkResult,
    notePartialWriteFailure, authorizeFinish, authorizeDiscard,
    forget, get, liveCount, forOwner, all,
    RegistryError
  };
}

module.exports = {
  STATE, TRANSITIONS, TERMINAL_STATES, CHUNK_ACCEPTING_STATES,
  RECORDING_ID_RE, DEFAULT_LIMITS, RegistryError,
  validateRecordingId, validateChunkPayload, validateFinishMeta,
  createRegistry
};