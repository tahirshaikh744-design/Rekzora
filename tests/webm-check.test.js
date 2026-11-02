'use strict';
/* Regression tests — WebM structural validation (audit §3.3 step 7, §6.3).
   A valid-looking rename must never be trusted: only EBML + webm DocType
   + at least one Cluster counts as "playable-looking". */
const test = require('node:test');
const assert = require('node:assert');
const { checkWebM, readVintId, readVintSize, topLevelElements } = require('../lib/webm-check');

/* fixtures */
function vs(n) {
  if (n < 128) return Buffer.from([0x80 | n]);
  return Buffer.from([0x40 | ((n >> 8) & 0x3f), n & 0xff]);
}
const EBML_HEADER = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), vs(7),
  Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]) // DocType "webm"
]);
const SEGMENT_OPEN = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]); // unknown size
const CLUSTER = Buffer.concat([Buffer.from([0x1f, 0x43, 0xb6, 0x75]), vs(12), Buffer.alloc(12, 1)]);
const INFO = Buffer.concat([Buffer.from([0x15, 0x49, 0xa9, 0x66]), vs(8), Buffer.alloc(8, 2)]);
const TRACKS = Buffer.concat([Buffer.from([0x16, 0x54, 0xae, 0x6b]), vs(6), Buffer.alloc(6, 3)]);
const cat = (...ps) => Buffer.concat(ps);

test('vint id/size readers', () => {
  const idv = readVintId(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 0);
  assert.strictEqual(idv.id, 0x1a45dfa3);
  assert.strictEqual(idv.length, 4);
  const sz1 = readVintSize(Buffer.from([0x81]), 0);
  assert.strictEqual(sz1.value, 1);
  const sz2 = readVintSize(Buffer.from([0x40, 0x7f]), 0);
  assert.strictEqual(sz2.value, 0x7f);
  const unk = readVintSize(SEGMENT_OPEN, 4);
  assert.strictEqual(unk.unknownSize, true);
  assert.strictEqual(unk.value, null);
});

test('a real-shaped webm validates with EBML + doctype + Info + Tracks + Cluster', () => {
  const r = checkWebM(cat(EBML_HEADER, SEGMENT_OPEN, INFO, TRACKS, CLUSTER));
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.hasEBML, true);
  assert.strictEqual(r.doctype, 'webm');
  assert.strictEqual(r.hasCluster, true);
  assert.strictEqual(r.sawInfo, true);
  assert.strictEqual(r.sawTracks, true);
});

test('header-only remnant (crash before first cluster) is NOT valid', () => {
  const r = checkWebM(cat(EBML_HEADER, SEGMENT_OPEN, INFO, TRACKS));
  assert.strictEqual(r.hasEBML, true);
  assert.strictEqual(r.hasCluster, false);
  assert.strictEqual(r.valid, false);
});

test('empty and tiny and garbage streams are rejected without throwing', () => {
  assert.strictEqual(checkWebM(Buffer.alloc(0)).valid, false);
  assert.strictEqual(checkWebM(Buffer.alloc(8)).reason.includes('too small'), true);
  assert.strictEqual(checkWebM(Buffer.from('RIFFffff waving at you')).valid, false);
  assert.strictEqual(checkWebM(Buffer.from('%PDF-1.4 whatever')).valid, false);
});

test('matroska doctype tolerated (same container family); bogus doctype rejected', () => {
  /* DocType element 0x4282, size (0x88 = 8), value "matroska" → body 11 bytes */
  const mkvDoc = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), vs(11),
    Buffer.from([0x42, 0x82, 0x88, 0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61])
  ]);
  const r = checkWebM(cat(mkvDoc, SEGMENT_OPEN, CLUSTER));
  assert.strictEqual(r.hasEBML, true);
  assert.strictEqual(r.hasCluster, true);
  assert.strictEqual(r.webm, true);      // matroska is accepted (webm ⊂ matroska)
  assert.strictEqual(r.valid, true);

  /* a corrupted doctype with media present is NOT a finished recording */
  const junkDoc = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), vs(7),
    Buffer.from([0x42, 0x82, 0x84, 0x78, 0x78, 0x78, 0x78]) // "xxxx"
  ]);
  const r2 = checkWebM(cat(junkDoc, SEGMENT_OPEN, CLUSTER));
  assert.strictEqual(r2.hasCluster, true);
  assert.strictEqual(r2.valid, false);
});

test('truncated cluster still reveals a cluster present but flagged context', () => {
  const r = checkWebM(cat(EBML_HEADER, SEGMENT_OPEN, CLUSTER.subarray(0, 6)));
  assert.strictEqual(r.hasCluster, true);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.sawInfo, false);
});

test('topLevelElements walks sized elements', () => {
  const els = topLevelElements(cat(EBML_HEADER, SEGMENT_OPEN, INFO, TRACKS, CLUSTER));
  const ids = els.map((e) => e.id);
  assert.ok(ids.includes(0x1a45dfa3));
  assert.ok(ids.includes(0x18538067));
});
