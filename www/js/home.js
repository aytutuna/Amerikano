var UI = (function () {
  const node = Cards.node;
  const $ = id => document.getElementById(id);
  let wait = null;
  let booted = false;
  let again = 0;
  let pressed = false;
  let linked = '';
  // a table link opened before signing in waits for the sign-in page
  let later = null;
  // set when Cancel is pressed, so a count update already on its way does not bring the sheet back
  let leaving = false;
  // net is wait, up, down or replaced
  const at = { tab: 'rooms', net: 'wait', stakes: null, entry: 10, n: {}, f: {}, gate: '', fast: false };
  try { at.fast = localStorage.getItem('amerikano.fast') === '1'; } catch (e) { /* normal pace */ }

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

  function pace(cur, fn) {
    return choice('mode', t('hall.mode'), [
      { v: 'normal', label: t('hall.normal'), note: t('hall.normalNote') },
      { v: 'fast', label: t('hall.fast'), note: t('hall.fastNote') }
    ], cur ? 'fast' : 'normal', v => fn(v === 'fast'), 'seg');
  }

  function setFast(on) {
    at.fast = on;
    try { localStorage.setItem('amerikano.fast', on ? '1' : '0'); } catch (e) { /* kept for this session only */ }
  }

  function gameOptions(n) {
    const out = [];
    for (let g = n; g <= 16; g += n) out.push(g);
    return out;
  }

  // players, games and level, plus the stake for an online table; get() reads what was picked
  function matchForm(room) {
    let n = Settings.get('players');
    if (![3, 4, 5].includes(n)) n = 4;
    let g = Settings.get('games');
    let lv = Settings.get('level') === 'sharp' ? 'sharp' : 'relaxed';
    const me = Account.me();
    const stakes = room && at.stakes ? at.stakes.filter(x => me && me.chips >= at.entry * x) : [];
    let sk = stakes[0];
    let fast = at.fast;
    const form = node('div', 'form' + (room ? ' one' : ''));
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
      if (!room) games.appendChild(node('p', 'note', t('setup.gamesNote')));
      form.appendChild(games);
      form.appendChild(choice('level', t('setup.level'), [
        { v: 'relaxed', label: t('setup.relaxed'), note: room ? '' : t('setup.relaxedNote') },
        { v: 'sharp', label: t('setup.sharp'), note: room ? '' : t('setup.sharpNote') }
      ], lv, v => { lv = v; }, room ? 'seg' : 'rows'));
      if (room) {
        const stake = choice('stake', t('hall.stake'), stakes.map(v => ({ v: v, label: fmt(v) })), sk, v => { sk = v; fill(); focusOn('stake:' + v); }, 'seg');
        form.appendChild(stake);
        form.appendChild(pace(fast, v => { fast = v; }));
      }
      if (saved && !room) form.appendChild(node('p', 'note', t('setup.replace')));
    }

    function focusOn(key) {
      const e = form.querySelector('[data-f="' + key + '"]');
      if (e) e.focus({ preventScroll: true });
    }

    fill();
    return {
      form: form,
      ok: () => !room || sk !== undefined,
      get: () => {
        Settings.set('players', n, true);
        Settings.set('games', g, true);
        Settings.set('level', lv, true);
        return { players: n, games: g, level: lv, stake: sk, fast: room ? fast : undefined };
      }
    };
  }

  function setup() {
    const f = matchForm(false);
    Sheet.open({
      kind: 'bottom', tall: true, title: t('start.go'), body: f.form,
      actions: [
        { label: t('setup.go'), kind: 'primary', fn: () => { const o = f.get(); App.newMatch({ players: o.players, games: o.games, level: o.level }); } },
        { label: t('cancel'), kind: 'quiet' }
      ]
    });
  }

  function toggle(key, label, note, extra, store) {
    store = store || Settings;
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
    const st = node('span', 'onoff', t(store.get(key) ? 'on' : 'off'));
    st.setAttribute('aria-hidden', 'true');
    row.appendChild(st);
    const inp = node('input', 'swt');
    inp.type = 'checkbox';
    inp.setAttribute('role', 'switch');
    inp.checked = !!store.get(key);
    inp.dataset.f = key;
    inp.setAttribute('aria-labelledby', id);
    if (note) inp.setAttribute('aria-describedby', id + '-n');
    inp.addEventListener('change', () => {
      st.textContent = t(inp.checked ? 'on' : 'off');
      const r = store.set(key, inp.checked);
      if (r && r.catch) r.catch(() => {
        inp.checked = !inp.checked;
        st.textContent = t(inp.checked ? 'on' : 'off');
      });
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

    function notes() {
      const fs = node('fieldset', 'fld');
      fs.appendChild(node('legend', '', t('set.notes')));
      if (Push.perm() === 'denied') fs.appendChild(node('p', 'note', t('set.push.denied')));
      const store = { get: Push.get, set: (k, v) => Push.set(k, v).then(() => { if (k === 'on') fill(); }) };
      for (const k of ['on', 'invite', 'daily', 'friend', 'week']) {
        const row = toggle(k, t('set.push.' + k), null, null, store);
        if (k !== 'on' && !Push.get('on')) row.querySelector('input').disabled = true;
        fs.appendChild(row);
      }
      return fs;
    }

    function fill() {
      const was = document.activeElement && form.contains(document.activeElement) ? document.activeElement.dataset.f : null;
      form.textContent = '';
      form.appendChild(choice('lang', t('set.lang'), [
        { v: 'auto', label: t('set.auto') },
        { v: 'en', label: t('set.en') },
        { v: 'tr', label: t('set.tr') }
      ], Settings.get('lang'), v => { Settings.set('lang', v); Push.sync(); fill(); if (h) h.set(t('set.title'), done()); }, 'seg'));
      const how = button(t('start.how'), 'plain', howTo);
      how.dataset.f = 'how';
      form.appendChild(how);
      form.appendChild(toggle('sound', t('set.sound')));
      form.appendChild(toggle('haptics', t('set.haptics')));
      const sw = node('span', 'suits');
      sw.setAttribute('aria-hidden', 'true');
      for (const s of ['s', 'h', 'd', 'c']) sw.appendChild(Cards.icon('su-' + s, 'su sx-' + s));
      form.appendChild(toggle('fourc', t('set.fourc'), t('set.fourcNote'), sw));
      form.appendChild(choice('speed', t('set.speed'), ['slow', 'normal', 'fast'].map(v => ({ v: v, label: t('set.' + v) })), Settings.get('speed'), v => Settings.set('speed', v), 'seg'));
      form.appendChild(choice('back', t('set.back'), ['red', 'blue', 'green', 'graphite'].map(v => ({ v: v, label: t('set.' + v), pic: () => backSwatch(v) })), Settings.get('back'), v => Settings.set('back', v), 'seg pics'));
      form.appendChild(choice('felt', t('set.felt'), ['green', 'blue', 'wine', 'walnut'].map(v => ({ v: v, label: t('set.' + v), pic: () => feltSwatch(v) })), Settings.get('felt'), v => Settings.set('felt', v), 'seg pics'));
      if (Push.can() && Account.me()) form.appendChild(notes());
      const acct = Account.has() && Account.me() && !App.active() ? Account.me() : null;
      if (acct) {
        const ex = node('div', 'exit');
        if (acct.apple || acct.google) ex.appendChild(button(t('set.out'), 'quiet', () => { h.close(); signOut(); }));
        ex.appendChild(button(t('pf.delete'), 'quiet', () => { h.close(); profile(true); }));
        form.appendChild(ex);
      }
      if (was) {
        const e = form.querySelector('[data-f="' + was + '"]');
        if (e) e.focus({ preventScroll: true });
      }
    }

    const done = () => [{ label: t('done'), kind: 'primary' }];
    fill();
    h = Sheet.open({ kind: 'bottom', tall: true, title: t('set.title'), body: form, actions: done() });
    if (Push.can()) Push.check().then(fill);
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
    const st = App.state();
    const cup = net && st && st.cup;
    // once a tournament table is over, leaving only costs something to a player waiting for the final
    if (cup && st.phase === 'matchend' && !cup.through) return;
    body.appendChild(node('p', 'note', t(cup ? 'cup.leaveNote' : net ? 'pause.onlineNote' : 'pause.note')));
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
    const b = raw('me', () => profile());
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
    const b = raw('pq', () => profile());
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
        redraw();
      }, e => {
        d.disabled = false;
        if (e.status !== 409) return notice(t('net.err.lost'));
        Account.refresh().then(redraw, () => {});
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

  // black, with Apple's mark, as Apple's button rules ask on a light background
  function appleButton(fn) {
    const b = node('button', 'btn apple');
    b.type = 'button';
    b.appendChild(Cards.icon('i-apple', 'ic'));
    b.appendChild(node('span', '', t('signin.apple')));
    b.addEventListener('click', fn);
    Apple.warm();
    return b;
  }

  // white, with Google's multicolour G, as Google's branding asks. In a browser Google draws the button itself
  // and hands the credential to use when it is pressed; elsewhere use gets the promise of the native dialog.
  function googleButton(use) {
    if (!Google.native()) {
      const d = node('div', 'gbtn');
      Google.render(d, c => use(Promise.resolve(c)));
      return d;
    }
    const b = node('button', 'btn google');
    b.type = 'button';
    b.appendChild(Cards.icon('i-google', 'ic'));
    b.appendChild(node('span', '', t('signin.google')));
    b.addEventListener('click', () => use(Google.signIn()));
    return b;
  }

  // Google's web button cannot be disabled, so a busy one is covered by a class
  function hold(b, on) {
    b.disabled = on;
    b.classList.toggle('wait', on);
  }

  function linkWith(via, cred, b, fill) {
    hold(b, true);
    cred.then(c => Account.link(c, via)).then(fill, e => {
      hold(b, false);
      if (e.cancelled) return;
      if (e.message === 'taken') return takenAsk(via, fill);
      notice(t(e.message === 'linked' ? (via === 'google' ? 'pf.otherGoogle' : 'pf.other') : e instanceof TypeError ? 'net.err.lost' : 'signin.fail'));
    });
  }

  // that ID already has an account: offer it in place of this guest
  function takenAsk(via, fill) {
    const web = via === 'google' && !Google.native();
    const ask = node('p', '', t('pf.takenAsk'));
    let body = ask;
    // Google's web button is the only way to a credential there, so it sits in the sheet
    if (web) {
      body = node('div');
      body.appendChild(ask);
      body.appendChild(googleButton(cred => { Sheet.closeAll(); switchTo(via, cred); }));
    }
    Sheet.open({
      kind: 'center', title: t(via === 'google' ? 'pf.takenGoogle' : 'pf.taken'), body: body,
      actions: web ? [{ label: t('cancel'), kind: 'primary' }] : [
        { label: t('pf.switch'), kind: 'plain', fn: () => switchTo(via, via === 'google' ? Google.signIn() : Apple.signIn()) },
        { label: t('cancel'), kind: 'primary' }
      ],
      onClose: web ? fill : undefined
    });
  }

  // the credential was spent on the link, so a new one is asked for
  function switchTo(via, cred) {
    Sheet.closeAll();
    cred.then(c => Account.signIn(c, via)).then(() => {
      Net.cancel();
      Social.reset();
      retry();
    }, e => { if (!e.cancelled) notice(t(e instanceof TypeError ? 'net.err.lost' : 'signin.fail')); });
  }

  function signOut() {
    Net.cancel();
    Account.forget();
    Social.reset();
    Net.up();
    at.net = 'wait';
    at.tab = 'rooms';
    at.stakes = null;
    at.gate = '';
    draw();
  }

  function signApple() {
    at.gate = 'busy';
    draw();
    Apple.signIn().then(c => Account.signIn(c)).then(enter, fail);
  }

  function signGoogle(cred) {
    at.gate = 'busy';
    draw();
    cred.then(c => Account.signIn(c, 'google')).then(enter, fail);
  }

  function signGuest() {
    at.gate = 'busy';
    draw();
    Account.ensure().then(enter, fail);
  }

  function enter() {
    at.gate = '';
    boot();
  }

  function fail(e) {
    // the account came through but its profile did not; the lobby has the offline card for that
    if (Account.has()) return enter();
    at.gate = e.cancelled ? '' : e instanceof TypeError || e.status >= 500 ? 'down' : 'fail';
    draw();
  }

  // the first screen without an account: Apple, a guest, or Training when the server is out of reach
  function gate() {
    const home = $('home');
    const keep = home.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    home.hidden = false;
    home.textContent = '';
    const bar = node('div', 'hl-top');
    const end = node('div', 'hl-end');
    const gear = raw('ib', settings);
    gear.dataset.k = 'set';
    gear.setAttribute('aria-label', t('start.settings'));
    gear.appendChild(Cards.icon('i-gear', 'ic'));
    end.appendChild(gear);
    bar.appendChild(end);
    home.appendChild(bar);
    const busy = at.gate === 'busy';
    const down = at.gate === 'down';
    const box = node('main', 'gate-box');
    const pn = node('section', 'paper gate');
    pn.appendChild(node('h2', 'gate-t', t('start.title')));
    if (down) {
      pn.appendChild(node('p', 'gate-s', t('nonet.down')));
      const p = node('p', 'note', t('nonet.downNote'));
      p.setAttribute('role', 'alert');
      pn.appendChild(p);
    } else pn.appendChild(node('p', 'gate-s', t(Apple.can() || Google.can() ? 'signin.lead' : 'signin.leadGuest')));
    if (Apple.can()) {
      const a = appleButton(signApple);
      a.dataset.k = 'apple';
      a.disabled = busy;
      pn.appendChild(a);
    }
    if (Google.can()) {
      const gb = googleButton(signGoogle);
      gb.dataset.k = 'google';
      hold(gb, busy);
      pn.appendChild(gb);
    }
    const g = button(t('signin.guest'), 'primary', signGuest);
    g.dataset.k = 'guest';
    g.disabled = busy;
    pn.appendChild(g);
    if (down) {
      const tr = button(t('start.go'), 'quiet', setup);
      tr.dataset.k = 'go';
      pn.appendChild(tr);
    } else {
      const p = node('p', 'note', t(busy ? 'net.connecting' : at.gate === 'fail' ? 'signin.fail' : 'signin.note'));
      if (busy || at.gate === 'fail') p.setAttribute('role', busy ? 'status' : 'alert');
      pn.appendChild(p);
    }
    box.appendChild(pn);
    home.appendChild(box);
    if (keep) {
      const e = home.querySelector('[data-k="' + keep + '"]');
      if (e && !e.disabled) e.focus({ preventScroll: true });
    }
  }

  function profile(ask) {
    if (!Account.me()) return;
    const body = node('div', 'prof');
    let sure = !!ask;
    let again = false;
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

      const ap = node('div', 'pf-link');
      const linked = (icon, key) => {
        const row = node('div', 'pf-on');
        row.appendChild(Cards.icon(icon, 'ic'));
        row.appendChild(node('b', '', t(key)));
        ap.appendChild(row);
      };
      let offer = false;
      if (me.apple) linked('i-apple', 'pf.linked');
      else if (Apple.can()) {
        const b = appleButton(() => linkWith('apple', Apple.signIn(), b, fill));
        b.dataset.f = 'apple';
        ap.appendChild(b);
        offer = true;
      }
      if (me.google) linked('i-google', 'pf.linkedGoogle');
      else if (Google.can()) {
        const b = googleButton(cred => linkWith('google', cred, b, fill));
        b.dataset.f = 'google';
        ap.appendChild(b);
        offer = true;
      }
      if (offer) ap.appendChild(node('p', 'note', t('pf.appleNote')));
      if (ap.firstChild) left.appendChild(ap);

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
          (again ? Apple.signIn().then(c => Account.remove(c)) : Account.remove()).then(() => {
            h.close();
            Net.cancel();
            Social.reset();
            Net.up();
            retry();
          }, e => {
            go.disabled = false;
            if (e.cancelled) return;
            if (e.message === 'reauth') {
              if (!Apple.can()) return notice(t('pf.reauthApple'));
              again = true;
              Apple.warm();
              return notice(t('pf.reauth'));
            }
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
    h = Sheet.open({ kind: 'bottom', tall: true, title: t('pf.title'), body: body, actions: [{ label: t('done'), kind: 'primary' }], onClose: redraw });
  }

  // a shared link opened this, so there is nothing to ask but whether to join
  function online(code) {
    Sheet.open({
      kind: 'center', title: t('net.joinTitle', { code: code }),
      actions: [{
        label: t('net.joinGo'), kind: 'primary', fn: () => {
          if (App.active()) App.leave(false);
          accept({ pub: false, code: code });
        }
      }, { label: t('cancel'), kind: 'quiet' }]
    });
  }

  // cancel is for a table socket; a request to the hub is answered within moments
  function connecting(cancel, title) {
    const body = node('div', 'conn');
    body.appendChild(Cards.icon('i-chip', 'chip spin'));
    const p = node('p', 'lead', t('net.connecting'));
    p.setAttribute('role', 'status');
    body.appendChild(p);
    const h = Sheet.open({
      kind: 'center', title: title || t('net.title'), body: body, dismiss: false,
      actions: cancel ? [{ label: t('cancel'), kind: 'plain', fn: () => { Net.cancel(); wait = null; } }] : []
    });
    wait = { h: h };
    if (!cancel) {
      setTimeout(() => {
        if (wait && wait.h === h && !wait.body && document.contains(h.wrap)) {
          close();
          notice(t('net.err.lost'));
        }
      }, 12000);
    }
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

  // the seats round a small felt; they are built once and only the seat that changed is redrawn, so an arrival can be seen
  function seatTable(m) {
    const box = node('div', 'wt-table' + (m.seats.length > 4 ? ' five' : ''));
    box.appendChild(node('div', 'felt wt-felt'));
    const mid = node('div', 'wt-mid');
    if (m.pub) mid.appendChild(node('b', 'plaque', fmt(m.stake)));
    else {
      const code = node('b', 'code', m.code);
      code.setAttribute('aria-label', m.code.split('').join(' '));
      mid.appendChild(code);
    }
    if (m.fast) mid.appendChild(node('i', 'tag', t('hall.fast')));
    box.appendChild(mid);
    const n = m.seats.length;
    const els = m.seats.map((s, i) => {
      const a = (((i - m.you + n) % n) / n + .25) * 2 * Math.PI;
      const seat = node('div', 'ws free');
      seat.style.left = 50 + 33 * Math.cos(a) + '%';
      seat.style.top = 50 + (n > 4 ? 35 : 26) * Math.sin(a) + '%';
      seat.appendChild(node('span', 'wr'));
      seat.appendChild(node('span', 'wn'));
      box.appendChild(seat);
      return seat;
    });
    return { box: box, els: els };
  }

  function seated(w, m) {
    m.seats.forEach((s, i) => {
      const e = w.els[i];
      const key = s ? s.seed + ':' + s.av.join() + ':' + s.level + ':' + (i === m.you) : m.finding > 0 ? 'seek' : 'free';
      const was = e.dataset.key;
      if (was === key) return;
      e.dataset.key = key;
      e.className = 'ws' + (s ? '' : ' free') + (!s && m.finding > 0 ? ' seek' : '') + (i === m.you ? ' me' : '');
      const ring = e.firstChild;
      ring.textContent = '';
      if (s) {
        ring.appendChild(face(s.av, 36));
        ring.appendChild(node('em', 'lv', s.level));
      }
      const name = s ? who(s.seed) + (i === m.you ? ' ' + t('net.you') : '') : t(m.finding > 0 ? 'net.looking' : 'net.free');
      e.lastChild.textContent = name;
      if (s && w.seen && (was === 'free' || was === 'seek') && i !== m.you) {
        e.classList.add('in');
        Sfx.join();
        Live.say(t('net.arrived', { name: who(s.seed), n: s.level }));
      }
    });
    w.seen = true;
  }

  // the table's own sheet: seats fill as the server reports them, until the match starts
  function lobby(m) {
    if (!wait || !wait.body || !document.contains(wait.h.wrap)) {
      close();
      const body = node('div', 'wt');
      const tb = seatTable(m);
      body.appendChild(tb.box);
      const side = node('div', 'wt-side');
      body.appendChild(side);
      wait = { body: body, side: side, els: tb.els, seen: false, h: Sheet.open({ kind: 'bottom', tall: true, title: t('net.room'), body: body, dismiss: false, actions: [{ label: t('net.leave'), kind: 'plain', fn: () => { Net.leave(); wait = null; show(); } }] }) };
    }
    wait.h.set(t(m.finding > 0 ? 'hall.finding' : 'net.room'));
    seated(wait, m);
    const side = wait.side;
    const keep = side.contains(document.activeElement) ? document.activeElement.dataset.f : null;
    side.textContent = '';
    const sk = node('p', 'stake', t('hall.stakeAt', { n: fmt(m.stake) }));
    if (m.fast) sk.append(' ', node('i', 'tag', t('hall.fast')));
    side.appendChild(sk);
    const mine = m.you === m.host;
    if (m.finding > 0) {
      const p = node('p', 'lead', t('net.finding', { n: m.finding }));
      p.setAttribute('role', 'status');
      side.appendChild(p);
    } else side.appendChild(node('p', 'note', m.pub ? t('hall.fill') : t(mine ? 'net.hintHost' : 'net.hintGuest')));
    side.appendChild(node('p', 'note', t('hall.stakeNote', { n: fmt(m.stake) })));
    const out = node('p', 'note');
    out.setAttribute('role', 'status');
    const acts = node('div', 'wt-acts');
    wait.go = null;
    wait.m = m;
    if (m.seats.includes(null)) {
      const inv = button(t('fr.inviteFriends'), 'plain', Social.invite);
      inv.dataset.f = 'invite';
      acts.appendChild(inv);
    }
    if (!m.pub) {
      if (mine && !m.finding) {
        const go = button(t('net.start'), 'primary', () => {
          go.disabled = true;
          Net.send({ t: 'start' });
        });
        go.dataset.f = 'start';
        wait.go = go;
        acts.appendChild(go);
      }
      const sh = button(t('net.share'), 'plain', () => share(m.code, out));
      sh.dataset.f = 'share';
      acts.appendChild(sh);
    }
    side.appendChild(acts);
    side.appendChild(out);
    if (keep) {
      const e = side.querySelector('[data-f="' + keep + '"]');
      if (e) e.focus({ preventScroll: true });
    }
  }

  // sets the lobby up on first sight and whenever the account has to be made again
  function boot(quiet) {
    clearTimeout(again);
    if (!Account.has()) return draw();
    if (!quiet) {
      at.net = 'wait';
      draw();
    }
    Account.ensure().then(() => Account.refresh()).then(() => {
      Net.up();
      Push.start();
      redraw();
    }, down);
  }

  function down() {
    at.net = 'down';
    at.stakes = null;
    redraw();
    clearTimeout(again);
    again = setTimeout(() => { if (at.net === 'down') boot(true); }, 12000);
  }

  function retry() {
    booted = true;
    boot();
  }

  // the lobby is the home screen; coming back from a match or from Training lands here
  function show() {
    $('home').hidden = false;
    if (!booted) {
      booted = true;
      return boot();
    }
    draw();
    if (at.net === 'up') Account.refresh().then(redraw, () => {});
  }

  function conn(k) {
    if (at.net === k) return;
    at.net = k;
    if (k !== 'up') at.stakes = null;
    redraw();
  }

  function hub(m) {
    leaving = false;
    at.net = 'up';
    at.stakes = m.stakes;
    at.entry = m.entry;
    if (Account.me()) Social.refresh().then(redraw, () => {});
    redraw();
  }

  function rooms(n, f) {
    at.n = n;
    at.f = f || {};
    redraw();
  }

  // one step back: from another tab to the rooms; the lobby itself has nothing behind it
  function up() {
    if ($('home').hidden || at.tab === 'rooms') return false;
    at.tab = 'rooms';
    draw();
    return true;
  }

  const short = n => n >= 1e4 ? new Intl.NumberFormat(I18n.lang(), { notation: 'compact' }).format(n) : fmt(n);
  const redraw = () => { if (!$('home').hidden) draw(); };
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
        connecting(false, t('hall.finding'));
        Net.play(s, at.fast);
      });
      b.disabled = !ok;
      b.dataset.k = 'room' + s;
      b.appendChild(node('b', 'plaque', short(s)));
      const here = (at.fast ? at.f : at.n)[s] || 0;
      b.appendChild(miniTable(here));
      const meta = node('span', 'rmeta');
      meta.appendChild(node('b', '', t('hall.min', { n: fmt(at.entry * s) })));
      meta.appendChild(node('i', '', t('hall.playing', { n: fmt(here) })));
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

  const BUYS = [1000, 5000, 25000];

  function fullOval() {
    const m = node('span', 'oval eight');
    m.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 8; i++) {
      const a = (i / 8 + .25) * 2 * Math.PI;
      const d = node('i', 'on');
      d.style.left = 50 + 50 * Math.cos(a) + '%';
      d.style.top = 50 + 50 * Math.sin(a) + '%';
      m.appendChild(d);
    }
    return m;
  }

  // the same wood cards as the rooms, on a tab of their own: the Fast switch does not reach them
  function cupCards(me) {
    const list = node('div', 'rooms cups');
    for (const buy of BUYS) {
      const ok = !!me && me.chips >= buy;
      const b = raw('room', () => {
        leaving = false;
        cupForm({ buy: buy, n: 1 });
        Net.cup(buy);
      });
      b.disabled = !ok;
      b.dataset.k = 'cup' + buy;
      b.appendChild(node('b', 'plaque', short(buy)));
      b.appendChild(fullOval());
      const meta = node('span', 'rmeta');
      meta.appendChild(node('b', '', t('cup.prize', { n: fmt(buy * 4) })));
      meta.appendChild(node('i', '', t('cup.line')));
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

  function cupBody(buy) {
    const body = node('div', 'wt cupf');
    const tb = node('div', 'wt-table');
    tb.appendChild(node('div', 'felt wt-felt'));
    const mid = node('div', 'wt-mid');
    mid.appendChild(node('b', 'plaque', fmt(buy)));
    tb.appendChild(mid);
    const marks = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8 + .25) * 2 * Math.PI;
      const d = node('i', 'cs');
      d.style.left = 50 + 40 * Math.cos(a) + '%';
      d.style.top = 50 + 36 * Math.sin(a) + '%';
      tb.appendChild(d);
      marks.push(d);
    }
    body.appendChild(tb);
    const side = node('div', 'wt-side');
    const count = node('p', 'lead');
    count.setAttribute('role', 'status');
    side.appendChild(count);
    const go = node('p', 'note', t('cup.starting'));
    go.hidden = true;
    side.appendChild(go);
    side.appendChild(node('p', 'stake', t('cup.buy', { n: fmt(buy) })));
    const ul = node('ul', 'pz');
    ul.setAttribute('aria-label', t('cup.prizes'));
    [50, 25, 15, 10].forEach((pc, i) => {
      const li = node('li');
      li.appendChild(node('span', '', t('cup.place', { n: i + 1 })));
      const amount = node('b');
      amount.appendChild(Cards.icon('i-chip', 'chip'));
      amount.appendChild(node('span', '', fmt(buy * 8 * pc / 100)));
      li.appendChild(amount);
      ul.appendChild(li);
    });
    side.appendChild(ul);
    side.appendChild(node('p', 'note', t('cup.note')));
    body.appendChild(side);
    return { body: body, marks: marks, count: count, go: go };
  }

  // the forming sheet sits in the connecting slot, so a refusal takes it down with close()
  function cupForm(m) {
    if (App.active()) return;
    if (!m.buy) {
      if (wait && wait.cup) close();
      return;
    }
    // a withdraw the hub refused at 8 / 8 comes back as this state, which reopens the sheet
    if (leaving && m.n < 8) return;
    leaving = false;
    if (!wait || !wait.cup || wait.buy !== m.buy || !document.contains(wait.h.wrap)) {
      close();
      const f = cupBody(m.buy);
      wait = {
        cup: true, buy: m.buy, f: f, n: 0,
        h: Sheet.open({
          kind: 'bottom', title: t('cup.table'), body: f.body, dismiss: false,
          actions: [{ label: t('cancel'), kind: 'plain', fn: () => { leaving = true; wait = null; Net.cup(0); } }]
        })
      };
    }
    const f = wait.f;
    f.marks.forEach((d, i) => {
      const on = i < m.n;
      if (on && !d.classList.contains('on') && wait.n) d.classList.add('in');
      d.classList.toggle('on', on);
    });
    f.count.textContent = m.n + ' / 8';
    f.count.setAttribute('aria-label', t('cup.seats', { n: m.n }));
    wait.n = m.n;
    f.go.hidden = m.n < 8;
    wait.h.acts.querySelector('button').disabled = m.n >= 8;
  }

  const cupSeated = () => { leaving = false; };

  function cupEnd() {
    Account.refresh().then(redraw, () => {});
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
    const list = Social.list().slice().sort((x, y) => !!y.at - !!x.at).slice(0, 7);
    if (!list.length) card.appendChild(node('p', 'note', t('fr.none')));
    const ul = node('ul', 'fl');
    for (const p of list) {
      const li = node('li', 'frw');
      li.appendChild(face(p.avatar, 28));
      const tx = node('span', 'tx');
      tx.appendChild(node('b', '', who(p.seed)));
      if (p.at) tx.appendChild(node('small', '', t('fr.at.' + p.at.w)));
      li.appendChild(tx);
      const d = node('i', 'dot' + (p.at ? ' on' : ''));
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', t(p.at ? 'fr.online' : 'fr.offline'));
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

  // Create table, Join with code and the friends list in one sheet
  function friendsSheet() {
    const body = node('div', 'fgrid');
    const f = matchForm(true);
    let tick = 0;
    const h = Sheet.open({
      kind: 'bottom', tall: true, title: t('hall.friends'), body: body, onClose: () => clearInterval(tick),
      actions: [
        {
          label: t('net.createGo'), kind: 'primary', fn: () => {
            if (!f.ok()) return notice(t('net.err.poor'));
            connecting(true, t('net.title'));
            Net.create(f.get());
          }
        },
        { label: t('cancel'), kind: 'quiet' }
      ]
    });
    const mk = node('section', 'fbox mk');
    mk.appendChild(f.form);
    body.appendChild(mk);

    const right = node('div', 'fcol');
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
      connecting(true, t('net.title'));
      account().then(() => Net.join(c.value), () => { close(); notice(t('net.err.lost')); });
    });
    j.disabled = true;
    c.addEventListener('input', () => {
      c.value = c.value.toUpperCase().replace(/[^A-Z]/g, '');
      j.disabled = c.value.length !== 4;
    });
    c.addEventListener('keydown', e => { if (e.key === 'Enter' && !j.disabled) j.click(); });
    jn.appendChild(node('p', 'note', t('net.join')));
    const row = node('div', 'jrow');
    row.appendChild(c);
    row.appendChild(j);
    jn.appendChild(row);
    right.appendChild(jn);

    const fr = node('section', 'fbox frs fl2');
    right.appendChild(fr);
    body.appendChild(right);
    const draw = () => {
      fr.textContent = '';
      fr.appendChild(node('p', 'note', t('fr.createFirst')));
      Social.friends(fr, { invite: false, join: a => { h.close(); accept(a); }, again: draw });
    };
    draw();
    Social.refresh().then(draw, () => {});
    tick = setInterval(() => { if (!pressed && !document.hidden) Social.refresh().then(draw, () => {}); }, 8000);
  }

  // Rejoin, Continue and an invitation put off during a match, kept to one strip
  function banner() {
    const bar = node('div', 'hl-bn');
    const pill = (k, head, sub, fn) => {
      const b = raw('pill', fn);
      b.dataset.k = k;
      b.appendChild(node('b', '', head));
      b.appendChild(node('span', '', sub));
      bar.appendChild(b);
    };
    const back = Net.recent();
    if (back && !Net.busy()) pill('back', t('start.rejoin'), t('start.rejoinNote', back), () => { connecting(true); Net.resume(); });
    const saved = App.saved();
    if (saved) pill('cont', t('start.cont'), t('start.saved', saved), () => App.resume());
    const inv = Social.late();
    if (inv) pill('late', t('fr.join'), t('fr.lateNote', { name: who(inv.from.seed) }), () => { Social.used(); accept(inv); });
    return bar.children.length ? bar : null;
  }

  function offline() {
    const w = node('div', 'conn off');
    const k = at.net === 'replaced' ? 'replaced' : 'down';
    w.appendChild(node('p', 'lead', t('nonet.' + k)));
    w.appendChild(node('p', 'note', t('nonet.' + k + 'Note')));
    const b = button(t(k === 'replaced' ? 'nonet.here' : 'nonet.retry'), 'primary', () => { booted = true; if (k === 'replaced') Net.up(); boot(); });
    b.dataset.k = 'retry';
    w.appendChild(b);
    return w;
  }

  function tablesTab(body, me, cups) {
    const on = at.net === 'up' && at.stakes;
    const side = node('div', 'hl-side');
    if (on && me) side.appendChild(daily(me));
    if (on) side.appendChild(friendCard());
    if (side.children.length) body.appendChild(side);
    const main = node('div', 'hl-main');
    const head = node('div', 'hl-hd');
    head.appendChild(node('h2', 'hl-h', t(on ? cups ? 'cup.title' : 'hall.pick' : 'start.title')));
    const bn = banner();
    if (bn) head.appendChild(bn);
    if (on && !cups) {
      const mode = pace(at.fast, v => { setFast(v); draw();
        const e = document.querySelector('[data-f="mode:' + (v ? 'fast' : 'normal') + '"]');
        if (e) e.focus({ preventScroll: true });
      });
      mode.classList.add('hl-mode');
      head.insertBefore(mode, bn);
    }
    main.appendChild(head);
    if (on) main.appendChild(cups ? cupCards(me) : roomCards(me));
    else if (at.net === 'wait') main.appendChild(waiting());
    else main.appendChild(offline());
    const play = node('div', 'hl-play');
    if (on && !cups) {
      // the second room, or the best one the player can pay for
      const ok = at.stakes.filter(s => afford(me, s));
      const q = ok[Math.min(1, ok.length - 1)];
      const quick = twoLines('primary', t('hall.quick'), q ? t('hall.quickAt', { n: fmt(q) }) : t('hall.locked'), () => {
        connecting(false, t('hall.finding'));
        Net.play(q, at.fast);
      });
      quick.disabled = !q;
      quick.dataset.k = 'quick';
      play.appendChild(quick);
      const fr = twoLines('plain', t('hall.friends'), t('hall.friendsNote'), friendsSheet);
      fr.dataset.k = 'friends';
      play.appendChild(fr);
    }
    const prac = twoLines(on ? 'quiet small' : 'primary', t('start.go'), t('start.goNote'), setup);
    prac.dataset.k = 'go';
    play.appendChild(prac);
    main.appendChild(play);
    body.appendChild(main);
  }

  function waiting() {
    const w = node('div', 'conn');
    w.appendChild(Cards.icon('i-chip', 'chip spin'));
    const p = node('p', 'lead', t('net.connecting'));
    p.setAttribute('role', 'status');
    w.appendChild(p);
    return w;
  }

  function pick(k) {
    at.tab = k;
    if (k === 'friends') Social.refresh().then(redraw, () => {});
    if (k === 'top') Social.top().then(redraw, () => {});
    draw();
  }

  // a tapped notification opens a tab; a match in progress is left alone
  function tab(k) {
    if (App.active()) return;
    Sheet.closeAll();
    pick(k);
  }

  function tabs(bar) {
    const list = node('div', 'tabs');
    list.setAttribute('role', 'tablist');
    for (const [k, label] of [['rooms', t('hall.rooms')], ['cups', t('cup.tab')], ['friends', t('fr.tab')], ['top', t('top.tab')]]) {
      const b = raw('tab', () => pick(k));
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
    if (me) bar.appendChild(capsule(me));
    if (at.net === 'up') tabs(bar);
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

  // a first table link makes the guest account on the way, which still needs its lobby and hub afterwards
  function account() {
    const fresh = !Account.has();
    return Account.ensure().then(r => {
      if (fresh) {
        at.gate = '';
        Net.up();
        Push.start();
      }
      return r;
    });
  }

  // an invitation or a friend's table, taken up from anywhere
  function accept(m) {
    Social.clear();
    // a full tournament is taking the buy-ins and cannot be left any more
    if (wait && wait.cup && wait.n >= 8) return notice(t('cup.starting'));
    if (wait && wait.cup) {
      leaving = true;
      wait = null;
      Net.cup(0);
    }
    Sheet.closeAll();
    if (Net.busy()) Net.leave(false);
    connecting(true, t('net.title'));
    if (m.pub) Net.sit(m.code);
    else account().then(() => Net.join(m.code), () => { close(); notice(t('net.err.lost')); });
  }

  // The lobby is the home screen: the stake rooms, the friends and the leaderboard.
  function draw() {
    if (!Account.has()) return gate();
    if (later) {
      const c = later;
      later = null;
      setTimeout(() => online(c));
    }
    const home = $('home');
    const keep = home.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const sb = home.querySelector('.sbody');
    const top = sb ? sb.scrollTop : 0;
    home.hidden = false;
    home.textContent = '';
    const me = Account.me();
    home.appendChild(hallBar(me));
    const body = node('main', 'hl-body');
    if (at.net !== 'up' || at.tab === 'rooms' || at.tab === 'cups') tablesTab(body, me, at.net === 'up' && at.tab === 'cups');
    else {
      const pn = node('section', 'paper pnl');
      const box = pn.appendChild(node('div', 'sbody frs'));
      if (at.tab === 'friends') Social.friends(box, { join: accept, again: redraw });
      else Social.leaders(box, redraw);
      body.appendChild(pn);
    }
    home.appendChild(body);
    const now = home.querySelector('.sbody');
    if (now) now.scrollTop = top;
    if (keep) {
      const e = home.querySelector('[data-k="' + keep + '"]');
      if (e) e.focus({ preventScroll: true });
    }
  }

  // the connecting sheet or the table's, whichever is up
  function close() {
    if (wait) wait.h.close();
    wait = null;
  }

  function notice(text) {
    Sheet.open({ kind: 'center', title: t('net.title'), body: node('p', '', text), actions: [{ label: t('close'), kind: 'primary' }] });
  }

  // the server will not start the room while this seat's account sits at another table
  function held(seat) {
    const s = wait && wait.m && wait.m.seats[seat];
    if (wait && wait.go) wait.go.disabled = false;
    notice(t('net.err.held', { name: s ? s.name : '' }));
  }

  // a link to a table: /t/CODE, or the older #CODE
  function link(url) {
    const u = url ? new URL(url, location.href) : location;
    const m = /^\/t\/([A-Za-z]{4})\/?$/.exec(u.pathname) || /^#([A-Za-z]{4})$/.exec(u.hash);
    if (!url && m) history.replaceState(history.state, '', '/');
    if (!m || App.online() || Net.busy()) return;
    const code = m[1].toUpperCase();
    if (!Account.has()) {
      later = code;
      return;
    }
    // the cold start can report the same link twice
    if (linked === code + Math.floor(Date.now() / 3000)) return;
    linked = code + Math.floor(Date.now() / 3000);
    Sheet.closeAll();
    online(code);
  }

  window.addEventListener('hashchange', () => link());

  // pictures are drawn at a pixel size, so a resized stage needs them again
  window.addEventListener('resize', () => redraw());

  // friends move around without telling the lobby, so it asks now and then; never under a finger
  document.addEventListener('pointerdown', () => { pressed = true; }, true);
  document.addEventListener('pointerup', () => { pressed = false; }, true);
  document.addEventListener('pointercancel', () => { pressed = false; }, true);
  setInterval(() => {
    if (pressed || document.hidden || $('home').hidden || at.net !== 'up' || Sheet.count() || at.tab === 'top') return;
    Social.refresh().then(redraw, () => {});
  }, 8000);

  return {
    show: show, pause: pause, settings: settings, howTo: howTo, lobby: lobby, close: close, notice: notice, held: held, link: link, tab: tab,
    accept: accept, up: up, hub: hub, rooms: rooms, cup: cupForm, cupSeated: cupSeated, cupEnd: cupEnd, conn: conn, retry: retry, redraw: redraw, entry: () => at.entry
  };
})();
