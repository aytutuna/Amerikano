var Apple = (function () {
  const SITE = { clientId: 'com.aytutuna.amerikano.web', redirectURI: 'https://amerikano.pages.dev/' };
  let sdk = null;
  let ready = null;

  const LOCALES = {
    en: 'en_US', tr: 'tr_TR', es: 'es_MX', pt: 'pt_BR', fr: 'fr_FR', it: 'it_IT', de: 'de_DE', nl: 'nl_NL', pl: 'pl_PL',
    ru: 'ru_RU', uk: 'uk_UA', ar: 'ar_SA', hi: 'hi_IN', id: 'id_ID', ja: 'ja_JP', ko: 'ko_KR', 'zh-Hans': 'zh_CN', 'zh-Hant': 'zh_TW'
  };

  const platform = () => (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web';

  // The server hands out the raw nonce and wants the token's nonce to be its hex SHA-256. Plain JS, since
  // crypto.subtle only exists in secure contexts and a custom app scheme may not count as one.
  function sha256(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const K = [];
    let H = [];
    for (let n = 2, i = 0; i < 64; n++) {
      let prime = true;
      for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
      if (!prime) continue;
      if (i < 8) H[i] = Math.floor(2 ** 32 * (Math.sqrt(n) % 1));
      K[i++] = Math.floor(2 ** 32 * (Math.cbrt(n) % 1));
    }
    const bits = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push(i > 3 ? 0 : (bits >>> (i * 8)) & 255);
    const ror = (x, n) => (x >>> n) | (x << (32 - n));
    const w = new Array(64);
    for (let o = 0; o < bytes.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (bytes[o + 4 * i] << 24) | (bytes[o + 4 * i + 1] << 16) | (bytes[o + 4 * i + 2] << 8) | bytes[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15];
        const b = w[i - 2];
        w[i] = (w[i - 16] + (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) + w[i - 7] + (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10))) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H = H.map((x, i) => (x + [a, b, c, d, e, f, g, h][i]) | 0);
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  function load() {
    if (window.AppleID) return Promise.resolve();
    sdk = sdk || new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/' + (LOCALES[I18n.lang()] || 'en_US') + '/appleid.auth.js';
      s.onload = ok;
      s.onerror = () => { sdk = null; s.remove(); no(new Error('load')); };
      document.head.appendChild(s);
    });
    return sdk;
  }

  const A = {};

  A.sha256 = sha256;

  // Android has no plugin and no redirect flow yet
  A.can = () => platform() !== 'android';

  const nonce = () => Account.call('POST', '/api/apple/nonce').then(d => d.nonce);

  // browsers block a popup that opens after a wait, so the script and a nonce are fetched before the tap
  A.warm = () => {
    if (platform() !== 'web' || (ready && Date.now() - ready.at < 300000)) return;
    const w = ready = { at: Date.now() };
    Promise.all([load(), nonce()]).then(r => {
      window.AppleID.auth.init(Object.assign({ usePopup: true, nonce: sha256(r[1]) }, SITE));
      w.raw = r[1];
    }).catch(() => { if (ready === w) ready = null; });
  };

  // resolves {token, nonce, code}; a closed dialog rejects with cancelled set
  A.signIn = async () => {
    try {
      if (platform() === 'ios') {
        const raw = await nonce();
        const r = await window.Capacitor.Plugins.AppleSignIn.signIn({ nonce: sha256(raw) });
        return { token: r.idToken, nonce: raw, code: r.authorizationCode };
      }
      const w = ready;
      if (!w || !w.raw) {
        A.warm();
        throw new Error('load');
      }
      ready = null;
      try {
        const r = (await window.AppleID.auth.signIn()).authorization;
        return { token: r.id_token, nonce: w.raw, code: r.code };
      } finally {
        A.warm();
      }
    } catch (e) {
      const code = String((e && (e.code || e.error)) || '');
      if (/CANCEL|1001|popup_closed|user_cancelled/i.test(code)) e = Object.assign(new Error('cancelled'), { cancelled: true });
      throw e;
    }
  };

  return A;
})();
