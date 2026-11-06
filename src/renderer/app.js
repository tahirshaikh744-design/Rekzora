'use strict';
/* ============================================================
   Rekzora app UI controller
   ============================================================ */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const rekzora = window.rekzora;

  /* ---------------- utilities ---------------- */
  function fmtBytes(n) {
    if (!n || n < 0) return '—';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB'];
    let u = -1;
    do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[u];
  }
  function fmtDur(ms) {
    const s = Math.round((ms || 0) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  }
  function fmtDate(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });
    } catch { return ''; }
  }
  function videoUrl(id) {
    /* recordings stream from the main process over an id-addressed custom
       protocol; the renderer never holds filesystem paths */
    return 'rekzora-video://' + encodeURIComponent(String(id)) + '/video';
  }
  function clampRect(r, w, h) {
    const x = Math.max(0, Math.min(w - 4, Math.round(r.x)));
    const y = Math.max(0, Math.min(h - 4, Math.round(r.y)));
    const rw = Math.max(8, Math.min(w - x, Math.round(r.w)));
    const rh = Math.max(8, Math.min(h - y, Math.round(r.h)));
    return { x, y, w: rw, h: rh };
  }

  /* ---------------- toasts (title + full path + action chips) ---------------- */
  function toast(message, opts = {}) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (opts.level ? ' t-' + opts.level : '');

    const text = document.createElement('div');
    text.className = 't-text';

    const main = document.createElement('span');
    main.textContent = message;
    text.appendChild(main);

    if (opts.sub) {
      const sub = document.createElement('span');
      sub.className = 't-sub';
      sub.textContent = opts.sub;
      sub.title = opts.sub;
      text.appendChild(sub);
    }
    el.appendChild(text);

    const actions = opts.actions || (opts.action ? [{ label: opts.action, onClick: opts.onClick }] : []);
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 't-actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.textContent = a.label;
        b.onclick = () => { a.onClick && a.onClick(); dismiss(); };
        row.appendChild(b);
      }
      el.appendChild(row);
    }

    const dismiss = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    };
    box.appendChild(el);
    setTimeout(dismiss, opts.duration || 5200);
  }

  /* ---------------- generic dialog (confirm / prompt) ---------------- */
  function dialog({ title, sub, input, okText, cancelText }) {
    return new Promise((resolve) => {
      const modal = $('#dialog');
      $('#dialog-title').textContent = title;
      const subEl = $('#dialog-sub');
      subEl.hidden = !sub;
      subEl.textContent = sub || '';
      const inEl = $('#dialog-input');
      inEl.hidden = !input;
      inEl.value = input || '';
      $('#dialog-ok').textContent = okText || 'OK';
      $('#dialog-cancel').textContent = cancelText || 'Cancel';
      modal.hidden = false;
      if (input) { inEl.focus(); inEl.select(); }
      const close = (val) => { modal.hidden = true; cleanup(); resolve(val); };
      const ok = () => close(input ? (inEl.value.trim() || null) : true);
      const cancel = () => close(null);
      function onKey(e) {
        if (e.key === 'Escape') cancel();
        if (e.key === 'Enter') ok();
      }
      function cleanup() {
        $('#dialog-ok').onclick = null;
        $('#dialog-cancel').onclick = null;
        window.removeEventListener('keydown', onKey);
      }
      $('#dialog-ok').onclick = ok;
      $('#dialog-cancel').onclick = cancel;
      window.addEventListener('keydown', onKey);
    });
  }

  /* ============================================================
     SETTINGS
     ============================================================ */
  let settings = null;
  let recursosMode = 'fullscreen';

  /* ---- Custom themed dropdown ------------------------------------------
     Native <select> popups on Windows mix author colors with OS-rendered
     scheme colors — text could end up invisible in either theme. This
     renders 100% with Rekzora design tokens, so it's always readable. */
  const hotkeyDrops = { toggle: null, pause: null };
  function closeDrops() {
    document.querySelectorAll('.drop-menu').forEach(m => { m.hidden = true; });
  }
  function makeDrop(id, values, current, onPick) {
    const host = document.querySelector('#' + id);
    if (!host) return { update: () => {} };
    host.innerHTML = '';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drop-btn';
    const cur = document.createElement('span');
    cur.textContent = current;
    const chev = document.createElement('span');
    chev.className = 'drop-chev';
    chev.textContent = '▾';
    btn.append(cur, chev);

    const menu = document.createElement('div');
    menu.className = 'drop-menu';
    menu.hidden = true;
    for (const v of values) {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'drop-item';
      it.textContent = v;
      if (v === current) it.classList.add('active');
      it.onclick = () => {
        cur.textContent = v;
        menu.querySelectorAll('.drop-item').forEach(x => x.classList.toggle('active', x === it));
        menu.hidden = true;
        onPick(v);
      };
      menu.appendChild(it);
    }

    btn.onclick = (e) => {
      e.stopPropagation();
      const wasClosed = menu.hidden;
      closeDrops();
      if (wasClosed) menu.hidden = false;
    };

    host.append(btn, menu);
    return { update: (v) => { cur.textContent = v; } };
  }
  document.addEventListener('click', () => closeDrops());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrops(); });

  /* ---- First-run Privacy Policy / EULA (enterprise-style) ----
     Shown before anything else when settings.eulaAccepted is false
     (fresh install + portable exe first run). Declining quits the app. */
  function showEula() {
    $('#eula').hidden = false;
    rekzora.log('eula: showing first-run privacy policy');
  }
  function eulaOpen() { return !$('#eula').hidden; }
  $('#eula-agree').onclick = async () => {
    $('#eula').hidden = true;
    try { await saveSettings({ eulaAccepted: true }); } catch { /* non-fatal */ }
    toast('Privacy Policy accepted — welcome to Rekzora!', {
      sub: 'NEURON TS LABS · Mohd Tahir Shaikh',
      duration: 6000
    });
  };
  $('#eula-disagree').onclick = () => {
    rekzora.log('eula: declined → quitting');
    $('#eula').hidden = true;
    toast('Privacy terms declined — closing Rekzora.', { level: 'warn', duration: 3000 });
    setTimeout(() => rekzora.win.quit(), 1400);
  };

  async function loadSettings() {
    settings = await rekzora.settings.get();
    applySettings();
  }

  function applySettings() {
    document.documentElement.dataset.theme = settings.theme || 'dark';
    $$('#theme-seg button').forEach(b => b.classList.toggle('active', b.dataset.theme === settings.theme));

    syncSeg('fps-home', 'fps', settings.fps);
    syncSeg('quality-home', 'quality', settings.quality);
    syncSeg('res-home', 'resolution', settings.resolution);
    syncSeg('fps-seg', 'fps', settings.fps);
    syncSeg('quality-seg', 'quality', settings.quality);
    syncSeg('resolution-seg', 'resolution', settings.resolution);
    syncSeg('countdown-seg', 'countdown', settings.countdown);

    recursosMode = settings.mode || 'fullscreen';
    $$('#mode-seg button').forEach(b => b.classList.toggle('active', b.dataset.mode === recursosMode));

    setDeviceState('dev-mic', settings.mic);
    setDeviceState('dev-sys', settings.sysAudio);
    setDeviceState('dev-cam', settings.webcam);

    $('#kbd-toggle').textContent = settings.hotkeyToggle;
    $('#kbd-pause').textContent = settings.hotkeyPause;
    // Custom themed dropdowns (native <select> popups are unreliable here)
    const KEYS = ['F8', 'F9', 'F10', 'F11', 'F12'];
    if (!hotkeyDrops.toggle) {
      hotkeyDrops.toggle = makeDrop('set-hotkey-toggle', KEYS, settings.hotkeyToggle, (v) => saveSettings({ hotkeyToggle: v }));
      hotkeyDrops.pause = makeDrop('set-hotkey-pause', KEYS, settings.hotkeyPause, (v) => saveSettings({ hotkeyPause: v }));
    } else {
      hotkeyDrops.toggle.update(settings.hotkeyToggle);
      hotkeyDrops.pause.update(settings.hotkeyPause);
    }
    $('#set-close-tray').dataset.on = settings.closeToTray ? '1' : '0';
    $('#set-folder').textContent = settings.saveDir;
    $('#set-folder').title = settings.saveDir;
    $('#set-version').textContent = settings.appVersion || '1.0.0';
  }

  function syncSeg(id, attr, value) {
    $$(`#${id} button`).forEach(b => {
      const match = b.dataset[attr] === String(value);
      b.classList.toggle('active', match);
    });
  }

  async function saveSettings(patch) {
    Object.assign(settings, patch);
    settings = await rekzora.settings.set(patch);
    applySettings();
  }
  const saveSettingsDebounced = saveSettings;

  function setDeviceState(id, on) {
    const card = $('#' + id);
    card.dataset.on = on ? '1' : '0';
    const sw = card.querySelector('.switch');
    if (sw) sw.dataset.on = on ? '1' : '0';
    const st = card.querySelector('.device-state');
    if (st) {
      st.textContent = on ? 'On' : 'Off';
      st.style.color = on ? 'var(--switch-on)' : 'var(--muted)';
    }
  }

  function toggleDevice(id, key) {
    const card = $('#' + id);
    const on = card.dataset.on !== '1';
    setDeviceState(id, on);
    saveSettings({ [key]: on });
  }
  $('#dev-mic').addEventListener('click', () => toggleDevice('dev-mic', 'mic'));
  $('#dev-sys').addEventListener('click', () => toggleDevice('dev-sys', 'sysAudio'));
  $('#dev-cam').addEventListener('click', () => toggleDevice('dev-cam', 'webcam'));

  /* navigation */
  function switchPage(name) {
    $$('.page').forEach(p => p.classList.remove('active'));
    $('#page-' + name).classList.add('active');
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
    if (name === 'library') renderLibrary();
  }
  $$('.nav-item').forEach(b => b.addEventListener('click', () => switchPage(b.dataset.nav)));

  /* window controls (Windows style, top-right) */
  $('#wc-close').onclick = () => rekzora.win.close();
  $('#wc-min').onclick = () => rekzora.win.minimize();
  $('#wc-max').onclick = () => rekzora.win.toggleMaximize();

  /* ============================================================
     RECORD FLOW
     ============================================================ */
  const recBtn = $('#record-btn');
  let lastRegion = null;
  let flowBusy = false;

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  $$('#mode-seg button').forEach(b => b.addEventListener('click', () => {
    recursosMode = b.dataset.mode;
    saveSettingsDebounced({ mode: recursosMode });
  }));

  recBtn.addEventListener('click', () => {
    if (flowBusy) return;
    const st = window.RekzoraRecorder.getState();
    if (st === 'recording' || st === 'paused') { window.RekzoraRecorder.stop(); return; }
    if (st !== 'idle') return;
    openPicker();
  });

  /* picker */
  async function openPicker() {
    const modal = $('#picker');
    modal.hidden = false;
    $('#picker-title').textContent =
      recursosMode === 'region' ? 'Choose a screen' :
      recursosMode === 'window' ? 'Choose a window' : 'Choose what to record';
    const groups = { screen: $('#picker-screens'), window: $('#picker-windows') };
    const grids = { screen: $('#picker-grid-screens'), window: $('#picker-grid-windows') };
    for (const k of ['screen', 'window']) {
      grids[k].innerHTML = '<div class="picker-empty">Loading…</div>';
    }
    groups.screen.hidden = recursosMode === 'window';
    groups.window.hidden = recursosMode === 'region';

    rekzora.log('picker open:', recursosMode);
    let sources = [];
    try {
      sources = await rekzora.sources.list();
      rekzora.log('sources found:', sources.length,
        'screens:', sources.filter(s => s.type === 'screen').length,
        'windows:', sources.filter(s => s.type === 'window').length);
    } catch (e) {
      rekzora.log('sources ERROR:', e.message);
      toast('Could not enumerate screens. Please try again.', { level: 'error' });
      modal.hidden = true;
      return;
    }

    const addItem = (src, kind) => {
      const b = document.createElement('button');
      b.className = 'picker-item';
      b.innerHTML = `
        <img class="pi-thumb" alt="" />
        <div class="pi-name"></div>`;
      b.querySelector('.pi-thumb').src = src.thumbnail || '';
      const nm = b.querySelector('.pi-name');
      if (src.appIcon) {
        const img = document.createElement('img');
        img.src = src.appIcon;
        nm.appendChild(img);
      }
      const span = document.createElement('span');
      span.textContent = src.name;
      nm.appendChild(span);
      b.onclick = () => {
        rekzora.log('source chosen:', src.type, src.name);
        modal.hidden = true;
        onSourceChosen(src);
      };
      grids[kind].appendChild(b);
    };

    let sCount = 0, wCount = 0;
    for (const s of sources) {
      if (s.type === 'screen' && (recursosMode !== 'window')) { addItem(s, 'screen'); sCount++; }
      else if (s.type === 'window' && recursosMode !== 'region') { addItem(s, 'window'); wCount++; }
    }
    if (!sCount) grids.screen.innerHTML = '<div class="picker-empty">No screens found</div>';
    if (!wCount && !groups.window.hidden) grids.window.innerHTML = '<div class="picker-empty">No windows available</div>';
  }
  $('#picker-close').onclick = () => { $('#picker').hidden = true; };

  async function onSourceChosen(source) {
    try {
      if (recursosMode === 'region') {
        await startRegionFlow(source);
        return;
      }
      const effectiveMode = source.type === 'window' ? 'window' : 'fullscreen';
      await runCountdownThenStart(source, effectiveMode, null);
    } catch (e) {
      rekzora.log('choose error', e.message);
      toast('Could not start recording: ' + (e.message || 'unknown error'), { level: 'error' });
    }
  }

  async function startRegionFlow(source) {
    return new Promise((resolve) => {
      let settled = false;
      const off = rekzora.region.onResult(async ({ rect }) => {
        settled = true;
        off();
        if (!rect || rect.w < 20 || rect.h < 20) {
          toast('Region too small — recording cancelled.');
          resolve();
          return;
        }
        const clamped = clampRect(rect, source.bounds.width, source.bounds.height);
        lastRegion = clamped;
        try { await runCountdownThenStart(source, 'region', clamped); }
        catch (e) {
          rekzora.log('region start error', e.message);
          toast('Could not start recording: ' + (e.message), { level: 'error' });
        }
        resolve();
      });
      rekzora.region.begin({ sourceId: source.id, bounds: source.bounds, scaleFactor: source.scaleFactor });
      // safety: if overlay cancelled while we listen (also handled via onResult)
      setTimeout(() => { if (!settled) { off(); resolve(); } }, 300000);
    });
  }

  async function runCountdownThenStart(source, sourceType, region) {
    if (flowBusy) return;
    flowBusy = true;
    try {
      const cfg = {
        source,
        sourceType,
        displayBounds: source.bounds ? { width: source.bounds.width, height: source.bounds.height } : null,
        region,
        fps: +settings.fps,
        quality: settings.quality,
        resolution: settings.resolution || 'auto',
        mic: settings.mic,
        sysAudio: settings.sysAudio,
        webcam: settings.webcam
      };
      /* PRE-ARM v2: acquire capture streams WHILE the countdown runs —
         prepare() and the countdown execute in parallel, so the wait is
         max(prepare, countdown) instead of prepare + countdown (that sum
         was delaying hotkey starts by seconds). */
      showRecPanel(source, sourceType, region);
      const prep = window.RekzoraRecorder.prepare(cfg);
      const cd = settings.countdown;
      const t0 = Date.now();
      rekzora.log('start flow: preparing in parallel, countdown =', String(cd));
      const countDone = (async () => {
        if (cd > 0) {
          const cdEl = $('#countdown');
          const cdNum = $('#cd-number');
          cdEl.hidden = false;
          try {
            for (let i = cd; i > 0; i--) {
              cdNum.textContent = i;
              cdNum.style.animation = 'none';
              void cdNum.offsetWidth;
              cdNum.style.animation = '';
              await sleep(1000);
            }
          } finally {
            cdEl.hidden = true;
          }
        }
      })();
      try {
        await Promise.all([prep, countDone]);
      } catch (e) {
        $('#countdown').hidden = true;
        hideRecPanel();
        throw e;
      }
      rekzora.log('pre-arm complete in', (Date.now() - t0) + 'ms → commit');
      await window.RekzoraRecorder.commit();
      // float bar over the selected display
      rekzora.float.show(source.bounds || null);
    } catch (e) {
      $('#countdown').hidden = true;
      hideRecPanel();
      rekzora.float.hide();
      window.RekzoraRecorder.abortPrepare();
      throw e;
    } finally {
      flowBusy = false;
    }
  }

  function showRecPanel(source, type, region) {
    $('#home-main').hidden = true;
    $('#rec-main').hidden = false;
    const label = type === 'region' ? 'Region · ' + (source.name || 'Screen')
      : source.name || (type === 'window' ? 'Window' : 'Display');
    $('#rec-source').textContent = label + (type === 'region' ? ' · ' + region.w + '×' + region.h : '');
    $('#pulse-ring').style.display = '';
  }
  function hideRecPanel() {
    $('#home-main').hidden = false;
    $('#rec-main').hidden = true;
    recBtn.classList.remove('recording');
    setPauseIcon(false);
  }

  function setPauseIcon(paused) {
    $('#page-pause').textContent = paused ? '▶' : '⏸';
    $('#page-pause').title = paused ? 'Resume (F10)' : 'Pause (F10)';
  }

  $('#page-stop').onclick = () => window.RekzoraRecorder.stop();
  $('#page-pause').onclick = () => window.RekzoraRecorder.togglePause();

  /* recorder events */
  window.addEventListener('rekzora:recorder-state', ({ detail }) => {
    const st = detail.state;
    if (st === 'recording' || st === 'paused') {
      recBtn.classList.add('recording');
      if (detail.seconds !== undefined) {
        $('#rec-timer').textContent = fmtDur(detail.seconds * 1000);
      }
    }
    if (st === 'idle') hideRecPanel();
    if (st === 'paused') setPauseIcon(true);
    if (st === 'recording') setPauseIcon(false);
    if (st === 'stopping' || st === 'saving') $('#pulse-ring').style.display = 'none';
  });

  window.addEventListener('rekzora:recorder-saved', ({ detail }) => {
    rekzora.log('recorder saved:', JSON.stringify(detail));
    rekzora.float.hide();
    if (detail.discarded) {
      toast('Recording discarded.');
      return;
    }
    const dur = fmtDur(detail.durationMs);
    const size = fmtBytes(detail.size);
    const title = (detail.fileName || 'Screen Recording').replace(/\.webm$/i, '');
    const partial = detail.status === 'partial';
    toast(partial ? `Saved with issues — ${title}` : `Saved — ${title}`, {
      sub: `${detail.fileName} · ${dur} · ${size}${partial ? ' · some chunks were lost' : ''}`,
      level: partial ? 'warn' : undefined,
      duration: 9000,
      actions: [
        { label: 'Show', onClick: () => detail.id && rekzora.recordings.reveal(detail.id) },
        { label: 'Share', onClick: () => detail.id && openShare({ id: detail.id }) },
        { label: 'Play', onClick: () => detail.id && openSaved(detail) }
      ]
    });
    switchPage('library');
  });

  async function openSaved(detail) {
    try {
      const items = await rekzora.recordings.list();
      const match = (detail.id && items.find(i => i.id === detail.id)) ||
        (detail.id
          ? { id: detail.id, title: (detail.fileName || '').replace(/\.webm$/i, ''), size: detail.size || 0, durationMs: detail.durationMs || 0, created: Date.now(), type: 'screen' }
          : items[0]);
      if (match) openPlayer(match);
    } catch { /* ignore */ }
  }

  window.addEventListener('rekzora:recorder-error', ({ detail }) => {
    toast(detail.message, { level: 'error', duration: 7000 });
  });
  window.addEventListener('rekzora:recorder-note', ({ detail }) => {
    toast(detail.message, { level: detail.level || 'warn' });
  });

  /* quality / fps / resolution quick chips on home */
  $$('#fps-home button').forEach(b => b.onclick = () => saveSettings({ fps: +b.dataset.fps }));
  $$('#quality-home button').forEach(b => b.onclick = () => saveSettings({ quality: b.dataset.quality }));
  $$('#res-home button').forEach(b => b.onclick = () => saveSettings({ resolution: b.dataset.resolution }));

  /* ============================================================
     External actions: float bar, hotkeys, system events
     ============================================================ */
  let lastActionAt = 0;
  let lastActionName = '';
  function handleAction({ action, status } = {}) {
    /* Guard: when Rekzora has focus, a single keypress fires BOTH the global
       shortcut (main process) and the in-window keydown fallback. Without
       this 350 ms dedupe, one F9 press could stop+restart recording. */
    const now = Date.now();
    if (action === lastActionName && now - lastActionAt < 350) return;
    lastActionName = action;
    lastActionAt = now;

    /* Block all external actions while the first-run Privacy Policy
       dialog is on screen (fresh install / portable first run). */
    if (eulaOpen()) return;

    const R = window.RekzoraRecorder;
    const st = R.getState();
    switch (action) {
      case 'stop':
        if (st === 'recording' || st === 'paused') R.stop();
        break;
      case 'discard':
        if (st === 'recording' || st === 'paused') R.discard();
        break;
      case 'pause-toggle':
        R.togglePause();
        break;
      case 'hotkey-toggle':
        if (st === 'recording' || st === 'paused') R.stop();
        else if (st === 'idle') quickStart();
        break;
      case 'hotkey-pause':
        R.togglePause();
        break;
      case 'system-suspend':
        if (st === 'recording') {
          R.pause();
          toast('System suspended — recording paused.', { level: 'warn' });
        }
        break;
      case 'hotkeys-status':
        if (Array.isArray(status)) {
          const failed = status.filter(s => !s.ok).map(s => s.key);
          if (failed.length) {
            toast(`Shortcut ${failed.join(', ')} is used by another app — it still works while Rekzora window is focused.`, { level: 'warn', duration: 7000 });
          }
        }
        break;
    }
  }

  rekzora.actions.on(handleAction);

  /* In-window fallback for the same shortcuts (works even if the global
     registration was stolen by another app — while Rekzora is focused). */
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === settings.hotkeyToggle) {
      e.preventDefault();
      handleAction({ action: 'hotkey-toggle' });
    } else if (e.key === settings.hotkeyPause) {
      e.preventDefault();
      handleAction({ action: 'hotkey-pause' });
    }
  });

  async function quickStart() {
    // F9 quick record: primary screen via the fast IPC path (no window
    // enumeration), or the last used region on it.
    try {
      rekzora.log('quickStart: fetching primary screen (fast path)');
      const primary = await rekzora.capture.primaryScreen();
      if (!primary) { toast('No screen found to record.', { level: 'error' }); return; }
      rekzora.log('quickStart: primary screen =', primary.id);
      if (recursosMode === 'region' && lastRegion) {
        await runCountdownThenStart(primary, 'region', lastRegion);
      } else {
        await runCountdownThenStart(primary, 'fullscreen', null);
      }
    } catch (e) {
      rekzora.log('quickStart error', e.message);
      toast('Quick start failed: ' + (e.message || 'unknown'), { level: 'error' });
    }
  }

  /* ============================================================
     LIBRARY
     ============================================================ */
  let libraryItems = [];
  let currentRecording = null;

  /* ---- crash-recovery banner (§6.5 B4, UI side) ---- */
  let recoveryItems = [];
  async function renderRecoveryBanner() {
    const banner = $('#recovery-banner');
    if (!banner) return;
    try { recoveryItems = await rekzora.recovery.list(); } catch (e) {
      rekzora.log('recovery list error:', e && e.message);
      recoveryItems = [];
    }
    banner.hidden = recoveryItems.length === 0;
    const list = $('#recovery-list');
    if (!list) return;
    list.innerHTML = '';
    for (const row of recoveryItems) {
      const el = document.createElement('div');
      el.className = 'recovery-row' + (row.playable ? '' : ' rr-broken');
      const when = row.lastWriteAt ? fmtDate(row.lastWriteAt) : 'unknown time';
      const meta = row.playable
        ? `${fmtBytes(row.bytes)} · last updated ${when}${row.writeFailures ? ' · ' + row.writeFailures + ' write issue(s)' : ''}`
        : `${fmtBytes(row.bytes)} · file damaged — only deletable`;
      el.innerHTML = `
        <span>${row.playable ? '🎬' : '⚠️'}</span>
        <span class="rr-name"></span>
        <span class="rr-meta"></span>
        <span class="recovery-actions"></span>`;
      el.querySelector('.rr-name').textContent =
        'Screen recording from ' + (row.startedAt ? fmtDate(row.startedAt) : 'previous session');
      el.querySelector('.rr-meta').textContent = meta;
      const actions = el.querySelector('.recovery-actions');
      if (row.playable) {
        const keep = document.createElement('button');
        keep.className = 'ghost-btn';
        keep.textContent = 'Keep';
        keep.onclick = () => recoverOne(row);
        actions.appendChild(keep);
      }
      const drop = document.createElement('button');
      drop.className = 'ghost-btn danger';
      drop.textContent = 'Delete';
      drop.onclick = () => deleteRecovered(row);
      actions.appendChild(drop);
      list.appendChild(el);
    }
  }
  async function recoverOne(row) {
    try {
      const res = await rekzora.recovery.recover(row.id);
      if (res && res.ok) toast(`Recovered as "${res.fileName}".`);
      renderLibrary();
    } catch (e) {
      toast(e && e.message ? `Recovery failed: ${e.message}` : 'Recovery failed.', { level: 'error' });
      renderLibrary();
    }
  }
  async function deleteRecovered(row) {
    try { await rekzora.recovery.del(row.id); } catch { /* ignore */ }
    renderLibrary();
  }
  $('#recovery-dismiss-all').onclick = async () => {
    for (const r of recoveryItems) {
      try { await rekzora.recovery.dismiss(r.id); } catch { /* ignore */ }
    }
    renderLibrary();
  };

  async function renderLibrary() {
    let folder = settings.saveDir;
    $('#lib-folder').textContent = folder;
    const q = ($('#lib-search').value || '').toLowerCase();
    try {
      libraryItems = await rekzora.recordings.list();
    } catch { libraryItems = []; }
    renderRecoveryBanner();

    const items = q
      ? libraryItems.filter(i => (i.title + i.fileName).toLowerCase().includes(q))
      : libraryItems;

    $('#lib-grid').innerHTML = '';
    $('#lib-empty').hidden = items.length > 0;
    const badge = $('#library-count');
    badge.hidden = libraryItems.length === 0;
    badge.textContent = libraryItems.length > 99 ? '99+' : String(libraryItems.length);

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'rec-card';
      const thumb = item.thumb
        ? `<img src="${item.thumb}" alt="" draggable="false"/>`
        : '';
      const badges = [
        item.type === 'window' ? 'Window' : item.type === 'region' ? 'Region' : 'Full',
        item.fps ? item.fps + ' fps' : null,
        item.mic ? '🎙' : null,
        item.systemAudio ? '🔊' : null
      ].filter(Boolean).map(b => `<span class="badge">${b}</span>`).join('');

      card.innerHTML = `
        <div class="rec-thumb">${thumb}
          <button class="kebab-btn" title="More actions">⋮</button>
          <div class="rec-play"><div class="rec-play-badge">▶</div></div>
          <div class="rec-duration">${item.durationMs ? fmtDur(item.durationMs) : '—'}</div>
        </div>
        <div class="rec-info">
          <div class="rec-name">…</div>
          <div class="rec-meta"><span class="rec-size"></span><span>${fmtDate(item.created)}</span><span class="rec-badges">${badges}</span></div>
        </div>`;
      card.querySelector('.rec-name').textContent = item.title || item.fileName;
      card.querySelector('.rec-size').textContent = fmtBytes(item.size);
      card.onclick = () => openPlayer(item);
      card.oncontextmenu = (e) => {
        e.preventDefault();
        showVideoMenu(item, null);
      };
      // Native OS drag-out: drag this card straight into Quick Share / SHAREit / any app
      card.draggable = true;
      card.ondragstart = (e) => {
        e.preventDefault(); // hand over to native OS drag (real file payload)
        rekzora.drag.start(item.id);
      };
      const kebab = card.querySelector('.kebab-btn');
      kebab.onclick = (e) => {
        e.stopPropagation();
        showVideoMenu(item, e.currentTarget);
      };
      $('#lib-grid').appendChild(card);
    }
  }

  function showRecordingMenu(item) {
    // kept for compatibility: opens the same menu at cursor position
    showVideoMenu(item, null);
  }

  /* ================= three-dot video menu ================= */
  function showVideoMenu(item, anchor) {
    closeVideoMenu();
    const menu = $('#vmenu');
    menu.innerHTML = '';

    const mk = (label, ico, fn, danger) => {
      const b = document.createElement('button');
      if (danger) b.className = 'danger';
      const i = document.createElement('span');
      i.className = 'vm-ico';
      i.textContent = ico;
      const s = document.createElement('span');
      s.textContent = label;
      b.append(i, s);
      b.onclick = () => { closeVideoMenu(); fn(); };
      return b;
    };

    menu.appendChild(mk('Play', '▶', () => openPlayer(item)));
    menu.appendChild(mk('Share…', '📤', () => openShare(item)));
    menu.appendChild(mk('Rename', '✏️', () => renameRecording(item)));
    menu.appendChild(mk('Show in folder', '📂', () => rekzora.recordings.reveal(item.id)));
    menu.appendChild(mk('Copy file path', '📋', async () => {
      const p = await rekzora.recordings.getFilePath(item.id);
      if (p) {
        rekzora.clipboard.write(p);
        toast('File path copied to clipboard.');
      } else {
        toast('Could not resolve the file (recording missing?).', { level: 'warn' });
      }
    }));
    menu.appendChild(mk('Properties', 'ℹ️', () => showProperties(item)));
    menu.appendChild(document.createElement('hr'));
    menu.appendChild(mk('Delete', '🗑', () => deleteRecording(item), true));

    // position near the anchor button (fallback: last mouse position)
    let x = 0, y = 0;
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      x = r.left - 190;
      y = r.bottom + 6;
    } else {
      x = lastMouse.x - 120;
      y = lastMouse.y;
    }
    const mw = 220, mh = 300;
    if (y + mh > window.innerHeight - 10) y = Math.max(10, window.innerHeight - mh - 10);
    if (x + mw > window.innerWidth - 10) x = Math.max(10, window.innerWidth - mw - 10);
    if (x < window.innerWidth / 2) x = anchor ? anchor.getBoundingClientRect().right - 6 : x;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.hidden = false;

    setTimeout(() => {
      window.addEventListener('click', closeVideoMenu, { once: true });
      window.addEventListener('keydown', menuKeyHandler);
      window.addEventListener('scroll', closeVideoMenu, { once: true, capture: true });
    }, 0);
  }
  const lastMouse = { x: window.innerWidth - 260, y: 140 };
  window.addEventListener('mousemove', (e) => { lastMouse.x = e.clientX; lastMouse.y = e.clientY; });
  function menuKeyHandler(e) {
    if (e.key === 'Escape') closeVideoMenu();
  }
  function closeVideoMenu() {
    const menu = $('#vmenu');
    if (menu.hidden) return;
    menu.hidden = true;
    window.removeEventListener('keydown', menuKeyHandler);
  }

  function renameRecording(item) {
    return (async () => {
      const name = await dialog({
        title: 'Rename recording',
        input: item.title,
        okText: 'Rename'
      });
      if (name) {
        try {
          await rekzora.recordings.rename(item.id, name);
          if (currentRecording && currentRecording.id === item.id) {
            currentRecording.title = name;
            $('#player-title').textContent = name;
          }
          renderLibrary();
          toast('Renamed to "' + name + '"');
        } catch (e) {
          toast('Rename failed: ' + e.message, { level: 'error' });
        }
      }
    })();
  }

  function deleteRecording(item) {
    return (async () => {
      const ok = await dialog({
        title: 'Delete this recording?',
        sub: `"${item.title}" will be permanently deleted.`,
        okText: 'Delete', cancelText: 'Cancel'
      });
      if (ok) {
        await rekzora.recordings.remove(item.id);
        if (currentRecording && currentRecording.id === item.id) {
          $('#player-video').pause();
          $('#player-video').removeAttribute('src');
          $('#player-video').load();
          currentRecording = null;
        }
        renderLibrary();
        toast('Recording deleted.');
      }
    })();
  }

  function showProperties(item) {
    const extra = [];
    if (item.fps) extra.push(item.fps + ' fps');
    if (item.quality) extra.push(item.quality + ' quality');
    if (item.resolution) extra.push(item.resolution);
    extra.push(item.mic ? 'mic ✓' : 'mic ✗');
    extra.push(item.systemAudio ? 'system audio ✓' : 'system audio ✗');
    toast(item.title, {
      sub: `${fmtBytes(item.size)} · ${item.durationMs ? fmtDur(item.durationMs) : '—'} · ${fmtDate(item.created)} [${item.type}] · ${extra.join(' · ')}`,
      duration: 7000
    });
  }

  /* ================= share sheet ================= */
  const SHARE_GUIDE_ICO = { quickshare: '📡', shareit: '⚡', sendanywhere: '🚀', localsend: '💻', xender: '🔁', telegram: '✈️' };

  async function openShare(item, force = false) {
    const modal = $('#share');
    $('#share-name').textContent = item.title || item.fileName;
    const grid = $('#share-apps');
    const gen = $('#share-generic');
    grid.innerHTML = '<div class="share-empty">Looking for sharing apps on your PC…</div>';
    gen.innerHTML = '';
    modal.hidden = false;

    /* Drag-out tile: native OS drag & drop is the only guaranteed way to
       pre-attach a file in apps like Google Quick Share (they expose no
       CLI / share-intent). Draggable element = real file payload out. */
    const addDragTile = () => {
      grid.querySelector('.drag-tile')?.remove();
      const dt = document.createElement('div');
      dt.className = 'drag-tile';
      dt.title = 'Hold and drag this tile into an open sharing app window';
      dt.draggable = true;
      dt.ondragstart = (e) => {
        e.preventDefault(); // Qt/Electron takes over as a native file drag
        rekzora.drag.start(item.id);
      };
      const ico = document.createElement('div');
      ico.className = 'dt-ico';
      ico.textContent = '🎬';
      const txt = document.createElement('div');
      txt.className = 'dt-text';
      const t1 = document.createElement('div');
      t1.className = 'dt-title';
      t1.textContent = `Drag this tile into the app window`;
      const t2 = document.createElement('div');
      t2.className = 'dt-sub';
      t2.textContent = `Drop it on Quick Share / SHAREit / WhatsApp… to attach "${item.title || item.fileName}" and send.`;
      txt.append(t1, t2);
      const grip = document.createElement('div');
      grip.className = 'dt-grip';
      grip.textContent = '⠿';
      dt.append(ico, txt, grip);
      grid.prepend(dt);
    };
    addDragTile();

    let apps = [];
    try {
      apps = await rekzora.share.apps(force ? { force: true } : undefined);
      rekzora.log('share apps detected:', apps.map(a => a.id).join(', ') || '(none)');
    } catch (e) {
      rekzora.log('share apps error', e.message);
    }

    grid.innerHTML = '';
    if (apps.length) {
      for (const app of apps) {
        if (app.available === false) continue;   // registry says the app vanished
        const b = document.createElement('button');
        b.className = 'share-app';
        b.innerHTML = `<span class="share-ico"></span><span></span>`;
        b.querySelector('.share-ico').textContent = app.ico || SHARE_GUIDE_ICO[app.id] || '📤';
        b.querySelector('span:last-child').textContent = app.name;
        b.onclick = () => {
          /* launch by appId — the main process owns executables and args */
          rekzora.share.launch({ appId: app.id, recordingId: item.id });
          toast(`Opening ${app.name}…`, {
            sub: `Quick Share-style apps can't receive files from the command line — drag the tile into the ${app.name} window to attach "${item.title}".`,
            duration: 7000
          });
          modal.hidden = true;
        };
        grid.appendChild(b);
      }
    } else {
      const empty = document.createElement('div');
      empty.className = 'share-empty';
      empty.textContent = 'No sharing apps found (Quick Share, SHAREit, LocalSend, Send Anywhere, Xender, Telegram). Install one, or use the actions below.';
      grid.appendChild(empty);
      const refresh = document.createElement('button');
      refresh.className = 'share-app';
      refresh.innerHTML = '<span class="share-ico">🔄</span><span>Try again</span>';
      refresh.onclick = () => openShare(item, true);
      grid.appendChild(refresh);
    }
    addDragTile();

    const mkGen = (label, ico, fn) => {
      const b = document.createElement('button');
      const i = document.createElement('span');
      i.textContent = ico;
      const s = document.createElement('span');
      s.textContent = label;
      b.append(i, s);
      b.onclick = () => { modal.hidden = true; fn(); };
      gen.appendChild(b);
    };

    mkGen('Quick Share / Nearby — reveal file for manual sharing', '🪟', () => {
      rekzora.recordings.reveal(item.id);
      toast('File revealed in Explorer', {
        sub: 'Windows keeps no public "Open Nearby Sharing" API — right-click the file → Share (or the Quick Share icon) to send it. Use the buttons above for one-click app sharing.',
        duration: 9000
      });
    });
    mkGen('Choose another app…', '🧩', () => {
      rekzora.share.openWith(item.id);
    });
    mkGen('Copy file path', '📋', async () => {
      const p = await rekzora.recordings.getFilePath(item.id);
      if (p) {
        rekzora.clipboard.write(p);
        toast('File path copied — paste it into any sharing app.');
      }
    });
    mkGen('Open recordings folder', '📂', () => rekzora.recordings.openFolder());
  }

  async function openShareById(detail) {
    try {
      const items = await rekzora.recordings.list();
      const match = (detail.id && items.find(i => i.id === detail.id)) ||
        (detail.id
          ? { id: detail.id, title: (detail.fileName || '').replace(/\.webm$/i, ''), fileName: detail.fileName, size: detail.size || 0, durationMs: detail.durationMs || 0, created: Date.now(), type: 'screen' }
          : null);
      if (match) openShare(match);
    } catch { /* ignore */ }
  }

  $('#lib-search').addEventListener('input', () => renderLibrary());
  $('#lib-open-folder').onclick = () => rekzora.recordings.openFolder();
  $('#lib-change-folder').onclick = async () => {
    const dir = await rekzora.recordings.pickFolder();
    if (dir) {
      settings.saveDir = dir;
      $('#lib-folder').textContent = dir;
      renderLibrary();
      toast('Recordings folder updated.');
    }
  };

  rekzora.recordings.onChanged(() => {
    if ($('#page-library').classList.contains('active')) renderLibrary();
  });

  /* ---- player ---- */
  function openPlayer(item) {
    currentRecording = item;
    switchPage('player');
    $('#player-title').textContent = item.title || item.fileName;
    $('#player-meta').textContent =
      `${fmtBytes(item.size)} · ${item.durationMs ? fmtDur(item.durationMs) : '—'} · ${fmtDate(item.created)} · ` +
      `${item.type === 'window' ? 'Window recording' : item.type === 'region' ? 'Region recording' : 'Fullscreen recording'}` +
      (item.fps ? ` · ${item.fps} fps` : '') + (item.quality ? ` · ${item.quality}` : '');
    $('#player-video').src = videoUrl(item.id);
    $('#player-video').play().catch(() => {});
    // Native OS drag-out from the player stage
    const stage = $('.player-stage');
    stage.draggable = true;
    stage.ondragstart = (e) => {
      e.preventDefault();
      rekzora.drag.start(item.id);
    };
  }
  $('#player-back').onclick = () => {
    const v = $('#player-video');
    v.pause(); v.removeAttribute('src'); v.load();
    switchPage('library');
  };
  $('#player-reveal').onclick = () => currentRecording && rekzora.recordings.reveal(currentRecording.id);
  $('#player-share').onclick = () => currentRecording && openShare(currentRecording);
  $('#share-close').onclick = () => { $('#share').hidden = true; };
  $('#player-delete').onclick = async () => {
    if (!currentRecording) return;
    const ok = await dialog({
      title: 'Delete this recording?',
      sub: `"${currentRecording.title}" will be permanently deleted.`,
      okText: 'Delete', cancelText: 'Cancel'
    });
    if (ok) {
      await rekzora.recordings.remove(currentRecording.id);
      const v = $('#player-video');
      v.pause(); v.removeAttribute('src'); v.load();
      currentRecording = null;
      switchPage('library');
      toast('Recording deleted.');
    }
  };
  $('#player-title').onclick = async () => {
    if (!currentRecording) return;
    const name = await dialog({
      title: 'Rename recording',
      input: currentRecording.title,
      okText: 'Rename'
    });
    if (name) {
      try {
        const newId = await rekzora.recordings.rename(currentRecording.id, name);
        if (newId) currentRecording.id = newId; // ids survive renames in v1.1
        currentRecording.title = name;
        $('#player-title').textContent = name;
        toast('Renamed.');
      } catch (e) {
        toast('Rename failed: ' + e.message, { level: 'error' });
      }
    }
  };

  /* ============================================================
     SETTINGS page wiring
     ============================================================ */
  $$('#theme-seg button').forEach(b => b.onclick = () => saveSettings({ theme: b.dataset.theme }));
  $$('#countdown-seg button').forEach(b => b.onclick = () => saveSettings({ countdown: +b.dataset.countdown }));
  $$('#fps-seg button').forEach(b => b.onclick = () => saveSettings({ fps: +b.dataset.fps }));
  $$('#quality-seg button').forEach(b => b.onclick = () => saveSettings({ quality: b.dataset.quality }));

  /* Hotkey picks come from the custom themed dropdowns (makeDrop above) —
     the native <select onchange> bindings were removed with them. */
  $('#set-close-tray').onclick = () => {
    const on = $('#set-close-tray').dataset.on !== '1';
    saveSettings({ closeToTray: on });
  };
  $('#set-folder-change') && ($('#set-folder-change').onclick = async () => {
    const dir = await rekzora.recordings.pickFolder();
    if (dir) { saveSettings({ saveDir: dir }); toast('Recordings folder updated.'); }
  });

  /* ============================================================
     Boot
     ============================================================ */
  window.addEventListener('error', (e) => {
    rekzora.log('window error:', e.message, e.filename, e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    rekzora.log('unhandled rejection:', String(e.reason && e.reason.message || e.reason));
  });

  (async function boot() {
    try {
      await loadSettings();
      const info = await rekzora.meta.version();
      $('#app-version').textContent = 'v' + info.version;
      switchPage('record');
    } catch (e) {
      rekzora.log('boot failed', e.message);
      toast('Startup issue: ' + e.message, { level: 'error' });
    }
    // Enterprise-style first-run consent gate (has to come after settings)
    try {
      if (!settings.eulaAccepted) showEula();
    } catch { /* ignore */ }
    rekzora.log('UI booted');
  })();
})();
