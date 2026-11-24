import Catalog from '../../www/js/catalog.js';
import { verify, player, grantTokens, worn, isVip, rcBase, json, fail } from './account.js';

const DAY = 86400000;
const SYNC_GAP = 10000;
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
  // subscriber items are owned for as long as the subscription runs
  const vip = isVip(p);
  return json({
    tokens: p.tokens, owned: results.map(r => r.item).concat(vip ? Catalog.ITEMS.filter(i => i.vip).map(i => i.id) : []), worn: worn(p),
    vipUntil: vip ? p.vip_until : 0,
    earned: p.earn_day === Math.floor(Date.now() / DAY) ? p.earned : 0, cap: Catalog.DAILY
  });
}

// The price is taken first under a ref of its own, so a retry after a failure in between only adds the item.
async function buy(db, p, request) {
  const item = Catalog.item((await body(request)).item);
  if (!item) return fail('item');
  if (item.vip) return fail('vip', 403);
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
    if (item.vip ? !isVip(p) : !await owns(db, p.id, item.id)) return fail(item.vip ? 'vip' : 'unowned', 403);
  }
  await db.prepare('UPDATE players SET wear_' + b.slot + ' = ? WHERE id = ?').bind(b.item, p.id).run();
}

const worth = product => product === Catalog.VIP ? Catalog.VIP_TOKENS : Catalog.amount(product);

