(function () {
  const node = Cards.node;

  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const num = I18n.num;
  const signed = n => n > 0 ? '+' + n : n < 0 ? '−' + -n : '0';
  const who = (st, i) => st.players[i].bot ? st.players[i].name : t('you');
  const mine = (st, i) => !st.players[i].bot;

  function person(st, i, out) {
    const s = node('span', 'who');
    s.appendChild(Avatar.sized(App.look(st.players[i], i), 30));
    s.appendChild(node('span', 'pn', who(st, i)));
    if (out) {
      s.appendChild(Cards.icon('jk-star', 'fin'));
      s.appendChild(node('span', 'sr', t('paper.wentOut')));
    }
    return s;
  }

  function cell(tag, text, cls) {
    const c = node(tag, cls, text);
    if (tag === 'th') c.scope = cls === 'rh' ? 'row' : 'col';
    return c;
  }

  function scroller(label, tbl) {
    const w = node('div', 'tbs');
    w.tabIndex = 0;
    w.setAttribute('role', 'region');
    w.setAttribute('aria-label', label);
    w.appendChild(tbl);
    return w;
  }

  function scoresPanel(st) {
    const box = node('div');
    box.appendChild(node('p', 'pline', t('paper.state', { n: st.gameNo, of: st.games, pot: st.pot })));
    const tbl = node('table', 'ptbl');
    tbl.appendChild(node('caption', 'sr', t('paper.caption')));
    const head = node('tr');
    head.appendChild(cell('th', t('paper.game'), 'ch'));
    st.players.forEach((p, i) => {
      const th = node('th');
      th.scope = 'col';
      th.appendChild(person(st, i));
      head.appendChild(th);
    });
    tbl.appendChild(node('thead')).appendChild(head);

    const body = node('tbody');
    const hist = App.hist;
    if (!hist.some(Boolean)) {
      const tr = node('tr');
      const td = node('td', 'empty', t('paper.none'));
      td.colSpan = st.n + 1;
      tr.appendChild(td);
      body.appendChild(tr);
    }
    for (const g of hist) {
      if (!g) continue;
      const tr = node('tr');
      tr.appendChild(cell('th', String(g.n), 'rh'));
      g.rows.forEach((r, i) => {
        const td = node('td', 'num');
        td.appendChild(node('span', '', num(r.game)));
        if (r.adj) td.appendChild(node('small', '', signed(r.adj)));
        if (g.fin === i) {
          td.appendChild(Cards.icon('jk-star', 'fin'));
          td.appendChild(node('span', 'sr', t('paper.wentOut')));
        }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
    tbl.appendChild(body);

    const foot = node('tfoot');
    const low = Math.min(...st.players.map(p => p.score));
    const tot = node('tr', 'tot');
    tot.appendChild(cell('th', t('paper.total'), 'rh'));
    st.players.forEach(p => tot.appendChild(node('td', 'num' + (p.score === low ? ' low' : ''), num(p.score))));
    foot.appendChild(tot);
    const ch = node('tr', 'chips');
    ch.appendChild(cell('th', t('paper.chips'), 'rh'));
    st.players.forEach(p => ch.appendChild(node('td', 'num', signed(p.chips))));
    foot.appendChild(ch);
    tbl.appendChild(foot);

    box.appendChild(scroller(t('paper.caption'), tbl));
    return box;
  }

  function logPanel(st) {
    const box = node('div');
    const ul = node('ul', 'plog');
    for (let i = st.log.length - 1; i >= 0 && ul.children.length < 250; i--) {
      const text = Say.event(st, st.log[i], true);
      if (text) ul.appendChild(node('li', st.log[i].k === 'game' ? 'g' : '', text));
    }
    if (!ul.children.length) box.appendChild(node('p', 'pline', t('paper.emptyLog')));
    else box.appendChild(ul);
    return box;
  }

  function tabs(panels) {
    const box = node('div');
    const bar = node('div', 'tabs');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', t('paper.tabs'));
    const btns = panels.map((p, i) => {
      const b = node('button', 'tab', p.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.id = 'tab-' + p.id;
      b.setAttribute('aria-controls', 'pan-' + p.id);
      p.el.setAttribute('role', 'tabpanel');
      p.el.id = 'pan-' + p.id;
      p.el.setAttribute('aria-labelledby', b.id);
      b.addEventListener('click', () => pick(i, false));
      bar.appendChild(b);
      return b;
    });
    function pick(i, focus) {
      btns.forEach((b, j) => {
        b.setAttribute('aria-selected', j === i ? 'true' : 'false');
        b.tabIndex = j === i ? 0 : -1;
        panels[j].el.hidden = j !== i;
      });
      if (focus) btns[i].focus();
    }
    bar.addEventListener('keydown', e => {
      const i = btns.indexOf(document.activeElement);
      const to = e.key === 'ArrowRight' ? (i + 1) % btns.length : e.key === 'ArrowLeft' ? (i + btns.length - 1) % btns.length : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : -1;
      if (to < 0 || i < 0) return;
      e.preventDefault();
      pick(to, true);
    });
    box.appendChild(bar);
    for (const p of panels) box.appendChild(p.el);
    pick(0, false);
    return box;
  }

  function score() {
    const st = App.state();
    if (!st) return;
    const body = node('div', 'pap');
    body.appendChild(tabs([
      { id: 'scores', label: t('paper.scores'), el: scoresPanel(st) },
      { id: 'log', label: t('paper.log'), el: logPanel(st) }
    ]));
    Sheet.open({ kind: 'paper', tall: true, title: t('paper.title'), body: body, actions: [{ label: t('close'), kind: 'primary' }] });
  }

  function roundEnd(st, next) {
    const r = st.result;
    const g = App.hist[st.gameNo - 1] || { got: 0 };
    const last = st.gameNo >= st.games;
    const body = node('div', 'pap');
    body.appendChild(node('p', 'pline', t('round.task', { task: t('task', { task: st.task }) })));
    const sum = r.finisher >= 0 ? t('round.out', { name: who(st, r.finisher), you: mine(st, r.finisher) }) : t('round.none');
    body.appendChild(node('p', 'pline strong', sum));

    const tbl = node('table', 'ptbl rt');
    tbl.appendChild(node('caption', 'sr', t('round.cap')));
    const head = node('tr');
    for (const k of ['player', 'hand', 'adj', 'total']) head.appendChild(cell('th', t('round.' + k), 'ch'));
    tbl.appendChild(node('thead')).appendChild(head);
    const tb = node('tbody');
    r.rows.forEach((x, i) => {
      const tr = node('tr', r.finisher === i ? 'win' : '');
      const th = node('th');
      th.scope = 'row';
      th.appendChild(person(st, i, r.finisher === i));
      tr.appendChild(th);
      tr.appendChild(node('td', 'num', String(x.pts)));
      tr.appendChild(node('td', 'num', x.adj ? signed(x.adj) : '–'));
      tr.appendChild(node('td', 'num tt', num(x.total)));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    body.appendChild(scroller(t('round.cap'), tbl));

    const notes = node('ul', 'pnotes');
    if (r.finisher >= 0 && g.got > 0) notes.appendChild(node('li', '', t('round.pot', { name: who(st, r.finisher), you: mine(st, r.finisher), n: g.got })));
    if (st.chooser >= 0) {
      const a = r.rows[st.chooser].adj;
      const k = a < 0 ? 'adjOut' : a > 0 ? 'adjNever' : 'adjNone';
      notes.appendChild(node('li', '', t('round.' + k, { name: who(st, st.chooser), you: mine(st, st.chooser) })));
    }
    if (notes.children.length) body.appendChild(notes);

    return Sheet.open({
      kind: 'paper', tall: true, title: t('round.title', { n: st.gameNo }), body: body, dismiss: false,
      actions: [{ label: t(last ? 'round.result' : 'round.next'), kind: 'primary', fn: next }]
    });
  }

  function flourish() {
    const f = node('div', 'flour');
    f.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 16; i++) {
      const s = node('i');
      s.style.setProperty('--x', (3 + i * 6) + '%');
      s.style.setProperty('--d', (i % 5) * 110 + 'ms');
      s.style.setProperty('--r', (i % 2 ? 1 : -1) * (40 + (i % 4) * 25) + 'deg');
      f.appendChild(s);
    }
    return f;
  }

  const fmt = n => Math.abs(n).toLocaleString(I18n.lang());
  const sgn = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(n);

  function count(el, from, to, ms, text) {
    if (still.matches || from === to) {
      el.textContent = text(to);
      return;
    }
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / ms);
      el.textContent = text(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1 && document.contains(el)) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const wait = ms => new Promise(r => setTimeout(r, still.matches ? 0 : ms));

  function kilim() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'hk');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<rect width="100%" height="12" fill="url(#kilim)"/>';
    return s;
  }

  // xp starts at 50n(n-1) for level n; each level gained pays 1,000 times the level, as the server does
  function xpRun(bar, label, bonus, me, add) {
    const lo = l => 50 * l * (l - 1);
    const hi = l => 50 * l * (l + 1);
    const fill = bar.firstChild;
    const frac = (l, x) => Math.max(0, Math.min(1, (x - lo(l)) / (hi(l) - lo(l)))) * 100 + '%';
    const put = (e, text) => { e.textContent = text; };
    fill.style.width = frac(me.level, me.xp);
    (async () => {
      let l = me.level;
      let x = me.xp;
      const to = me.xp + add;
      await wait(900);
      while (document.contains(bar)) {
        const end = Math.min(to, hi(l));
        const a = fill.animate([{ width: frac(l, x) }, { width: frac(l, end) }], { duration: still.matches ? 0 : 900, easing: 'ease-out', fill: 'forwards' });
        await a.finished.catch(() => {});
        fill.style.width = frac(l, end);
        a.cancel();
        x = end;
        if (to < hi(l)) return;
        l++;
        put(label, t('end.level', { n: l }));
        put(bonus, t('end.bonus', { n: fmt(1000 * l) }));
        bonus.classList.add('pop');
        label.classList.remove('pop');
        void label.offsetWidth;
        label.classList.add('pop');
        await wait(900);
        fill.style.width = '0%';
        x = lo(l);
      }
    })();
  }

  // the winner large over a kilim burst, then what the match did to my chips and xp
  function hero(st, f) {
    const w = f.low;
    const box = node('div', 'hero');
    box.appendChild(node('div', 'rays'));
    box.appendChild(kilim());
    const pic = node('div', 'hpic');
    pic.appendChild(Avatar.sized(App.look(st.players[w], w), 88));
    box.appendChild(pic);
    box.appendChild(node('h3', '', who(st, w)));
    box.appendChild(node('p', 'hpts', t('ptsShort', { n: st.players[w].score })));
    const r = st.res;
    if (r) {
      const me = Account.me();
      const res = node('div', 'hres');
      res.setAttribute('aria-label', t('end.change', { n: r.net, abs: fmt(r.net) }) + (r.xp ? ' ' + t('end.xp', { n: r.xp }) : ''));
      const row = node('div', 'hwin' + (r.net < 0 ? ' lose' : ''));
      row.appendChild(Cards.icon('i-chip', 'chip'));
      const amount = node('b', '', sgn(0));
      row.appendChild(amount);
      res.appendChild(node('p', 'hlbl', t('end.winnings')));
      res.appendChild(row);
      count(amount, 0, r.net, 1100, sgn);
      if (r.xp && me) {
        // the profile may already include this match, so start from the xp the server saw at the deal
        let lv = 1;
        while (r.from >= 50 * lv * (lv + 1)) lv++;
        const start = r.from === undefined ? me : { xp: r.from, level: lv };
        const head = node('div', 'xph');
        const label = node('span', 'lvl', t('pf.level', { n: start.level }));
        head.appendChild(label);
        head.appendChild(node('span', '', t('end.xp', { n: r.xp })));
        res.appendChild(head);
        const bar = node('div', 'xpbar');
        bar.appendChild(node('i'));
        res.appendChild(bar);
        const bonus = node('p', 'bonus');
        res.appendChild(bonus);
        xpRun(bar, label, bonus, start, r.xp);
      } else if (r.xp) res.appendChild(node('p', 'hlbl', t('end.xp', { n: r.xp })));
      box.appendChild(res);
    }
    box.appendChild(kilim());
    box.lastChild.classList.add('bot');
    return box;
  }

  function matchEnd(st) {
    const f = st.final;
    const won = mine(st, f.low);
    const body = node('div', 'pap');
    if (won) body.appendChild(flourish());
    body.appendChild(hero(st, f));

    const tbl = node('table', 'ptbl et');
    tbl.appendChild(node('caption', 'sr', t('end.cap')));
    const head = node('tr');
    for (const k of ['place', 'player', 'points', 'chips']) head.appendChild(cell('th', t('end.' + k), 'ch'));
    tbl.appendChild(node('thead')).appendChild(head);
    const tb = node('tbody');
    f.order.forEach((p, i) => {
      const tr = node('tr', i === 0 ? 'win' : '');
      tr.appendChild(cell('th', String(i + 1), 'rh'));
      const td = node('td');
      td.appendChild(person(st, p, p === f.finisher));
      tr.appendChild(td);
      tr.appendChild(node('td', 'num', num(st.players[p].score)));
      // online the pot is in chips of stake/10, as in the result above
      tr.appendChild(node('td', 'num', signed(st.res ? st.players[p].chips * st.stake / 10 : st.players[p].chips)));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    body.appendChild(scroller(t('end.cap'), tbl));

    const v = { name: who(st, f.low), you: won, pot: f.pot, lowPay: f.pay[f.low] };
    let sentence;
    if (!f.pot) sentence = t('end.empty', v);
    else if (f.finisher < 0 || f.finisher === f.low || !f.pay[f.finisher]) sentence = t('end.whole', v);
    else {
      v.fin = who(st, f.finisher);
      v.finYou = mine(st, f.finisher);
      v.finPay = f.pay[f.finisher];
      sentence = t('end.split', v);
    }
    body.appendChild(node('p', 'pline', sentence));
    if (st.res) {
      body.appendChild(node('p', 'pline', t('end.unit', { stake: st.stake.toLocaleString(I18n.lang()), unit: (st.stake / 10).toLocaleString(I18n.lang()) })));
    }

    const sheet = node('button', 'btn quiet', t('end.scores'));
    sheet.type = 'button';
    sheet.addEventListener('click', score);
    body.appendChild(sheet);

    const again = { label: t('end.again'), kind: 'primary', fn: () => App.newMatch({ players: st.n, games: st.games, level: st.level }) };
    const home = App.online()
      ? { label: t('end.lobby'), kind: 'primary', fn: () => { App.leave(true); UI.hall(st.stake); } }
      : { label: t('end.home'), kind: 'plain', fn: () => App.leave(true) };
    return Sheet.open({
      kind: 'paper', title: t('end.won', v), body: body, dismiss: false,
      actions: App.online() ? [home] : [again, home]
    });
  }

  function askTask(st, pick) {
    const hand = st.players[0].hand;
    const list = st.tasksLeft
      .map(task => ({ task: task, away: Game.away(hand, task) }))
      .sort((a, b) => a.away - b.away);
    const body = node('div', 'tasks');
    body.appendChild(node('p', 'hint', t('choice.hint')));
    const ul = node('ul', 'tl');
    list.forEach((x, i) => {
      const li = node('li');
      const b = node('button', 'tk' + (i === 0 ? ' near' : ''));
      b.type = 'button';
      b.appendChild(Cards.pattern(x.task));
      const tx = node('span', 'tt');
      tx.appendChild(node('b', '', t('task', { task: x.task })));
      b.appendChild(tx);
      b.appendChild(node('span', 'aw', t('choice.away', { n: x.away })));
      b.addEventListener('click', () => { h.close(); pick(x.task.id); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    body.appendChild(ul);
    const h = Sheet.open({ kind: 'tasks', title: t('choice.pick'), body: body, dismiss: false, modal: false });
    return h;
  }

  Object.assign(UI, { score: score, roundEnd: roundEnd, matchEnd: matchEnd, askTask: askTask });
})();
