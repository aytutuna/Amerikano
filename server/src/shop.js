import Catalog from '../../www/js/catalog.js';
import { verify, placed, player, grantTokens, worn, isVip, rcBase, json, fail } from './account.js';

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

// Chip packs are on offer everywhere except the countries on the admin page's list. Only the offer closes: a charge the store has
// already taken is credited whatever the list says. Phase 3 adds the age and state rules here.
export async function chipsOpen(env, p) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'chipsoff'").first();
  return !(p.country && row && row.value.split(',').includes(p.country));
}

async function view(env, id) {
  const db = env.DB;
  const p = await player(db, id);
  if (!p) return fail('auth', 401);
  const { results } = await db.prepare('SELECT item FROM owned WHERE player = ?').bind(id).all();
  // subscriber items are owned for as long as the subscription runs
  const vip = isVip(p);
  return json({
    tokens: p.tokens, owned: results.map(r => r.item).concat(vip ? Catalog.ITEMS.filter(i => i.vip).map(i => i.id) : []), worn: worn(p),
    vipUntil: vip ? p.vip_until : 0,
    earned: p.earn_day === Math.floor(Date.now() / DAY) ? p.earned : 0, cap: Catalog.DAILY, chips: await chipsOpen(env, p)
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

const envOf = e => e === 'SANDBOX' || e === 'PRODUCTION' ? e : null;
const countryOf = c => typeof c === 'string' && /^[A-Z]{2}$/.test(c) ? c : null;

// Trials, price-0 offers and family shares give access but no tokens. A sandbox purchase counts as paid, since the store charges
// nothing there and App Review has to see the tokens arrive. A price the event does not carry is taken as paid.
const paid = e => String(e.period_type || 'NORMAL').toUpperCase() === 'NORMAL' && !e.is_family_share && (e.environment === 'SANDBOX' || !(typeof e.price === 'number' && e.price <= 0));

// Credits one store transaction. The purchase row, the tokens and a subscription month's end date go in one batch, guarded on the row
// not being refunded, so a refund racing its purchase leaves nothing behind in either order. A repeat adds nothing.
// o: env, until (a month's end), paid (false pays no tokens) and country. False when the transaction was refunded.
async function take(db, id, product, tx, o) {
  const old = await db.prepare('SELECT player, until, refunded FROM purchases WHERE tx = ?').bind(tx).first();
  if (old && old.refunded) return false;
  const vip = product === Catalog.VIP;
  if (old && old.player !== id) {
    // a restore on another account: the subscription follows it, the tokens stay with the account that paid
    if (vip) await move(db, tx, old, id, o.until);
    return vip;
  }
  const until = vip ? o.until || 0 : 0;
  const tokens = o.paid === false ? 0 : worth(product);
  const row = db.prepare('INSERT OR IGNORE INTO purchases (tx, player, product, tokens, env, at, until, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(tx, id, product, tokens, envOf(o.env), Date.now(), until, countryOf(o.country));
  const post = [db.prepare('UPDATE purchases SET country = ?1 WHERE tx = ?2 AND country IS NULL AND ?1 IS NOT NULL').bind(countryOf(o.country), tx)];
  if (vip) post.push(db.prepare('UPDATE players SET vip_until = MAX(vip_until, ?1) WHERE id = ?2 AND ?1 > 0 AND EXISTS (SELECT 1 FROM purchases WHERE tx = ?3 AND player = ?2 AND refunded = 0)').bind(until, id, tx));
  const given = tokens > 0 && await db.prepare('SELECT 1 FROM token_log WHERE ref = ?').bind('rc:' + tx).first();
  if (tokens > 0 && !given) await grantTokens(db, id, tokens, 'purchase', 'rc:' + tx, undefined, { env: envOf(o.env), pre: [row], guard: 'EXISTS (SELECT 1 FROM purchases WHERE tx = ? AND player = ? AND refunded = 0)', args: [tx, id], post: post });
  else await db.batch([row, ...post]);
  const now = await db.prepare('SELECT refunded FROM purchases WHERE tx = ?').bind(tx).first();
  return !(now && now.refunded);
}

// A subscription month that changes hands: the old account loses VIP now unless it holds a later period, the new one gets the end date.
async function move(db, tx, old, to, until) {
  await db.batch([
    db.prepare('UPDATE purchases SET player = ?1 WHERE tx = ?2 AND player = ?3 AND refunded = 0').bind(to, tx, old.player),
    db.prepare('UPDATE players SET vip_until = ?1 WHERE id = ?2 AND vip_until > ?1 AND NOT EXISTS (SELECT 1 FROM purchases WHERE player = ?2 AND product = ?3 AND refunded = 0 AND until > ?4)').bind(Date.now(), old.player, Catalog.VIP, old.until),
    db.prepare('UPDATE players SET vip_until = MAX(vip_until, ?1) WHERE id = ?2 AND EXISTS (SELECT 1 FROM purchases WHERE tx = ?3 AND player = ?2 AND refunded = 0)').bind(until || old.until, to, tx)
  ]);
}

// RevenueCat moved entitlements between app user ids: the accounts they came from lose VIP, and the subscription months go to the
// account that now has them, when that is one of ours.
async function transfer(db, e) {
  const ids = list => (Array.isArray(list) ? list : []).filter(x => typeof x === 'string' && ID.test(x));
  let to = null;
  for (const x of ids(e.transferred_to)) if (await player(db, x)) { to = x; break; }
  for (const from of ids(e.transferred_from)) {
    if (from === to || !await player(db, from)) continue;
    if (to) {
      const { results } = await db.prepare('SELECT tx, until FROM purchases WHERE player = ? AND product = ? AND refunded = 0 AND until > ? ORDER BY until').bind(from, Catalog.VIP, Date.now()).all();
      for (const r of results) await move(db, r.tx, { player: from, until: r.until }, to, r.until);
    }
    await db.prepare('UPDATE players SET vip_until = ?1 WHERE id = ?2 AND vip_until > ?1').bind(Date.now(), from).run();
  }
}

// A refund takes back what is still there: tokens that were spent stay spent, and they come from the account that was paid them.
// One that arrives before its purchase is written down as already refunded, so the purchase is never credited. Marked done only once
// the tokens are really back; after three tries the admin page gets a flag. Returns the account that holds the purchase now.
async function refund(db, tx, id, product, until) {
  let r = await db.prepare('SELECT * FROM purchases WHERE tx = ?').bind(tx).first();
  if (!r) {
    await db.prepare('INSERT OR IGNORE INTO purchases (tx, player, product, tokens, at, refunded, until) VALUES (?, ?, ?, 0, ?, 1, ?)').bind(tx, id, product, Date.now(), until || 0).run();
    // the purchase may have landed in between, and then it is refunded the ordinary way
    r = await db.prepare('SELECT * FROM purchases WHERE tx = ?').bind(tx).first();
  }
  if (r.refunded) return r.player;
  const given = await db.prepare('SELECT player, delta FROM token_log WHERE ref = ?').bind('rc:' + tx).first();
  for (let i = 0; i < 3; i++) {
    const p = given && await player(db, given.player);
    const back = p ? Math.min(given.delta, p.tokens) : 0;
    if (back > 0 && !await grantTokens(db, p.id, -back, 'refund', 'refund:' + tx)) continue;
    await db.prepare('UPDATE purchases SET refunded = 1 WHERE tx = ?').bind(tx).run();
    return r.player;
  }
  await db.prepare("INSERT INTO flags (kind, a, b, x, y, at) SELECT 'refund', ?1, ?2, ?3, 0, ?4 WHERE NOT EXISTS (SELECT 1 FROM flags WHERE kind = 'refund' AND b = ?2)").bind(given.player, tx, given.delta, Date.now()).run();
  return r.player;
}

// The end date only moves later here, so an event that arrives late cannot cut a paid month short.
const extend = (db, id, until) => db.prepare('UPDATE players SET vip_until = MAX(vip_until, ?1) WHERE id = ?2').bind(until, id).run();

// A refund that was reversed: the purchase counts again and what the refund took back is paid again.
async function reverse(db, tx) {
  const r = await db.prepare('SELECT * FROM purchases WHERE tx = ?').bind(tx).first();
  if (!r || !r.refunded) return;
  await db.prepare('UPDATE purchases SET refunded = 0 WHERE tx = ?').bind(tx).run();
  const took = await db.prepare('SELECT player, delta FROM token_log WHERE ref = ?').bind('refund:' + tx).first();
  if (took) await grantTokens(db, took.player, -took.delta, 'reversed', 'reversed:' + tx);
  if (r.product === Catalog.VIP && r.until > Date.now()) await extend(db, r.player, r.until);
}

// A refund ends VIP now, unless a later month has been paid since: the refunded one must be the last period. The stored end of the
// month counts first, because the date a refund event carries is the refund's own.
async function endNow(db, id, tx, until) {
  const r = await db.prepare('SELECT until FROM purchases WHERE tx = ?').bind(tx).first();
  const end = (r && r.until) || until || 0;
  await db.prepare('UPDATE players SET vip_until = ?1 WHERE id = ?2 AND vip_until > ?1 AND (?3 = 0 OR vip_until <= ?3)').bind(Date.now(), id, end).run();
}

// An expiration of an old period says nothing once a later one has been paid.
async function lapse(db, id, until) {
  if (!until || await db.prepare('SELECT 1 FROM purchases WHERE player = ? AND product = ? AND until > ? AND refunded = 0').bind(id, Catalog.VIP, until).first()) return;
  await db.prepare('UPDATE players SET vip_until = MIN(vip_until, ?1) WHERE id = ?2').bind(until, id).run();
}

// What sandbox purchases left on an account: the tokens they gave, as far as the account still holds them, and VIP when every month it
// ever had was sandbox. Items it bought stay. The wipe row's ref comes from the grant, so a second run finds nothing to do.
export async function wipe(db, id) {
  const { results } = await db.prepare("SELECT t.ref, t.delta FROM token_log t WHERE t.player = ?1 AND t.env = 'SANDBOX' AND t.reason = 'purchase' AND NOT EXISTS (SELECT 1 FROM token_log r WHERE r.ref IN ('refund:' || substr(t.ref, 4), 'wipe:' || t.ref)) ORDER BY t.id").bind(id).all();
  let tokens = 0;
  for (const g of results) {
    const p = await player(db, id);
    if (!p) return { tokens: 0, vip: false };
    const back = Math.min(g.delta, p.tokens);
    if (back > 0 && await grantTokens(db, id, -back, 'wipe', 'wipe:' + g.ref)) tokens += back;
  }
  const months = (await db.prepare('SELECT env FROM purchases WHERE player = ? AND product = ? AND refunded = 0').bind(id, Catalog.VIP).all()).results;
  let vip = false;
  if (months.some(m => m.env === 'SANDBOX') && !months.some(m => m.env !== 'SANDBOX')) vip = (await db.prepare('UPDATE players SET vip_until = ?1 WHERE id = ?2 AND vip_until > ?1').bind(Date.now(), id).run()).meta.changes === 1;
  return { tokens: tokens, vip: vip };
}

export async function sandboxers(db) {
  return (await db.prepare("SELECT player FROM token_log WHERE env = 'SANDBOX' UNION SELECT player FROM purchases WHERE env = 'SANDBOX'").all()).results.map(r => r.player);
}

async function subscription(db, e) {
  const id = String(e.app_user_id);
  const tx = typeof e.transaction_id === 'string' ? e.transaction_id : '';
  const until = Number(e.expiration_at_ms) > 0 ? Number(e.expiration_at_ms) : 0;
  if (!ID.test(id) || !await player(db, id)) return;
  if (e.type === 'CANCELLATION') {
    if (e.cancel_reason === 'CUSTOMER_SUPPORT' && tx) await endNow(db, await refund(db, tx, id, Catalog.VIP, until), tx, until);
  } else if (e.type === 'INITIAL_PURCHASE' || e.type === 'RENEWAL') {
    if (tx && until) await take(db, id, Catalog.VIP, tx, { env: e.environment, until: until, paid: paid(e), country: e.country_code });
  } else if (e.type === 'SUBSCRIPTION_EXTENDED') {
    // the month now ends later, which a refund of it has to know
    if (until && tx) await db.prepare('UPDATE purchases SET until = MAX(until, ?1) WHERE tx = ?2 AND product = ?3').bind(until, tx, Catalog.VIP).run();
    if (until) await extend(db, id, until);
  } else if (e.type === 'PRODUCT_CHANGE' || e.type === 'UNCANCELLATION') {
    if (until) await extend(db, id, until);
  } else if (e.type === 'REFUND_REVERSED') {
    if (tx) await reverse(db, tx);
  } else if (e.type === 'BILLING_ISSUE') {
    // the store keeps trying for a while and the player keeps VIP meanwhile
    const grace = Number(e.grace_period_expiration_at_ms);
    if (grace > 0) await extend(db, id, grace);
  } else if (e.type === 'EXPIRATION') await lapse(db, id, until);
  else console.log('rc: ' + e.type + ' needs nothing');
}

const digest = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

async function same(a, b) {
  return crypto.subtle.timingSafeEqual(await digest(a), await digest(b));
}

async function pack(db, e) {
  const tx = typeof e.transaction_id === 'string' ? e.transaction_id : '';
  const id = String(e.app_user_id);
  if (!tx || !Catalog.amount(e.product_id) || !ID.test(id) || !await player(db, id)) return;
  if (e.type === 'INITIAL_PURCHASE' || e.type === 'NON_RENEWING_PURCHASE') await take(db, id, e.product_id, tx, { env: e.environment, country: e.country_code });
  else if (e.type === 'CANCELLATION' && e.cancel_reason === 'CUSTOMER_SUPPORT') await refund(db, tx, id, e.product_id);
  else if (e.type === 'REFUND_REVERSED') await reverse(db, tx);
}

// RevenueCat's webhook; everything it sends that is not a token purchase, the subscription, a transfer or their refunds is acknowledged and left alone
async function hook(env, request) {
  const auth = request.headers.get('Authorization');
  if (!env.RC_WEBHOOK_AUTH || !auth || !await same(auth, env.RC_WEBHOOK_AUTH)) return fail('auth', 401);
  const e = (await body(request)).event;
  if (!e || typeof e !== 'object') return fail('event');
  if (e.type === 'TRANSFER') await transfer(env.DB, e);
  else if (e.product_id === Catalog.VIP || e.new_product_id === Catalog.VIP) await subscription(env.DB, e);
  else await pack(env.DB, e);
  return json({ ok: true });
}

// The subscriber's current VIP period, for a month or a grace period the webhook has not delivered. Without a store transaction
// id there is nothing to count the month's tokens once against, so only the webhook pays them; the month is matched to its row
// by its end date, so a restore moves it all the same.
async function resync(db, id, s) {
  if (!s || typeof s !== 'object' || s.refunded_at) return;
  const until = Date.parse(s.expires_date);
  const grace = Date.parse(s.grace_period_expires_date);
  if (until > 0) {
    if (typeof s.store_transaction_id === 'string' && s.store_transaction_id) {
      const normal = String(s.period_type || 'NORMAL').toUpperCase() === 'NORMAL' && s.ownership_type !== 'FAMILY_SHARED';
      await take(db, id, Catalog.VIP, s.store_transaction_id, { env: s.is_sandbox ? 'SANDBOX' : 'PRODUCTION', until: until, paid: normal });
    } else {
      const row = await db.prepare('SELECT tx, player, until FROM purchases WHERE product = ? AND until = ? AND player <> ? AND refunded = 0').bind(Catalog.VIP, until, id).first();
      if (row) await move(db, row.tx, row, id, until);
      else await extend(db, id, until);
    }
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
      await take(env.DB, p.id, product, tx, { env: t.is_sandbox ? 'SANDBOX' : 'PRODUCTION' });
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
  await placed(env, p, request);
  if (path === '/api/shop' && method === 'GET') return view(env, p.id);
  if (method !== 'POST') return fail('nope', 404);
  let err = null;
  if (path === '/api/shop/buy') err = await buy(env.DB, p, request);
  else if (path === '/api/shop/wear') err = await wear(env.DB, p, request);
  else if (path === '/api/shop/sync') err = await sync(env, p);
  else return fail('nope', 404);
  return err || view(env, p.id);
}
