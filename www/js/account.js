var Account = (function () {
  const KEY = 'amerikano.account';
  const ME = 'amerikano.me';
  let acc = load(KEY);
  let me = load(ME);
  let making = null;

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
    if (acc && path !== '/api/guest' && path !== '/api/apple') h.Authorization = 'Bearer ' + acc.id + '.' + acc.secret;
    const sent = acc;
    const r = await fetch(base() + path, { method: method, headers: h, body: body && JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && acc && acc === sent && d.error === 'auth') forget(true);
    if (!r.ok) throw Object.assign(new Error(d.error || d.k || 'api'), { status: r.status });
    return d;
  }

  function forget(dead) {
    // the request needs the login, so it starts before the account goes; a dead login has no devices left to drop
    if (acc && !dead && typeof Push !== 'undefined') Push.leave();
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
  A.id = () => acc && acc.id;
  A.call = call;

  A.refresh = async () => {
    const a = acc;
    const p = await call('GET', '/api/me');
    return acc === a ? set(p) : p;
  };

  // the guest account is made on first use
  A.ensure = async () => {
    if (!acc) {
      making = making || call('POST', '/api/guest').finally(() => { making = null; });
      const g = await making;
      if (!acc) {
        acc = g;
        keep(KEY, acc);
      }
    }
    return me || A.refresh();
  };

  // c is {token, nonce, code} from Apple; the account linked to that Apple ID replaces the stored one
  A.signIn = async c => {
    const g = await call('POST', '/api/apple', c);
    acc = g;
    me = null;
    keep(KEY, g);
    keep(ME, null);
    return A.refresh();
  };

  A.link = async c => set(await call('POST', '/api/apple/link', c));

  A.reroll = async () => set(await call('POST', '/api/name'));
  A.look = async avatar => set(await call('POST', '/api/avatar', { avatar: avatar }));
  A.daily = async () => set(await call('POST', '/api/daily'));
  A.bailout = async () => set(await call('POST', '/api/bailout'));
  A.push = async (k, v) => set(await call('POST', '/api/push', { [k]: v }));
  A.region = async r => set(await call('POST', '/api/region', { region: r }));

  // an Apple account the server holds no token for has to send a fresh credential
  A.remove = async cred => {
    await call('DELETE', '/api/me', cred);
    forget();
  };

  A.forget = forget;

  return A;
})();
