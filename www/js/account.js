var Account = (function () {
  const KEY = 'amerikano.account';
  const ME = 'amerikano.me';
  let acc = load(KEY);
  let me = load(ME);

  function load(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
  }

  function keep(k, v) {
    try {
      if (v) localStorage.setItem(k, JSON.stringify(v));
      else localStorage.removeItem(k);
    } catch (e) { /* kept for this session only */ }
  }

  function base() {
    const l = location;
    const dev = l.protocol === 'http:' && (l.hostname === 'localhost' || l.hostname === '127.0.0.1');
    return dev ? 'http://localhost:8787' : 'https://amerikano.aytu-tuna.workers.dev';
  }

  async function call(method, path, body) {
    const h = {};
    if (body) h['Content-Type'] = 'application/json';
    if (acc && path !== '/api/guest') h.Authorization = 'Bearer ' + acc.id + '.' + acc.secret;
    const r = await fetch(base() + path, { method: method, headers: h, body: body && JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && acc) forget();
    if (!r.ok) throw Object.assign(new Error(d.error || 'api'), { status: r.status });
    return d;
  }

  function forget() {
    acc = me = null;
    keep(KEY, null);
    keep(ME, null);
  }

  function set(p) {
    me = p;
    keep(ME, p);
    return p;
  }

  const A = {};

  A.has = () => !!acc;
  A.auth = () => acc && acc.id + '.' + acc.secret;
  A.me = () => me;

  A.refresh = async () => {
    const a = acc;
    const p = await call('GET', '/api/me');
    return acc === a ? set(p) : p;
  };

  // the guest account is made on first use
  A.ensure = async () => {
    if (!acc) {
      acc = await call('POST', '/api/guest');
      keep(KEY, acc);
    }
    return me || A.refresh();
  };

  A.reroll = async () => set(await call('POST', '/api/name'));
  A.look = async avatar => set(await call('POST', '/api/avatar', { avatar: avatar }));
  A.daily = async () => set(await call('POST', '/api/daily'));
  A.bailout = async () => set(await call('POST', '/api/bailout'));

  A.remove = async () => {
    await call('DELETE', '/api/me');
    forget();
  };

  A.forget = forget;

  return A;
})();
