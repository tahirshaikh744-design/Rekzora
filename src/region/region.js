'use strict';
/* Region selection overlay: dim screen, drag rectangle, confirm. */
(function () {
  const rekzora = window.rekzora;
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const hint = document.getElementById('hint');
  const sizeEl = document.getElementById('size');
  const actions = document.getElementById('actions');

  let W = 0, H = 0, dpr = 1;
  let start = null;   // {x, y}
  let rect = null;    // {x, y, w, h}
  let dragging = false;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  function norm(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y)
    };
  }

  function paint() {
    ctx.clearRect(0, 0, W, H);
    // dim layer
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    ctx.fillRect(0, 0, W, H);
    if (rect && rect.w >= 2 && rect.h >= 2) {
      // punch hole
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
      ctx.strokeStyle = 'rgba(10, 132, 255, 0.95)';
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x - 1, rect.y - 1, rect.w + 2, rect.h + 2);
      ctx.restore();
    }
  }

  function setRect(r) {
    rect = r;
    paint();
    const ok = rect && rect.w >= 20 && rect.h >= 20;
    sizeEl.hidden = !rect || !dragging ? true : false;
    if (rect && !actions.contains(document.activeElement)) {
      sizeEl.style.left = rect.x + 'px';
      sizeEl.style.top = rect.y + 'px';
      sizeEl.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
    }
    actions.hidden = !(ok && !dragging);
    sizeEl.hidden = !dragging && !ok;
  }

  cv.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    actions.hidden = true;
    start = { x: e.clientX, y: e.clientY };
    setRect({ x: start.x, y: start.y, w: 0, h: 0 });
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging || !start) return;
    const r = norm(start, { x: e.clientX, y: e.clientY });
    r.x = Math.max(0, Math.min(W - 2, r.x));
    r.y = Math.max(0, Math.min(H - 2, r.y));
    r.w = Math.min(r.w, W - r.x);
    r.h = Math.min(r.h, H - r.y);
    sizeEl.style.left = r.x + 'px';
    sizeEl.style.top = r.y + 'px';
    sizeEl.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    setRect({ ...r });
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (rect && rect.w >= 20 && rect.h >= 20) {
      actions.hidden = false;
      sizeEl.hidden = true;
    } else {
      rect = null;
      setRect(null);
    }
  });

  function confirm() {
    if (!rect || rect.w < 20 || rect.h < 20) return;
    rekzora.log('region done', Math.round(rect.w), 'x', Math.round(rect.h));
    // send logical-pixel rect relative to the display
    window.rekzora.region.sendDone({
      x: rect.x, y: rect.y, w: rect.w, h: rect.h
    });
  }
  function cancel() {
    window.rekzora.region.sendCancel();
  }
  function redo() {
    rect = null;
    actions.hidden = true;
    paint();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirm();
    else if (e.key === 'Escape') cancel();
    else if (e.key === 'r' || e.key === 'R') redo();
  });
  document.getElementById('a-confirm').onclick = confirm;
  document.getElementById('a-cancel').onclick = cancel;
  document.getElementById('a-redo').onclick = redo;

  window.RekzoraRegion = { confirm, cancel };

  window.addEventListener('resize', resize);
  resize();
  rekzora.log('region overlay ready', window.innerWidth, 'x', window.innerHeight);
})();
