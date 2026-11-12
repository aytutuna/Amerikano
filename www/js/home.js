var UI = (function () {
  const node = Cards.node;
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const FAN = [23, 37, 104, 51, 12];
  let launched = false;
  let wait = null;
  let at = null;
  let tick = 0;

  function button(label, kind, fn) {
    const b = node('button', 'btn ' + kind, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function kilim() {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'hm-kilim');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('width', '1200');
    r.setAttribute('height', '120');
    r.setAttribute('fill', 'url(#kilim)');
    r.setAttribute('transform', 'scale(3)');
    s.appendChild(r);
    return s;
  }

  // whole kilim rows (36px each) so the band never ends on a cut motif
  function kilimRows() {
    const land = matchMedia('(orientation: landscape) and (max-height: 520px)').matches;
    const rows = land || at ? 2 : Math.max(4, Math.min(7, Math.floor(innerHeight * 0.27 / 36)));
    document.documentElement.style.setProperty('--kh', rows * 36 + 'px');
  }

  function band() {
    const top = node('div', 'hm-top');
    top.setAttribute('aria-hidden', 'true');
    top.appendChild(kilim());
    top.appendChild(node('div', 'fringe'));
    return top;
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
      clearInterval(tick);
    }
    const home = $('home');
    const keep = quiet && home.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const go = !launched && !quiet;
    launched = true;
    home.hidden = false;
    home.textContent = '';

    kilimRows();
    home.appendChild(band());

    const main = node('main', 'hm-main');
    const brand = node('div', 'hm-brand');
    const h1 = node('h1', '', t('start.title'));
    brand.appendChild(h1);
    brand.appendChild(fan(go));
    main.appendChild(brand);

    const nav = node('div', 'hm-btns');
    const mine = Account.me();
    if (Account.has() && mine) nav.appendChild(strip(mine));
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
    // Large system text sizes scale the title past the screen width.
    document.fonts.ready.then(() => {
      const room = getComputedStyle(main).display === 'grid' ? brand.clientWidth : main.clientWidth - 40;
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
      form.appendChild(choice('games', t('setup.games'), opts.map(v => ({ v: v, label: String(v) })), g, v => { g = v; }, 'seg'));
      form.appendChild(node('p', 'note', t('setup.gamesNote')));
      form.appendChild(choice('level', t('setup.level'), [
        { v: 'relaxed', label: t('setup.relaxed'), note: t('setup.relaxedNote') },
        { v: 'sharp', label: t('setup.sharp'), note: t('setup.sharpNote') }
      ], lv, v => { lv = v; }, 'rows'));
      if (room) {
        form.appendChild(choice('stake', t('hall.stake'), stakes.map(v => ({ v: v, label: fmt(v) })), sk, v => { sk = v; fill(); focusOn('stake:' + v); }, 'seg'));
        form.appendChild(node('p', 'note', t('hall.stakeNote', { n: fmt(sk) })));
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
      form.appendChild(choice('felt', t('set.felt'), ['night', 'pine', 'wine', 'sea'].map(v => ({ v: v, label: t('set.' + v), pic: () => feltSwatch(v) })), Settings.get('felt'), v => Settings.set('felt', v), 'seg pics'));
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

  function chipsLine(n) {
    const c = node('span', 'chips');
    c.appendChild(Cards.icon('i-chip', 'chip'));
    c.appendChild(node('b', '', fmt(n)));
    c.setAttribute('aria-label', t('pf.chips') + ' ' + fmt(n));
    return c;
  }

  // the profile on the home screen, big in the lobby, with the daily bonus under it when it can be claimed
  function strip(me, big) {
    const box = node('div', 'hm-me');
    const b = node('button', 'me' + (big ? ' big' : ''));
    b.type = 'button';
    b.dataset.k = 'me';
    const pic = node('span', 'mypic');
    pic.appendChild(Avatar.pic(me.avatar, big ? 120 : 60, big));
    pic.appendChild(node('em', 'lv', me.level));
    pic.setAttribute('aria-hidden', 'true');
    b.appendChild(pic);
    const tx = node('span', 'tx');
    tx.appendChild(node('b', '', who(me.seed)));
    tx.appendChild(node('small', '', t('pf.level', { n: me.level }) + (big ? ', ' + t('pf.xpOf', { a: fmt(me.xp), b: fmt(me.to) }) : '')));
    tx.appendChild(xpBar(me));
    if (big) tx.appendChild(chipsLine(me.chips));
    b.appendChild(tx);
    if (!big) b.appendChild(chipsLine(me.chips));
    b.addEventListener('click', profile);
    box.appendChild(b);
    if (big) box.appendChild(daily(me));
    else if (me.daily.ready) box.appendChild(claim(me, 'primary big', true));
    return box;
  }

  function claim(me, cls, note) {
    const d = button('', cls, () => {
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
    if (note) {
      d.appendChild(node('b', '', t('pf.daily', { n: fmt(me.daily.reward) })));
      d.appendChild(node('span', '', t('pf.streak', { n: Math.min(me.daily.streak + 1, 7) })));
    } else d.textContent = t('pf.claim');
    return d;
  }

  // seven days in a row; a missed day starts the count again
  function daily(me) {
    const d = me.daily;
    const card = node('section', 'daily' + (d.ready ? ' ready' : ''));
    const head = node('div', 'dl-head');
    head.appendChild(node('b', '', t('pf.dailyTitle')));
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

  function profile() {
    if (!Account.me()) return;
    const body = node('div', 'form prof');
    let sure = false;
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
      const top = node('div', 'pf-top');
      top.appendChild(Avatar.pic(me.avatar, 132, true));
      const tx = node('div', 'tx');
      tx.appendChild(node('h3', '', who(me.seed)));
      tx.appendChild(node('p', '', t('pf.level', { n: me.level })));
      tx.appendChild(xpBar(me));
      tx.appendChild(node('p', 'note', t('pf.xpOf', { a: fmt(me.xp), b: fmt(me.to) })));
      top.appendChild(tx);
      body.appendChild(top);

      const stats = node('dl', 'stats');
      for (const [k, v] of [['chips', fmt(me.chips)], ['games', fmt(me.games)], ['wins', fmt(me.wins)]]) {
        const d = node('div');
        d.appendChild(node('dt', '', t('pf.' + k)));
        d.appendChild(node('dd', '', v));
        stats.appendChild(d);
      }
      body.appendChild(stats);

      const reroll = button(t('pf.reroll'), 'plain', () => {
        reroll.disabled = true;
        Account.reroll().then(fill, e => {
          reroll.disabled = false;
          notice(t(e.status === 429 ? 'pf.limit' : 'net.err.lost'));
        });
      });
      reroll.dataset.f = 'reroll';
      body.appendChild(reroll);
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
        body.appendChild(b);
        body.appendChild(node('p', 'note', t('pf.bailoutNote')));
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
          b.appendChild(Avatar.pic(swap(me, k, i), 44));
          b.addEventListener('click', () => {
            const cur = Account.me();
            if (!cur || cur.avatar[k] === i) return;
            Account.look(swap(cur, k, i)).then(fill, () => notice(t('net.err.lost')));
          });
          row.appendChild(b);
        }
        fs.appendChild(row);
        body.appendChild(fs);
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
            Net.cancel();
            h.close();
            start(true);
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
      }
      body.appendChild(del);
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
    const body = node('div', 'form');
    const h = Sheet.open({
      kind: 'bottom', tall: true, title: t('net.joinTitle', { code: code }), body: body,
      actions: [{ label: t('cancel'), kind: 'quiet' }]
    });
    body.appendChild(button(t('net.joinGo'), 'primary', () => {
      h.close();
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
    }));
  }

  function connecting() {
    const p = node('p', 'lead', t('net.connecting'));
    p.setAttribute('role', 'status');
    wait = { h: Sheet.open({ kind: 'center', title: t('net.title'), body: p, dismiss: false, actions: [{ label: t('cancel'), kind: 'plain', fn: () => { Net.cancel(); wait = null; resume(); } }] }) };
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

  function lobby(m) {
    if (!wait || !wait.body || !document.contains(wait.h.wrap)) {
      close();
      const body = node('div', 'lobby');
      wait = { body: body, h: Sheet.open({ kind: 'bottom', tall: true, title: t('net.room'), body: body, dismiss: false, actions: [{ label: t('net.leave'), kind: 'plain', fn: () => { Net.leave(); resume(); } }] }) };
    }
    const body = wait.body;
    body.textContent = '';
    clearInterval(tick);
    if (m.pub) body.appendChild(node('p', 'stake', t('hall.stakeAt', { n: fmt(m.stake) })));
    else {
      const code = node('p', 'code', m.code);
      code.setAttribute('aria-label', m.code.split('').join(' '));
      body.appendChild(code);
      body.appendChild(node('p', 'stake', t('hall.stakeAt', { n: fmt(m.stake) })));
    }
    const mine = m.you === m.host;
    if (m.pub) {
      if (m.left !== null) {
        const cd = node('p', 'lead');
        cd.dataset.end = Date.now() + m.left;
        body.appendChild(cd);
        countdown(body);
      }
      body.appendChild(node('p', 'note', t('hall.fill')));
    } else body.appendChild(node('p', 'note', t(mine ? 'net.hintHost' : 'net.hintGuest')));
    body.appendChild(node('p', 'note', t('hall.stakeNote', { n: fmt(m.stake) })));
    const ul = node('ul', 'seatlist');
    m.seats.forEach((s, i) => {
      const li = node('li', s ? '' : 'free');
      const line = node('span', 'sit');
      if (s && s.av) line.appendChild(Avatar.pic(s.av, 44));
      const nm = s ? who(s.seed) : t('net.bot');
      line.appendChild(node('span', '', nm + (s && i === m.you ? ' ' + t('net.you') : '')));
      li.appendChild(line);
      if (s && i === m.host) li.appendChild(node('small', '', t('net.hostTag')));
      else if (s && s.level) li.appendChild(node('small', '', t('hall.level', { n: s.level })));
      ul.appendChild(li);
    });
    body.appendChild(ul);
    if (m.seats.includes(null)) body.appendChild(button(t('fr.inviteFriends'), 'plain', Social.invite));
    if (m.pub) return;
    const out = node('p', 'note');
    out.setAttribute('role', 'status');
    const row = node('div', 'menu');
    if (mine) {
      const go = button(t('net.start'), 'primary', () => {
        go.disabled = true;
        Net.send({ t: 'start' });
      });
      row.appendChild(go);
    }
    row.appendChild(button(t('net.share'), 'plain', () => share(m.code, out)));
    body.appendChild(row);
    body.appendChild(out);
  }

  // keeps the "starts in" lines under root counting down
  function countdown(root) {
    const set = () => {
      const all = root.querySelectorAll('[data-end]');
      if (!all.length || !document.contains(root)) return clearInterval(tick);
      for (const e of all) e.textContent = t('hall.starts', { n: Math.max(0, Math.ceil((e.dataset.end - Date.now()) / 1000)) });
    };
    set();
    clearInterval(tick);
    tick = setInterval(set, 1000);
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
    clearInterval(tick);
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

  // a small round table with a dot per player that is in, and a lock when the player is short
  function miniTable(n, lock) {
    const m = node('span', 'mini');
    m.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) m.appendChild(node('i', i < n ? 'on' : ''));
    if (lock) m.appendChild(Cards.icon('i-lock', 'lock'));
    return m;
  }

  function stakeRooms(box, me) {
    const list = node('div', 'rooms');
    for (const s of at.stakes) {
      const need = at.entry * s;
      const ok = !!me && me.chips >= need;
      const b = button('', 'room' + (ok ? '' : ' locked'), () => {
        at.stake = s;
        at.tables = [];
        Net.watch(s);
        draw();
      });
      b.disabled = !ok;
      b.dataset.k = 'room' + s;
      const top = node('b', 'stk');
      top.appendChild(Cards.icon('i-chip', 'chip'));
      top.appendChild(document.createTextNode(fmt(s)));
      b.appendChild(top);
      b.appendChild(miniTable(at.n[s] || 0, !ok));
      b.appendChild(node('span', 'min', t('hall.min', { n: fmt(need) })));
      b.appendChild(node('span', 'here', ok ? t('hall.here', { n: at.n[s] || 0 }) : t('hall.locked')));
      list.appendChild(b);
    }
    box.appendChild(list);

    const fr = node('div', 'fld');
    fr.appendChild(node('span', 'lbl', t('hall.friends')));
    const mk = button(t('net.create'), 'plain big', () => setup(true));
    mk.disabled = !me || me.chips < at.entry * at.stakes[0];
    mk.dataset.k = 'create';
    fr.appendChild(mk);
    const line = node('div', 'joinrow');
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
      connecting();
      Net.join(c.value);
    });
    j.disabled = true;
    c.addEventListener('input', () => {
      c.value = c.value.toUpperCase().replace(/[^A-Z]/g, '');
      j.disabled = c.value.length !== 4;
    });
    c.addEventListener('keydown', e => { if (e.key === 'Enter' && !j.disabled) j.click(); });
    line.appendChild(c);
    line.appendChild(j);
    fr.appendChild(line);
    box.appendChild(fr);
  }

  function inRoom(box) {
    const q = button('', 'qp', () => {
      connecting();
      Net.play(at.stake);
    });
    q.dataset.k = 'quick';
    const m = miniTable(4, false);
    m.classList.add('lit');
    q.appendChild(m);
    const qt = node('span', 'qt');
    qt.appendChild(node('b', '', t('hall.quick')));
    qt.appendChild(node('span', '', t('hall.quickNote')));
    q.appendChild(qt);
    box.appendChild(q);
    box.appendChild(node('p', 'note', t('hall.fill')));
    box.appendChild(node('h3', '', t('hall.tables')));
    if (!at.tables.length) return box.appendChild(node('p', 'note', t('hall.none')));
    const ul = node('ul', 'tbls');
    for (const x of at.tables) {
      const li = node('li');
      const b = node('button', 'tbl');
      b.type = 'button';
      b.dataset.k = 'sit' + x.code;
      b.addEventListener('click', () => {
        connecting();
        Net.sit(x.code);
      });
      const faces = node('span', 'faces');
      for (const s of x.seats) faces.appendChild(s ? Avatar.pic(s.av, 44) : node('span', 'none'));
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
    box.appendChild(ul);
  }

  const redraw = () => { if (at) draw(); };

  function tabs(box) {
    const bar = node('div', 'pills');
    bar.setAttribute('role', 'tablist');
    for (const [k, label] of [['rooms', t('hall.rooms')], ['friends', t('fr.tab')], ['top', t('top.tab')]]) {
      const b = node('button', 'pill', label);
      b.type = 'button';
      b.dataset.k = 'tab' + k;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', at.tab === k);
      b.addEventListener('click', () => {
        at.tab = k;
        if (k === 'friends') Social.refresh().then(redraw, () => {});
        if (k === 'top') Social.top().then(redraw, () => {});
        draw();
      });
      bar.appendChild(b);
    }
    box.appendChild(bar);
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
    const typed = home.querySelector('input.code');
    const word = typed ? typed.value : '';
    const caret = typed ? typed.selectionStart : 0;
    const top = home.scrollTop;
    clearInterval(tick);
    home.hidden = false;
    home.textContent = '';
    kilimRows();
    home.appendChild(band());
    const main = node('main', 'hm-main hall');
    const box = node('div', 'hl');
    const bar = node('div', 'hl-bar');
    const back = button(t('hall.back'), 'quiet', up);
    back.dataset.k = 'back';
    bar.appendChild(back);
    bar.appendChild(node('h2', '', at.stake ? t('hall.room', { n: fmt(at.stake) }) : t('net.title')));
    box.appendChild(bar);
    const me = Account.me();
    if (me) box.appendChild(strip(me, !at.stake));
    if (!at.stakes) {
      const p = node('p', 'lead', t('net.connecting'));
      p.setAttribute('role', 'status');
      box.appendChild(p);
    } else if (at.stake) inRoom(box);
    else {
      tabs(box);
      if (at.tab === 'friends') Social.friends(box.appendChild(node('div', 'frs')), { again: redraw });
      else if (at.tab === 'top') Social.leaders(box.appendChild(node('div', 'frs')), redraw);
      else stakeRooms(box, me);
    }
    main.appendChild(box);
    home.appendChild(main);
    countdown(home);
    const field = home.querySelector('input.code');
    if (field && word) {
      field.value = word;
      field.dispatchEvent(new Event('input'));
    }
    home.scrollTop = top;
    if (keep) {
      const e = home.querySelector('[data-k="' + keep + '"]');
      if (e) {
        e.focus({ preventScroll: true });
        if (e === field) e.setSelectionRange(caret, caret);
      }
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

  window.addEventListener('resize', () => { if (!$('home').hidden) kilimRows(); });

  return {
    start: start, pause: pause, settings: settings, howTo: howTo, lobby: lobby, close: close, notice: notice, link: link,
    hall: enter, exit: exit, accept: accept, resume: resume, up: up, inHall: () => !!at, hub: hub, rooms: rooms, tables: tables
  };
})();
