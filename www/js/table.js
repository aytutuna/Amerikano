var Table = (function () {
  const $ = id => document.getElementById(id);
  const game = $('game');
  const seatsEl = $('seats');
  const minesEl = $('mine');
  const meldsEl = $('melds');
  const mlist = $('mlist');
  const hand = $('hand');
  const stockEl = $('stock');
  const discEl = $('discard');
  const actsEl = $('acts');
  const fl = $('flights');
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const HR = Cards.RATIO;
  const DASH = 2 * Math.PI * 32.5;
  // where each opponent sits, by how many opponents there are
  const SPOTS = [[], ['t'], ['tl', 'tr'], ['l', 't', 'r'], ['l', 'tl', 'tr', 'r']];

  const rackEls = new Map();
  const meldEls = new Map();
  const seatEls = new Map();
  const actEls = new Map();
  const flying = new Map();
  let prev = new Map();
  let view = null;
  let lay = null;
  let patKey = '';
  let discTop = -1;
  let discUnder = -1;
  let hide = [];
  let ring = null;

  const T = { drag: null };

  function zones(st) {
    const z = new Map();
    // forEach skips the holes that stand for hidden cards in an online match
    st.players.forEach((p, i) => p.hand.forEach(c => z.set(c.id, 'h' + i)));
    st.stock.forEach(c => z.set(c.id, 's'));
    for (const c of st.discard) z.set(c.id, 'd');
    for (const m of st.melds) for (const c of m.cards) z.set(c.id, 'm' + m.id);
    return z;
  }

  function same(a, b) {
    return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  }

  // one overlapped row: cards keep their size and close up as the hand grows
  function rackLayout(n, W) {
    const u = Stage.u;
    const w = Math.round(54 * u);
    const h = Math.round(w * HR);
    const step = n > 1 ? Math.min(Math.round(w * .76), (W - 24 * u - w) / (n - 1)) : 0;
    const x0 = (W - w - (n - 1) * step) / 2;
    const pos = [];
    for (let i = 0; i < n; i++) pos.push({ x: x0 + i * step, y: 0, w: w, h: h });
    return { w: w, h: h, step: step, pos: pos, height: h };
  }

  function putCard(el, p, i, sel) {
    el.style.width = p.w + 'px';
    el.style.height = p.h + 'px';
    el.style.setProperty('--w', p.w + 'px');
    el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
    el.style.zIndex = i;
  }

  function rackEl(c) {
    let e = rackEls.get(c.id);
    if (!e) {
      e = Cards.el(c, 'button');
      e.classList.add('rc');
      hand.appendChild(e);
      rackEls.set(c.id, e);
    }
    return e;
  }

  function rack(v, s, instant) {
    const have = new Set(v.order);
    for (const [id, e] of rackEls) {
      if (!have.has(id)) { e.remove(); rackEls.delete(id); }
    }
    lay = rackLayout(v.order.length, hand.clientWidth);
    hand.style.height = lay.height + 'px';
    const hr = hand.getBoundingClientRect();
    const els = v.order.map(id => rackEl(Game.CARDS[id]));
    // tab and swipe order follow the visual order; not mid-drag, which would drop the touch
    if (T.drag == null && els.some((e, i) => hand.children[i] !== e)) {
      const f = document.activeElement;
      for (const e of els) hand.appendChild(e);
      if (f && f !== document.activeElement && hand.contains(f)) f.focus({ preventScroll: true });
    }
    v.order.forEach((id, i) => {
      const c = Game.CARDS[id];
      const e = els[i];
      const sel = v.sel.has(id);
      const lab = Cards.title(c) + (sel ? ', ' + t('selected') : '');
      if (e.getAttribute('aria-label') !== lab) e.setAttribute('aria-label', lab);
      e.classList.toggle('sel', sel);
      if (T.drag === id) return;
      const p = lay.pos[i];
      putCard(e, p, i, sel);
      const old = s && s.btn.get(id);
      if (!instant && old && !s.live.has(id) && !still.matches) {
        const dx = old.left - (hr.left + p.x), dy = old.top - (hr.top + p.y);
        const sx = old.width / p.w;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(sx - 1) > 0.01) {
          e.animate([
            { transform: 'translate(' + (p.x + dx) + 'px,' + (p.y + dy) + 'px) scale(' + sx + ')' },
            { transform: 'translate(' + p.x + 'px,' + p.y + 'px) scale(1)' }
          ], { duration: 220, easing: 'cubic-bezier(.2,.8,.25,1)' });
        }
      }
    });
  }

  const short = n => n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? +(n / 1e3).toFixed(1) + 'K' : n.toLocaleString(I18n.lang());

  function seatEl(i) {
    const e = Cards.node('div', 'seat');
    e.setAttribute('role', 'group');
    e.dataset.p = i;
    e.innerHTML = '<span class="hf" aria-hidden="true"><i class="fc"></i><i class="fc"></i></span><span class="av" aria-hidden="true"><svg class="rg" viewBox="0 0 68 68"><circle class="rt" cx="34" cy="34" r="32.5"/><circle class="rf" cx="34" cy="34" r="32.5" transform="rotate(-90 34 34)"/></svg><span class="pf"></span><i class="cnt"></i><em class="lv"></em></span><span class="si" aria-hidden="true"><span class="nm"></span><span class="sb"><span class="sc"></span><span class="bk"></span></span><span class="tw"></span></span><button class="tap" type="button"></button>';
    e.querySelector('.av').appendChild(Cards.icon('i-check', 'ok'));
    e.querySelector('.bk').appendChild(Cards.icon('i-chip', 'chip'));
    e.querySelector('.bk').appendChild(document.createTextNode(''));
    e.querySelector('.tap').addEventListener('click', () => Social.seat(+e.dataset.p));
    return e;
  }

  function seats(v) {
    const st = v.st;
    const live = st.phase !== 'gameend' && st.phase !== 'matchend';
    const keep = new Set();
    const order = st.players.map((p, i) => i);
    let at = 0;
    for (const i of order) {
      const p = st.players[i];
      keep.add(i);
      let e = seatEls.get(i);
      if (!e) {
        e = seatEl(i);
        seatEls.set(i, e);
      }
      const mine = i === 0 && !p.bot;
      if (!i) {
        if (e.parentNode !== minesEl) minesEl.appendChild(e);
      } else if (seatsEl.children[at] !== e) seatsEl.insertBefore(e, seatsEl.children[at] || null);
      if (i) at++;
      e.classList.toggle('mine', i === 0);
      e.dataset.at = i ? SPOTS[st.n - 1][i - 1] : 'b';
      const turn = live && (st.clock ? st.clock.p === i : st.turn === i);
      e.classList.toggle('turn', turn);
      e.classList.toggle('ring', turn && (!!st.clock || mine));
      e.classList.toggle('open', p.opened);
      const av = e.querySelector('.pf');
      const parts = App.look(p, i);
      const box = Math.round(62 * Stage.u);
      const look = parts.join() + ':' + box;
      if (av.dataset.look !== look) {
        av.dataset.look = look;
        av.textContent = '';
        av.appendChild(Avatar.pic(parts, box));
      }
      const lv = e.querySelector('.lv');
      lv.textContent = p.level || '';
      lv.hidden = !p.level;
      e.querySelector('.cnt').textContent = p.hand.length;
      e.querySelector('.nm').textContent = p.name;
      e.querySelector('.sc').textContent = t('ptsShort', { n: p.score });
      const bk = e.querySelector('.bk');
      bk.hidden = p.bank === undefined;
      if (!bk.hidden) bk.lastChild.textContent = short(p.bank);
      const tap = e.querySelector('.tap');
      tap.hidden = !App.online();
      tap.setAttribute('aria-label', t('pc.title') + ': ' + p.name);
      e.classList.toggle('away', !!p.away);
      e.querySelector('.tw').textContent = p.away ? t('away') : i && !App.online() ? t('start.botTag') : '';
      e.setAttribute('aria-label', t('seat', { name: p.name, n: p.hand.length, turn: turn, opened: p.opened, score: p.score, away: p.away }));
    }
    for (const [i, e] of seatEls) {
      if (!keep.has(i)) { e.remove(); seatEls.delete(i); }
    }
    timer(st, live);
  }

  function stopRing() {
    if (!ring) return;
    ring.anim && ring.anim.cancel();
    ring.tm.forEach(clearTimeout);
    ring.rf.classList.remove('hot');
    ring = null;
  }

  // the ring drains to the moment the server plays for a stalled human; the last 5 s go red and tick on my own turn
  function timer(st, live) {
    const c = live && st.clock;
    if (!c) return stopRing();
    if (ring && ring.p === c.p && Math.abs(ring.due - c.due) < 400) return;
    stopRing();
    const e = seatEls.get(c.p);
    if (!e) return;
    const rf = e.querySelector('.rf');
    const left = Math.max(0, c.due - Date.now());
    ring = { p: c.p, due: c.due, rf: rf, anim: null, tm: [] };
    if (!still.matches) {
      ring.anim = rf.animate([{ strokeDashoffset: DASH * (1 - Math.min(1, left / c.span)) }, { strokeDashoffset: DASH }], { duration: left, easing: 'linear', fill: 'forwards' });
    }
    const warn = left - 5000;
    const mine = c.p === 0 && !st.players[0].bot;
    ring.tm.push(setTimeout(() => rf.classList.add('hot'), Math.max(0, warn)));
    if (!mine) return;
    for (let k = 5; k > 0; k--) {
      if (left > k * 1000) ring.tm.push(setTimeout(Sfx.tick, left - k * 1000));
    }
  }

  function topbar(v) {
    const st = v.st;
    const task = st.task;
    $('tname').textContent = task ? t('task', { task: task }) : t('taskNone');
    const key = task ? task.id : '';
    const sub = $('tsub');
    if (key !== patKey || !sub.firstChild) {
      patKey = key;
      sub.textContent = '';
      if (task) sub.appendChild(Cards.pattern(task));
      sub.appendChild(Cards.node('span', 'gn'));
    }
    const gn = sub.querySelector('.gn');
    const gloss = task ? t('taskSub', { task: task }) : '';
    const game = t(st.gameNo === st.games ? 'lastGame' : 'gameOf', { n: st.gameNo, of: st.games });
    gn.textContent = gloss ? game + ', ' + gloss : game;
    sub.classList.remove('nopat');
    // the other language's name is a hint, so it goes first when the line is too long
    if (gloss && gn.scrollWidth > gn.clientWidth) gn.textContent = game;
    if (gn.scrollWidth > gn.clientWidth) sub.classList.add('nopat');
    $('scl').textContent = t('score');
    $('pot').textContent = t('pot', { n: st.pot });
    $('menu').setAttribute('aria-label', t('menu'));
    $('chat').hidden = !App.online();
    $('chat').setAttribute('aria-label', t('chat.open'));
    seatsEl.setAttribute('aria-label', t('seatsLabel'));
    $('rack').setAttribute('aria-label', t('hand'));
    $('tools').setAttribute('aria-label', t('ctlLabel'));
    $('piles').setAttribute('aria-label', t('pilesLabel'));
  }

  function piles(v) {
    const st = v.st;
    if (!stockEl.firstChild) {
      stockEl.appendChild(Cards.backEl()).classList.add('pc');
      stockEl.appendChild(Cards.node('span', 'badge'));
    }
    stockEl.querySelector('.badge').textContent = st.stock.length;
    stockEl.classList.toggle('empty', !st.stock.length);
    stockEl.setAttribute('aria-label', t(v.ring === 'draw' && st.stock.length ? 'stockDraw' : 'stock', { n: st.stock.length }));
    const top = st.discard[st.discard.length - 1];
    const under = st.discard[st.discard.length - 2];
    const tid = top ? top.id : -1, uid = under ? under.id : -1;
    if (tid !== discTop || uid !== discUnder) {
      discEl.textContent = '';
      if (under) discEl.appendChild(Cards.el(under)).classList.add('dunder');
      if (top) discEl.appendChild(Cards.el(top)).classList.add('dtop');
      else discEl.appendChild(Cards.node('span', 'slot'));
      discTop = tid;
      discUnder = uid;
    }
    discEl.classList.toggle('empty', !top);
    let lab = t('discardPile', { card: top && Cards.label(top) });
    if (v.ring === 'draw' && top) lab = t('discardTake', { card: Cards.label(top) });
    else if (v.ring === 'put') lab = t('discardPut');
    discEl.setAttribute('aria-label', lab);
    stockEl.classList.toggle('ring', v.ring === 'draw' && st.stock.length > 0);
    discEl.classList.toggle('ring', (v.ring === 'draw' && !!top) || v.ring === 'claim' || v.ring === 'put');
  }

  function meldEl(m, v) {
    let r = meldEls.get(m.id);
    if (!r) {
      const e = Cards.node('div', 'meld');
      e.setAttribute('role', 'group');
      e.dataset.mid = m.id;
      r = { el: e, cards: new Map(), plus: null };
      meldEls.set(m.id, r);
    }
    return r;
  }

  function melds(v) {
    const st = v.st;
    const byOwner = new Map();
    for (const m of st.melds) {
      if (!byOwner.has(m.owner)) byOwner.set(m.owner, []);
      byOwner.get(m.owner).push(m);
    }
    const live = new Set(st.melds.map(m => m.id));
    for (const [id, r] of meldEls) {
      if (!live.has(id)) { r.el.remove(); meldEls.delete(id); }
    }
    const avail = mlist.clientWidth - 16;
    const mw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mw')) || 36;
    const cap = Math.max(30, Math.round(mw * .75));
    const groups = [...mlist.children];
    for (const g of groups) if (!byOwner.has(+g.dataset.p)) g.remove();
    let at = 0;
    st.players.forEach((p, i) => {
      const list = byOwner.get(i);
      if (!list) return;
      let g = mlist.querySelector('.grp[data-p="' + i + '"]');
      if (!g) {
        g = Cards.node('section', 'grp');
        g.dataset.p = i;
        g.appendChild(Cards.node('h2'));
        g.appendChild(Cards.node('div', 'mrow'));
      }
      if (mlist.children[at] !== g) mlist.insertBefore(g, mlist.children[at] || null);
      at++;
      const name = p.bot ? t('theirMelds', { name: p.name }) : t('yourMelds');
      const h = g.firstChild;
      if (h.textContent !== name) h.textContent = name;
      const row = g.lastChild;
      list.forEach((m, k) => {
        const r = meldEl(m, v);
        if (row.children[k] !== r.el) row.insertBefore(r.el, row.children[k] || null);
        const label = Cards.meldLabel(m);
        const who = p.bot ? p.name : t('you');
        const from = m.t === 'run' && Game.runStart(m.cards);
        const range = from ? ', ' + t('meldRange', { a: from, b: from + m.cards.length - 1 }) : '';
        r.el.setAttribute('aria-label', t('meldBy', { label: label + range, who: who }));
        r.el.style.setProperty('--st', Math.min(cap, m.cards.length > 1 ? (avail - mw) / (m.cards.length - 1) : cap) + 'px');
        const ids = new Set(m.cards.map(c => c.id));
        for (const [id, b] of r.cards) if (!ids.has(id)) { b.remove(); r.cards.delete(id); }
        m.cards.forEach((c, j) => {
          let b = r.cards.get(c.id);
          if (!b) {
            b = Cards.el(c, 'button');
            b.classList.add('mc');
            r.cards.set(c.id, b);
          }
          if (r.el.children[j] !== b) r.el.insertBefore(b, r.el.children[j] || null);
          b.setAttribute('aria-label', t('cardIn', { card: Cards.label(c), label: label }));
        });
        const tg = v.targets.has(m.id);
        r.el.classList.toggle('tg', tg);
        if (tg && !r.plus) {
          r.plus = Cards.node('button', 'plus');
          r.plus.type = 'button';
          r.plus.appendChild(Cards.icon('i-plus', 'ic'));
          r.plus.dataset.mid = m.id;
          r.el.appendChild(r.plus);
        } else if (!tg && r.plus) {
          r.plus.remove();
          r.plus = null;
        }
        if (r.plus) r.plus.setAttribute('aria-label', t('meldAdd', { label: label, more: range + ', ' + who }));
      });
    });
    // many melds: step the cards down until they fit the box instead of hiding rows below the fold
    const box = $('melds');
    box.style.removeProperty('--mw');
    const floor = Math.round(26 * Stage.u);
    for (let w = mw - 2; w >= floor && box.scrollHeight > box.clientHeight + 1; w -= 2) {
      box.style.setProperty('--mw', w + 'px');
      for (const el of mlist.querySelectorAll('.meld')) {
        const n = el.querySelectorAll('.mc').length;
        el.style.setProperty('--st', Math.min(Math.round(w * .75), n > 1 ? (avail - w) / (n - 1) : w) + 'px');
      }
    }
    $('nomelds').textContent = st.melds.length ? '' : t('noMelds');
  }

  function controls(v) {
    const s = $('status');
    if (s.textContent !== v.status) s.textContent = v.status;
    const keys = new Set(v.acts.map(a => a.key));
    for (const [k, e] of actEls) if (!keys.has(k)) { e.remove(); actEls.delete(k); }
    v.acts.forEach((a, i) => {
      let e = actEls.get(a.key);
      if (!e) {
        e = Cards.node('button', 'btn');
        e.type = 'button';
        e.dataset.key = a.key;
        actEls.set(a.key, e);
      }
      e.className = 'btn ' + (a.kind || 'plain');
      if (e.textContent !== a.label) e.textContent = a.label;
      if (actsEl.children[i] !== e) actsEl.insertBefore(e, actsEl.children[i] || null);
    });
    const b = $('sort');
    b.lastChild.textContent = v.sortLabel;
    b.setAttribute('aria-label', v.sortLabel);
    $('rinfo').textContent = v.rinfo;
    $('rinfo').hidden = !!v.mv;
    for (const [id, k, on] of [['mvl', 'moveLeft', v.mv && v.mv.l], ['mvr', 'moveRight', v.mv && v.mv.r]]) {
      const m = $(id);
      m.hidden = !v.mv;
      m.setAttribute('aria-label', t(k));
      m.setAttribute('aria-disabled', on ? 'false' : 'true');
    }
  }

  function snapshot() {
    const s = { btn: new Map(), vis: new Map(), live: new Map(), stock: stockEl.getBoundingClientRect(), disc: null, seat: new Map() };
    const top = discEl.querySelector('.dtop');
    s.disc = (top || discEl).getBoundingClientRect();
    for (const [id, e] of rackEls) {
      s.btn.set(id, e.getBoundingClientRect());
      s.vis.set(id, e.firstChild.getBoundingClientRect());
    }
    for (const r of meldEls.values()) for (const [id, b] of r.cards) s.vis.set(id, b.firstChild.getBoundingClientRect());
    for (const [i, e] of seatEls) s.seat.set(i, e.querySelector('.av').getBoundingClientRect());
    for (const [id, f] of flying) {
      s.live.set(id, f.g.getBoundingClientRect());
      f.anim.cancel();
      f.g.remove();
    }
    flying.clear();
    return s;
  }

  function anchor(r, w) {
    const h = w * HR;
    return { left: r.left + r.width / 2 - w / 2, top: r.top + r.height / 2 - h / 2, width: w, height: h };
  }

  function target(id, zone, st) {
    if (zone === 'h0') {
      const e = rackEls.get(id);
      return e && { el: e.firstChild, rect: null, face: true };
    }
    if (zone[0] === 'm') {
      const r = meldEls.get(+zone.slice(1));
      const b = r && r.cards.get(id);
      return b && { el: b.firstChild, rect: null, face: true, meld: true };
    }
    if (zone === 'd') {
      const top = st.discard[st.discard.length - 1];
      const e = top && top.id === id && discEl.querySelector('.dtop');
      return e && { el: e, rect: null, face: true };
    }
    return { el: null, rect: null, face: false };
  }

  function source(id, zone, s) {
    if (s.live.has(id)) return { rect: s.live.get(id), face: null };
    if (zone === 'h0' || zone[0] === 'm') {
      const r = s.vis.get(id);
      return r ? { rect: r, face: true } : null;
    }
    if (zone === 'd') return { rect: s.disc, face: true };
    if (zone === 's') return { rect: s.stock, face: false };
    const a = s.seat.get(+zone.slice(1));
    return a ? { rect: anchor(a, 26), face: false } : null;
  }

  function ghost(card, base, from, to, o) {
    const g = Cards.node('div', 'ghost');
    g.style.width = base.width + 'px';
    g.style.height = base.height + 'px';
    g.style.setProperty('--w', base.width + 'px');
    const gi = Cards.node('div', 'gi');
    const fr = Cards.node('div', 'gf card ' + (card.r ? 'su-' + card.s : 'su-j'));
    if (o.f0 || o.f1) fr.appendChild(Cards.face(card));
    const bk = Cards.node('div', 'gb card');
    bk.appendChild(Cards.back());
    gi.appendChild(fr);
    gi.appendChild(bk);
    g.appendChild(gi);
    fl.appendChild(g);
    const sx = from.width / base.width, sy = from.height / base.height;
    const ex = to.width / base.width, ey = to.height / base.height;
    const dur = o.dur;
    const ease = 'cubic-bezier(.2,.8,.25,1)';
    const start = 'translate(' + from.left + 'px,' + from.top + 'px) scale(' + sx + ',' + sy + ')';
    const end = 'translate(' + to.left + 'px,' + to.top + 'px) scale(' + ex + ',' + ey + ')';
    gi.style.transform = o.f0 ? 'rotateY(0)' : 'rotateY(180deg)';
    if (o.f0 !== o.f1) {
      gi.animate([{ transform: o.f0 ? 'rotateY(0)' : 'rotateY(180deg)' }, { transform: o.f1 ? 'rotateY(0)' : 'rotateY(180deg)' }],
        { duration: dur, delay: o.delay, easing: 'ease-in-out', fill: 'both' });
      gi.style.transform = '';
    }
    const kf = [{ transform: start, opacity: 1 }, { transform: end, opacity: o.fade ? 0 : 1 }];
    return g.animate(kf, { duration: dur, delay: o.delay, easing: ease, fill: 'both' });
  }

  function clamp(r) {
    const c = meldsEl.getBoundingClientRect();
    if (r.top + r.height > c.top + 4 && r.top < c.bottom - 4) return { rect: r, off: false };
    const top = r.top < c.top ? c.top : c.bottom - r.height;
    return { rect: { left: r.left, top: top, width: r.width, height: r.height }, off: true };
  }

  function fly(id, before, zone, s, st, o) {
    const dest = target(id, zone, st);
    const src = source(id, before, s);
    if (!dest || !src) return false;
    const card = Game.CARDS[id];
    const f0 = src.face === null ? dest.face : src.face;
    if (still.matches) {
      if (dest.el) dest.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: o.delay });
      return false;
    }
    let to = dest.el ? dest.el.getBoundingClientRect() : (zone === 's' ? s.stock : anchor(s.seat.get(+zone.slice(1)) || s.stock, 26));
    let off = false;
    if (dest.meld) {
      const c = clamp(to);
      to = c.rect;
      off = c.off;
    }
    const from = src.rect;
    const base = dest.el ? to : from;
    const dx = to.left - from.left, dy = to.top - from.top;
    const dur = Math.round(Math.min(320, 220 + Math.hypot(dx, dy) * 0.14));
    const anim = ghost(card, base, from, to, { dur: dur, delay: o.delay, f0: f0, f1: dest.face, fade: off || !dest.el });
    const g = fl.lastChild;
    g.style.willChange = 'transform';
    if (dest.el) hide.push(dest.el);
    const rec = { g: g, anim: anim, el: dest.el };
    flying.set(id, rec);
    const done = () => {
      g.remove();
      if (flying.get(id) !== rec) return;
      flying.delete(id);
      if (rec.el) rec.el.classList.remove('fly');
    };
    anim.onfinish = done;
    anim.oncancel = done;
    return true;
  }

  // where a card came from when it was hidden before: an opponent's hand, or the stock for my own draw
  function origin(st, id, zone) {
    if (zone === 'h0') return 's';
    if (zone[0] === 'm') {
      const m = st.melds.find(x => x.id === +zone.slice(1));
      return m && m.owner ? 'h' + m.owner : null;
    }
    const e = zone === 'd' && st.log.findLast(x => x.k === 'discard' && x.card === id);
    return e && e.p ? 'h' + e.p : null;
  }

  function flights(v, s, z, o) {
    const st = v.st;
    if (o.instant) {
      document.querySelectorAll('.fly').forEach(e => e.classList.remove('fly'));
      return;
    }
    const was = o.deal ? new Map([...z].map(([k]) => [k, 's'])) : prev;
    if (!was.size) return;
    let n = 0;
    const seen = new Map();
    const dealStep = 450 / (13 * st.n);
    for (const [id, zone] of z) {
      const before = was.get(id) || origin(st, id, zone);
      const live = s.live.has(id);
      if (!before) continue;
      if (before === zone && !live) continue;
      let delay = 0;
      if (o.deal) {
        const p = zone[0] === 'h' ? +zone.slice(1) : -1;
        if (p > 0) {
          const k = seen.get(p) || 0;
          if (k >= 5) continue;
          seen.set(p, k + 1);
          delay = (k * st.n + ((p - st.cutter + st.n) % st.n)) * dealStep;
        } else if (p === 0) {
          const k = seen.get(0) || 0;
          seen.set(0, k + 1);
          delay = (k * st.n + ((0 - st.cutter + st.n) % st.n)) * dealStep;
        } else if (zone === 'd') delay = 13 * st.n * dealStep;
        else continue;
      } else {
        delay = Math.min(n * 45, 400);
        n++;
      }
      fly(id, before, zone, s, st, { delay: delay });
    }
    // hidden together after the loop so each rect read above comes from a clean layout
    for (const e of hide) e.classList.add('fly');
    hide = [];
    const active = new Set([...flying.values()].map(r => r.el));
    document.querySelectorAll('.fly').forEach(e => { if (!active.has(e)) e.classList.remove('fly'); });
  }

  function reveal(mid) {
    const r = meldEls.get(mid);
    if (!r) return;
    const a = r.el.getBoundingClientRect(), b = meldsEl.getBoundingClientRect();
    if (a.bottom > b.bottom - 8) meldsEl.scrollTop += a.bottom - b.bottom + 12;
    else if (a.top < b.top) meldsEl.scrollTop -= b.top - a.top + 12;
  }

  function render(v, o) {
    o = o || {};
    view = v;
    const s = snapshot();
    seats(v);
    // seats drawn for the first time still give the deal something to fly to
    for (const [i, e] of seatEls) if (!s.seat.has(i)) s.seat.set(i, e.querySelector('.av').getBoundingClientRect());
    topbar(v);
    piles(v);
    melds(v);
    if (o.reveal != null) reveal(o.reveal);
    controls(v);
    rack(v, s, o.instant);
    const z = zones(v.st);
    flights(v, s, z, o);
    prev = z;
  }

  function relayout() {
    if (!view || game.hidden) return;
    seats(view);
    rack(view, null, true);
    melds(view);
  }

  function slotAt(x, y) {
    if (!lay) return -1;
    const hr = hand.getBoundingClientRect();
    let best = 0, bd = Infinity;
    lay.pos.forEach((p, i) => {
      const cx = hr.left + p.x + Math.min(p.w, lay.step) / 2;
      const cy = hr.top + p.y + p.h / 2;
      const d = Math.hypot(cx - x, (cy - y) * 1.5);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  window.addEventListener('resize', relayout);
  new ResizeObserver(relayout).observe(hand);

  T.render = render;
  T.relayout = relayout;
  T.slotAt = slotAt;
  T.rackEl = id => rackEls.get(id);
  T.seat = i => seatEls.get(i);
  T.reset = () => {
    for (const f of flying.values()) { f.anim.cancel(); f.g.remove(); }
    flying.clear();
    prev = new Map();
    stopRing();
  };

  // chips fly from every other seat to the winner's
  T.chips = to => {
    const dest = seatEls.get(to);
    if (still.matches || !dest) return;
    const d = dest.querySelector('.av').getBoundingClientRect();
    let n = 0;
    for (const [i, e] of seatEls) {
      if (i === to) continue;
      const r = e.querySelector('.av').getBoundingClientRect();
      for (let k = 0; k < 6; k++, n++) {
        const c = Cards.icon('i-chip', 'coin');
        const x0 = r.left + r.width / 2 - 11, y0 = r.top + r.height / 2 - 11;
        const dx = d.left + d.width / 2 - 11 - x0, dy = d.top + d.height / 2 - 11 - y0;
        c.style.left = x0 + 'px';
        c.style.top = y0 + 'px';
        fl.appendChild(c);
        const a = c.animate([
          { transform: 'translate(0,0) scale(.6)', opacity: 0 },
          { transform: 'translate(' + dx * .5 + 'px,' + (dy * .5 - 36) + 'px) scale(1.1)', opacity: 1, offset: .5 },
          { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.8)', opacity: 0 }
        ], { duration: 650, delay: n * 55, easing: 'ease-in-out', fill: 'backwards' });
        a.onfinish = () => c.remove();
      }
    }
    Sfx.play('place', 300);
  };
  return T;
})();
