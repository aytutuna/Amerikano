var Sfx = (function () {
  const names = ['deal', 'flip', 'place'];
  const bufs = {};
  let ctx = null;
  let on = true;

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    for (const n of names) {
      fetch('snd/' + n + '.wav')
        .then(r => r.arrayBuffer())
        .then(b => ctx.decodeAudioData(b))
        .then(d => { bufs[n] = d; })
        .catch(() => {});
    }
  }

  function play(n, delay) {
    if (!on || !ctx || !bufs[n]) return;
    // an interrupted or suspended context queues sounds on a frozen clock, so skip this one
    if (ctx.state !== 'running') { ctx.resume(); return; }
    const s = ctx.createBufferSource();
    s.buffer = bufs[n];
    s.connect(ctx.destination);
    s.start(ctx.currentTime + (delay || 0) / 1000);
  }

  document.addEventListener('pointerdown', init, { once: true });
  document.addEventListener('keydown', init, { once: true });

  return { play: play, set: v => { on = v; } };
})();

var Haptic = (function () {
  let on = true;

  function plugin() {
    const c = window.Capacitor;
    return c && c.Plugins && c.Plugins.Haptics;
  }

  function tick() {
    if (!on) return;
    const h = plugin();
    if (h) h.impact({ style: 'LIGHT' });
    else if (navigator.vibrate) navigator.vibrate(12);
  }

  function double() {
    if (!on) return;
    const h = plugin();
    if (h) {
      h.impact({ style: 'MEDIUM' });
      setTimeout(() => h.impact({ style: 'MEDIUM' }), 90);
    } else if (navigator.vibrate) navigator.vibrate([14, 70, 14]);
  }

  return { tick: tick, double: double, set: v => { on = v; } };
})();

var Live = (function () {
  const polite = document.getElementById('live');
  const loud = document.getElementById('alert');
  let buf = [];
  let timer = 0;
  let late = 0;

  function flush() {
    timer = 0;
    polite.textContent = buf.join(' ');
    buf = [];
  }

  function say(text) {
    buf.push(text);
    if (!timer) timer = setTimeout(flush, 60);
  }

  function urgent(text) {
    if (timer) { clearTimeout(timer); flush(); }
    loud.textContent = '';
    clearTimeout(late);
    late = setTimeout(() => { loud.textContent = text; }, 30);
  }

  function clear() {
    clearTimeout(timer);
    clearTimeout(late);
    timer = 0;
    buf = [];
    polite.textContent = '';
    loud.textContent = '';
  }

  return { say: say, urgent: urgent, clear: clear };
})();
