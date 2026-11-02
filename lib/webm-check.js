'use strict';
/* ============================================================
   Rekzora — WebM structural validity check (main process only)

   Answers one question: **is this byte stream a WebM container that
   still holds at least one media Cluster?** Used by:
   - recording finalization (a truncated container ⇒ PARTIAL, not COMPLETED)
   - crash recovery (a cluster-less remnant is NOT offered as recoverable)

   Hand-rolled minimal EBML walk — no dependency, offline-only, MIT-safe.
   Not a full parser: it validates structure well enough to separate
   "playable-looking" from "garbage".
   ============================================================ */

/* EBML element ids (as used by Matroska/WebM) */
const ID_EBML = 0x1a45dfa3;       // container header
const ID_SEGMENT = 0x18538067;    // segment (usually "unknown size" vint)
const ID_CLUSTER = 0x1f43b675;    // media cluster
const ID_KAXTRACKS = 0x1654ae6b;  // Tracks container
const ID_INFO = 0x1549a966;

const DEFAULT_MAX_SCAN_BYTES = 16 * 1024 * 1024;  // don't scan past 16 MB

/* ---- EBML vints ---- */

function isVintAllOnes(buf, offset, length) {
  /* all-ones vint: first byte = marker at the lowest possible position
     with every data bit of that byte set (0xff >> (length-1)), remaining
     bytes are 0xff. e.g. length 8 → 0x01 ff ff ff ff ff ff ff */
  if (buf[offset] !== (0xff >> (length - 1))) return false;
  for (let i = 1; i < length; i++) {
    if (buf[offset + i] !== 0xff) return false;
  }
  return true;
}

/** Read a vint as an EBML element ID (marker bit kept in the id value).
 *  Returns { id, length } or null. */
function readVintId(buf, offset) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;              // leading zero byte is invalid
  let bitsToMarker = 0;
  while (bitsToMarker < 8 && !((first << bitsToMarker) & 0x80)) bitsToMarker++;
  const len = bitsToMarker + 1;              // marker position defines length
  if (len > 8 || offset + len > buf.length) return null;
  let raw = 0;
  for (let i = 0; i < len; i++) raw = raw * 256 + buf[offset + i];
  return { id: raw >>> 0, length: len };
}

/** Read a vint as a SIZE (marker bit stripped). Canonical "unknown size"
 *  is an 8-byte vint with every data bit set → unknownSize=true.
 *  Returns { value, length, unknownSize } or null. */
function readVintSize(buf, offset) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let bitsToMarker = 0;
  while (bitsToMarker < 8 && !((first << bitsToMarker) & 0x80)) bitsToMarker++;
  const len = bitsToMarker + 1;
  if (len > 8 || offset + len > buf.length) return null;

  let dataValue = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[offset + i];
    dataValue = dataValue * 256 + (i === 0 ? (b & (0x7f >> (len - 1))) : b);
  }
  const unknownSize = len === 8 && isVintAllOnes(buf, offset, len);
  return { value: unknownSize ? null : dataValue, length: len, unknownSize };
}

/** Walk top-level EBML elements inside `buf`. */
function topLevelElements(buf, maxScanBytes = DEFAULT_MAX_SCAN_BYTES) {
  const out = [];
  let pos = 0;
  const limit = Math.min(buf.length, maxScanBytes);
  while (pos < limit && out.length < 1024) {
    const idv = readVintId(buf, pos);
    if (!idv) break;
    const size = readVintSize(buf, pos + idv.length);
    if (!size) break;
    const bodyStart = pos + idv.length + size.length;
    const bodyLen = size.unknownSize ? (buf.length - bodyStart) : size.value;
    out.push({ id: idv.id, start: pos, bodyStart, bodyLen, unknownSize: size.unknownSize });
    if (size.unknownSize) break; // unknown-size element = rest of file
    pos = bodyStart + Math.max(0, Math.min(bodyLen, buf.length - bodyStart));
    if (bodyLen === 0) pos += 1; // zero-length element; nudge forward
  }
  return out;
}

/**
 * Validate WebM bytes.
 * @param {Buffer} buf
 * @param {{findClusterBytes?: number, maxScanBytes?: number}} opts
 *   findClusterBytes — how far into the Segment to search for the first
 *   Cluster (default 16 MB).
 */
function checkWebM(buf, opts = {}) {
  const res = {
    valid: false, webm: false, hasEBML: false, hasCluster: false,
    doctype: null, sawInfo: false, sawTracks: false,
    reason: '', clusterBytesOffset: null
  };
  if (!Buffer.isBuffer(buf) || buf.length < 16) {
    res.reason = 'too small to be a WebM container';
    return res;
  }

  const els = topLevelElements(buf, opts.maxScanBytes);
  const ebmlEl = els.find(e => e.id === ID_EBML);
  const segEl = els.find(e => e.id === ID_SEGMENT);
  if (!ebmlEl) { res.reason = 'no EBML header'; return res; }
  res.hasEBML = true;

  try {
    const header = buf.subarray(ebmlEl.bodyStart, Math.min(ebmlEl.bodyStart + Math.max(64, ebmlEl.bodyLen), buf.length));
    if (header.indexOf('webm', 0, 'utf8') >= 0) res.doctype = 'webm';
    else if (header.indexOf('matroska', 0, 'utf8') >= 0) res.doctype = 'matroska';
  } catch { /* keep null */ }

  if (!segEl) { res.reason = 'no Segment element'; return res; }
  res.webm = res.doctype === 'webm' || res.doctype === 'matroska';

  /* look for the first media Cluster inside the Segment body */
  const segLimit = Math.min(segEl.unknownSize ? buf.length : segEl.bodyStart + Math.max(0, segEl.bodyLen), buf.length);
  const scanStart = segEl.bodyStart;
  const scanEnd = Math.min(scanStart + (opts.findClusterBytes ?? DEFAULT_MAX_SCAN_BYTES), segLimit);
  let pos = scanStart;
  let steps = 0;
  while (pos < scanEnd && steps < 4096) {
    const idv = readVintId(buf, pos);
    if (!idv) { pos += 1; steps++; continue; }        // resync byte-by-byte
    if (idv.id === ID_CLUSTER) {
      res.hasCluster = true;
      res.clusterBytesOffset = pos;
      break;
    }
    if (idv.id === ID_INFO) res.sawInfo = true;
    if (idv.id === ID_KAXTRACKS) res.sawTracks = true;
    const size = readVintSize(buf, pos + idv.length);
    if (!size) { pos = scanEnd; break; }
    if (size.unknownSize) { pos = scanEnd; break; }
    pos = pos + idv.length + size.length + Math.max(0, Math.min(size.value, scanEnd - (pos + idv.length + size.length)));
    steps++;
  }

  if (!res.hasCluster) {
    res.reason = 'no media Cluster found (header-only or truncated remnant)';
    return res;
  }
  res.valid = res.webm;
  res.reason = res.valid
    ? `valid WebM container with media (Info:${res.sawInfo ? 'y' : 'n'}, Tracks:${res.sawTracks ? 'y' : 'n'})`
    : `sold as webm but doctype is "${res.doctype}"`;
  return res;
}

module.exports = {
  ID_EBML, ID_SEGMENT, ID_CLUSTER, ID_KAXTRACKS, ID_INFO,
  DEFAULT_MAX_SCAN_BYTES,
  checkWebM, topLevelElements, readVintId, readVintSize, isVintAllOnes
};
