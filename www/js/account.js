var Account = (function () {
  const KEY = 'amerikano.account';
  const ME = 'amerikano.me';
  // the apps keep the key in the system's own store; the web keeps it in localStorage
  const pref = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
  let acc = pref() ? null : load(KEY);
  let me = pref() ? null : load(ME);
  let loaded = !pref();
  let making = null;

  function load(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
  }

  function local(k, v) {
    try {
      if (v) localStorage.setItem(k, JSON.stringify(v));
      else localStorage.removeItem(k);
    } catch (e) { /* kept for this session only */ }
  }

  // Until the read is in, nothing signs in and nothing is written, so a slow read cannot swap the real account for a new guest.
  // Only a read that fails falls through to the localStorage copy, if there is one, and then to a guest.
  const ready = !pref() ? Promise.resolve() : (async () => {
    const p = pref();
    const got = async k => {
      const r = await p.get({ key: k });
      return r && r.value ? JSON.parse(r.value) : null;
    };
    try {
      acc = await got(KEY);
      me = await got(ME);
      const old = load(KEY);
      if (!acc && old) {
        const oldMe = load(ME);
        await p.set({ key: KEY, value: JSON.stringify(old) });
        if (oldMe) await p.set({ key: ME, value: JSON.stringify(oldMe) });
        acc = old;
        me = oldMe;
        local(KEY, null);
        local(ME, null);
      }
    } catch (e) {
      acc = acc || load(KEY);
      me = me || load(ME);
    }
    loaded = true;
  })();
  let writes = ready;

  function keep(k, v) {
    const p = pref();
    if (!p) return local(k, v);
    // a write that fails lands in localStorage, and one that works removes the old copy so a sign-out cannot come back
    writes = writes.then(() => (v ? p.set({ key: k, value: JSON.stringify(v) }) : p.remove({ key: k })))
      .then(() => local(k, null), () => local(k, v));
  }

  function base() {
    const l = location;
    const dev = l.protocol === 'http:' && (l.hostname === 'localhost' || l.hostname === '127.0.0.1');
    return dev ? 'http://localhost:8787' : 'https://amerikano.aytu-tuna.workers.dev';
  }

  async function call(method, path, body) {
    if (!loaded) await ready;
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
    // the requests need the login, so they start before the account goes; a dead login has nothing left to end
    if (acc && !dead) {
      if (typeof Push !== 'undefined') Push.leave();
      call('POST', '/api/signout').catch(() => {});
    }
    acc = me = null;
    keep(KEY, null);
    keep(ME, null);
    // the old account's bought back and felt leave the table
    if (typeof Settings !== 'undefined') Settings.apply();
  }

  function set(p) {
    me = p;
    keep(ME, p);
    // a worn back or felt is drawn from the body
    if (typeof Settings !== 'undefined') Settings.apply();
    return p;
  }

  const A = {};

  A.ready = ready;
  A.loaded = () => loaded;
  A.has = () => !!acc;
  A.auth = () => acc && acc.id + '.' + acc.secret;
  A.me = () => me;
  A.id = () => acc && acc.id;
  A.call = call;

  A.refresh = async () => {
    const a = acc;
    const p = await call('GET', '/api/me');
    if (p.lang !== I18n.lang()) call('POST', '/api/lang', { lang: I18n.lang() }).catch(() => {});
    return acc === a ? set(p) : p;
  };

  // the guest account is made on first use
  A.ensure = async () => {
    await ready;
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
  A.typed = async v => set(await call('POST', '/api/typed', { typed: v }));
  A.voice = async v => set(await call('POST', '/api/voice', { voice: v }));

  // an Apple account the server holds no token for has to send a fresh credential
  A.remove = async cred => {
    await call('DELETE', '/api/me', cred);
    forget(true);
  };

  A.forget = forget;

  return A;
})();
