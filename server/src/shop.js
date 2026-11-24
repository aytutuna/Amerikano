import Catalog from '../../www/js/catalog.js';
import { verify, player, grantTokens, worn, json, fail } from './account.js';

const DAY = 86400000;
const API = 'https://api.revenuecat.com';
const ID = /^[0-9a-f]{32}$/;

export async function owns(db, id, item) {
  return !!await db.prepare('SELECT 1 FROM owned WHERE player = ? AND item = ?').bind(id, item).first();
}

async function body(request) {
  try {
    const b = await request.json();
    return b && typeof b === 'object' ? b : {};
  } catch (e) {
    return {};
  }
}

async function view(db, id) {
  const p = await player(db, id);
  if (!p) return fail('auth', 401);
  const { results } = await db.prepare('SELECT item FROM owned WHERE player = ?').bind(id).all();
  return json({
    tokens: p.tokens, owned: results.map(r => r.item), worn: worn(p),
    earned: p.earn_day === Math.floor(Date.now() / DAY) ? p.earned : 0, cap: Catalog.DAILY
  });
}

// The price is taken first under a ref of its own, so a retry after a failure in between only adds the item.
async function buy(db, p, request) {
  const item = Catalog.item((await body(request)).item);
  if (!item) return fail('item');
  if (await owns(db, p.id, item.id)) return fail('owned', 409);
  if (!await grantTokens(db, p.id, -item.price, 'buy', 'buy:' + p.id + ':' + item.id)) return fail('broke', 409);
  await db.prepare('INSERT OR IGNORE INTO owned (player, item, at) VALUES (?, ?, ?)').bind(p.id, item.id, Date.now()).run();
}

async function wear(db, p, request) {
  const b = await body(request);
  if (!Catalog.WORN.includes(b.slot)) return fail('slot');
  if (b.item !== null) {
    const item = Catalog.item(b.item);
    if (!item || item.slot !== b.slot) return fail('item');
    if (!await owns(db, p.id, item.id)) return fail('unowned', 403);
  }
  await db.prepare('UPDATE players SET wear_' + b.slot + ' = ? WHERE id = ?').bind(b.item, p.id).run();
}

// Credits one store transaction. The ref makes the tokens arrive once whichever of the webhook and sync sees it first.
async function take(db, id, product, tx, env) {
  const tokens = Catalog.amount(product);
  await grantTokens(db, id, tokens, 'purchase', 'rc:' + tx);
  await db.prepare('INSERT OR IGNORE INTO purchases (tx, player, product, tokens, env, at) VALUES (?, ?, ?, ?, ?, ?)').bind(tx, id, product, tokens, env || null, Date.now()).run();
}

// a refund takes back what is still there: tokens that were spent stay spent
async function refund(db, tx) {
  const r = await db.prepare('SELECT * FROM purchases WHERE tx = ? AND refunded = 0').bind(tx).first();
  const p = r && await player(db, r.player);
  if (!p) return;
  const back = Math.min(r.tokens, p.tokens);
  if (back > 0) await grantTokens(db, p.id, -back, 'refund', 'refund:' + tx);
  await db.prepare('UPDATE purchases SET refunded = 1 WHERE tx = ?').bind(tx).run();
}

const digest = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

async function same(a, b) {
  return crypto.subtle.timingSafeEqual(await digest(a), await digest(b));
}

// RevenueCat's webhook; everything it sends that is not a token purchase or its refund is acknowledged and left alone
async function hook(env, request) {
  const auth = request.headers.get('Authorization');
  if (!env.RC_WEBHOOK_AUTH || !auth || !await same(auth, env.RC_WEBHOOK_AUTH)) return fail('auth', 401);
  const e = (await body(request)).event;
  if (!e || typeof e !== 'object') return fail('event');
  const tx = typeof e.transaction_id === 'string' ? e.transaction_id : '';
  if (!tx || !Catalog.amount(e.product_id)) return json({ ok: true });
  if (e.type === 'INITIAL_PURCHASE' || e.type === 'NON_RENEWING_PURCHASE') {
    if (ID.test(e.app_user_id) && await player(env.DB, e.app_user_id)) await take(env.DB, e.app_user_id, e.product_id, tx, e.environment);
  } else if (e.type === 'CANCELLATION' && e.cancel_reason === 'CUSTOMER_SUPPORT') await refund(env.DB, tx);
  return json({ ok: true });
}

// The app asks right after a purchase, so the tokens do not wait for the webhook. Without a key there is nobody to ask.
async function sync(env, p) {
  if (!env.RC_SECRET_KEY) return null;
  const r = await fetch((env.RC_API || API) + '/v1/subscribers/' + p.id, { headers: { Authorization: 'Bearer ' + env.RC_SECRET_KEY } });
  if (!r.ok) return fail('rc', 502);
  const list = ((await r.json()).subscriber || {}).non_subscriptions || {};
  for (const product of Object.keys(list)) {
    if (!Catalog.amount(product) || !Array.isArray(list[product])) continue;
    for (const t of list[product]) {
      // the store's own transaction id is what the webhook carries as well
      const tx = t && (t.store_transaction_id || t.id);
      if (typeof tx !== 'string' || await env.DB.prepare('SELECT 1 FROM purchases WHERE tx = ?').bind(tx).first()) continue;
      await take(env.DB, p.id, product, tx, t.is_sandbox ? 'SANDBOX' : 'PRODUCTION');
    }
  }
  return null;
}

export async function shop(request, env) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === '/api/rc' && method === 'POST') return hook(env, request);
  const p = await verify(env.DB, (request.headers.get('Authorization') || '').replace(/^Bearer /, ''));
  if (!p) return fail('auth', 401);
  if (path === '/api/shop' && method === 'GET') return view(env.DB, p.id);
  if (method !== 'POST') return fail('nope', 404);
  let err = null;
  if (path === '/api/shop/buy') err = await buy(env.DB, p, request);
  else if (path === '/api/shop/wear') err = await wear(env.DB, p, request);
  else if (path === '/api/shop/sync') err = await sync(env, p);
  else return fail('nope', 404);
  return err || view(env.DB, p.id);
}
