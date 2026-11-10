var Settings = (function () {
  const KEY = 'amerikano.settings';
  const def = { lang: 'auto', speed: 'normal', sound: true, haptics: true, fourc: false, back: 'red', players: 4, games: 4, level: 'relaxed' };
  let s = Object.assign({}, def);
  try { Object.assign(s, JSON.parse(localStorage.getItem(KEY))); } catch (e) { /* first run */ }

  function apply() {
    I18n.set(s.lang);
    Sfx.set(s.sound);
    Haptic.set(s.haptics);
    document.body.classList.toggle('fourc', !!s.fourc);
    document.body.dataset.back = s.back;
  }

  function set(k, v, quiet) {
    s[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* kept for this session only */ }
    apply();
    if (!quiet && window.App) App.refresh();
  }

  return { get: k => s[k], set: set, apply: apply };
})();

var Say = (function () {
  const low = s => s.toLocaleLowerCase(I18n.lang());

  function pname(st, p) {
    return st.players[p].bot ? st.players[p].name : t('you');
  }

  function cardName(id) {
    return Cards.label(Game.CARDS[id]);
  }

  function list(ids) {
    return ids.map(cardName).join(', ');
  }

  function meldText(m) {
    return low(Cards.meldLabel({ t: m.t, cards: m.ids.map(i => Game.CARDS[i]) }));
  }

  // past: reading the log later, when the hand no longer shows which card was drawn
  function event(st, e, past) {
    const v = { name: e.p != null ? pname(st, e.p) : '', you: e.p != null && !st.players[e.p].bot };
    switch (e.k) {
      case 'game': v.n = e.n; return t('ev.game', v);
      case 'keep': return t('ev.keep', v);
      case 'top': v.card = cardName(e.card); return t('ev.top', v);
      case 'last': return t('ev.last', v);
      case 'task': v.task = low(t('task', { task: Game.TASKS.find(x => x.id === e.task) })); return t('ev.task', v);
      case 'draw': v.card = v.you && !past && st.players[0].hand.length ? cardName(drawn(st)) : ''; return t('ev.draw', v);
      case 'take':
      case 'claim':
        v.card = cardName(e.card);
        v.pen = e.k === 'claim' && v.you && !past && st.players[0].hand.length ? cardName(drawn(st)) : '';
        return t('ev.' + e.k, v);
      case 'open':
      case 'lay':
      case 'finish':
        v.melds = (e.melds ? e.melds : [{ t: e.t, ids: e.ids }]).map(meldText).join(', ');
        return t('ev.' + e.k, v);
      case 'add': {
        const m = st.melds.find(x => x.id === e.mid);
        v.cards = list(e.ids);
        v.one = e.ids.length === 1 ? cardName(e.ids[0]) : '';
        v.label = m ? low(Cards.meldLabel(m)) : t('meldAny');
        return t('ev.add', v);
      }
      case 'discard': v.card = cardName(e.card); return t('ev.discard', v);
      case 'out': return t('ev.out', v);
      case 'stockout': return t('ev.stockout');
      case 'win': return t('ev.win', v);
    }
    return '';
  }

  function drawn(st) {
    const h = st.players[0].hand;
    return h[h.length - 1].id;
  }

  return { event: event };
})();

