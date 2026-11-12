var Avatar = (function () {
  const PARTS = ['skin', 'eyes', 'hair', 'acc'];
  const COUNTS = [9, 7, 16, 9];
  const TILE = 66;

  function valid(a) {
    return Array.isArray(a) && a.length === COUNTS.length && a.every((v, i) => Number.isInteger(v) && v >= 0 && v < COUNTS[i]);
  }

  function random() {
    const r = new Uint32Array(COUNTS.length);
    crypto.getRandomValues(r);
    return COUNTS.map((n, i) => r[i] % n);
  }

  function at(n) {
    return COUNTS.map((c, i) => {
      let h = Math.imul(n ^ Math.imul(i + 1, 0x9e3779b9), 0x85ebca6b);
      h = Math.imul(h ^ h >>> 13, 0xc2b2ae35);
      return ((h ^ h >>> 16) >>> 0) % c;
    });
  }

  // layers are stacked sprites cut from one strip per part; px is the drawn size
  function el(parts, px) {
    const d = document.createElement('span');
    d.className = 'avt' + (px % TILE ? ' down' : '');
    d.setAttribute('aria-hidden', 'true');
    d.style.width = d.style.height = px + 'px';
    PARTS.forEach((p, i) => {
      if (p === 'acc' && !parts[i]) return;
      const l = document.createElement('i');
      l.style.backgroundImage = 'url(img/avatar/' + p + '.png)';
      l.style.backgroundSize = COUNTS[i] * px + 'px ' + px + 'px';
      l.style.backgroundPosition = -parts[i] * px + 'px 0';
      d.appendChild(l);
    });
    return d;
  }

  // a round frame around the head. Below one tile the sprite is scaled smoothly, above it only by whole steps so the pixels stay even
  function pic(parts, box) {
    const want = box * 1.2;
    let px = want;
    if (want >= TILE * .85) {
      const step = TILE * Math.max(1, Math.round(want / TILE));
      // a whole step far from the frame would crop the head or leave it small, so those sizes scale smoothly
      if (step / box >= 1.05 && step / box <= 1.35) px = step;
    }
    const f = document.createElement('span');
    f.className = 'avf';
    f.style.width = f.style.height = box + 'px';
    const a = el(parts, px);
    // the head sits right of and below the middle of the tile
    const k = px / TILE;
    a.style.left = Math.round(box / 2 - 36 * k) + 'px';
    a.style.top = Math.round(box / 2 - 40 * k) + 'px';
    f.appendChild(a);
    return f;
  }

  // a pic for n stage units at the current stage size
  function sized(parts, n) {
    const box = Math.round(n * Stage.u);
    const w = document.createElement('span');
    w.className = 'apic';
    w.style.width = w.style.height = box + 'px';
    w.appendChild(pic(parts, box));
    return w;
  }

  return { COUNTS: COUNTS, valid: valid, random: random, at: at, el: el, pic: pic, sized: sized, TILE: TILE };
})();

if (typeof module !== 'undefined') module.exports = Avatar;
