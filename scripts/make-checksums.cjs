#!/usr/bin/env node
/* make-checksums.cjs — verify built artifacts and write dist\SHA256SUMS.txt.
 *
 * Usage: node scripts/make-checksums.cjs [minExes]
 *   minExes: minimum number of .exe artifacts required (default 2 = Setup + Portable)
 *
 * Honest exit codes:
 *   0 = checksums written
 *   1 = bad argument
 *   2 = dist\ missing
 *   3 = artifact count below minimum
 *   4 = checksum write failed
 * Pure Node built-ins: no dependencies, same as the regression suite.
 * Brand: NEURON TS LABS · Author: Mohd Tahir Shaikh
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const minArg = Number(process.argv[2] === undefined ? 2 : process.argv[2]);
if (!Number.isInteger(minArg) || minArg < 1) {
  console.error('[sums] refusing: argument must be a positive integer');
  process.exit(1);
}

const dist = path.join(process.cwd(), 'dist');
if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) {
  console.error('[sums] refusing: the dist\\ directory does not exist');
  process.exit(2);
}

const exes = fs
  .readdirSync(dist)
  .filter((f) => /\.exe$/i.test(f))
  .sort();
if (exes.length < minArg) {
  console.error(`[sums] refusing: expected at least ${minArg} exe artifacts, found ${exes.length}`);
  process.exit(3);
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

(async () => {
  const lines = [];
  for (const name of exes) {
    const hash = await sha256File(path.join(dist, name));
    lines.push(`${hash}  ${name}`);
    console.log(`[sums] ${hash}  ${name}`);
  }
  try {
    fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), `${lines.join('\r\n')}\r\n`, 'ascii');
    console.log(`[sums] wrote dist\\SHA256SUMS.txt (${exes.length} exes, minimum required ${minArg})`);
  } catch (e) {
    console.error('[sums] failed to write dist\\SHA256SUMS.txt:', e.message);
    process.exit(4);
  }
})().catch((e) => {
  console.error('[sums] unreadable artifact:', e.message);
  process.exit(3);
});
