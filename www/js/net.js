var Net = (function () {
  const KEY = 'amerikano.online';
  const SITE = 'https://amerikano.pages.dev/';
  const FRESH = 15 * 60000;
  const REFUSED = ['nocode', 'started', 'full', 'taken', 'auth', 'poor', 'busy'];
  let sock = null;
  let hubSock = null;
  let ses = null;
  let tries = 0;
  let retry = 0;
  let pong = 0;
  let pinged = 0;
  let hubTries = 0;
  let hubRetry = 0;
  let hubDone = false;
  let where = 'lobby';

  function host() {
    const l = location;
    const dev = l.protocol === 'http:' && (l.hostname === 'localhost' || l.hostname === '127.0.0.1');
    return dev ? 'ws://localhost:8787' : 'wss://amerikano.aytu-tuna.workers.dev';
  }

  function msg(k) {
    const s = t('net.err.' + k);
    return s === 'net.err.' + k ? t('net.err.other') : s;
  }

  function store() {
    try { localStorage.setItem(KEY, JSON.stringify(ses)); } catch (e) { /* the match just will not offer a rejoin */ }
  }

  function save(o) {
    ses = Object.assign(ses || {}, o, { at: Date.now() });
    store();
  }

  function drop() {
    ses = null;
    clearTimeout(retry);
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  function recent() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.code && d.token && Date.now() - d.at < FRESH) return d;
    } catch (e) { /* corrupt, treated as none */ }
    return null;
  }

  function detach() {
    const w = sock;
    sock = null;
    if (w) w.close();
  }

  function open(path, hello) {
    detach();
    const ws = new WebSocket(host() + path);
    sock = ws;
    ws.onopen = () => {
      if (ws !== sock) return;
      pong = Date.now();
      pinged = 0;
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = e => { if (ws === sock) got(e.data); };
    ws.onclose = e => { if (ws === sock) lost(e); };
  }

  function rejoin() {
    if (ses) open('/ws/' + ses.code, { t: 'join', token: ses.token });
  }

  // gives up on the table: back to the lobby with the reason. A lost connection keeps the
  // session so Rejoin still works once the network is back; a replaced one belongs to the other window.
  function gone(k) {
    const live = App.online();
    detach();
    clearTimeout(retry);
    if (k === 'replaced') ses = null;
    else if (k !== 'lost') drop();
    UI.close();
    if (live) App.leave(false, true);
    UI.notice(msg(k));
    UI.show();
  }

  function lost(e) {
    sock = null;
    // 4000 means the seat was taken over from another window, 1000 that the server ended it
    if (e.code === 4000) return gone('replaced');
    if (e.code === 1000) return ses ? gone('ended') : undefined;
    if (!ses) return gone('lost');
    if (++tries > 12) return gone('lost');
    if (tries === 1 && App.online()) App.flash(t('net.retry'));
    clearTimeout(retry);
    retry = setTimeout(rejoin, Math.min(1000 * 2 ** (tries - 1), 8000));
  }

  function got(d) {
    if (d === 'pong') { pong = Date.now(); return; }
    let m;
    try { m = JSON.parse(d); } catch (e) { return; }
    switch (m.t) {
      case 'joined':
        tries = 0;
        save({ code: m.code, token: m.token, hist: ses && ses.code === m.code ? ses.hist : [] });
        break;
      case 'room': UI.lobby(m); break;
      case 'state':
        if (App.active() && !App.online()) return detach();
        UI.close();
        save();
        App.sync(m);
        break;
      case 'sent': Social.sent(m); break;
      case 'said': if (App.online()) Social.said(m); break;
      case 'gifted': if (App.online()) Social.gifted(m); break;
      case 'error': fail(m); break;
    }
  }

  function fail(m) {
    if (m.k === 'held') return UI.held(m.seat);
    if (REFUSED.includes(m.k)) {
      if (m.k === 'auth') Account.forget();
      const live = App.online();
      detach();
      drop();
      UI.close();
      if (live) App.leave(false);
      UI.notice(msg(m.k));
      if (m.k === 'auth') UI.retry();
      else UI.show();
      return;
    }
    if (App.online()) App.fail(m.k, m);
    else UI.notice(msg(m.k));
  }

  // The hub socket lives as long as the app is in the foreground, whatever screen is up.
  function hubOpen() {
    clearTimeout(hubRetry);
    if (hubSock || hubDone || document.hidden || !Account.auth()) return;
    const ws = new WebSocket(host() + '/ws/hub');
    hubSock = ws;
    ws.onopen = () => {
      if (ws !== hubSock) return;
      ws.pong = Date.now();
      ws.pinged = 0;
      ws.send(JSON.stringify({ t: 'hello', auth: Account.auth(), at: where }));
    };
    ws.onmessage = e => { if (ws === hubSock) hubGot(e.data); };
    ws.onclose = () => {
      if (ws !== hubSock) return;
      hubSock = null;
      if (hubDone || document.hidden) return;
      UI.conn(hubTries++ ? 'down' : 'wait');
      hubRetry = setTimeout(hubOpen, Math.min(1000 * 2 ** (hubTries - 1), 15000));
    };
  }

  function hubClose() {
    clearTimeout(hubRetry);
    const w = hubSock;
    hubSock = null;
    if (w) w.close();
  }

  function hubGot(d) {
    if (d === 'pong') { hubSock.pong = Date.now(); return; }
    let m;
    try { m = JSON.parse(d); } catch (e) { return; }
    switch (m.t) {
      case 'hub':
        hubTries = 0;
        UI.conn('up');
        UI.hub(m);
        break;
      case 'rooms': UI.rooms(m.n); break;
      case 'seated':
        save({ code: m.code, token: m.token, hist: [] });
        open('/ws/' + m.code, { t: 'join', token: m.token });
        break;
      case 'invited': Social.invited(m); break;
      case 'error': hubFail(m); break;
    }
  }

  function hubFail(m) {
    if (m.k === 'replaced') {
      hubDone = true;
      hubClose();
      return UI.conn('replaced');
    }
    UI.close();
    if (m.k === 'auth') {
      Account.forget();
      hubClose();
      return UI.retry();
    }
    UI.notice(msg(m.k));
  }

  function hubSay(m) {
    if (hubSock && hubSock.readyState === 1) hubSock.send(JSON.stringify(m));
    else {
      UI.close();
      UI.notice(msg('lost'));
    }
  }

  // the wake-up after a background trip: a socket that looks open may be long dead
  function wake() {
    if (document.hidden) return hubClose();
    hubTries = 0;
    hubOpen();
    if (!ses || (App.active() && !App.online())) return;
    clearTimeout(retry);
    const w = sock;
    if (!w || w.readyState !== 1) {
      tries = 0;
      return rejoin();
    }
    const at = Date.now();
    w.send('ping');
    setTimeout(() => { if (sock === w && pong < at) rejoin(); }, 3000);
  }

  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  setInterval(() => {
    const h = hubSock;
    if (h && h.readyState === 1) {
      if (h.pinged > h.pong) {
        hubClose();
        hubOpen();
      } else {
        h.pinged = Date.now();
        h.send('ping');
      }
    }
    if (!sock || sock.readyState !== 1) return;
    if (pinged > pong) return rejoin();
    pinged = Date.now();
    sock.send('ping');
  }, 25000);

  const N = {};

  N.link = code => SITE + 't/' + code;
  N.recent = recent;
  N.busy = () => !!sock || !!ses;
  N.code = () => ses && ses.code;
  N.hist = () => (ses && ses.hist) || [];
  N.keep = hist => { if (ses) { ses.hist = hist; store(); } };

  N.up = () => {
    hubDone = false;
    hubTries = 0;
    hubClose();
    hubOpen();
  };

  // where the hub tells friends this player is, besides at a table
  N.at = w => {
    where = w;
    if (hubSock && hubSock.readyState === 1) hubSock.send(JSON.stringify({ t: 'at', at: w }));
  };

  N.sit = code => hubSay({ t: 'sit', code: code });
  N.play = stake => hubSay({ t: 'quick', stake: stake });

  N.create = o => {
    drop();
    open('/ws/new', Object.assign({ t: 'create', auth: Account.auth() }, o));
  };

  N.join = code => {
    drop();
    open('/ws/' + code, { t: 'join', auth: Account.auth() });
  };

  N.resume = () => {
    ses = recent();
    tries = 0;
    rejoin();
  };

  N.cancel = () => {
    detach();
    drop();
  };

  // keep: the match goes on without this window, so the stored session stays
  N.leave = keep => {
    if (keep) return detach();
    if (sock && sock.readyState === 1) sock.send(JSON.stringify({ t: 'leave' }));
    detach();
    drop();
  };

  N.send = m => {
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(m));
    else if (App.online()) App.fail('offline');
    else UI.notice(msg('lost'));
  };

  return N;
})();
