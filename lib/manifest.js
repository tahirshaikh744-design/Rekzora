'use strict';
/* ============================================================
   Rekzora — crash recovery manifest store (main process only)

   One small JSON manifest per live recording session, describing the
   temporary media file so a future launch can offer genuine recovery
   instead of silently deleting the footage.

   Writes are atomic (temp file + rename within the same directory),
   failure-safe, and cheap: callers decide *when* to write (thresholds,
   not per-chunk).
   ============================================================ */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;

function newManifest(fields) {
  const now = Date.now();
  return {
    v: SCHEMA_VERSION,
    sessionId: fields.sessionId,            // opaque, renderer never holds it
    startTime: fields.startTime ?? now,
    lastWriteAt: fields.lastWriteAt ?? now,
    tempFileName: fields.tempFileName,      // base name only — no absolute paths
    state: fields.state || 'RECORDING',
    videoInfo: fields.videoInfo || null,    // { mime, requestedW, requestedH, fps ... }
    audioInfo: fields.audioInfo || null,
    bytesCommitted: fields.bytesCommitted ?? 0,
    chunksCommitted: fields.chunksCommitted ?? 0,
    writeFailures: fields.writeFailures ?? 0,
    finalization: fields.finalization || 'pending', // pending | completed | partial | failed | discarded
    recoveryEligible: fields.recoveryEligible !== false
  };
}

function manifestFileName(sessionId) { return `${sessionId}.json`; }

/* Validate a manifest read back from disk — a corrupt or foreign file must
   never crash startup. Returns manifest or null. */
function sanitizeManifest(raw, sessionId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.v !== SCHEMA_VERSION) return null;
  if (typeof raw.sessionId !== 'string' || raw.sessionId !== sessionId) return null;
  const safeStr = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.-]+$/.test(v)) ? v : null;
  const tempFileName = safeStr(raw.tempFileName);
  if (!tempFileName) return null;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : d;
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    v: SCHEMA_VERSION,
    sessionId,
    startTime: num(raw.startTime, 0),
    lastWriteAt: num(raw.lastWriteAt, 0),
    tempFileName,
    state: ['CREATED', 'RECORDING', 'STOPPING', 'FINALIZING'].includes(raw.state) ? raw.state : 'RECORDING',
    videoInfo: raw.videoInfo && typeof raw.videoInfo === 'object' ? raw.videoInfo : null,
    audioInfo: raw.audioInfo && typeof raw.audioInfo === 'object' ? raw.audioInfo : null,
    bytesCommitted: num(raw.bytesCommitted, 0),
    chunksCommitted: num(raw.chunksCommitted, 0),
    writeFailures: num(raw.writeFailures, 0),
    finalization: ['pending', 'completed', 'partial', 'failed', 'discarded'].includes(raw.finalization)
      ? raw.finalization : 'pending',
    recoveryEligible: bool(raw.recoveryEligible, true)
  };
}

function createManifestStore({ dir }) {
  const pending = new Map(); // sessionId → debounce timer
  const latest = new Map();  // sessionId → fields for the debounced write

  function fileFor(sessionId) { return path.join(dir, manifestFileName(sessionId)); }
  function assertId(sessionId) {
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(sessionId)) {
      throw new Error('manifest: invalid session id');
    }
  }

  /* atomic write: unique temp file in the same dir, then rename over the target */
  async function writeAtomic(sessionId, data) {
    assertId(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${sessionId}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const body = JSON.stringify(data, null, 0);
    let handle = null;
    try {
      handle = await fsp.open(tmp, 'w');
      await handle.writeFile(body, 'utf8');
      await handle.sync();                 // durability before rename
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    try {
      await fsp.rename(tmp, fileFor(sessionId));
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  /** save(sessionId, fields) — creates/updates the manifest (debounced for
      per-chunk updates; saveNow() for state transitions). */
  function save(sessionId, fields, { debounceMs = 0 } = {}) {
    assertId(sessionId);
    if (debounceMs > 0) {
      latest.set(sessionId, fields);
      if (pending.has(sessionId)) clearTimeout(pending.get(sessionId));
      const t = setTimeout(() => {
        pending.delete(sessionId);
        const f = latest.get(sessionId) ?? fields;
        latest.delete(sessionId);
        writeAtomic(sessionId, newManifest(f)).catch(() => {});
      }, debounceMs);
      pending.set(sessionId, t);
      return Promise.resolve();
    }
    return writeAtomic(sessionId, newManifest(fields));
  }

  async function saveNow(sessionId, fields) {
    assertId(sessionId);
    const t = pending.get(sessionId);
    if (t !== undefined) { clearTimeout(t); pending.delete(sessionId); }
    latest.delete(sessionId);
    return writeAtomic(sessionId, newManifest(fields));
  }

  async function load(sessionId) {
    assertId(sessionId);
    try {
      const raw = JSON.parse(await fsp.readFile(fileFor(sessionId), 'utf8'));
      return sanitizeManifest(raw, sessionId);
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      return null; // corrupt manifest → treated as absent, never crash
    }
  }

  /** All surviving manifests (for the startup recovery scan). */
  async function listAll() {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json') || !/^[0-9a-f]{32}\.json$/.test(n)) continue;
      const sessionId = n.slice(0, -5);
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
        const m = sanitizeManifest(raw, sessionId);
        if (m) out.push(m);
      } catch { /* corrupt → skip */ }
    }
    return out;
  }

  async function remove(sessionId) {
    assertId(sessionId);
    const t = pending.get(sessionId);
    if (t !== undefined) { clearTimeout(t); pending.delete(sessionId); }
    await fsp.rm(fileFor(sessionId), { force: true }).catch(() => {});
  }

  /* Force-flush every debounced manifest so nothing is lost at quit. */
  async function flushPending() {
    const snapshot = [...latest.entries()];
    latest.clear();
    await Promise.allSettled(
      snapshot.map(async ([id, fields]) => {
        const t = pending.get(id);
        if (t !== undefined) { clearTimeout(t); pending.delete(id); }
        try { await writeAtomic(id, newManifest(fields)); } catch { /* best-effort */ }
      })
    );
  }

  return { save, saveNow, load, listAll, remove, newManifest, flushPending };
}

module.exports = {
  SCHEMA_VERSION, newManifest, manifestFileName, sanitizeManifest, createManifestStore
};