// Credits one store transaction. The ref makes the tokens arrive once whichever of the webhook and sync sees it first.
// A subscription month also remembers where its period ends. False when the transaction was refunded before it arrived.
async function take(db, id, product, tx, env, until) {
  const old = await db.prepare('SELECT refunded FROM purchases WHERE tx = ?').bind(tx).first();
  if (old && old.refunded) return false;
  const tokens = worth(product);
  await grantTokens(db, id, tokens, 'purchase', 'rc:' + tx);
  await db.prepare('INSERT OR IGNORE INTO purchases (tx, player, product, tokens, env, at, until) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(tx, id, product, tokens, env || null, Date.now(), until || 0).run();
  return true;
}

// A refund takes back what is still there: tokens that were spent stay spent. One that arrives before its purchase is
// written down as already refunded, so the purchase is never credited. Marked done only once the tokens are really back.
async function refund(db, tx, id, product, until) {
  const r = await db.prepare('SELECT * FROM purchases WHERE tx = ?').bind(tx).first();
  if (!r) {
    await db.prepare('INSERT OR IGNORE INTO purchases (tx, player, product, tokens, at, refunded, until) VALUES (?, ?, ?, ?, ?, 1, ?)').bind(tx, id, product, worth(product), Date.now(), until || 0).run();
    return;
  }
  if (r.refunded) return;
  for (let i = 0; i < 3; i++) {
    const p = await player(db, r.player);
    const back = p ? Math.min(r.tokens, p.tokens) : 0;
    if (back > 0 && !await grantTokens(db, p.id, -back, 'refund', 'refund:' + tx)) continue;
    await db.prepare('UPDATE purchases SET refunded = 1 WHERE tx = ?').bind(tx).run();
    return;
  }
}

// The end date only moves later here, so an event that arrives late cannot cut a paid month short.
const extend = (db, id, until) => db.prepare('UPDATE players SET vip_until = MAX(vip_until, ?1) WHERE id = ?2').bind(until, id).run();

// One paid month: its tokens once, then the end of the period it paid for.
async function month(db, id, tx, until, env) {
  if (await take(db, id, Catalog.VIP, tx, env, until)) await extend(db, id, until);
}

// A refund ends VIP now, unless a later month has been paid since: the refunded one must be the last period.
async function endNow(db, id, tx, until) {
  const r = await db.prepare('SELECT until FROM purchases WHERE tx = ?').bind(tx).first();
  const end = until || (r && r.until) || 0;
  await db.prepare('UPDATE players SET vip_until = ?1 WHERE id = ?2 AND vip_until > ?1 AND (?3 = 0 OR vip_until <= ?3)').bind(Date.now(), id, end).run();
}

// An expiration of an old period says nothing once a later one has been paid.
async function lapse(db, id, until) {
  if (!until || await db.prepare('SELECT 1 FROM purchases WHERE player = ? AND product = ? AND until > ? AND refunded = 0').bind(id, Catalog.VIP, until).first()) return;
  await db.prepare('UPDATE players SET vip_until = MIN(vip_until, ?1) WHERE id = ?2').bind(until, id).run();
}

async function subscription(db, e) {
  const id = String(e.app_user_id);
  const tx = typeof e.transaction_id === 'string' ? e.transaction_id : '';
  const until = Number(e.expiration_at_ms) > 0 ? Number(e.expiration_at_ms) : 0;
  if (e.type === 'CANCELLATION') {
    if (e.cancel_reason === 'CUSTOMER_SUPPORT' && tx) {
      await refund(db, tx, id, Catalog.VIP, until);
      await endNow(db, id, tx, until);
    }
    return;
  }
  if (!ID.test(id) || !await player(db, id)) return;
  if (e.type === 'INITIAL_PURCHASE' || e.type === 'RENEWAL') {
    if (tx && until) await month(db, id, tx, until, e.environment);
  } else if (e.type === 'PRODUCT_CHANGE' || e.type === 'UNCANCELLATION') {
    if (until) await extend(db, id, until);
  } else if (e.type === 'BILLING_ISSUE') {
    // the store keeps trying for a while and the player keeps VIP meanwhile
    const grace = Number(e.grace_period_expiration_at_ms);
    if (grace > 0) await extend(db, id, grace);
  } else if (e.type === 'EXPIRATION') await lapse(db, id, until);
}

const digest = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

async function same(a, b) {
  return crypto.subtle.timingSafeEqual(await digest(a), await digest(b));
}

// RevenueCat's webhook; everything it sends that is not a token purchase, the subscription or their refunds is acknowledged and left alone
async function hook(env, request) {
  const auth = request.headers.get('Authorization');
  if (!env.RC_WEBHOOK_AUTH || !auth || !await same(auth, env.RC_WEBHOOK_AUTH)) return fail('auth', 401);
  const e = (await body(request)).event;
  if (!e || typeof e !== 'object') return fail('event');
  if (e.product_id === Catalog.VIP || e.new_product_id === Catalog.VIP) {
    await subscription(env.DB, e);
    return json({ ok: true });
  }
  const tx = typeof e.transaction_id === 'string' ? e.transaction_id : '';
  if (!tx || !Catalog.amount(e.product_id)) return json({ ok: true });
  if (e.type === 'INITIAL_PURCHASE' || e.type === 'NON_RENEWING_PURCHASE') {
    if (ID.test(e.app_user_id) && await player(env.DB, e.app_user_id)) await take(env.DB, e.app_user_id, e.product_id, tx, e.environment);
  } else if (e.type === 'CANCELLATION' && e.cancel_reason === 'CUSTOMER_SUPPORT') await refund(env.DB, tx, String(e.app_user_id), e.product_id);
  return json({ ok: true });
}

// The subscriber's current VIP period, for a month or a grace period the webhook has not delivered. Without a store transaction
// id there is nothing to count the month's tokens once against, so only the webhook pays them.
async function resync(db, id, s) {
  if (!s || typeof s !== 'object' || s.refunded_at) return;
  const until = Date.parse(s.expires_date);
  const grace = Date.parse(s.grace_period_expires_date);
  if (until > 0) {
    if (typeof s.store_transaction_id === 'string' && s.store_transaction_id) await month(db, id, s.store_transaction_id, until, s.is_sandbox ? 'SANDBOX' : 'PRODUCTION');
    else await extend(db, id, until);
  }
  if (grace > Date.now()) await extend(db, id, grace);
}

// The app asks right after a purchase, so the tokens do not wait for the webhook. Without a key there is nobody to ask.
async function sync(env, p) {
  if (!env.RC_SECRET_KEY) return null;
  // every call asks RevenueCat, so one a player at a time
  const now = Date.now();
  const t0 = await env.DB.prepare('UPDATE players SET sync_at = ?1 WHERE id = ?2 AND sync_at <= ?3').bind(now, p.id, now - SYNC_GAP).run();
  if (t0.meta.changes !== 1) return fail('slow', 429);
  const r = await fetch(rcBase(env) + '/v1/subscribers/' + p.id, { headers: { Authorization: 'Bearer ' + env.RC_SECRET_KEY } });
  if (!r.ok) return fail('rc', 502);
  const sub = (await r.json()).subscriber || {};
  const list = sub.non_subscriptions || {};
  for (const product of Object.keys(list)) {
    if (!Catalog.amount(product) || !Array.isArray(list[product])) continue;
    for (const t of list[product]) {
      // only the store's own transaction id is the one the webhook carries; RevenueCat's own would credit twice
      const tx = t && t.store_transaction_id;
      if (typeof tx !== 'string' || await env.DB.prepare('SELECT 1 FROM purchases WHERE tx = ?').bind(tx).first()) continue;
      await take(env.DB, p.id, product, tx, t.is_sandbox ? 'SANDBOX' : 'PRODUCTION');
    }
  }
  await resync(env.DB, p.id, (sub.subscriptions || {})[Catalog.VIP]);
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
