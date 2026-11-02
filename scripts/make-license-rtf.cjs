/* Converts build/license.txt (plain text, source of truth) into
   build/license.rtf — the rich-text version NSIS needs for the
   installer's Privacy Policy / EULA page (electron-builder nsis.license).

   Run: node scripts/make-license-rtf.cjs
   Exits 0; overwrites build/license.rtf. */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcPath = path.join(root, 'build', 'license.txt');
const outPath = path.join(root, 'build', 'license.rtf');

const src = fs.readFileSync(srcPath, 'utf8');

/* Minimal, safe RTF: ASCII text, \par for newlines, "=" lines turned into
   bold section dividers. NSIS richtext license control renders \b, \par. */
function esc(s) {
  return s.replace(/[\\{}]/g, ch => '\\' + ch).replace(/[^\x00-\x7F]/g, () => '?');
}

const lines = src.split(/\r?\n/);
const body = [];
for (const line of lines) {
  const t = line.replace(/^\s+|\s+$/g, '');
  if (!t) {
    body.push('\\par');
    continue;
  }
  if (/^={4,}$/.test(t)) {
    // underline-style divider line rendered subtly, grouped with previous header
    body.push('\\line');
    continue;
  }
  if (/^[0-9]+\.[0-9]+/.test(t) || /^THANK YOU/.test(t)) {
    body.push('{\\b ' + esc(t) + '}\\par');
    continue;
  }
  body.push(esc(t) + '\\par');
}

const rtf = '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Segoe UI;}}' +
  '\\fs16\\i0\\b0\n' +
  body.join('\n') +
  '\n}';

fs.writeFileSync(outPath, rtf, 'utf8');
console.log('[license] wrote', path.relative(root, outPath), `(${outPath.length ? Buffer.byteLength(rtf) : 0} bytes)`);
