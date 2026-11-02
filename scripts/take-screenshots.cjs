/*
   take-screenshots.cjs — drives a running Rekzora instance over the Chrome
   DevTools Protocol and saves polished screenshots to docs/screenshots/.

   Usage:
     1) launch:   electron . --remote-debugging-port=9222
     2) run:      node scripts\take-screenshots.cjs
   Shots: record page · source picker · library (with a real 4s recording) · settings
*/
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findMainTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === 'page' && /index\.html/.test(x.url));
      if (t) return t;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('no Rekzora webContents on port ' + PORT);
}

function connect(wsWithDebuggerUrl) {
  let nextId = 1;
  const pending = new Map();

  const ws = new WebSocket(wsWithDebuggerUrl);
  const openP = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', (e) => rej(new Error('WS error: ' + (e.message || e.type))));
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });

  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result && r.result.value;
  };

  return { openP, send, evalJs, close: () => ws.close() };
}

async function shot(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, file);
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('[shot] saved', out, Math.round(fs.statSync(out).size / 1024) + ' KB');
}

(async () => {
  const only = (process.argv[2] || 'all').toLowerCase().split(',');
  const want = (s) => only.includes('all') || only.includes(s);

  const target = await findMainTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.openP;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // Crisp, larger rendering for docs
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1180, height: 740, deviceScaleFactor: 1.5, mobile: false });

  await sleep(3500); // boot + ready-to-show + animations

  /* Shot 0 prep: politely dismiss the first-run EULA overlay if present
     (without changing eulaAccepted) */
  await cdp.evalJs(`(function(){ const e = document.getElementById('eula'); if (e && !e.hidden) e.hidden = true; return !!(e && !e.hidden); })()`);

  /* 1 — Record page (home) */
  if (want('record') || want('picker')) {
    await cdp.evalJs(`document.querySelector('.nav-item[data-nav="record"]').click()`);
    await sleep(900);
  }
  if (want('record')) {
    await shot(cdp, 'record.png');
  }

  /* 2 — Source picker modal via the real flow (big red button opens it) */
  if (want('record') || want('picker')) {
    await cdp.evalJs(`document.querySelector('.nav-item[data-nav="record"]').click()`);
    await sleep(500);
    await cdp.evalJs(`document.getElementById('record-btn').click()`);
    await sleep(1900); // source thumbnails populate asynchronously
    await shot(cdp, 'picker.png');
    await cdp.evalJs(`document.getElementById('picker-close').click()`);
    await sleep(400);
  }

  /* Recording to populate the library (4.5 s, screen only) — skipped if
     the library already has entries (idempotent re-runs). */
  const libCount = await cdp.evalJs(`(async () => (await window.rekzora.recordings.list()).length)()`);
  if (libCount === 0) {
    try {
      const started = await cdp.evalJs(`(async () => {
      const srcs = await window.rekzora.sources.list();
      const scr = srcs.find((s) => s.type === 'screen');
      if (!scr) throw new Error('no screen source');
      await window.RekzoraRecorder.start({
        source: scr, sourceType: 'screen',
        displayBounds: { width: scr.bounds.width, height: scr.bounds.height },
        region: null, fps: 30, quality: 'high', resolution: 'auto',
        mic: false, sysAudio: false, webcam: false
      });
      return 'recording';
    })()`);
    console.log('[rec]', started);
    await sleep(4500);
    await cdp.evalJs(`window.RekzoraRecorder.stop()`);
    await sleep(7500); // saved event → auto-navigate + save toast (6 s) → toast clears
  } catch (e) {
    console.warn('[rec] skipped:', e.message);
  }
  } else {
    console.log('[rec] library already has', libCount, 'entries — skipping new recording');
  }

  /* 3 — Library (populated) */
  if (want('library')) {
    await cdp.evalJs(`document.querySelector('.nav-item[data-nav="library"]').click()`);
    await sleep(700);
    await shot(cdp, 'library.png');
  }

  /* 4 — Settings */
  if (want('settings')) {
    await cdp.evalJs(`document.querySelector('.nav-item[data-nav="settings"]').click()`);
    await sleep(700);
    await shot(cdp, 'settings.png');
  }

  /* Clean exit (fires before-quit → tray cleanup) */
  await cdp.evalJs(`window.rekzora.win.quit()`);
  await sleep(1500);
  cdp.close();
  console.log('[done] screenshots complete');
})().catch((e) => { console.error('[fatal]', e); process.exit(1); });
