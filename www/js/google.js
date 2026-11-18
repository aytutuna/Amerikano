var Google = (function () {
  // OAuth client ids from the Google Cloud project: the web client (also what Android asks for) and the iOS one
  const WEB = 'set-the-web-client-id';
  const IOS = 'set-the-ios-client-id';
  const REDIRECT = 'com.googleusercontent.apps.' + IOS.replace('.apps.googleusercontent.com', '') + ':/oauth2redirect';
  let sdk = null;
  let state = null;
  let handler = null;

  const platform = () => (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web';
  const real = id => /\.apps\.googleusercontent\.com$/.test(id);
  const nonce = () => Account.call('POST', '/api/google/nonce').then(d => d.nonce);

  function load() {
    if (window.google && window.google.accounts) return Promise.resolve();
    sdk = sdk || new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = ok;
      s.onerror = () => { sdk = null; s.remove(); no(new Error('load')); };
      document.head.appendChild(s);
    });
    return sdk;
  }

  const G = {};

  // a button is only offered once the client ids are filled in
  G.can = () => real(platform() === 'ios' ? IOS : WEB);

  G.native = () => platform() !== 'web';

  // Web: the button is Google's own (a custom one cannot get an ID token), so it is drawn into el and
  // done gets {token, nonce}, or an error with cancelled set.
  G.render = (el, done) => {
    handler = done;
    const ready = state && Date.now() - state.at < 300000 ? state.ready : prepare();
    ready.then(() => {
      window.google.accounts.id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: Math.min(400, Math.max(200, el.clientWidth)), locale: I18n.lang() });
    }, () => {});
  };

  function prepare() {
    const w = state = { at: Date.now() };
    return w.ready = Promise.all([load(), nonce()]).then(r => {
      w.raw = r[1];
      window.google.accounts.id.initialize({
        client_id: WEB,
        nonce: Apple.sha256(w.raw),
        callback: c => {
          // the nonce is spent with the token, so the next button press gets a new one
          state = null;
          prepare().catch(() => {});
          if (handler) handler({ token: c.credential, nonce: w.raw });
        }
      });
    }, e => { if (state === w) state = null; throw e; });
  }

  // resolves {token, nonce}; a dismissed dialog rejects with cancelled set
  G.signIn = async () => {
    try {
      const raw = await nonce();
      const hex = Apple.sha256(raw);
      const plugin = window.Capacitor.Plugins.GoogleSignIn;
      const r = platform() === 'ios'
        ? await plugin.signIn({ clientId: IOS, redirect: REDIRECT, nonce: hex })
        : await plugin.signIn({ clientId: WEB, nonce: hex });
      return { token: r.idToken, nonce: raw };
    } catch (e) {
      const code = String((e && (e.code || e.message)) || '');
      if (/CANCEL|1001|cancelled|canceled/i.test(code)) e = Object.assign(new Error('cancelled'), { cancelled: true });
      throw e;
    }
  };

  return G;
})();
