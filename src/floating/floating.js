'use strict';
/* Floating control bar: receives state from main, sends actions. */
(function () {
  const rekzora = window.rekzora;
  const timeEl = document.getElementById('time');
  const dotEl = document.getElementById('dot');
  const pauseEl = document.getElementById('btn-pause');

  function fmt(secs) {
    const s = Math.max(0, secs | 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  }

  let lastSecs = 0;

  rekzora.float.onState((state) => {
    if (!state) return;
    if (state.seconds !== undefined) {
      lastSecs = state.seconds;
      timeEl.textContent = fmt(lastSecs);
    }
    const paused = state.state === 'paused';
    dotEl.classList.toggle('paused', paused);
    pauseEl.textContent = paused ? '▶' : '⏸';
  });

  document.getElementById('btn-pause').onclick = () => rekzora.float.action('pause-toggle');
  document.getElementById('btn-stop').onclick = () => rekzora.float.action('stop');

  window.addEventListener('error', (e) => rekzora.log('float error:', e.message));
  rekzora.log('floating bar ready');
})();
