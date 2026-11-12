var Cards = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  const RATIO = 498 / 360;

  function icon(id, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    const u = document.createElementNS(NS, 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  }

  function node(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function artSrc(c) {
    return 'img/' + (c.r ? c.s + c.r : 'blank') + '.webp';
  }

  function face(c) {
    const cv = node('span', 'cv');
    const img = new Image();
    img.className = 'art';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.src = artSrc(c);
    cv.appendChild(img);
    const pl = node('span', 'plate');
    pl.setAttribute('aria-hidden', 'true');
    if (c.r) {
      const rk = node('b', 'rk');
      rk.dataset.r = t('short', c);
      pl.appendChild(rk);
      pl.appendChild(icon('su-' + c.s, 'su'));
    } else {
      pl.appendChild(icon('jk-star', 'su js'));
      cv.appendChild(icon('joker-art', 'jk'));
    }
    cv.appendChild(pl);
    return cv;
  }

  function back() {
    return node('span', 'cv bk');
  }

  function label(c) {
    return t('card', c);
  }

  function title(c) {
    return I18n.cap(label(c));
  }

  // Every card on screen is built here; the caller sets --w on it or a parent.
  function el(c, tag) {
    const e = node(tag || 'span', 'card ' + (c.r ? 'su-' + c.s : 'su-j'));
    if (tag === 'button') e.type = 'button';
    e.dataset.id = c.id;
    e.appendChild(face(c));
    return e;
  }

  function backEl() {
    const e = node('span', 'card');
    e.appendChild(back());
    return e;
  }

  function meldLabel(m) {
    const nat = m.cards.find(c => c.r);
    if (m.t === 'set') return t('meldSet', { what: nat ? t('plural', nat) : t('meldJokers') });
    return t('meldRun', { what: nat ? t('suit', nat) : t('meldJokers') });
  }

  function preload() {
    for (const c of Game.CARDS) if (c.id < 52) new Image().src = artSrc(c);
    for (const n of ['blank', 'red', 'blue']) new Image().src = 'img/' + n + '.webp';
  }

  // A row of small tiles per meld of the task: equal tiles for a set, rising tiles for a run.
  function pattern(task) {
    const p = node('span', 'pat');
    p.setAttribute('aria-hidden', 'true');
    if (!task.reqs.length) {
      const g = node('span', 'pg ara');
      for (let i = 0; i < 7; i++) g.appendChild(node('i'));
      p.appendChild(g);
      return p;
    }
    for (const r of task.reqs) {
      const g = node('span', 'pg ' + r.t);
      for (let i = 0; i < r.n; i++) {
        const i_ = node('i');
        if (r.t === 'run') i_.style.height = 'calc(var(--u) * ' + (5 + i * 2.5) + ')';
        g.appendChild(i_);
      }
      p.appendChild(g);
    }
    return p;
  }

  return { RATIO: RATIO, icon: icon, node: node, el: el, face: face, back: back, backEl: backEl, label: label, title: title, meldLabel: meldLabel, preload: preload, pattern: pattern };
})();
