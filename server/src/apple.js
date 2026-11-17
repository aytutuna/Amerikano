const ISS = 'https://appleid.apple.com';
const WEB = 'com.aytutuna.amerikano.web';
const CLIENTS = ['com.aytutuna.amerikano', WEB];
const RETURN = 'https://amerikano.pages.dev/';
const HOUR = 3600000;

let jwks = null;
let fetched = 0;

const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const part = s => JSON.parse(new TextDecoder().decode(unb64(s)));

// PACE only exists on a dev server, so a stray APPLE_BASE can never point production at other keys
const root = env => (env.PACE && env.APPLE_BASE) || ISS;

async function keyFor(env, kid) {
  // an unknown kid refetches, but not more than once a minute
  const age = Date.now() - fetched;
  if (!jwks || age > HOUR || (!jwks.some(k => k.kid === kid) && age > 60000)) {
    const r = await fetch(root(env) + '/auth/keys');
    if (!r.ok) throw new Error('jwks ' + r.status);
    jwks = (await r.json()).keys;
    fetched = Date.now();
  }
  return jwks.find(k => k.kid === kid);
}

// The client hands Apple sha256(raw) as the nonce, so the token carries its hex and the server is given raw.
// Returns { sub, aud } or null.
export async function identity(env, token, nonce) {
  try {
    const [h, p, s] = token.split('.');
    const head = part(h);
    if (head.alg !== 'RS256') return null;
    const jwk = await keyFor(env, head.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64(s), new TextEncoder().encode(h + '.' + p))) return null;
    const c = part(p);
    const want = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce))), b => b.toString(16).padStart(2, '0')).join('');
    if (c.iss !== ISS || !CLIENTS.includes(c.aud) || !(c.exp > Date.now() / 1000) || c.nonce !== want) return null;
    return typeof c.sub === 'string' && c.sub ? { sub: c.sub, aud: c.aud } : null;
  } catch (e) {
    return null;
  }
}

async function secret(env, client) {
  const pem = env.APPLE_KEY.replace(/-----[A-Z ]+-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', unb64(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = o => b64(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'ES256', kid: env.APPLE_KEY_ID }) + '.' + enc({ iss: env.APPLE_TEAM, iat: now, exp: now + 300, aud: ISS, sub: client });
  return head + '.' + b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head)));
}

function post(env, path, form) {
  return fetch(root(env) + path, { method: 'POST', body: new URLSearchParams(form) });
}

// The refresh token for an authorization code, or null; sign-in never depends on it.
export async function refresh(env, code, client) {
  if (!code || !env.APPLE_KEY) return null;
  try {
    const form = { client_id: client, client_secret: await secret(env, client), code: code, grant_type: 'authorization_code' };
    if (client === WEB) form.redirect_uri = RETURN;
    const r = await post(env, '/auth/token', form);
    return r.ok ? (await r.json()).refresh_token || null : null;
  } catch (e) {
    return null;
  }
}

export async function revoke(env, token, client) {
  if (!token || !client || !env.APPLE_KEY) return;
  try {
    await post(env, '/auth/revoke', { client_id: client, client_secret: await secret(env, client), token: token, token_type_hint: 'refresh_token' });
  } catch (e) {}
}
