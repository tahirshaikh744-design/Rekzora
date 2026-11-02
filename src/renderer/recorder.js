'use strict';
/* ============================================================
   Rekzora recorder engine (runs in the main window renderer)
   - prepare(cfg): acquires capture streams + builds canvas
   - commit(): starts MediaRecorder + temp-file streaming
   - start(cfg): prepare + commit (full synchronous flow)
   Pre-arming during the countdown makes hotkey starts instant.
   ============================================================ */

(function () {
  'use strict';

  const rekzora = window.rekzora;
  const State = Object.freeze({
    IDLE: 'idle', ARMED: 'armed', RECORDING: 'recording',
    PAUSED: 'paused', STOPPING: 'stopping', SAVING: 'saving'
  });

  const rec = {
    state: State.IDLE,
    session: null,        // active or prepared session
    errors: []
  };

  function setState(next, extra = {}) {
    rec.state = next;
    try { rekzora.rec.state({ state: next, ...extra }); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('rekzora:recorder-state', {
      detail: { state: next, ...extra }
    }));
  }

  function err(...a) {
    try { rekzora.log('recorder:', ...a); } catch { /* ignore */ }
  }

  /* ---------- small helpers ---------- */
  function pickMime(withAudio) {
    const candidates = withAudio
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
      for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  function withTimeout(promise, ms, label) {
    let rej;
    const timer = setTimeout(() => rej && rej(new Error(label + ' timed out')), ms);
    const wrapped = new Promise((resolve, reject) => {
      rej = reject;
      promise.then(resolve, reject);
    });
    return wrapped.finally(() => clearTimeout(timer));
  }

  function computeBitrate(quality, w, h) {
    const base = { low: 3_500_000, medium: 8_000_000, high: 14_000_000, ultra: 24_000_000 }[quality] || 8_000_000;
    const factor = (w * h) / (1920 * 1080);
    return Math.round(Math.min(42_000_000, Math.max(1_500_000, base * Math.max(0.5, factor))));
  }

  function even(n) {
    n = Math.max(2, Math.round(n));
    return n % 2 ? n - 1 : n;
  }

  function stopStream(stream) {
    if (!stream) return;
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch { /* ignore */ }
    }
  }

  function mixTracks(tracks) {
    const alive = tracks.filter(Boolean);
    if (alive.length === 0) return { track: null, ctx: null };
    if (alive.length === 1) return { track: alive[0], ctx: null };
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const dest = ctx.createMediaStreamDestination();
    for (const t of alive) {
      try {
        const src = ctx.createMediaStreamSource(new MediaStream([t]));
        if (t._rekzoraIsMic) {
          const comp = ctx.createDynamicsCompressor();
          comp.threshold.value = -18;
          comp.knee.value = 20;
          comp.ratio.value = 6;
          const g = ctx.createGain();
          g.gain.value = 0.95;
          src.connect(comp).connect(g).connect(dest);
        } else {
          src.connect(dest);
        }
      } catch (e) { err('audio mix skip', e && e.message); }
    }
    return { track: dest.stream.getAudioTracks()[0], ctx };
  }

  function cleanup(session) {
    try {
      if (!session) return;
      if (session.drawTimer) clearInterval(session.drawTimer);
      if (session.uiTimer) clearInterval(session.uiTimer);
      if (session.audioCtx && session.audioCtx.state !== 'closed') session.audioCtx.close().catch(() => {});
      stopStream(session.gdmStream);
      stopStream(session.micStream);
      stopStream(session.camStream);
      if (session.videoEl && session.videoEl.srcObject) {
        session.videoEl.srcObject = null;
        session.videoEl.remove();
      }
    } catch { /* ignore */ }
  }

  /* ---------- screen acquisition (3 robust paths) ---------- */
  async function acquireScreenStream(cfg, fps) {
    /* Path 1 (preferred): getDisplayMedia approved by the main-process
       handler, with system-audio loopback on Windows. */
    try {
      const s = await withTimeout(
        navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: !!cfg.sysAudio }),
        10000, 'getDisplayMedia'
      );
      if (s && s.getVideoTracks().length) {
        return { stream: s, sysOk: !!s.getAudioTracks().length };
      }
      throw new Error('no video track');
    } catch (e1) {
      err('getDisplayMedia failed →', e1 && e1.message);
    }

    /* Path 2: Electron desktop source via getUserMedia (with loopback). */
    if (cfg.source && cfg.source.id) {
      try {
        const audioReq = cfg.sysAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false;
        const s = await withTimeout(
          navigator.mediaDevices.getUserMedia({
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: cfg.source.id,
                maxFrameRate: fps
              }
            },
            audio: audioReq
          }),
          10000, 'desktop getUserMedia'
        );
        return { stream: s, sysOk: !!s.getAudioTracks().length };
      } catch (e2) {
        err('desktop getUserMedia failed →', e2 && e2.message);
      }
    } else {
      /* No source id (should not happen): primary screen via handler */
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { mandatory: { chromeMediaSource: 'desktop' } },
          audio: false
        });
        return { stream: s, sysOk: !!s.getAudioTracks().length };
      } catch (e2b) {
        err('desktop getUserMedia (no id) failed →', e2b && e2b.message);
      }
    }

    /* Path 3: video only, no system audio. */
    if (cfg.source && cfg.source.id) {
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: cfg.source.id,
            maxFrameRate: fps
          }
        },
        audio: false
      });
      return { stream: s, sysOk: false };
    }
    throw new Error('Could not acquire the screen');
  }

  /* ============================================================
     PREPARE — acquire everything, build the canvas pipeline,
     but do NOT create the recorder / temp file yet.
     ============================================================ */
  async function prepare(cfg) {
    if (rec.state !== State.IDLE) throw new Error('Recorder is busy');
    setState(State.ARMED);

    const session = {
      cfg,
      writeErrors: 0,
      queueDepth: 0,
      writeChain: Promise.resolve(),
      chunkQueue: Promise.resolve(),
      thumb: null,
      audioCtx: null,
      drawTimer: null,
      uiTimer: null,
      recordingId: null,
      recorder: null
    };
    rec.session = session;
    rec.pendingSession = session;

    const fps = Math.min(60, Math.max(24, Number(cfg.fps) || 30));

    try {
      /* Mic + webcam jobs START HERE (independent of screen) so all three
         acquisitions run in parallel — serial awaits cost seconds on
         hotkey starts. */
      const micJob = cfg.mic
        ? navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          }).then(mic => {
            if (rec.pendingSession !== session && rec.session !== session) {
              // aborted while still acquiring — release immediately
              mic.getTracks().forEach(tr => tr.stop());
              return null;
            }
            session.micStream = mic;
            const t = mic.getAudioTracks()[0];
            if (t) t._rekzoraIsMic = true;
            return t || null;
          }).catch(e => {
            err('mic unavailable:', e && e.message);
            window.dispatchEvent(new CustomEvent('rekzora:recorder-note', {
              detail: { level: 'warn', message: 'Microphone unavailable — recording without mic audio.' }
            }));
            return null;
          })
        : Promise.resolve(null);

      const camJob = cfg.webcam
        ? navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, frameRate: 30 }
          }).then(async cam => {
            if (rec.pendingSession !== session && rec.session !== session) {
              // aborted while still acquiring — release immediately
              cam.getTracks().forEach(tr => tr.stop());
              return null;
            }
            session.camStream = cam;
            const el = document.createElement('video');
            el.srcObject = cam;
            el.muted = true;
            el.playsInline = true;
            await el.play().catch(() => {});
            return el;
          }).catch(e => {
            err('camera unavailable:', e && e.message);
            window.dispatchEvent(new CustomEvent('rekzora:recorder-note', {
              detail: { level: 'warn', message: 'Camera unavailable — recording without webcam.' }
            }));
            return null;
          })
        : Promise.resolve(null);

      /* 1. Screen capture */
      if (cfg.source && cfg.source.id) {
        let selectOk = false;
        try { selectOk = await rekzora.capture.selectSource(cfg.source.id); } catch { /* ignore */ }
        if (!selectOk) err('selectSource returned false, continuing anyway');
      }
      const acquired = await acquireScreenStream(cfg, fps);
      const gdmStream = acquired.stream;
      session.gdmStream = gdmStream;
      const videoTrack = gdmStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('No video track from capture');
      const sysTrack = acquired.sysOk ? (gdmStream.getAudioTracks()[0] || null) : null;

      /* Mic + webcam results (already resolving in parallel) */
      const micTrack = await micJob;
      const camVideo = await camJob;

      /* 4. Decode capture into a hidden element for redraw */
      const videoEl = document.createElement('video');
      videoEl.srcObject = new MediaStream([videoTrack]);
      videoEl.muted = true;
      videoEl.playsInline = true;
      session.videoEl = videoEl;
      await new Promise((resolve, reject) => {
        videoEl.onloadedmetadata = () => resolve();
        videoEl.onerror = () => reject(new Error('Capture stream failed to load'));
        setTimeout(() => reject(new Error('Capture stream timeout')), 10000);
        videoEl.play().catch(reject);
      });
      const vw = videoEl.videoWidth || 1920;
      const vh = videoEl.videoHeight || 1080;

      /* 5. Canvas size + crop rect (device pixels) */
      const RES_CAPS = {
        '240p': 426, '360p': 640, '480p': 854, '720p': 1280,
        '1080p': 1920, '1440p': 2560, '2160p': 3840, auto: 2560
      };
      let sx = 0, sy = 0, sw = vw, sh = vh;
      if (cfg.sourceType === 'screen' && cfg.displayBounds && cfg.displayBounds.width) {
        const scale = vw / cfg.displayBounds.width;
        const r = cfg.region || { x: 0, y: 0, w: cfg.displayBounds.width, h: cfg.displayBounds.height };
        sx = Math.max(0, Math.min(vw - 1, Math.round(r.x * scale)));
        sy = Math.max(0, Math.min(vh - 1, Math.round(r.y * scale)));
        sw = even(Math.min(vw - sx, Math.round(r.w * scale)));
        sh = even(Math.min(vh - sy, Math.round(r.h * scale)));
      }
      const resCap = RES_CAPS[cfg.resolution] ?? 2560;
      const outScale = Math.min(1, resCap / Math.max(sw, sh));
      const outW = even(sw * outScale);
      const outH = even(sh * outScale);
      err('capture size:', outW + 'x' + outH, 'resolution:', cfg.resolution);

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx2d = canvas.getContext('2d', { alpha: false });
      ctx2d.imageSmoothingEnabled = true;
      ctx2d.imageSmoothingQuality = 'high';
      session.canvas = canvas;
      session.ctx = ctx2d;
      session.srcRect = { sx, sy, sw, sh };

      const draw = () => {
        try {
          ctx2d.drawImage(videoEl, sx, sy, sw, sh, 0, 0, outW, outH);
          if (camVideo && camVideo.videoWidth) {
            const size = Math.max(120, Math.min(260, Math.round(outH * 0.22)));
            const margin = Math.round(outH * 0.045);
            const cx = outW - margin - size;
            const cy = outH - margin - size;
            const radius = Math.round(size / 5);
            ctx2d.save();
            ctx2d.beginPath();
            const r2 = radius * 2;
            ctx2d.moveTo(cx + radius, cy);
            ctx2d.arcTo(cx + size, cy, cx + size, cy + size, radius);
            ctx2d.arcTo(cx + size, cy + size, cx, cy + size, radius);
            ctx2d.arcTo(cx, cy + size, cx, cy, radius);
            ctx2d.arcTo(cx, cy, cx + size, cy, radius);
            ctx2d.closePath();
            ctx2d.clip();
            const vw2 = camVideo.videoWidth, vh2 = camVideo.videoHeight;
            const sc = Math.max(size / vw2, size / vh2);
            const dw = vw2 * sc, dh = vh2 * sc;
            ctx2d.drawImage(camVideo, cx + (size - dw) / 2, cy + (size - dh) / 2, dw, dh);
            ctx2d.restore();
            ctx2d.save();
            ctx2d.beginPath();
            ctx2d.arc(cx + size, cy + size, radius, 0, Math.PI * 2);
            ctx2d.rect(cx + size - radius, cy + size - radius, radius, radius);
            ctx2d.strokeStyle = 'rgba(255,255,255,0.25)';
            ctx2d.lineWidth = Math.max(2, Math.round(outH / 400));
            ctx2d.stroke();
            ctx2d.restore();
          }
          if (!session.thumb && outW > 0) {
            try {
              const tc = document.createElement('canvas');
              const tw = 480;
              tc.width = tw;
              tc.height = even(tw * (outH / outW));
              tc.getContext('2d').drawImage(canvas, 0, 0, tc.width, tc.height);
              session.thumb = tc.toDataURL('image/jpeg', 0.55);
            } catch { /* ignore */ }
          }
        } catch { /* frame drop, keep going */ }
      };
      session.draw = draw;

      /* 6. Canvas video track, driven at exact fps */
      let outVideoStream;
      const cStream = canvas.captureStream(0);
      const cTrack = cStream.getVideoTracks()[0];
      if (cTrack && typeof cTrack.requestFrame === 'function') {
        outVideoStream = cStream;
        session.drawTimer = setInterval(() => {
          draw();
          try { cTrack.requestFrame(); } catch { /* ignore */ }
        }, 1000 / fps);
      } else {
        outVideoStream = canvas.captureStream(fps);
        session.drawTimer = setInterval(draw, 1000 / fps);
      }
      session.cTrack = cTrack;

      /* 7. Audio mixing (mic gets a light compressor) */
      const { track: audioTrack, ctx: audioCtx } = mixTracks([sysTrack, micTrack]);
      session.audioCtx = audioCtx;
      session.audioTrack = audioTrack;

      /* Source-end watch */
      videoTrack.addEventListener('ended', () => {
        err('source ended');
        if (rec.state === State.RECORDING || rec.state === State.PAUSED) stop();
      });

      /* Keep writing when the window is hidden */
      window.addEventListener('beforeunload', () => {
        if (rec.state === State.RECORDING || rec.state === State.PAUSED) stop();
      }, { once: true });

      return session;
    } catch (e) {
      err('prepare failed:', e && (e.stack || e.message));
      cleanup(session);
      rec.session = null;
      rec.pendingSession = null;
      setState(State.IDLE);
      throw e;
    }
  }

  /* ============================================================
     COMMIT — create MediaRecorder, temp file, start recording.
     ============================================================ */
  async function commit() {
    const s = rec.pendingSession || rec.session;
    if (!s || rec.state !== State.ARMED) throw new Error('Nothing prepared to commit');
    rec.pendingSession = null;

    try {
      const cTrack = s.cTrack;
      if (!cTrack || cTrack.readyState !== 'live') throw new Error('Video track lost before start');
      const mixed = new MediaStream(s.audioTrack ? [cTrack, s.audioTrack] : [cTrack]);
      const mimeType = pickMime(!!s.audioTrack);
      const outW = s.canvas.width, outH = s.canvas.height;
      const options = {
        videoBitsPerSecond: computeBitrate(s.cfg.quality, outW, outH),
        audioBitsPerSecond: 128000
      };
      if (mimeType) options.mimeType = mimeType;

      const mr = new MediaRecorder(mixed, options);
      s.recorder = mr;

      mr.addEventListener('error', (e) => {
        err('MediaRecorder ERROR:', e && e.error && (e.error.message || String(e.error)));
        window.dispatchEvent(new CustomEvent('rekzora:recorder-note', {
          detail: { level: 'error', message: 'Recorder error — the recording may be truncated.' }
        }));
      });

      mr.addEventListener('dataavailable', (e) => {
        if (!e.data || !e.data.size || !s.recordingId) return;
        const blob = e.data;
        s.queueDepth = (s.queueDepth || 0) + 1;      // bounded-chunk tracking (§11)
        s.writeChain = s.writeChain.then(async () => {
          try {
            const buf = await blob.arrayBuffer();
            await rekzora.rec.chunk(s.recordingId, new Uint8Array(buf));
            s.queueDepth = Math.max(0, (s.queueDepth || 1) - 1);
          } catch (e2) {
            s.writeErrors++;
            err('chunk write failed:', e2 && e2.message);
            if (s.writeErrors >= 5 && rec.state !== State.STOPPING) {
              window.dispatchEvent(new CustomEvent('rekzora:recorder-note', {
                detail: { level: 'error', message: 'Disk write failure — stopping recording to protect your data.' }
              }));
              stop();
            }
          }
          s.queueDepth = Math.max(0, (s.queueDepth || 1) - 1);
        });
      });

      /* 9. Begin temp file (opaque session id from the main process),
         start recorder + timers */
      const beginRes = await rekzora.rec.begin();
      s.recordingId = beginRes && beginRes.recordingId;
      if (!s.recordingId) throw new Error('Recording session was rejected by the main process');
      s.writeChain = s.writeChain.then(() => rekzora.rec.chunk(s.recordingId, new Uint8Array(0))).catch(() => {});

      s.startTs = performance.now();
      s.pausedAcc = 0;
      s.pauseTs = 0;

      mr.start(1000);
      setState(State.RECORDING);

      s.uiTimer = setInterval(() => {
        if (rec.state === State.RECORDING || rec.state === State.PAUSED) {
          const secs = Math.floor(elapsedMs() / 1000);
          try { rekzora.rec.state({ state: rec.state, seconds: secs }); } catch { /* ignore */ }
          window.dispatchEvent(new CustomEvent('rekzora:recorder-state', {
            detail: { state: rec.state, seconds: secs }
          }));
        }
      }, 500);

      return { width: outW, height: outH };
    } catch (e) {
      err('commit failed:', e && (e.stack || e.message));
      cleanup(s);
      if (s.recordingId) rekzora.rec.discard(s.recordingId).catch(() => {});
      rec.session = null;
      rec.pendingSession = null;
      setState(State.IDLE);
      throw e;
    }
  }

  /* ---------- timer ---------- */
  function elapsedMs() {
    const s = rec.session;
    if (!s || !s.startTs) return 0;
    const now = performance.now();
    const paused = s.pauseTs ? now - s.pauseTs : 0;
    return Math.max(0, now - s.startTs - s.pausedAcc - paused);
  }

  /* ---------- controls ---------- */
  function pause() {
    const s = rec.session;
    if (!s || rec.state !== State.RECORDING || !s.recorder) return;
    try {
      s.recorder.pause();
      s.pauseTs = performance.now();
      setState(State.PAUSED);
    } catch (e) { err('pause failed', e && e.message); }
  }

  function resume() {
    const s = rec.session;
    if (!s || rec.state !== State.PAUSED || !s.recorder) return;
    try {
      s.recorder.resume();
      s.pausedAcc += performance.now() - s.pauseTs;
      s.pauseTs = 0;
      setState(State.RECORDING);
    } catch (e) { err('resume failed', e && e.message); }
  }

  function togglePause() {
    if (rec.state === State.RECORDING) pause();
    else if (rec.state === State.PAUSED) resume();
  }

  function stop(discard = false) {
    const s = rec.session;
    if (!s || (rec.state !== State.RECORDING && rec.state !== State.PAUSED)) return;
    setState(State.STOPPING);
    const finish = async () => {
      // flush any pending chunk writes
      await s.writeChain.catch(() => {});
      const durationMs = Math.round(elapsedMs());
      cleanup(s);
      try {
        if (discard) {
          if (s.recordingId) await rekzora.rec.discard(s.recordingId);
          window.dispatchEvent(new CustomEvent('rekzora:recorder-saved', {
            detail: { discarded: true, durationMs }
          }));
        } else {
          const res = await rekzora.rec.finish({
            recordingId: s.recordingId,
            durationMs,
            meta: {
              type: s.cfg.sourceType || 'screen',
              sourceName: s.cfg.source ? s.cfg.source.name : null,
              region: s.cfg.region || null,
              displayBounds: s.cfg.displayBounds || null,
              fps: s.cfg.fps,
              quality: s.cfg.quality,
              resolution: s.cfg.resolution || null,
              mic: !!s.cfg.mic,
              systemAudio: !!s.audioTrack && !!s.cfg.sysAudio,
              webcam: !!s.cfg.webcam,
              thumb: s.thumb || null
            }
          });
          const status = (res && res.status) || 'completed';
          if (status === 'failed') {
            /* the main process kept the footage where possible; surface it */
            window.dispatchEvent(new CustomEvent('rekzora:recorder-error', {
              detail: {
                message: (res && res.reason) ||
                  'Could not save the recording. Nothing was lost silently — check Library recovery later.'
              }
            }));
          } else {
            if (status === 'partial') {
              window.dispatchEvent(new CustomEvent('rekzora:recorder-note', {
                detail: {
                  level: 'warn',
                  message: (res && res.reason) || 'This recording saved with missing chunks — it may be shorter than expected.'
                }
              }));
            }
            window.dispatchEvent(new CustomEvent('rekzora:recorder-saved', {
              detail: Object.assign({ discarded: false, durationMs }, res)
            }));
          }
        }
      } catch (e) {
        err('finish failed', e && e.message);
        if (s.recordingId) await rekzora.rec.discard(s.recordingId).catch(() => {});
        window.dispatchEvent(new CustomEvent('rekzora:recorder-error', {
          detail: { message: 'Could not save recording — the take was not finalized. Check disk space and permissions.' }
        }));
      }
      rec.session = null;
      rec.pendingSession = null;
      setState(State.IDLE);
    };

    if (!s.recorder || s.recorder.state === 'inactive') {
      finish();
      return;
    }
    s.recorder.addEventListener('stop', () => finish(), { once: true });
    try { s.recorder.stop(); }
    catch { finish(); }
  }

  /* Abort a pending (prepared but not committed) session */
  function abortPrepare() {
    const s = rec.pendingSession;
    if (!s) return;
    cleanup(s);
    rec.session = null;
    rec.pendingSession = null;
    setState(State.IDLE);
  }

  /* ---------- combined API ---------- */
  async function start(cfg) {
    await prepare(cfg);
    return await commit();
  }

  window.RekzoraRecorder = {
    prepare,
    commit,
    abortPrepare,
    start,
    stop: () => stop(false),
    discard: () => stop(true),
    pause,
    resume,
    togglePause,
    getState: () => rec.state,
    isBusy: () => rec.state !== State.IDLE || !!rec.pendingSession,
    elapsedMs,
    State
  };
})();
