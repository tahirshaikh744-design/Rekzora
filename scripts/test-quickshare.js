/* Quick standalone check of the Quick Share detection logic. */
const fs = require('fs');
const path = require('path');
const os = require('os');

function existsSync(p) { try { return !!p && fs.existsSync(p); } catch { return false; } }
function findExeInDir(dir, exeRegex, depth = 2) {
  if (!dir || depth < 0) return null;
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          const r = findExeInDir(full, exeRegex, depth - 1);
          if (r) return r;
        } else if (/\.exe$/i.test(f) && exeRegex.test(f)) return full;
      } catch {}
    }
  } catch {}
  return null;
}
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const LA = path.join(os.homedir(), 'AppData', 'Local');
const QS_NAMES = [
  'quicksharelauncher.exe', 'quickshare.exe', 'googlequickshare.exe',
  'nearby_share_launcher.exe', 'nearbyshare.exe',
  'nearbysharelauncher.exe', 'nearby_share.exe'
];
outer: for (const n of QS_NAMES) {
  const rex = new RegExp('^' + n.replace(/[.]/g, '\\.') + '$', 'i');
  for (const root of [path.join(PF, 'Google'), path.join(LA, 'Google')]) {
    if (!existsSync(root)) continue;
    const exe = findExeInDir(root, rex, 2);
    if (exe) { console.log('FOUND →', exe); break outer; }
  }
}