var App = (function () {
  const KEY = 'amerikano.match';
  const DELAY = { slow: 1600, normal: 1000, fast: 520 };
  const $ = id => document.getElementById(id);
  const SORT_SUIT = { s: 0, h: 1, c: 2, d: 3 };

  const A = { order: [], sel: new Set(), hist: [] };
  let st = null;
  let armed = false;
  let sortMode = 'suit';
  let seen = 0;
  let timer = 0;
  let note = null;
  let dragIds = null;
  let askKey = '';
  let endKey = '';
  let claimKey = '';
  let alertKey = '';
  let prompt = null;

  function human() {
    return st.turn === 0 && !st.players[0].bot;
  }

  function cards(ids) {
    return ids.map(i => Game.CARDS[i]);
  }

  function selCards() {
    return cards(A.order.filter(id => A.sel.has(id)));
  }

  function syncOrder() {
    const hand = st.players[0].hand;
    const ids = new Set(hand.map(c => c.id));
    A.order = A.order.filter(id => ids.has(id));
    const have = new Set(A.order);
    for (const c of hand) if (!have.has(c.id)) A.order.push(c.id);
    for (const id of [...A.sel]) if (!ids.has(id)) A.sel.delete(id);
  }

  function sortKey(mode) {
    return id => {
      const c = Game.CARDS[id];
      if (!c.r) return 1000 + id;
      return mode === 'suit' ? SORT_SUIT[c.s] * 20 + c.r : c.r * 10 + SORT_SUIT[c.s];
    };
  }

  function sorted(mode) {
    const k = sortKey(mode);
    return A.order.every((id, i) => !i || k(A.order[i - 1]) <= k(id));
  }

  function nextSort() {
    return sorted(sortMode) ? (sortMode === 'suit' ? 'rank' : 'suit') : sortMode;
  }

  function targets() {
    const out = new Set();
    if (!st || st.phase !== 'play' || !human() || !st.players[0].opened || st.justOpened) return out;
    const c = dragIds ? cards(dragIds) : selCards();
    if (!c.length) return out;
    for (const id of Game.fits(st, c)) out.add(id);
    return out;
  }

  function planFor() {
    const sel = selCards();
    return Game.openPlan(st, sel) || (sel.length ? Game.openPlan(st) : null);
  }

  function actions() {
    const acts = [];
    if (st.phase !== 'play' || !human()) return acts;
    const p = st.players[0];
    const sel = selCards();
    const ara = st.task.id === 'ara';
    if (!p.opened) {
      if (planFor()) acts.push({ key: 'open', label: t(ara ? 'finish' : 'open') });
    } else if (!st.justOpened && sel.length >= 3 && Game.meldTypes(sel).length) {
      acts.push({ key: 'meld', label: t('meld') });
    }
    if (sel.length === 1) acts.push({ key: 'discard', label: t('discard') });
    if (acts.length) acts[0].kind = 'primary';
    if (sel.length >= 2) acts.push({ key: 'clear', label: t('clear'), kind: 'quiet' });
    return acts;
  }

  function status() {
    if (note) return note.text;
    const cur = st.players[st.turn];
    const top = st.discard[st.discard.length - 1];
    const topName = top ? Cards.label(top) : '';
    switch (st.phase) {
      case 'choose': return human() ? t('st.choose') : t('st.chooseBot', { name: cur.name });
      case 'draw': return human() ? t('st.draw', { card: topName }) : t('st.bot', { name: cur.name });
      case 'claim': {
        const c = st.players[Game.claimer(st)];
        return c.bot ? t('st.claimBot', { name: c.name, card: Cards.label(st.claim.card) }) : t('ev.claimOffer', { card: Cards.label(st.claim.card) });
      }
      case 'play': {
        if (!human()) return t('st.bot', { name: cur.name });
        const ara = st.task.id === 'ara';
        if (!cur.opened) {
          if (planFor()) return t(ara ? 'st.canFinish' : 'st.canOpen');
          const n = Game.need(st, 0) || 1;
          return t(ara ? 'st.needAra' : 'st.need', { n: n }) + (A.sel.size ? '' : ' ' + t('st.pickOne'));
        }
        return t(st.justOpened ? 'st.just' : 'st.ready');
      }
      case 'gameend': return t('st.over');
      case 'matchend': return t('st.matchOver');
    }
    return '';
  }

  function view() {
    const p = st.players[0];
    const draw = st.phase === 'draw' && human();
    return {
      st: st,
      order: A.order,
      sel: A.sel,
      targets: targets(),
      status: status(),
      acts: actions(),
      ring: draw ? 'draw' : (dragIds || A.sel.size === 1) && canDiscard() ? 'put' : null,
      mv: A.sel.size === 1 ? { l: A.order.indexOf([...A.sel][0]) > 0, r: A.order.indexOf([...A.sel][0]) < A.order.length - 1 } : null,
      sortLabel: t(nextSort() === 'suit' ? 'sortSuit' : 'sortRank'),
      rinfo: t('rackInfo', { n: p.hand.length, pts: Game.handPts(p.hand) }) + (p.opened ? ', ' + t('lipOpened') : '')
    };
  }

  function canDiscard() {
    return st.phase === 'play' && human();
  }

  function render(o) {
    syncOrder();
    const was = $('game').contains(document.activeElement);
    Table.render(view(), o);
    after();
    // the focused button or card may be gone after a move; keep the player in the game
    if (was && (!document.activeElement || document.activeElement === document.body)) land();
  }

  function land() {
    if (Sheet.count()) return;
    const to = st.phase === 'play' && human() && $('hand').querySelector('.card');
    (to || $('stock')).focus({ preventScroll: true });
  }

  function sounds() {
    let i = 0;
    for (; seen < st.log.length; seen++) {
      const e = st.log[seen];
      const text = Say.event(st, e);
      if (text) Live.say(text);
      const me = e.p === 0 && !st.players[0].bot;
      const d = i * 90;
      if (e.k === 'game') Sfx.play('deal', d);
      else if (e.k === 'draw' || e.k === 'take' || e.k === 'claim' || e.k === 'top') Sfx.play('flip', d);
      else if (e.k === 'discard' || e.k === 'lay' || e.k === 'add') Sfx.play('place', d);
      else if (e.k === 'open' || e.k === 'finish') Sfx.play('place', d);
      else continue;
      i++;
      if (me) {
        if (e.k === 'open' || e.k === 'finish') Haptic.double();
        else if (e.k === 'draw' || e.k === 'take' || e.k === 'discard') Haptic.tick();
      }
    }
  }

  function after() {
    const was = seen;
    sounds();
    if (seen !== was || alertKey !== key()) {
      alertKey = key();
      if (st.phase === 'draw' && human()) Live.urgent(t('ev.yourTurn'));
      else if (st.phase === 'choose' && human()) Live.urgent(t('ev.choose'));
    }
    record();
    save();
    if (st.phase === 'gameend' || st.phase === 'matchend') return ended();
    if (st.phase === 'choose' && human()) return ask();
    if (st.phase === 'claim' && Game.claimer(st) === 0) return offer();
    schedule();
  }

  function key() {
    return st.gameNo + ':' + st.phase + ':' + st.turn + ':' + st.turns;
  }

  // chips the finisher took from the pot, found by replaying the log
  function potGain() {
    let pot = 0;
    let g = 0;
    for (const e of st.log) {
      if (e.k === 'pot') pot = st.n * e.n;
      else if (e.k === 'claim') pot++;
      else if (e.k === 'game') g = 0;
      else if (e.k === 'out') {
        g = Math.min(5, pot);
        pot -= g;
      }
    }
    return g;
  }

  function record() {
    if (st.phase !== 'gameend' || !st.result || A.hist.length >= st.gameNo) return;
    const r = st.result;
    A.hist.push({
      n: st.gameNo,
      task: st.task.id,
      chooser: st.chooser,
      fin: r.finisher,
      got: r.finisher >= 0 ? potGain() : 0,
      rows: r.rows.map(x => ({ pts: x.pts, adj: x.adj, game: x.game, total: x.total, chips: x.chips }))
    });
  }

  function save() {
    try {
      if (st.phase === 'matchend') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify({ v: 1, st: Game.dump(st), order: A.order, sort: sortMode, hist: A.hist }));
    } catch (e) { /* storage full or blocked, the match just will not resume */ }
  }

  function read() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      const s = d && d.v === 1 && Array.isArray(d.order) && Array.isArray(d.hist) && Game.load(d.st);
      if (s) return { st: s, d: d };
    } catch (e) { /* corrupt, dropped below */ }
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    return null;
  }

  function ask() {
    const k = st.gameNo + ':' + st.turns;
    if (askKey === k || Sheet.count()) return;
    askKey = k;
    prompt = UI.askTask(st, id => run(() => Game.chooseTask(st, id)));
  }

  function ended() {
    const k = st.gameNo + ':' + st.phase;
    if (endKey === k) return;
    endKey = k;
    setTimeout(() => {
      if (!st || k !== st.gameNo + ':' + st.phase) return;
      Sheet.closeAll();
      if (st.phase === 'gameend') UI.roundEnd(st, A.nextGame);
      else UI.matchEnd(st);
    }, 900);
  }

  function offer() {
    const k = key() + ':' + st.claim.i;
    if (claimKey === k || Sheet.count()) return;
    claimKey = k;
    const c = st.claim.card;
    const body = Cards.node('div', 'offer');
    const cv = Cards.el(c);
    cv.style.setProperty('--w', '56px');
    body.appendChild(cv);
    body.appendChild(Cards.node('p', '', t('claimBody', { left: 4 - st.players[0].claims })));
    Live.urgent(t('ev.claimOffer', { card: Cards.label(c) }));
    prompt = Sheet.open({
      kind: 'above', modal: false, dismiss: false,
      title: t('claimTitle', { card: Cards.label(c) }),
      body: body,
      note: Cards.node('p', 'cost', t('costPill')),
      actions: [
        { label: t('take'), kind: 'primary', fn: () => run(() => Game.claimTake(st)) },
        { label: t('pass'), kind: 'plain', fn: () => run(() => Game.claimPass(st)) }
      ]
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = 0;
    if (!st || document.hidden || Sheet.count()) return;
    if (st.phase === 'gameend' || st.phase === 'matchend') return;
    const base = DELAY[Settings.get('speed')] || DELAY.normal;
    const w = st.phase === 'claim' ? 0.5 : st.phase === 'draw' ? 0.8 : 1;
    timer = setTimeout(() => {
      timer = 0;
      if (!st || document.hidden || Sheet.count()) return;
      if (Game.botStep(st)) { clearNote(); render(); }
    }, base * w);
  }

  function flash(text) {
    note = { text: text };
    Live.say(text);
    if (st) Table.render(view());
  }

  function clearNote() {
    note = null;
  }

  function errText(r) {
    if (r.err === 'closed' && r.ara) return t('err.closedAra');
    const s = t('err.' + r.err);
    return s === 'err.' + r.err ? t('err.other') : s;
  }

  function run(fn, o) {
    const r = fn();
    if (!r.ok) {
      flash(errText(r));
      return r;
    }
    clearNote();
    render(o);
    return r;
  }

  A.tapCard = id => {
    clearNote();
    if (A.sel.has(id)) A.sel.delete(id);
    else A.sel.add(id);
    Live.say(t('selSay', { card: Cards.label(Game.CARDS[id]), on: A.sel.has(id) }));
    render();
  };

  A.tapStock = () => {
    if (st.phase === 'draw' && human()) return run(() => Game.drawStock(st));
    flash(t('err.phase'));
  };

  A.tapDiscard = () => {
    if (st.phase === 'draw' && human()) return run(() => Game.takeDiscard(st));
    if (canDiscard()) return A.sel.size === 1 ? A.act('discard') : flash(t('st.pickOne'));
    flash(t('err.phase'));
  };

  A.addTo = (mid, ids) => {
    const c = ids ? cards(ids) : selCards();
    run(() => Game.addToMeld(st, mid, c), { reveal: mid });
  };

  function lay(c, type) {
    run(() => Game.layMeld(st, c, type), { reveal: st.mid });
  }

  A.act = k => {
    if (!st) return;
    if (k === 'clear') { A.sel.clear(); clearNote(); return render(); }
    if (!human()) return;
    const sel = selCards();
    if (k === 'discard') return run(() => Game.discard(st, sel[0]));
    if (k === 'open') {
      const plan = planFor();
      if (!plan) return flash(t('err.match'));
      return run(() => st.task.id === 'ara' ? Game.finishHand(st, plan) : Game.open(st, plan), { reveal: st.mid });
    }
    if (k === 'meld') {
      const types = Game.meldTypes(sel);
      if (types.length === 1) return lay(sel, types[0]);
      const body = Cards.node('div', 'types');
      const h = Sheet.open({
        kind: 'above', title: t('typeTitle'), body: body,
        actions: [{ label: t('cancel'), kind: 'quiet' }]
      });
      for (const ty of ['set', 'run']) {
        const b = Cards.node('button', 'btn primary');
        b.type = 'button';
        b.appendChild(Cards.node('b', '', t(ty === 'set' ? 'typeSet' : 'typeRun')));
        b.appendChild(Cards.node('span', '', t(ty === 'set' ? 'typeSetNote' : 'typeRunNote')));
        b.addEventListener('click', () => { h.close(); lay(sel, ty); });
        body.appendChild(b);
      }
    }
  };

  A.sort = () => {
    clearNote();
    sortMode = nextSort();
    const k = sortKey(sortMode);
    A.order.sort((a, b) => k(a) - k(b));
    Live.say(t('sortedSay', { suit: sortMode === 'suit' }));
    render();
  };

  function where(id) {
    Live.say(t('posSay', { card: Cards.label(Game.CARDS[id]), n: A.order.indexOf(id) + 1, of: A.order.length }));
  }

  A.moveTo = (id, i) => {
    A.order.splice(A.order.indexOf(id), 1);
    A.order.splice(i, 0, id);
    where(id);
    render();
  };

  A.move = d => {
    const id = [...A.sel][0];
    const i = A.order.indexOf(id) + d;
    if (A.sel.size !== 1) return;
    if (i < 0 || i >= A.order.length) return where(id);
    A.moveTo(id, i);
  };

  A.dragStart = id => {
    dragIds = A.sel.has(id) ? [...A.sel] : [id];
    clearNote();
    render();
  };

  A.dragOver = o => {
    document.querySelectorAll('.over').forEach(e => e.classList.remove('over'));
    if (!o) return;
    if (o.discard && canDiscard()) $('discard').classList.add('over');
    if (o.meld != null && targets().has(o.meld)) {
      const e = document.querySelector('.meld[data-mid="' + o.meld + '"]');
      if (e) e.classList.add('over');
    }
  };

  function dropErr() {
    if (!canDiscard()) return { err: 'phase' };
    if (!st.players[0].opened) return { err: 'closed', ara: st.task.id === 'ara' };
    return { err: st.justOpened ? 'wait' : 'fit' };
  }

  A.dragEnd = (id, o) => {
    const ids = dragIds;
    const ok = targets();
    dragIds = null;
    A.dragOver(null);
    if (o && o.discard && canDiscard()) return run(() => Game.discard(st, Game.CARDS[id]));
    if (o && o.meld != null && ok.has(o.meld)) return A.addTo(o.meld, ids);
    if (o && o.meld != null) flash(errText(dropErr()));
    else if (o && o.discard) flash(t('err.phase'));
    render();
  };

  A.preview = id => {
    const c = Game.CARDS[id];
    const body = Cards.node('div', 'big');
    const e = Cards.el(c);
    e.style.setProperty('--w', Math.round(Math.min(innerWidth * 0.6, 300, (innerHeight - 150) / Cards.RATIO)) + 'px');
    body.appendChild(e);
    Sheet.open({
      kind: 'center', title: t('preview', { card: Cards.label(c) }), body: body,
      actions: [{ label: t('close'), kind: 'primary' }]
    });
  };

  A.nextGame = () => {
    Game.nextGame(st);
    A.order = [];
    A.sel.clear();
    note = null;
    sortMode = 'suit';
    syncOrder();
    A.order.sort((a, b) => sortKey('suit')(a) - sortKey('suit')(b));
    render({ deal: st.phase !== 'matchend' });
  };

  A.newMatch = o => {
    st = Game.newMatch({ players: o.players, games: o.games, level: o.level, name: t('you') });
    A.order = [];
    A.sel.clear();
    A.hist = [];
    Live.clear();
    note = null;
    seen = 0;
    askKey = endKey = claimKey = alertKey = '';
    sortMode = 'suit';
    syncOrder();
    A.order.sort((a, b) => sortKey('suit')(a) - sortKey('suit')(b));
    show();
    Table.reset();
    render({ deal: true });
    if (!$('game').contains(document.activeElement)) land();
  };

  // what Continue offers, or null when nothing usable is saved
  A.saved = () => {
    const r = read();
    return r && { n: r.st.gameNo, of: r.st.games, players: r.st.n };
  };

  A.resume = () => {
    const r = read();
    if (!r) return false;
    st = r.st;
    A.order = r.d.order;
    A.hist = r.d.hist;
    A.sel.clear();
    note = null;
    sortMode = r.d.sort || 'suit';
    seen = st.log.length;
    askKey = endKey = claimKey = alertKey = '';
    show();
    Table.reset();
    try {
      render({ instant: true });
    } catch (e) {
      A.leave(true);
      return false;
    }
    if (!$('game').contains(document.activeElement)) land();
    return true;
  };

  A.leave = drop => {
    clearTimeout(timer);
    Sheet.closeAll();
    Live.clear();
    if (drop) {
      try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    }
    st = null;
    $('game').hidden = true;
    UI.start();
    const b = document.querySelector('#home [data-k=cont], #home [data-k=go]');
    if (b) b.focus({ preventScroll: true });
  };

  A.refresh = () => {
    if (prompt && document.contains(prompt.wrap)) {
      prompt.close();
      prompt = null;
      askKey = claimKey = '';
    }
    if (st && !$('game').hidden) render({ instant: true });
    else if (!$('home').hidden) UI.start(true);
  };

  A.state = () => st;
  A.active = () => !!st && !$('game').hidden;

  function show() {
    $('game').hidden = false;
    $('home').hidden = true;
    arm();
  }

  // The native shell calls this from its back button. It closes the top sheet,
  // else opens the pause menu in a match, else leaves the app.
  A.back = () => {
    if (Sheet.back()) return;
    if (A.active()) UI.pause();
    else {
      const c = window.Capacitor;
      if (c && c.Plugins && c.Plugins.App) c.Plugins.App.exitApp();
    }
  };

  // In a plain browser the back button pops a history entry, so keep one spare
  // in front of it while a sheet or a match is up.
  function arm() {
    if (armed || native()) return;
    armed = true;
    history.pushState({ amerikano: 1 }, '');
  }

  function native() {
    const c = window.Capacitor;
    return !!(c && c.Plugins && c.Plugins.App);
  }

  window.addEventListener('popstate', () => {
    armed = false;
    if (!Sheet.count() && !A.active()) return;
    arm();
    A.back();
  });

  // a prompt held back by an open sheet comes up once the last one closes
  function pending() {
    if (!st || Sheet.count() || $('game').hidden) return;
    if (st.phase === 'gameend' || st.phase === 'matchend') ended();
    else if (st.phase === 'choose' && human()) ask();
    else if (st.phase === 'claim' && Game.claimer(st) === 0) offer();
  }

  Sheet.changed = () => {
    if (Sheet.count()) arm();
    else setTimeout(pending, 0);
    schedule();
  };
  document.addEventListener('visibilitychange', schedule);
  document.addEventListener('DOMContentLoaded', () => {
    Settings.apply();
    Cards.preload();
    if (native()) {
      window.Capacitor.Plugins.App.addListener('backButton', A.back);
      launch();
    } else UI.start();
  });

  // The native splash stays up until the faces are loaded and the system bars have
  // reported their size, so the home screen is built once at its final size.
  function launch() {
    const sp = window.Capacitor.Plugins.SplashScreen;
    const html = document.documentElement;
    const probe = Cards.node('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top,0px)';
    html.appendChild(probe);
    html.classList.add('wait');
    let shown = false;
    let freed = false;
    const free = () => {
      if (freed) return;
      freed = true;
      setTimeout(() => html.classList.remove('wait'), 250);
      Promise.resolve().then(() => sp.hide({ fadeOutDuration: 200 })).catch(() => {});
    };
    const show = () => {
      if (shown) return;
      shown = true;
      probe.remove();
      UI.start();
      // the timer covers a view that is not drawing yet, where rAF would never run
      requestAnimationFrame(free);
      setTimeout(free, 100);
    };
    // never leave the player on the splash, whatever fails
    setTimeout(show, 2000);
    const text = ['start.title', 'start.go', 'start.cont', 'start.how', 'start.settings'].map(k => t(k)).join(' ');
    const faces = ['400 16px "Yeseva One"', '500 16px "Alegreya Sans"', '700 16px "Alegreya Sans"'];
    const fonts = Promise.all(faces.map(f => document.fonts.load(f, text))).catch(() => {});
    // iOS reads the insets from env() and never sets the property, so there is nothing to wait for
    const ios = !!(window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'ios');
    const bars = new Promise(res => {
      const t0 = performance.now();
      const poll = () => {
        // the bars set this property once they have reported, even when the top inset is 0
        if (ios || parseFloat(getComputedStyle(probe).paddingTop) > 0 || html.style.getPropertyValue('--safe-area-inset-top') || performance.now() - t0 > 1200) res();
        else requestAnimationFrame(poll);
      };
      poll();
    });
    Promise.all([fonts, bars]).then(show);
  }

  return A;
})();
