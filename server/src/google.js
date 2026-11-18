import { unb64, part } from './apple.js';

const ISS = ['accounts.google.com', 'https://accounts.google.com'];
const CERTS = 'https://www.googleapis.com';
const HOUR = 3600000;

let jwks = null;
let fetched = 0;

// PACE only exists on a dev server, so a stray GOOGLE_BASE can never point production at other keys
const root = env => (env.PACE && env.GOOGLE_BASE) || CERTS;

// the web client (also the audience of Android tokens) and the iOS client; the wrangler.toml placeholder matches none
const clients = env => (env.GOOGLE_CLIENTS || '').split(',').map(s => s.trim()).filter(s => s.endsWith('.apps.googleusercontent.com'));

export const configured = env => clients(env).length > 0;

async function keyFor(env, kid) {
  // an unknown kid refetches, but not more than once a minute
  const age = Date.now() - fetched;
  if (!jwks || age > HOUR || (!jwks.some(k => k.kid === kid) && age > 60000)) {
    const r = await fetch(root(env) + '/oauth2/v3/certs');
    if (!r.ok) throw new Error('jwks ' + r.status);
    jwks = (await r.json()).keys;
    fetched = Date.now();
  }
  return jwks.find(k => k.kid === kid);
}

// Same nonce rule as Apple: the token carries the hex SHA-256 of the raw nonce the server issued.
// Returns { sub } or null.
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
    if (!ISS.includes(c.iss) || !clients(env).includes(c.aud) || !(c.exp > Date.now() / 1000) || c.nonce !== want) return null;
    return typeof c.sub === 'string' && c.sub ? { sub: c.sub } : null;
  } catch (e) {
    return null;
  }
}
