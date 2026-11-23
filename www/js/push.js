var Push = (function () {
  const ASKED = 'amerikano.pushAsked';
  const LAST = 'amerikano.pushTap';
  const TABS = { friend: 'friends', dm: 'friends', daily: 'rooms', week: 'top' };
  let token = '';
  let perm = '';
  let wired = false;
  // a tap that launched the app waits until the lobby is up
  let ready = false;
  let held = null;

  const plug = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
  // Android answers prompt-with-rationale after a refusal, which is a refusal
  const state = r => (r.receive === 'prompt' ? 'prompt' : r.receive === 'granted' ? 'granted' : 'denied');

  function asked() {
    try { return !!localStorage.getItem(ASKED); } catch (e) { return true; }
  }

  function send() {
    if (!token || !Account.has()) return Promise.resolve();
    const kind = window.Capacitor.getPlatform() === 'ios' ? 'apns' : 'fcm';
    return Account.call('POST', '/api/device', { kind: kind, token: token, lang: I18n.lang(), tz: new Date().getTimezoneOffset() }).catch(() => {});
  }

  // an invite opens its table like a /t/CODE link; the rest open a lobby tab
  function tap(d) {
    if (!d) return;
    if (!ready) {
      held = d;
      return;
    }
    if (d.t === 'invite' && /^[A-Za-z]{4}$/.test(d.code)) UI.link('/t/' + d.code);
    else if (TABS[d.t]) UI.tab(TABS[d.t]);
  }

  const P = {};

  // only the native apps have the plugin
  P.can = () => !!plug();

  // the system permission as last read: granted, denied or prompt
  P.perm = () => perm;

  // granted in the system settings after a refusal: register now rather than at the next cold start
  P.check = () => plug().checkPermissions().then(r => {
    perm = state(r);
    if (perm === 'granted' && !token) return plug().register();
  }).catch(() => {});

  P.init = () => {
    const p = plug();
    if (!p || wired) return;
    wired = true;
    p.addListener('registration', e => {
      token = e.value;
      send();
    });
    p.addListener('registrationError', () => {});
    p.addListener('pushNotificationActionPerformed', e => {
      const n = e.notification;
      // android replays the launching intent when the activity is recreated
      if (n && n.id) {
        try {
          if (localStorage.getItem(LAST) === n.id) return;
          localStorage.setItem(LAST, n.id);
        } catch (x) { /* no de-dupe without storage */ }
      }
      tap(n && n.data);
    });
  };

  P.ready = () => {
    ready = true;
    const d = held;
    held = null;
    tap(d);
  };

  // asks once, then registers with the system and sends the token on; runs on every start once the player is signed in
  P.start = async () => {
    const p = plug();
    if (!p || !Account.has()) return;
    try {
      let r = await p.checkPermissions();
      if (state(r) === 'prompt' && !asked()) {
        try { localStorage.setItem(ASKED, '1'); } catch (e) { /* asks again next time */ }
        r = await p.requestPermissions();
      }
      perm = state(r);
      if (perm === 'granted') await p.register();
    } catch (e) { /* this device cannot do push */ }
  };

  // the language may have changed
  P.sync = () => send();

  // before the account is forgotten, since the request needs its login
  P.leave = () => {
    if (token) Account.call('DELETE', '/api/device', { token: token }).catch(() => {});
  };

  P.get = k => {
    const m = Account.me();
    return !m || !m.push || m.push[k] !== false;
  };

  // switching push on asks again when the system permission is not granted; a refusal leaves perm denied for the note
  P.set = async (k, v) => {
    const m = await Account.push(k, v);
    const p = plug();
    if (k === 'on' && v && p && perm !== 'granted') {
      try {
        perm = state(await p.requestPermissions());
        if (perm === 'granted') await p.register();
      } catch (e) { /* stays as it was */ }
    }
    return m;
  };

  return P;
})();
