var UI = (function () {
  const node = Cards.node;
  const $ = id => document.getElementById(id);
  const FAN = [23, 37, 104, 51, 12];
  let launched = false;
  let wait = null;
  let at = null;

  function button(label, kind, fn) {
    const b = node('button', 'btn ' + kind, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  const face = Avatar.sized;

  function raw(cls, fn) {
    const b = node('button', cls);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  // The one orchestrated moment: the fan opens once per launch, later visits show it open.
  function fan(go) {
    const f = node('div', 'fan' + (go ? ' go' : ''));
    f.setAttribute('role', 'img');
    f.setAttribute('aria-label', t('start.fan'));
    FAN.forEach((id, i) => {
      const c = Cards.el(Game.CARDS[id]);
      c.style.setProperty('--a', (i - 2) * 15 + 'deg');
      c.style.setProperty('--i', i);
      f.appendChild(c);
    });
    return f;
  }

  function start(quiet) {
    if (at && quiet) return draw();
    if (!quiet) {
      at = null;
      }
    const home = $('home');
    const keep = quiet && home.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const go = !launched && !quiet;
    launched = true;
    home.hidden = false;
    home.textContent = '';

    const main = node('main', 'hm');
    const felt = node('div', 'hm-felt felt');
    felt.appendChild(node('i', 'kil'));
    const brand = node('div', 'hm-brand');
    const h1 = node('h1', '', t('start.title'));
    brand.appendChild(h1);
    brand.appendChild(fan(go));
    felt.appendChild(brand);
    main.appendChild(felt);

    const nav = node('div', 'hm-btns');
    const mine = Account.me();
    if (Account.has() && mine) {
      const who = node('div', 'hm-who');
      who.appendChild(capsule(mine));
      who.appendChild(purse(mine));
      nav.appendChild(who);
      if (mine.daily.ready) nav.appendChild(claim(mine, 'primary', true));
    }
    if (!quiet && Account.has()) {
      const redo = () => { if (!$('home').hidden) start(true); };
      Account.refresh().then(redo, redo);
    }
    const saved = App.saved();
    const back = Net.recent();
    if (back) {
      const r = button('', 'primary big', () => {
        Net.resume();
        connecting();
      });
      r.appendChild(node('b', '', t('start.rejoin')));
      r.appendChild(node('span', '', t('start.rejoinNote', back)));
      r.dataset.k = 'back';
      nav.appendChild(r);
    }
    if (saved) {
      const c = button('', 'primary big', () => App.resume());
      c.appendChild(node('b', '', t('start.cont')));
      c.appendChild(node('span', '', t('start.saved', saved)));
      c.dataset.k = 'cont';
      nav.appendChild(c);
    }
    const o = button(t('start.online'), saved || back ? 'plain big' : 'primary big', () => enter(0));
    o.dataset.k = 'net';
    const n = button(t('start.go'), 'plain big', () => setup());
    n.dataset.k = 'go';
    nav.appendChild(o);
    nav.appendChild(n);
    const row = node('div', 'hm-row');
    const h = button(t('start.how'), 'quiet', howTo);
    h.dataset.k = 'how';
    const s = button(t('start.settings'), 'quiet', settings);
    s.dataset.k = 'set';
    row.appendChild(h);
    row.appendChild(s);
    nav.appendChild(row);
    main.appendChild(nav);
    home.appendChild(main);
    // Large system text sizes scale the title past the felt.
    document.fonts.ready.then(() => {
      const room = brand.clientWidth;
      if (h1.offsetWidth > room) h1.style.setProperty('--fit', room / h1.offsetWidth);
    });

    if (keep) {
      const e = home.querySelector('[data-k="' + keep + '"]');
      if (e) e.focus({ preventScroll: true });
    }
  }

  // Radio group drawn as pills or rows; the native input stays for keyboard and screen readers.
  function choice(name, legend, opts, cur, fn, cls) {
    const fs = node('fieldset', 'fld ' + (cls || ''));
    fs.appendChild(node('legend', '', legend));
    const wrap = node('div', 'opts');
    for (const o of opts) {
      const lab = node('label', 'opt');
      const inp = node('input');
      inp.type = 'radio';
      inp.name = name;
      inp.value = o.v;
      inp.checked = o.v === cur;
      inp.dataset.f = name + ':' + o.v;
      inp.addEventListener('change', () => fn(o.v));
      lab.appendChild(inp);
      const face = node('span', 'face');
      if (o.pic) face.appendChild(o.pic());
      face.appendChild(node('b', '', o.label));
      if (o.note) face.appendChild(node('small', '', o.note));
      lab.appendChild(face);
      wrap.appendChild(lab);
    }
    fs.appendChild(wrap);
    return fs;
  }

  function gameOptions(n) {
    const out = [];
    for (let g = n; g <= 16; g += n) out.push(g);
    return out;
  }

  function setup(room) {
    let n = Settings.get('players');
    if (![3, 4, 5].includes(n)) n = 4;
    let g = Settings.get('games');
    let lv = Settings.get('level') === 'sharp' ? 'sharp' : 'relaxed';
    const me = Account.me();
    const stakes = room && at && at.stakes ? at.stakes.filter(x => me && me.chips >= at.entry * x) : [];
    let sk = stakes[0];
    const form = node('div', 'form');
    const saved = App.saved();

    function fill() {
      const opts = gameOptions(n);
      if (!opts.includes(g)) g = opts.reduce((a, b) => Math.abs(b - g) < Math.abs(a - g) ? b : a);
      form.textContent = '';
      form.appendChild(choice('players', t('setup.players'), [3, 4, 5].map(v => ({ v: v, label: String(v) })), n, v => {
        n = v;
        fill();
        focusOn('players:' + v);
      }, 'seg'));
      const games = choice('games', t('setup.games'), opts.map(v => ({ v: v, label: String(v) })), g, v => { g = v; }, 'seg');
      games.appendChild(node('p', 'note', t('setup.gamesNote')));
      form.appendChild(games);
      form.appendChild(choice('level', t('setup.level'), [
        { v: 'relaxed', label: t('setup.relaxed'), note: t('setup.relaxedNote') },
        { v: 'sharp', label: t('setup.sharp'), note: t('setup.sharpNote') }
      ], lv, v => { lv = v; }, 'rows'));
      if (room) {
        const stake = choice('stake', t('hall.stake'), stakes.map(v => ({ v: v, label: fmt(v) })), sk, v => { sk = v; fill(); focusOn('stake:' + v); }, 'seg');
        stake.appendChild(node('p', 'note', t('hall.stakeNote', { n: fmt(sk) })));
        form.appendChild(stake);
      }
      if (saved && !room) form.appendChild(node('p', 'note', t('setup.replace')));
    }

    function focusOn(key) {
      const e = form.querySelector('[data-f="' + key + '"]');
      if (e) e.focus({ preventScroll: true });
    }

    fill();

    Sheet.open({
      kind: 'bottom', tall: true, title: t(room ? 'net.create' : 'setup.title'), body: form,
      actions: [
        {
          label: t(room ? 'net.createGo' : 'setup.go'), kind: 'primary', fn: () => {
            Settings.set('players', n, true);
            Settings.set('games', g, true);
            Settings.set('level', lv, true);
            if (room) {
              Net.create({ players: n, games: g, level: lv, stake: sk });
              connecting();
            } else App.newMatch({ players: n, games: g, level: lv });
          }
        },
        { label: t('cancel'), kind: 'quiet' }
      ]
    });
  }

  function toggle(key, label, note, extra) {
    const row = node('label', 'row');
    const id = 'tg-' + key;
    const tx = node('span', 'tx');
    const b = node('b', '', label);
    b.id = id;
    tx.appendChild(b);
    if (note) {
      const s = node('small', '', note);
      s.id = id + '-n';
      tx.appendChild(s);
    }
    if (extra) tx.appendChild(extra);
    row.appendChild(tx);
    const st = node('span', 'onoff', t(Settings.get(key) ? 'on' : 'off'));
    st.setAttribute('aria-hidden', 'true');
    row.appendChild(st);
    const inp = node('input', 'swt');
    inp.type = 'checkbox';
    inp.setAttribute('role', 'switch');
    inp.checked = !!Settings.get(key);
    inp.dataset.f = key;
    inp.setAttribute('aria-labelledby', id);
    if (note) inp.setAttribute('aria-describedby', id + '-n');
    inp.addEventListener('change', () => {
      st.textContent = t(inp.checked ? 'on' : 'off');
      Settings.set(key, inp.checked);
    });
    row.appendChild(inp);
    row.appendChild(node('span', 'track'));
    return row;
  }

  function backSwatch(v) {
    const e = node('span', 'sbk');
    e.dataset.back = v;
    e.appendChild(Cards.backEl());
    return e;
  }

  function feltSwatch(v) {
    const e = node('span', 'sfelt');
    e.dataset.felt = v;
    return e;
  }

  function settings() {
    const form = node('div', 'form');
    let h = null;

    function fill() {
      const was = document.activeElement && form.contains(document.activeElement) ? document.activeElement.dataset.f : null;
      form.textContent = '';
      form.appendChild(choice('lang', t('set.lang'), [
        { v: 'auto', label: t('set.auto') },
        { v: 'en', label: t('set.en') },
        { v: 'tr', label: t('set.tr') }
      ], Settings.get('lang'), v => { Settings.set('lang', v); fill(); if (h) h.set(t('set.title'), done()); }, 'seg'));
      form.appendChild(toggle('sound', t('set.sound')));
      form.appendChild(toggle('haptics', t('set.haptics')));
      const sw = node('span', 'suits');
      sw.setAttribute('aria-hidden', 'true');
      for (const s of ['s', 'h', 'd', 'c']) sw.appendChild(Cards.icon('su-' + s, 'su sx-' + s));
      form.appendChild(toggle('fourc', t('set.fourc'), t('set.fourcNote'), sw));
      form.appendChild(choice('speed', t('set.speed'), ['slow', 'normal', 'fast'].map(v => ({ v: v, label: t('set.' + v) })), Settings.get('speed'), v => Settings.set('speed', v), 'seg'));
      form.appendChild(choice('back', t('set.back'), ['red', 'blue', 'green', 'graphite'].map(v => ({ v: v, label: t('set.' + v), pic: () => backSwatch(v) })), Settings.get('back'), v => Settings.set('back', v), 'seg pics'));
      form.appendChild(choice('felt', t('set.felt'), ['green', 'blue', 'wine', 'walnut'].map(v => ({ v: v, label: t('set.' + v), pic: () => feltSwatch(v) })), Settings.get('felt'), v => Settings.set('felt', v), 'seg pics'));
      if (Account.has() && Account.me() && !App.active()) form.appendChild(button(t('pf.delete'), 'quiet', () => { h.close(); profile(true); }));
      if (was) {
        const e = form.querySelector('[data-f="' + was + '"]');
        if (e) e.focus({ preventScroll: true });
      }
    }

    const done = () => [{ label: t('done'), kind: 'primary' }];
    fill();
    h = Sheet.open({ kind: 'bottom', tall: true, title: t('set.title'), body: form, actions: done() });
  }

  const cid = (s, r) => ({ c: 0, d: 13, h: 26, s: 39 })[s] + r - 1;

  function demo() {
    const d = node('div', 'demo');
    for (const [key, ids] of [['set', [cid('h', 7), cid('s', 7), cid('d', 7)]], ['run', [cid('h', 4), cid('h', 5), cid('h', 6)]]]) {
      const fig = node('figure', 'fig');
      const row = node('div', 'crow');
      row.setAttribute('role', 'img');
      row.setAttribute('aria-label', I18n.cap(ids.map(i => Cards.label(Game.CARDS[i])).join(', ')));
      for (const i of ids) row.appendChild(Cards.el(Game.CARDS[i]));
      fig.appendChild(row);
      fig.appendChild(node('figcaption', '', t('how.' + key)));
      d.appendChild(fig);
    }
    return d;
  }

  function howTo() {
    const body = node('div', 'how');
    body.appendChild(node('p', 'lead', t('how.intro')));
    for (const s of t('how.secs')) {
      const sec = node('section', 'hsec');
      sec.appendChild(node('h3', '', s.h));
      if (s.demo) sec.appendChild(demo());
      for (const x of s.p) {
        const p = node('p');
        if (x[1]) {
          p.appendChild(node('span', 'tag', t('how.house')));
          p.appendChild(document.createTextNode(' '));
        }
        p.appendChild(document.createTextNode(x[0]));
        sec.appendChild(p);
      }
      body.appendChild(sec);
    }
    Sheet.open({ kind: 'bottom', tall: true, title: t('how.title'), body: body, actions: [{ label: t('close'), kind: 'primary' }] });
  }

  function pause() {
    const body = node('div', 'menu');
    const net = App.online();
    const h = Sheet.open({ kind: 'bottom', title: t(net ? 'menu' : 'pause.title'), body: body });
    const item = (label, kind, fn) => {
      body.appendChild(button(label, kind, () => { h.close(); fn(); }));
    };
    item(t('pause.resume'), 'primary', () => {});
    item(t('pause.how'), 'plain', howTo);
    item(t('pause.settings'), 'plain', settings);
    item(t('pause.leave'), 'plain', () => App.leave(false));
    body.appendChild(node('p', 'note', t(net ? 'pause.onlineNote' : 'pause.note')));
  }

  const fmt = n => n.toLocaleString(I18n.lang());
  const who = seed => Names.text(seed, I18n.lang());

  function xpBar(me) {
    const bar = node('div', 'xpbar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', t('pf.xp'));
    bar.setAttribute('aria-valuemin', me.from);
    bar.setAttribute('aria-valuemax', me.to);
    bar.setAttribute('aria-valuenow', me.xp);
    const fill = node('i');
    fill.style.width = Math.min(100, Math.max(0, (me.xp - me.from) / (me.to - me.from) * 100)) + '%';
    bar.appendChild(fill);
    return bar;
  }

  function capsule(me) {
    const b = raw('me', profile);
    b.dataset.k = 'me';
    b.setAttribute('aria-label', who(me.seed) + ', ' + t('pf.level', { n: me.level }));
    const pic = node('span', 'mypic');
    pic.appendChild(face(me.avatar, 36));
    pic.appendChild(node('em', 'lv', me.level));
    pic.setAttribute('aria-hidden', 'true');
    b.appendChild(pic);
    const tx = node('span', 'tx');
    tx.appendChild(node('b', '', who(me.seed)));
    tx.appendChild(xpBar(me));
    b.appendChild(tx);
    return b;
  }

  // the chips, with the profile behind it where a top-up lives
  function purse(me) {
    const b = raw('pq', profile);
    b.dataset.k = 'chips';
    b.setAttribute('aria-label', t('pf.chips') + ' ' + fmt(me.chips));
    b.appendChild(Cards.icon('i-chip', 'chip'));
    b.appendChild(node('b', '', fmt(me.chips)));
    b.appendChild(node('i', 'add', '+'));
    return b;
  }

  function claim(me, cls, long) {
    const d = button(t(long ? 'pf.daily' : 'pf.claim', { n: fmt(me.daily.reward) }), cls, () => {
      d.disabled = true;
      Account.daily().then(() => {
        $('live').textContent = t('pf.got', { n: fmt(me.daily.reward) });
        start(true);
      }, e => {
        d.disabled = false;
        if (e.status !== 409) return notice(t('net.err.lost'));
        Account.refresh().then(() => start(true), () => {});
      });
    });
    d.dataset.k = 'daily';
    return d;
  }

  // seven days in a row; a missed day starts the count again
  function daily(me) {
    const d = me.daily;
    const card = node('section', 'paper daily' + (d.ready ? ' ready' : ''));
    const head = node('div', 'dl-head');
    head.appendChild(node('h3', '', t('pf.dailyTitle')));
    const rew = node('span', 'chips');
    rew.appendChild(Cards.icon('i-chip', 'chip'));
    rew.appendChild(node('b', '', '+' + fmt(d.reward)));
    head.appendChild(rew);
    card.appendChild(head);
    const days = node('ol', 'days');
    const done = d.ready ? Math.min(d.streak + 1, 7) - 1 : d.streak;
    for (let i = 0; i < 7; i++) {
      const li = node('li', i < done ? 'got' : d.ready && i === done ? 'now' : '');
      if (i < done) li.appendChild(Cards.icon('i-check', 'ic'));
      else li.appendChild(node('span', '', i + 1));
      li.setAttribute('aria-label', t('pf.streakDay', { n: i + 1 }));
      days.appendChild(li);
    }
    card.appendChild(days);
    if (d.ready) card.appendChild(claim(me, 'primary', false));
    else card.appendChild(node('p', 'note', t('pf.dailyDone')));
    return card;
  }

  const LOOK = ['skin', 'eyes', 'hair', 'acc'];

  function profile(ask) {
    if (!Account.me()) return;
    const body = node('div', 'prof');
    let sure = !!ask;
    let h = null;

    function swap(me, k, v) {
      const a = me.avatar.slice();
      a[k] = v;
      return a;
    }

    function fill() {
      const me = Account.me();
      if (!me) return h && h.close();
      const was = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.f : null;
      body.textContent = '';
      const left = node('div', 'pcol');
      const right = node('div', 'pcol');
      body.appendChild(left);
      body.appendChild(right);
      const top = node('div', 'pf-top');
      top.appendChild(face(me.avatar, 100));
      const tx = node('div', 'tx');
      tx.appendChild(node('h3', '', who(me.seed)));
      tx.appendChild(node('p', '', t('pf.level', { n: me.level })));
      tx.appendChild(xpBar(me));
      tx.appendChild(node('p', 'note', t('pf.xpOf', { a: fmt(me.xp), b: fmt(me.to) })));
      top.appendChild(tx);
      left.appendChild(top);

      const stats = node('dl', 'stats');
      for (const [k, v] of [['chips', fmt(me.chips)], ['games', fmt(me.games)], ['wins', fmt(me.wins)]]) {
        const d = node('div');
        d.appendChild(node('dt', '', t('pf.' + k)));
        d.appendChild(node('dd', '', v));
        stats.appendChild(d);
      }
      left.appendChild(stats);

      const reroll = button(t('pf.reroll'), 'plain', () => {
        reroll.disabled = true;
        Account.reroll().then(fill, e => {
          reroll.disabled = false;
          notice(t(e.status === 429 ? 'pf.limit' : 'net.err.lost'));
        });
      });
      reroll.dataset.f = 'reroll';
      left.appendChild(reroll);
      if (me.bailout) {
        const b = button(t('pf.bailout'), 'primary', () => {
          b.disabled = true;
          Account.bailout().then(fill, e => {
            b.disabled = false;
            if (e.status !== 409) return notice(t('net.err.lost'));
            Account.refresh().then(fill, () => {});
          });
        });
        b.dataset.f = 'bailout';
        left.appendChild(b);
        left.appendChild(node('p', 'note', t('pf.bailoutNote')));
      }

      LOOK.forEach((part, k) => {
        const fs = node('fieldset', 'fld');
        fs.appendChild(node('legend', '', t('pf.' + part)));
        const row = node('div', 'looks');
        for (let i = 0; i < Avatar.COUNTS[k]; i++) {
          const on = me.avatar[k] === i;
          const b = node('button', 'look' + (on ? ' on' : ''));
          b.type = 'button';
          b.dataset.f = part + ':' + i;
          b.setAttribute('aria-pressed', on);
          b.setAttribute('aria-label', part === 'acc' && !i ? t('pf.none') : t('pf.' + part) + ' ' + (i + 1));
          b.appendChild(face(swap(me, k, i), 36));
          b.addEventListener('click', () => {
            const cur = Account.me();
            if (!cur || cur.avatar[k] === i) return;
            Account.look(swap(cur, k, i)).then(fill, () => notice(t('net.err.lost')));
          });
          row.appendChild(b);
        }
        fs.appendChild(row);
        right.appendChild(fs);
      });

      const del = node('div', 'danger');
      if (!sure) {
        const d = button(t('pf.delete'), 'quiet', () => { sure = true; fill(); });
        d.dataset.f = 'delete';
        del.appendChild(d);
      } else {
        const p = node('p', '', t('pf.deleteAsk'));
        p.setAttribute('role', 'alert');
        del.appendChild(p);
        const go = button(t('pf.deleteGo'), 'plain', () => {
          go.disabled = true;
          Account.remove().then(() => {
            h.close();
            exit();
          }, () => {
            go.disabled = false;
            notice(t('net.err.lost'));
          });
        });
        go.dataset.f = 'deleteGo';
        del.appendChild(go);
        const keep = button(t('pf.keep'), 'primary', () => { sure = false; fill(); });
        keep.dataset.f = 'keep';
        del.appendChild(keep);
        setTimeout(() => keep.scrollIntoView({ block: 'nearest' }), 0);
      }
      left.appendChild(del);
      if (was) {
        const e = body.querySelector('[data-f="' + was + '"]');
        if (e) e.focus({ preventScroll: true });
      }
    }

    fill();
    h = Sheet.open({ kind: 'bottom', tall: true, title: t('pf.title'), body: body, actions: [{ label: t('done'), kind: 'primary' }], onClose: () => start(true) });
  }

  // a shared link opened this, so there is nothing to ask but whether to join
  function online(code) {
    Sheet.open({
      kind: 'center', title: t('net.joinTitle', { code: code }),
      actions: [{
        label: t('net.joinGo'), kind: 'primary', fn: () => {
          connecting();
          const w = wait;
          Account.ensure().then(() => {
            if (wait !== w) return;
            close();
            Net.join(code);
            connecting();
          }, () => {
            if (wait !== w) return;
            close();
            notice(t('net.err.lost'));
          });
        }
      }, { label: t('cancel'), kind: 'quiet' }]
    });
  }

  function connecting() {
    const body = node('div', 'conn');
    body.appendChild(Cards.icon('i-chip', 'chip spin'));
    const p = node('p', 'lead', t('net.connecting'));
    p.setAttribute('role', 'status');
    body.appendChild(p);
    wait = { h: Sheet.open({ kind: 'center', title: t('net.title'), body: body, dismiss: false, actions: [{ label: t('cancel'), kind: 'plain', fn: () => { Net.cancel(); wait = null; resume(); } }] }) };
  }

  function share(code, out) {
    const url = Net.link(code);
    const copy = () => {
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => { out.textContent = t('net.copied'); }, () => { out.textContent = url; });
      else out.textContent = url;
    };
    if (navigator.share) navigator.share({ title: t('start.title'), text: t('net.shareText'), url: url }).catch(e => { if (e.name !== 'AbortError') copy(); });
    else copy();
  }

  // the seats round a small felt: who is in, and where a bot will sit
  function seatTable(m) {
    const box = node('div', 'wt-table');
    box.appendChild(node('div', 'felt wt-felt'));
    const mid = node('div', 'wt-mid');
    if (m.pub) mid.appendChild(node('b', 'plaque', fmt(m.stake)));
    else {
      const code = node('b', 'code', m.code);
      code.setAttribute('aria-label', m.code.split('').join(' '));
      mid.appendChild(code);
    }
    box.appendChild(mid);
    const n = m.seats.length;
    m.seats.forEach((s, i) => {
      const a = (i / n + .25) * 2 * Math.PI;
      const seat = node('div', 'ws' + (s ? '' : ' free'));
      seat.style.left = 50 + 33 * Math.cos(a) + '%';
      seat.style.top = 50 + 26 * Math.sin(a) + '%';
      const ring = node('span', 'wr');
      if (s && s.av) ring.appendChild(face(s.av, 36));
      seat.appendChild(ring);
      if (!s) ring.setAttribute('aria-label', t('net.bot'));
      seat.appendChild(node('span', 'wn', s ? who(s.seed) + (i === m.you ? ' ' + t('net.you') : '') : t('net.botTag')));
      box.appendChild(seat);
    });
    return box;
  }

  function lobby(m) {
    if (!wait || !wait.body || !document.contains(wait.h.wrap)) {
      close();
      const body = node('div', 'wt');
      wait = { body: body, h: Sheet.open({ kind: 'bottom', tall: true, title: t('net.room'), body: body, dismiss: false, actions: [{ label: t('net.leave'), kind: 'plain', fn: () => { Net.leave(); resume(); } }] }) };
    }
    const body = wait.body;
    body.textContent = '';
    body.appendChild(seatTable(m));
    const side = node('div', 'wt-side');
    side.appendChild(node('p', 'stake', t('hall.stakeAt', { n: fmt(m.stake) })));
    const mine = m.you === m.host;
    if (m.pub) {
      if (m.left !== null) {
        const cd = node('p', 'lead');
        cd.dataset.end = Date.now() + m.left;
        side.appendChild(cd);
      }
      side.appendChild(node('p', 'note', t('hall.fill')));
    } else side.appendChild(node('p', 'note', t(mine ? 'net.hintHost' : 'net.hintGuest')));
    side.appendChild(node('p', 'note', t('hall.stakeNote', { n: fmt(m.stake) })));
    const out = node('p', 'note');
    out.setAttribute('role', 'status');
    const acts = node('div', 'wt-acts');
    if (m.seats.includes(null)) acts.appendChild(button(t('fr.inviteFriends'), 'plain', Social.invite));
    if (!m.pub) {
      if (mine) {
        const go = button(t('net.start'), 'primary', () => {
          go.disabled = true;
          Net.send({ t: 'start' });
        });
        acts.appendChild(go);
      }
      acts.appendChild(button(t('net.share'), 'plain', () => share(m.code, out)));
    }
    side.appendChild(acts);
    side.appendChild(out);
    body.appendChild(side);
    countdown(body);
  }

  // keeps the "starts in" lines under root counting down
  function countdown(root) {
    const set = () => {
      const all = root.querySelectorAll('[data-end]');
      if (!all.length || !document.contains(root)) return clearInterval(root.tick);
      for (const e of all) e.textContent = t('hall.starts', { n: Math.max(0, Math.ceil((e.dataset.end - Date.now()) / 1000)) });
    };
    clearInterval(root.tick);
    set();
    root.tick = setInterval(set, 1000);
  }

  function enter(stake) {
    at = { stake: stake, stakes: null, entry: 10, n: {}, tables: [], tab: 'rooms' };
    draw();
    Account.ensure().then(() => Account.refresh()).then(() => {
      if (at) Net.hub();
    }, e => {
      if (!at) return;
      exit();
      notice(t(e.status === 401 ? 'net.err.auth' : 'net.err.lost'));
    });
  }

  function exit() {
    at = null;
    Net.cancel();
    start(true);
  }

  function resume() {
    if (at) enter(at.stake);
  }

  // one step back: from a room to the list, from the list to the home screen
  function up() {
    if (!at) return false;
    if (at.stake) {
      at.stake = 0;
      at.tables = [];
      Net.watch(0);
      draw();
    } else exit();
    return true;
  }

  function hub(m) {
    if (!at) return;
    at.stakes = m.stakes;
    at.entry = m.entry;
    const me = Account.me();
    if (at.stake && me && me.chips < at.entry * at.stake) at.stake = 0;
    if (at.stake) Net.watch(at.stake);
    if (me) Social.refresh().then(redraw, () => {});
    draw();
  }

  function rooms(n) {
    if (!at) return;
    at.n = n;
    draw();
  }

  function tables(stake, list) {
    if (!at || at.stake !== stake) return;
    at.tables = list.map(x => Object.assign(x, { end: x.left === null ? 0 : Date.now() + x.left }));
    draw();
  }

  const short = n => n >= 1e4 ? new Intl.NumberFormat(I18n.lang(), { notation: 'compact' }).format(n) : fmt(n);
  const redraw = () => { if (at && !$('home').hidden) draw(); };
  const afford = (me, s) => !!me && me.chips >= at.entry * s;

  // a small green oval with a seat per player that is in
  function miniTable(n) {
    const m = node('span', 'oval');
    m.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) m.appendChild(node('i', i < n ? 'on' : ''));
    return m;
  }

  function roomCards(me) {
    const list = node('div', 'rooms');
    for (const s of at.stakes) {
      const ok = afford(me, s);
      const b = raw('room', () => {
        at.stake = s;
        at.tables = [];
        Net.watch(s);
        draw();
      });
      b.disabled = !ok;
      b.dataset.k = 'room' + s;
      b.appendChild(node('b', 'plaque', short(s)));
      b.appendChild(miniTable(at.n[s] || 0));
      const meta = node('span', 'rmeta');
      meta.appendChild(node('b', '', t('hall.min', { n: fmt(at.entry * s) })));
      meta.appendChild(node('i', '', t('hall.playing', { n: fmt(at.n[s] || 0) })));
      b.appendChild(meta);
      if (!ok) {
        const lock = node('span', 'lock');
        lock.setAttribute('role', 'img');
        lock.setAttribute('aria-label', t('hall.locked'));
        lock.appendChild(Cards.icon('i-lock', 'ic'));
        b.appendChild(lock);
      }
      list.appendChild(b);
    }
    return list;
  }

  // the friends who are around, with the full list a tab away
  function friendCard() {
    const card = node('section', 'paper frc');
    const head = node('div', 'dl-head');
    head.appendChild(node('h3', '', t('fr.tab')));
    const all = raw('more', () => {
      at.tab = 'friends';
      Social.refresh().then(redraw, () => {});
      draw();
    });
    all.textContent = t('hall.all');
    all.dataset.k = 'more';
    head.appendChild(all);
    card.appendChild(head);
    const list = Social.list().slice().sort((x, y) => y.online - x.online).slice(0, 7);
    if (!list.length) card.appendChild(node('p', 'note', t('fr.none')));
    const ul = node('ul', 'fl');
    for (const p of list) {
      const li = node('li', 'frw');
      li.appendChild(face(p.avatar, 28));
      li.appendChild(node('b', '', who(p.seed)));
      const d = node('i', 'dot' + (p.online ? ' on' : ''));
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', t(p.online ? 'fr.online' : 'fr.offline'));
      li.appendChild(d);
      ul.appendChild(li);
    }
    card.appendChild(ul);
    return card;
  }

  function twoLines(cls, head, sub, fn) {
    const b = button('', cls + ' big', fn);
    b.appendChild(node('b', '', head));
    b.appendChild(node('span', '', sub));
    return b;
  }

  function friendRoom() {
    const body = node('div', 'fgrid');
    const h = Sheet.open({ kind: 'bottom', title: t('hall.friends'), body: body, actions: [{ label: t('cancel'), kind: 'quiet' }] });
    const mk = node('section', 'fbox');
    mk.appendChild(node('p', 'note', t('hall.friendsNote')));
    const go = button(t('net.create'), 'primary', () => { h.close(); setup(true); });
    go.disabled = !afford(Account.me(), at.stakes[0]);
    go.dataset.k = 'create';
    mk.appendChild(go);
    body.appendChild(mk);
    const jn = node('section', 'fbox');
    const c = node('input', 'txt code');
    c.type = 'text';
    c.maxLength = 4;
    c.placeholder = 'ABCD';
    c.dataset.k = 'code';
    c.autocomplete = 'off';
    c.autocapitalize = 'characters';
    c.spellcheck = false;
    c.setAttribute('aria-label', t('net.code'));
    const j = button(t('net.joinGo'), 'primary', () => {
      h.close();
      connecting();
      Net.join(c.value);
    });
    j.disabled = true;
    c.addEventListener('input', () => {
      c.value = c.value.toUpperCase().replace(/[^A-Z]/g, '');
      j.disabled = c.value.length !== 4;
    });
    c.addEventListener('keydown', e => { if (e.key === 'Enter' && !j.disabled) j.click(); });
    jn.appendChild(c);
    jn.appendChild(j);
    body.appendChild(jn);
  }

  function tablesTab(body, me) {
    const side = node('div', 'hl-side');
    if (me) side.appendChild(daily(me));
    side.appendChild(friendCard());
    body.appendChild(side);
    const main = node('div', 'hl-main');
    main.appendChild(node('h2', 'hl-h', t('hall.pick')));
    main.appendChild(roomCards(me));
    const play = node('div', 'hl-play');
    // the second room, or the best one the player can pay for
    const ok = at.stakes.filter(s => afford(me, s));
    const q = ok[Math.min(1, ok.length - 1)];
    const quick = twoLines('primary', t('hall.quick'), q ? t('hall.quickAt', { n: fmt(q) }) : t('hall.locked'), () => {
      connecting();
      Net.play(q);
    });
    quick.disabled = !q;
    quick.dataset.k = 'quick';
    play.appendChild(quick);
    const prac = twoLines('plain', t('start.go'), t('start.goNote'), () => { exit(); setup(); });
    prac.dataset.k = 'go';
    play.appendChild(prac);
    const fr = twoLines('plain', t('hall.friends'), t('hall.friendsNote'), friendRoom);
    fr.dataset.k = 'friends';
    play.appendChild(fr);
    main.appendChild(play);
    body.appendChild(main);
  }

  function inRoom(body) {
    const side = node('div', 'hl-side');
    const card = node('section', 'paper rcard');
    card.appendChild(node('b', 'plaque', short(at.stake)));
    card.appendChild(node('p', 'rmeta', t('hall.min', { n: fmt(at.entry * at.stake) })));
    card.appendChild(node('p', 'note', t('hall.fill')));
    side.appendChild(card);
    const quick = twoLines('primary', t('hall.quick'), t('hall.quickNote'), () => {
      connecting();
      Net.play(at.stake);
    });
    quick.dataset.k = 'quick';
    side.appendChild(quick);
    body.appendChild(side);

    const pn = node('section', 'paper pnl');
    pn.appendChild(node('h3', '', t('hall.tables')));
    const sb = node('div', 'sbody');
    pn.appendChild(sb);
    body.appendChild(pn);
    if (!at.tables.length) return sb.appendChild(node('p', 'note', t('hall.none')));
    const ul = node('ul', 'tbls');
    for (const x of at.tables) {
      const li = node('li');
      const b = raw('tbl', () => {
        connecting();
        Net.sit(x.code);
      });
      b.dataset.k = 'sit' + x.code;
      const faces = node('span', 'faces');
      for (const s of x.seats) faces.appendChild(s ? face(s.av, 30) : node('span', 'none'));
      b.appendChild(faces);
      const tx = node('span', 'tx');
      tx.appendChild(node('b', '', t('hall.seated', { n: x.seats.filter(Boolean).length })));
      tx.appendChild(node('small', '', x.seats.filter(Boolean).map(s => who(s.seed) + ' ' + t('hall.level', { n: s.level })).join(', ')));
      b.appendChild(tx);
      if (x.left !== null) {
        const cd = node('small', 'cd');
        cd.dataset.end = x.end;
        b.appendChild(cd);
      }
      li.appendChild(b);
      ul.appendChild(li);
    }
    sb.appendChild(ul);
  }

  function tabs(bar) {
    const list = node('div', 'tabs');
    list.setAttribute('role', 'tablist');
    for (const [k, label] of [['rooms', t('hall.rooms')], ['friends', t('fr.tab')], ['top', t('top.tab')]]) {
      const b = raw('tab', () => {
        at.tab = k;
        if (k === 'friends') Social.refresh().then(redraw, () => {});
        if (k === 'top') Social.top().then(redraw, () => {});
        draw();
      });
      b.textContent = label;
      b.dataset.k = 'tab' + k;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', at.tab === k);
      list.appendChild(b);
    }
    bar.appendChild(list);
  }

  function hallBar(me) {
    const bar = node('div', 'hl-top');
    const back = raw('ib', up);
    back.dataset.k = 'back';
    back.setAttribute('aria-label', t('hall.back'));
    back.appendChild(Cards.icon('i-left', 'ic'));
    bar.appendChild(back);
    if (me) bar.appendChild(capsule(me));
    if (at.stake) bar.appendChild(node('h2', 'hl-room', t('hall.room', { n: fmt(at.stake) })));
    else tabs(bar);
    const end = node('div', 'hl-end');
    if (me) end.appendChild(purse(me));
    const gear = raw('ib', settings);
    gear.dataset.k = 'set';
    gear.setAttribute('aria-label', t('start.settings'));
    gear.appendChild(Cards.icon('i-gear', 'ic'));
    end.appendChild(gear);
    bar.appendChild(end);
    return bar;
  }

  // an invitation from a friend, taken up from the lobby
  function accept(m) {
    connecting();
    if (m.pub) Net.sit(m.code);
    else Net.join(m.code);
  }

  // The lobby is a screen of its own in the home container: the stake rooms, and inside one its open tables.
  function draw() {
    const home = $('home');
    const keep = home.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const sb = home.querySelector('.sbody');
    const top = sb ? sb.scrollTop : 0;
    home.hidden = false;
    home.textContent = '';
    const me = Account.me();
    home.appendChild(hallBar(me));
    const body = node('main', 'hl-body');
    if (!at.stakes) {
      const w = node('div', 'conn');
      w.appendChild(Cards.icon('i-chip', 'chip spin'));
      const p = node('p', 'lead', t('net.connecting'));
      p.setAttribute('role', 'status');
      w.appendChild(p);
      body.appendChild(w);
    } else if (at.stake) inRoom(body);
    else if (at.tab === 'rooms') tablesTab(body, me);
    else {
      const pn = node('section', 'paper pnl');
      const box = pn.appendChild(node('div', 'sbody frs'));
      if (at.tab === 'friends') Social.friends(box, { again: redraw });
      else Social.leaders(box, redraw);
      body.appendChild(pn);
    }
    home.appendChild(body);
    countdown(home);
    const now = home.querySelector('.sbody');
    if (now) now.scrollTop = top;
    if (keep) {
      const e = home.querySelector('[data-k="' + keep + '"]');
      if (e) e.focus({ preventScroll: true });
    }
  }

  // the lobby or the connecting sheet, whichever is up
  function close() {
    if (wait) wait.h.close();
    wait = null;
  }

  function notice(text) {
    Sheet.open({ kind: 'center', title: t('net.title'), body: node('p', '', text), actions: [{ label: t('close'), kind: 'primary' }] });
  }

  function link() {
    const m = /^#([A-Za-z]{4})$/.exec(location.hash);
    if (!m || Net.busy() || App.active()) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    Sheet.closeAll();
    online(m[1].toUpperCase());
  }

  window.addEventListener('hashchange', link);

  // pictures are drawn at a pixel size, so a resized stage needs them again
  window.addEventListener('resize', () => { if (!$('home').hidden) start(true); });

  return {
    start: start, pause: pause, settings: settings, howTo: howTo, lobby: lobby, close: close, notice: notice, link: link,
    hall: enter, exit: exit, accept: accept, resume: resume, up: up, inHall: () => !!at, hub: hub, rooms: rooms, tables: tables
  };
})();
