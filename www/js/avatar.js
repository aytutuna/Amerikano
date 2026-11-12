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

  // layers are stacked sprites cut from one strip per part; px is the drawn size
  function el(parts, px) {
    const d = document.createElement('span');
    d.className = 'avt' + (px < TILE ? ' down' : '');
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

  return { COUNTS: COUNTS, valid: valid, random: random, el: el, TILE: TILE };
})();

if (typeof module !== 'undefined') module.exports = Avatar;
