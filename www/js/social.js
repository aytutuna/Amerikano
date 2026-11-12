var Social = (function () {
  const node = Cards.node;
  const FRESH = 20000;
  let book = { friends: [], incoming: [], outgoing: [], blocked: [] };
  let board = null;
  let mode = 'week';
  let toast = null;
  const asked = new Map();

  const fmt = n => n.toLocaleString(I18n.lang());
  const who = seed => Names.text(seed, I18n.lang());
  const face = p => p.avatar || p.av;
  const rate = p => (p.games ? Math.round(p.wins / p.games * 100) + '%' : '-');

  function button(label, kind, fn) {
    const b = node('button', 'btn ' + kind, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function chipLine(n) {
    const c = node('span', 'chips');
    c.appendChild(Cards.icon('i-chip', 'chip'));
    c.appendChild(node('b', '', fmt(n)));
    return c;
  }

  const S = {};

  S.refresh = () => Account.call('GET', '/api/friends').then(d => (book = d));

  S.blocked = pid => !!pid && book.blocked.some(x => x.id === pid);

  // a person in a list: picture, name and level, opening the profile card when tapped
  function person(p, extra, again) {
    const li = node('li', 'fr');
    const b = node('button', 'pick');
    b.type = 'button';
    b.appendChild(Avatar.pic(face(p), 44));
    const tx = node('span', 'tx');
    tx.appendChild(node('b', '', who(p.seed)));
    tx.appendChild(node('small', '', t('hall.level', { n: p.level })));
    b.appendChild(tx);
    if (p.online !== undefined) {
      const d = node('i', 'dot' + (p.online ? ' on' : ''));
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', t(p.online ? 'fr.online' : 'fr.offline'));
      b.appendChild(d);
    }
    b.addEventListener('click', () => S.profile(p.id, p, undefined, again));
    li.appendChild(b);
    if (extra) for (const e of extra) li.appendChild(e);
    return li;
  }

  function section(box, title, list, mk) {
    if (!list.length) return;
    box.appendChild(node('h3', '', title));
    const ul = node('ul', 'fl');
    for (const p of list) ul.appendChild(mk(p));
    box.appendChild(ul);
  }

  function inviteBtn(p) {
    const b = button(t('fr.invite'), 'plain', () => {
      b.disabled = true;
      asked.set(p.id, 'wait');
      Net.send({ t: 'invite', to: p.id });
    });
    b.dataset.pid = p.id;
    b.disabled = !p.online;
    const k = asked.get(p.id);
    if (k && k !== 'wait') {
      b.textContent = t(k);
      b.disabled = true;
    } else if (k) b.disabled = true;
    return b;
  }

  // the friends list from what was fetched last; o.invite adds Invite buttons, o.again redraws after a change
  S.friends = (box, o) => {
    const call = (method, path, body) => () => Account.call(method, path, body).then(S.refresh).then(o.again, () => {});
    section(box, t('fr.requests'), book.incoming, p => person(p, [
      button(t('pc.accept'), 'primary', call('POST', '/api/friend', { id: p.id })),
      button(t('pc.decline'), 'plain', call('DELETE', '/api/friend/' + p.id))
    ], o.again));
    if (book.friends.length) section(box, t('fr.tab'), book.friends, p => person(p, o.invite ? [inviteBtn(p)] : null, o.again));
    else if (!book.incoming.length) box.appendChild(node('p', 'note', t('fr.none')));
    section(box, t('fr.waiting'), book.outgoing, p => person(p, null, o.again));
    section(box, t('fr.blocked'), book.blocked, p => person(p, [button(t('pc.unblock'), 'plain', call('DELETE', '/api/block/' + p.id))], o.again));
  };

  // from the room lobby: friends who are in the lobby can be asked to this table
  S.invite = () => {
    const body = node('div', 'form frs');
    asked.clear();
    const draw = () => {
      body.textContent = '';
      body.appendChild(node('p', 'note', t('fr.inviteNote')));
      S.friends(body, { invite: true, again: draw });
    };
    draw();
    Sheet.open({ kind: 'bottom', tall: true, title: t('fr.inviteFriends'), body: body, actions: [{ label: t('close'), kind: 'primary' }] });
    S.refresh().then(draw, () => {});
  };

  S.sent = m => {
    if (!asked.has(m.to)) return;
    const k = m.ok ? 'fr.invited' : 'fr.away';
    asked.set(m.to, k);
    for (const b of document.querySelectorAll('.frs [data-pid]')) if (b.dataset.pid === m.to) b.textContent = t(k);
  };

  S.invited = m => {
    if (!UI.inHall()) return;
    if (toast) toast.close();
    const body = node('p', '', t('fr.invText', { name: who(m.from.seed), n: fmt(m.stake) }));
    toast = Sheet.open({
      kind: 'center', title: t('fr.invTitle'), body: body,
      actions: [{ label: t('fr.join'), kind: 'primary', fn: () => UI.accept(m) }, { label: t('fr.later'), kind: 'quiet' }]
    });
  };

  S.top = () => {
    if (board && Date.now() - board.at < FRESH) return Promise.resolve(board);
    return Account.call('GET', '/api/top').then(d => (board = Object.assign(d, { at: Date.now() })));
  };

  // the leaderboard from the last fetch, with a switch between this week and all time
  S.leaders = (box, again) => {
    const modes = node('div', 'pills');
    for (const k of ['week', 'all']) {
      const b = node('button', 'pill', t('top.' + k));
      b.type = 'button';
      b.setAttribute('aria-pressed', mode === k);
      b.addEventListener('click', () => { mode = k; again(); });
      modes.appendChild(b);
    }
    box.appendChild(modes);
    box.appendChild(node('p', 'note', t('top.note')));
    if (!board) return;
    const week = mode === 'week';
    const rows = week ? board.week : board.level;
    const mine = week ? board.you.rank : board.up;
    if (!rows.length) return box.appendChild(node('p', 'note', t('top.none')));
    const me = Account.me();
    const ol = node('ol', 'ranks');
    const line = (p, n, you) => {
      const li = node('li', 'lb' + (you ? ' you' : ''));
      const b = node('button', 'pick');
      b.type = 'button';
      b.appendChild(node('span', 'no', n));
      b.appendChild(Avatar.pic(face(p), 44));
      const tx = node('span', 'tx');
      tx.appendChild(node('b', '', you ? t('top.you') : who(p.seed)));
      tx.appendChild(node('small', '', t('top.level', { n: p.level })));
      b.appendChild(tx);
      if (week) b.appendChild(chipLine(p.won));
      else b.appendChild(node('span', 'xp', fmt(p.xp) + ' XP'));
      if (!you) b.addEventListener('click', () => S.profile(p.id, p));
      li.appendChild(b);
      return li;
    };
    rows.forEach((p, i) => ol.appendChild(line(p, i + 1, p.id === Account.id())));
    if (me && mine && mine > rows.length) {
      const own = week ? { won: board.you.won } : { xp: me.xp };
      ol.appendChild(line(Object.assign({ level: me.level, avatar: me.avatar, seed: me.seed }, own), mine, true));
    }
    box.appendChild(ol);
  };

  // the card for one player; at a table the seat adds the gift row
  S.profile = (pid, hint, seat, again) => {
    const body = node('div', 'form prof pcard');
    const h = Sheet.open({ kind: 'bottom', tall: true, title: t('pc.title'), body: body, onClose: again, actions: [{ label: t('close'), kind: 'primary' }] });
    let data = null;

    function reload() {
      Account.call('GET', '/api/player/' + pid).then(d => {
        data = d;
        fill();
      }, () => {});
    }

    function post(path, method, fn) {
      return () => Account.call(method, path, fn && fn()).then(S.refresh).then(reload, e => {
        if (e.status === 409) Live.say(t('pc.cap'));
        else if (e.status === 403) Live.say(t('pc.barred'));
      });
    }

    function gifts() {
      const fs = node('fieldset', 'fld');
      fs.appendChild(node('legend', '', t('gift.title')));
      const row = node('div', 'gifts');
      const st = App.state();
      const bank = st && st.players[0].bank;
      for (const g of Chat.GIFTS) {
        const b = node('button', 'gift');
        b.type = 'button';
        b.appendChild(Cards.icon('g-' + g.k, 'gico'));
        b.appendChild(node('b', '', t('gift.' + g.k)));
        b.appendChild(chipLine(g.cost));
        b.disabled = bank !== undefined && bank < g.cost;
        b.addEventListener('click', () => {
          Net.send({ t: 'gift', to: seat, k: g.k });
          h.close();
        });
        row.appendChild(b);
      }
      fs.appendChild(row);
      fs.appendChild(node('p', 'note', t('gift.note')));
      return fs;
    }

    function fill() {
      body.textContent = '';
      const top = node('div', 'pf-top');
      top.appendChild(Avatar.pic(face(hint), 132, true));
      const tx = node('div', 'tx');
      tx.appendChild(node('h3', '', hint.seed === undefined ? hint.name : who(hint.seed)));
      if (!hint.bot) tx.appendChild(node('p', '', t('pf.level', { n: hint.level })));
      top.appendChild(tx);
      body.appendChild(top);
      if (data) {
        const stats = node('dl', 'stats');
        for (const [k, v] of [['games', fmt(data.games)], ['rate', rate(data)], ['week', data.rank ? '#' + data.rank : '-']]) {
          const d = node('div');
          d.appendChild(node('dt', '', t(k === 'week' ? 'pc.week' : k === 'rate' ? 'pc.rate' : 'pf.games')));
          d.appendChild(node('dd', '', v));
          stats.appendChild(d);
        }
        body.appendChild(stats);
        const r = data.rel;
        if (r === 'none') body.appendChild(button(t('pc.add'), 'primary', post('/api/friend', 'POST', () => ({ id: pid }))));
        else if (r === 'got') {
          body.appendChild(button(t('pc.accept'), 'primary', post('/api/friend', 'POST', () => ({ id: pid }))));
          body.appendChild(button(t('pc.decline'), 'plain', post('/api/friend/' + pid, 'DELETE')));
        } else if (r === 'sent') {
          const b = button(t('pc.sent'), 'plain', () => {});
          b.disabled = true;
          body.appendChild(b);
          body.appendChild(button(t('pc.cancel'), 'quiet', post('/api/friend/' + pid, 'DELETE')));
        } else if (r === 'friend') {
          body.appendChild(node('p', 'note', t('pc.friends')));
          body.appendChild(button(t('pc.remove'), 'plain', post('/api/friend/' + pid, 'DELETE')));
        }
      } else if (hint.bot) body.appendChild(node('p', 'note', t('pc.bot')));
      if (seat && (!data || data.rel !== 'you')) body.appendChild(gifts());
      if (data && data.rel === 'block') body.appendChild(button(t('pc.unblock'), 'plain', post('/api/block/' + pid, 'DELETE')));
      else if (data && data.rel !== 'you') body.appendChild(button(t('pc.block'), 'quiet', post('/api/block/' + pid, 'POST')));
    }

    fill();
    if (pid) reload();
    return h;
  };

  // a seat tapped at the table
  S.seat = i => {
    const st = App.state();
    const p = st && st.players[i];
    if (!p) return;
    const hint = { seed: p.seed, name: p.name, av: App.look(p, i), level: p.level, bot: !p.pid };
    S.profile(p.pid, hint, i || 0);
  };

  S.chat = () => {
    const body = node('div', 'form tray');
    const h = Sheet.open({ kind: 'bottom', tall: true, title: t('chat.title'), body: body, actions: [{ label: t('close'), kind: 'quiet' }] });
    const send = k => () => {
      Net.send({ t: 'say', k: k });
      h.close();
    };
    const fs = node('fieldset', 'fld');
    fs.appendChild(node('legend', '', t('chat.phrases')));
    const say = node('div', 'says');
    for (const k of Chat.SAY) say.appendChild(button(t('chat.say.' + k), 'plain', send(k)));
    fs.appendChild(say);
    body.appendChild(fs);
    const es = node('fieldset', 'fld');
    es.appendChild(node('legend', '', t('chat.emotes')));
    const emo = node('div', 'emos');
    for (const k of Chat.EMO) {
      const b = node('button', 'emo');
      b.type = 'button';
      b.setAttribute('aria-label', t('chat.emo.' + k));
      b.appendChild(Cards.icon('e-' + k, 'em'));
      b.addEventListener('click', send(k));
      emo.appendChild(b);
    }
    es.appendChild(emo);
    body.appendChild(es);
  };

  // a short-lived element on a player's picture
  function pin(i, el, ms) {
    const seat = Table.seat(i);
    const av = seat && seat.querySelector('.av');
    if (!av) return;
    for (const old of av.querySelectorAll('.' + el.classList[0])) old.remove();
    av.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  S.said = m => {
    const st = App.state();
    const p = st && st.players[m.p];
    if (!p || S.blocked(p.pid)) return;
    const emo = Chat.EMO.includes(m.k);
    const what = t(emo ? 'chat.emo.' + m.k : 'chat.say.' + m.k);
    const b = node('span', 'bub' + (emo ? ' emo' : ''));
    if (emo) b.appendChild(Cards.icon('e-' + m.k, 'em'));
    else b.textContent = what;
    pin(m.p, b, 3000);
    if (m.p) Live.say(t('chat.said', { name: p.name, what: what }));
  };

  S.gifted = m => {
    const st = App.state();
    if (!st || !st.players[m.to] || !st.players[m.from]) return;
    const g = node('span', 'gft');
    g.appendChild(Cards.icon('g-' + m.k, 'gico'));
    pin(m.to, g, 3200);
    Sfx.play('place');
    Live.say(t('gift.gifted', { from: st.players[m.from].name, to: st.players[m.to].name, gift: t('gift.' + m.k) }));
  };

  document.getElementById('chat').addEventListener('click', S.chat);

  return S;
})();
