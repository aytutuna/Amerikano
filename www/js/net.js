var Net = (function () {
  const KEY = 'amerikano.online';
  const SITE = 'https://amerikano.pages.dev/';
  const FRESH = 15 * 60000;
  const REFUSED = ['nocode', 'started', 'full', 'taken'];
  let sock = null;
  let ses = null;
  let tries = 0;
  let retry = 0;
  let pong = 0;
  let pinged = 0;

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

  // gives up: back to the home screen with the reason. A lost connection keeps the
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
      case 'queue': UI.queue(m.n); break;
      case 'matched':
        save({ code: m.code, token: m.token, hist: [] });
        open('/ws/' + m.code, { t: 'join', token: m.token });
        break;
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
      case 'error': fail(m); break;
    }
  }

  function fail(m) {
    if (REFUSED.includes(m.k)) {
      const live = App.online();
      detach();
      drop();
      UI.close();
      if (live) App.leave(false);
      return UI.notice(msg(m.k));
    }
    if (App.online()) App.fail(m.k, m);
    else UI.notice(msg(m.k));
  }

  // the wake-up after a background trip: a socket that looks open may be long dead
  function wake() {
    if (document.hidden || !ses || (App.active() && !App.online())) return;
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
    if (!sock || sock.readyState !== 1) return;
    if (pinged > pong) return rejoin();
    pinged = Date.now();
    sock.send('ping');
  }, 25000);

  const N = {};

  N.link = code => SITE + '#' + code;
  N.recent = recent;
  N.busy = () => !!sock || !!ses;
  N.hist = () => (ses && ses.hist) || [];
  N.keep = hist => { if (ses) { ses.hist = hist; store(); } };

  N.quick = () => {
    drop();
    UI.queue(null);
    open('/ws/quick', { t: 'quick' });
  };

  N.create = (name, o) => {
    drop();
    open('/ws/new', Object.assign({ t: 'create', name: name }, o));
  };

  N.join = (code, name) => {
    drop();
    open('/ws/' + code, { t: 'join', name: name });
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
