import Names from '../../www/js/names.js';
import Avatar from '../../www/js/avatar.js';
import Catalog from '../../www/js/catalog.js';
import { identity, refresh, revoke } from './apple.js';
import { REGIONS, DEFAULT, regionOf } from './region.js';
import { LANGS } from './text.js';

const DAY = 86400000;
const START = 5000;
const MIN_ROOM = 1000;
export const STAKES = [100, 500, 2500, 10000, 50000];
export const ENTRY = 10;
// finished public matches an account needs before it may sit at a friend table with a stake
export const FRIEND_GAMES = 10;
export const BUYINS = [1000, 5000, 25000];

// a friend table's stake: payouts are counted in tenths of it; the top is a bound for the arithmetic, not a policy
export const stakeOk = s => Number.isInteger(s) && s >= 0 && s <= 1e9 && s % 10 === 0;

// what the final table of a tournament shares out, from first place down: half, a quarter, 15 % and 10 % of the buy-ins
export const prizes = buy => [50, 25, 15, 10].map(x => 8 * buy * x / 100);

// Match chips move by a tenth of the stake each. The most a seat can lose is set aside at the deal, so no
// loss is ever forgiven; the rules phase changes the games count here and nowhere else.
export const maxLoss = games => 10 + 4 * games;
export const hold = (stake, games) => stake * maxLoss(games) / 10;

// the held amount back plus the match chips at stake/10 each
export const payout = (stake, games, chips) => hold(stake, games) + chips * stake / 10;

// Level needed for each public table and each cup; a friend table takes the gate of the highest public stake at or below its own.
const GATES = { 100: 1, 500: 4, 2500: 10, 10000: 20, 50000: 30 };
const CUP_GATES = { 1000: 1, 5000: 10, 25000: 20 };
const FEES = { 100: 5, 500: 25, 2500: 125, 10000: 700, 50000: 4000 };
export const gates = () => ({ gate: GATES, cupGate: CUP_GATES, fee: FEES });

const tier = stake => STAKES.filter(s => s <= stake).pop() || 0;

// the table fee, taken from every seat at the deal; under the lowest table it is the same 5 % of the stake
export const feeFor = stake => !stake ? 0 : tier(stake) ? FEES[tier(stake)] : Math.floor(stake * 5 / 100);

// How many computer seats play sharp at a table, from the ladder in the settings: a public table by its stake, a cup by its buy-in,
// a friend table by the highest public stake at or below its own and none below the lowest.
export function strongFor(ladder, stake, buy) {
  const key = buy ? 'cup' + buy : tier(stake) && String(tier(stake));
  return key ? Number(ladder[key]) || 0 : 0;
}

// Why an account may not sit at a table with this stake, or null. Guests take the 100 and 500 tables and no friend table with a stake.
export function barred(p, stake, pub) {
  if (!stake) return null;
  if (!signedIn(p) && !(pub && stake <= 500)) return { k: 'guest' };
  const need = GATES[tier(stake)] || 1;
  if (p.level < need) return { k: 'level', need: need };
  if (!pub && p.pub_games < FRIEND_GAMES) return { k: 'games', need: FRIEND_GAMES };
  // a cooldown from leaving public tables covers the stake it was earned at and every larger one
  return pub && p.cool_until > Date.now() && stake >= p.cool_stake ? { k: 'cool', left: p.cool_until - Date.now() } : null;
}

// the level a seat at this table or cup needs, so a computer player is never below what a person could be
export const levelNeed = (stake, buy) => (buy ? CUP_GATES[buy] : GATES[tier(stake)]) || 1;

export function cupBarred(p, buy) {
  if (!signedIn(p)) return { k: 'guest' };
  return p.level < CUP_GATES[buy] ? { k: 'level', need: CUP_GATES[buy] } : null;
}

const ROLLS = 20;
const SESSIONS = 10;
const DEVICES = 10;
const PUSH = ['on', 'invite', 'daily', 'friend', 'week', 'dm'];
const TOKEN = /^([0-9a-f]{32})\.([0-9a-f]{64})$/;

const today = () => Math.floor(Date.now() / DAY);
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function random(n) {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

async function hash(s) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

// level n starts at 50n(n-1) xp, so the climb to level n+1 is 100n(n+1)/2 in total
export const levelAt = xp => {
  let n = 1;
  while (xp >= 50 * n * (n + 1)) n++;
  return n;
};

// claim: {set: {column: value}, where: 'sql with ? marks', args: [...]} makes a once-only grant (daily, bailout) one batch with its log row;
// also: statements that run after the log row in the same batch, each guarding itself on that row
function creditStmts(db, id, delta, reason, ref, claim) {
  const set = claim ? Object.keys(claim.set) : [];
  const stmts = [
    db.prepare('UPDATE players SET chips = chips + ?' + set.map(k => ', ' + k + ' = ?').join('') + ' WHERE id = ? AND chips + ? >= 0' + (claim ? ' AND (' + claim.where + ')' : ''))
      .bind(delta, ...set.map(k => claim.set[k]), id, delta, ...(claim ? claim.args : []))
  ];
  // a claim that pays nothing still sets its columns but leaves no log row
  if (delta) stmts.push(db.prepare('INSERT INTO chip_log (player, delta, reason, at, ref) SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() > 0').bind(id, delta, reason, Date.now(), ref || null));
  if (claim && claim.also) stmts.push(...claim.also);
  return stmts;
}

// The only way chips change. Returns false when the player is gone, would go below zero or lost the claim.
// A ref makes the change happen once: the unique index fails the batch on a repeat, which counts as done.
export async function credit(db, id, delta, reason, ref, claim) {
  if (!delta && !claim) return true;
  // a retry after the balance has moved must still see the first run
  if (ref && await db.prepare('SELECT 1 FROM chip_log WHERE player = ? AND ref = ?').bind(id, ref).first()) return true;
  try {
    const r = await db.batch(creditStmts(db, id, delta, reason, ref, claim));
    return r[0].meta.changes === 1;
  } catch (e) {
    if (ref && /UNIQUE/.test(e.message)) return true;
    throw e;
  }
}

// Several credits that stand or fall together: each one carries the guard (sql with ? marks, over rows that `done` changes), and
// `done` goes last. True when this run was the one that got through, so a repeat or a second click changes nothing.
export async function creditAll(db, list, guard, args, done) {
  const stmts = list.flatMap(c => creditStmts(db, c.id, c.delta, c.reason, c.ref, { set: {}, where: guard, args: args }));
  stmts.push(done);
  const r = await db.batch(stmts);
  return r[r.length - 1].meta.changes === 1;
}

// The deal's charge in one batch: the held amount (ref <match>:in) and the table fee (ref <match>:fee) both go, or neither.
// False when the player cannot cover both.
export async function charge(db, id, held, fee, match) {
  if (!held && !fee) return true;
  const ref = match + ':in';
  if (await db.prepare('SELECT 1 FROM chip_log WHERE player = ? AND ref = ?').bind(id, ref).first()) return true;
  const stmts = creditStmts(db, id, -held, 'escrow', ref, { set: {}, where: 'chips >= ?', args: [held + fee] });
  if (fee) stmts.push(...creditStmts(db, id, -fee, 'fee', match + ':fee', { set: {}, where: 'EXISTS (SELECT 1 FROM chip_log WHERE player = ? AND ref = ?)', args: [id, ref] }));
  try {
    const r = await db.batch(stmts);
    return r[0].meta.changes === 1;
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return true;
    throw e;
  }
}

// A leave from a started public match: counted once per match, and from the third in a rolling week the player pays one more
// stake (at most 2,500, destroyed), is flagged for the admin page and may not sit at that stake or a larger one for a while.
// Safe to run again for the same match.
export async function strike(db, id, match, code, stake, now = Date.now()) {
  await db.prepare('INSERT OR IGNORE INTO leaves (player, match, at, code, stake, kind) VALUES (?, ?, ?, ?, ?, ?)').bind(id, match, now, code, stake, 'pub').run();
  // a repeat works from the first run's time, so the cooldown does not move
  now = (await db.prepare('SELECT at FROM leaves WHERE player = ? AND match = ?').bind(id, match).first()).at;
  const { n } = await db.prepare('SELECT count(*) AS n FROM leaves WHERE player = ? AND at > ?').bind(id, now - 7 * DAY).first();
  if (n < 3) return n;
  const cost = Math.min(stake, 2500);
  let paid = 0;
  for (let i = 0; i < 2 && cost; i++) {
    const p = await player(db, id);
    if (!p) return n;
    paid = Math.min(cost, p.chips);
    if (!paid || await credit(db, id, -paid, 'leave', match + ':leave')) break;
  }
  const mins = n >= 6 ? 60 : 15;
  const until = now + mins * 60000;
  await db.batch([
    db.prepare('UPDATE players SET cool_until = CASE WHEN cool_until > ?1 THEN max(cool_until, ?2) ELSE ?2 END, cool_stake = CASE WHEN cool_until > ?1 THEN min(cool_stake, ?3) ELSE ?3 END WHERE id = ?4').bind(now, until, stake, id),
    db.prepare("INSERT INTO flags (kind, a, b, x, y, at) SELECT 'leave', ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM flags WHERE kind = 'leave' AND a = ?1 AND b = ?2)").bind(id, match, n, paid, now),
    db.prepare("INSERT INTO admin_log (at, who, action, target, detail) SELECT ?1, 'auto', 'leave', ?2, ?3 WHERE changes() > 0").bind(now, id, JSON.stringify({ match: match, leaves: n, paid: paid, minutes: mins }))
  ]);
  return n;
}

// The only way tokens change, with the same ref rule as credit(). A cap makes it an earning: the day's total may not pass it.
// opts is for a store purchase: env marks the log row, pre and post are statements in the same batch around the grant, and
// guard (sql with ? marks, args) lets the grant through only while the purchase row stands unrefunded.
export async function grantTokens(db, id, delta, reason, ref, cap, opts = {}) {
  if (!delta) return true;
  if (ref && await db.prepare('SELECT 1 FROM token_log WHERE ref = ?').bind(ref).first()) return true;
  const day = today();
  const pre = opts.pre || [];
  const guard = opts.guard ? ' AND (' + opts.guard + ')' : '';
  try {
    const r = await db.batch([
      ...pre,
      cap
        ? db.prepare('UPDATE players SET tokens = tokens + ?1, earn_day = ?3, earned = CASE WHEN earn_day = ?3 THEN earned + ?1 ELSE ?1 END WHERE id = ?2 AND (earn_day <> ?3 OR earned + ?1 <= ?4)').bind(delta, id, day, cap)
        : db.prepare('UPDATE players SET tokens = tokens + ?1 WHERE id = ?2 AND tokens + ?1 >= 0' + guard).bind(delta, id, ...(opts.args || [])),
      db.prepare('INSERT INTO token_log (player, delta, reason, ref, at, env) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() > 0').bind(id, delta, reason, ref || null, Date.now(), opts.env || null),
      ...(opts.post || [])
    ]);
    return r[pre.length].meta.changes === 1;
  } catch (e) {
    if (ref && /UNIQUE/.test(e.message)) return true;
    throw e;
  }
}

export async function verify(db, token) {
  const m = TOKEN.exec(token || '');
  if (!m) return null;
  const h = await hash(m[2]);
  const p = await db.prepare('SELECT p.* FROM players p JOIN sessions s ON s.player = p.id WHERE p.id = ?1 AND s.secret_hash = ?2 AND p.banned = 0').bind(m[1], h).first();
  return p && Object.assign(p, { session: h });
}

export function player(db, id) {
  return db.prepare('SELECT * FROM players WHERE id = ?').bind(id).first();
}

// a player, or failing that a stored profile for the same lookups
export async function who(db, id) {
  const p = await player(db, id);
  if (p) return p;
  const q = await db.prepare('SELECT * FROM personas WHERE id = ?').bind(id).first();
  return q && Object.assign(q, { persona: true });
}

export const isVip = (p, now = Date.now()) => p.vip_until > now;

// a guest has no Apple account behind the key
export const signedIn = p => !!p.apple;

// the items a player wears, by slot; the felt is only for their own table. VIP items come off when the subscription ends.
export function worn(p, slots = Catalog.WORN, now = Date.now()) {
  const vip = isVip(p, now);
  return Object.fromEntries(slots.filter(k => p['wear_' + k] && (vip || !(Catalog.item(p['wear_' + k]) || {}).vip)).map(k => [k, p['wear_' + k]]));
}

export function seat(p) {
  return { pid: p.id, seed: p.name_seed, av: p.avatar.split(',').map(Number), level: p.level, wear: worn(p, ['frame', 'plate', 'back']), vip: isVip(p) };
}

// xp, games and wins for one finished match (and the public one that opens friend tables); a level-up pays 1,000 chips times the new level
export async function award(db, id, add) {
  await db.prepare('UPDATE players SET xp = xp + ?, games = games + 1, wins = wins + ?, pub_games = pub_games + ? WHERE id = ?').bind(add.xp, add.win ? 1 : 0, add.pub ? 1 : 0, id).run();
  const p = await db.prepare('SELECT xp, level FROM players WHERE id = ?').bind(id).first();
  if (!p) return;
  const to = levelAt(p.xp);
  if (to <= p.level) return;
  // only the settle that moves the level pays for it
  const r = await db.prepare('UPDATE players SET level = ? WHERE id = ? AND level = ?').bind(to, id, p.level).run();
  if (r.meta.changes !== 1) return;
  for (let l = p.level + 1; l <= to; l++) await credit(db, id, 1000 * l, 'level');
}

// what a claim made at this moment pays
export function reward(p, at = Date.now()) {
  return 500 + 250 * (Math.floor(p.daily_at / DAY) === Math.floor(at / DAY) - 1 ? Math.min(p.streak + 1, 7) : 1);
}

function profile(p) {
  const last = Math.floor(p.daily_at / DAY);
  const now = today();
  return {
    seed: p.name_seed, avatar: p.avatar.split(',').map(Number), chips: p.chips, tokens: p.tokens, vipUntil: isVip(p) ? p.vip_until : 0, wear: worn(p), xp: p.xp, level: p.level,
    from: 50 * p.level * (p.level - 1), to: 50 * p.level * (p.level + 1), games: p.games, wins: p.wins,
    daily: { ready: last < now, streak: last >= now - 1 ? p.streak : 0, reward: reward(p) },
    bailout: p.chips < MIN_ROOM && Math.floor(p.bail_at / DAY) < now,
    apple: !!p.apple,
    cool: p.cool_until > Date.now() ? { until: p.cool_until, stake: p.cool_stake } : null,
    typed: !!p.typed,
    voice: !!p.voice,
    lang: p.lang,
    region: p.region || DEFAULT,
    push: Object.fromEntries(PUSH.map(k => [k, !!p['push_' + k]]))
  };
}

export const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
export const fail = (error, status) => json({ error: error }, status || 400);

async function body(request) {
  try {
    const b = await request.json();
    return b && typeof b === 'object' ? b : {};
  } catch (e) {
    return {};
  }
}

// one secret per device, so signing in on a new one leaves the others signed in; a pruned session takes its device along
async function sessionStmts(db, id, secret) {
  return [
    db.prepare('INSERT INTO sessions (player, secret_hash, created) VALUES (?1, ?2, ?3)').bind(id, await hash(secret), Date.now()),
    db.prepare('DELETE FROM sessions WHERE player = ?1 AND rowid NOT IN (SELECT rowid FROM sessions WHERE player = ?1 ORDER BY created DESC, rowid DESC LIMIT ?2)').bind(id, SESSIONS),
    db.prepare('DELETE FROM devices WHERE player = ?1 AND session NOT IN (SELECT secret_hash FROM sessions WHERE player = ?1)').bind(id)
  ];
}

// a is {sub, aud, token} for an account made by signing in with Apple
async function guest(db, a) {
  const id = random(16);
  const secret = random(32);
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO players (id, secret_hash, name_seed, avatar, chips, created, apple, apple_refresh, apple_client) VALUES (?, '', ?, ?, 0, ?, ?, ?, ?)")
      .bind(id, Names.pick(), Avatar.random().join(','), now, a ? a.sub : null, a ? a.token : null, a && a.token ? a.aud : null),
    ...creditStmts(db, id, START, 'start'),
    ...await sessionStmts(db, id, secret)
  ]);
  return json({ id: id, secret: secret });
}

// every new account starts with chips, so keep one address from minting them in bulk
const limited = async (env, request) => env.GUESTS && !(await env.GUESTS.limit({ key: request.headers.get('CF-Connecting-IP') || '' })).success;

// A token counts once: its nonce was issued by /api/apple/nonce and is used up here.
async function appleToken(env, b) {
  if (typeof b.token !== 'string' || typeof b.nonce !== 'string') return null;
  const a = await identity(env, b.token, b.nonce);
  if (!a) return null;
  const r = await env.DB.prepare('DELETE FROM nonces WHERE raw = ? AND exp > ?').bind(b.nonce, Date.now()).run();
  return r.meta.changes === 1 ? a : null;
}

async function signIn(env, request) {
  const b = await body(request);
  const a = await appleToken(env, b);
  if (!a) return fail('apple', 401);
  // an authorization code works once, so it is exchanged here and not again on the retry
  a.token = await refresh(env, typeof b.code === 'string' ? b.code : null, a.aud);
  return enter(env, request, a);
}

async function enter(env, request, a) {
  const db = env.DB;
  const old = await db.prepare('SELECT id, banned FROM players WHERE apple = ?').bind(a.sub).first();
  if (old) {
    if (old.banned) return fail('banned', 403);
    const secret = random(32);
    await db.batch([
      db.prepare('UPDATE players SET apple_refresh = COALESCE(?1, apple_refresh), apple_client = CASE WHEN ?1 IS NULL THEN apple_client ELSE ?2 END WHERE id = ?3').bind(a.token, a.aud, old.id),
      ...await sessionStmts(db, old.id, secret)
    ]);
    return json({ id: old.id, secret: secret });
  }
  if (await limited(env, request)) return fail('slow', 429);
  try {
    return await guest(db, a);
  } catch (e) {
    if (!/UNIQUE/.test(e.message)) throw e;
    // a parallel sign-in made the account first
    return enter(env, request, a);
  }
}

async function link(env, request, p) {
  const b = await body(request);
  const a = await appleToken(env, b);
  if (!a) return fail('apple', 401);
  const token = await refresh(env, typeof b.code === 'string' ? b.code : null, a.aud);
  try {
    const r = await env.DB.prepare('UPDATE players SET apple = ?1, apple_refresh = COALESCE(?2, apple_refresh), apple_client = CASE WHEN ?2 IS NULL THEN apple_client ELSE ?4 END WHERE id = ?3 AND (apple IS NULL OR apple = ?1)').bind(a.sub, token, p.id, a.aud).run();
    if (r.meta.changes !== 1) return json({ k: 'linked' }, 409);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return json({ k: 'taken' }, 409);
    throw e;
  }
}

async function reroll(db, p) {
  const day = today();
  let seed = Names.pick();
  if (seed === p.name_seed) seed = Names.pick();
  const r = await db.prepare('UPDATE players SET name_seed = ?1, rolls = CASE WHEN roll_day = ?2 THEN rolls + 1 ELSE 1 END, roll_day = ?2 WHERE id = ?3 AND (roll_day <> ?2 OR rolls < ?4)')
    .bind(seed, day, p.id, ROLLS).run();
  if (r.meta.changes !== 1) return fail('limit', 429);
}

async function daily(db, p) {
  const day = today();
  const last = Math.floor(p.daily_at / DAY);
  if (last >= day) return fail('claimed', 409);
  const streak = last === day - 1 ? Math.min(p.streak + 1, 7) : 1;
  const reward = 500 + 250 * streak;
  if (!await credit(db, p.id, reward, 'daily', null, { set: { daily_at: Date.now(), streak: streak }, where: 'daily_at = ?', args: [p.daily_at] })) return fail('claimed', 409);
}

// the token comes from the phone, so its shape is checked: an APNs one goes into a URL
async function device(db, p, request) {
  const b = await body(request);
  if (b.kind !== 'apns' && b.kind !== 'fcm') return fail('kind');
  if (typeof b.token !== 'string' || !(b.kind === 'apns' ? /^[0-9a-fA-F]{32,200}$/ : /^[\w:.-]{20,4096}$/).test(b.token)) return fail('token');
  if (!Number.isInteger(b.tz) || b.tz < -840 || b.tz > 840) return fail('tz');
  const token = b.kind === 'apns' ? b.token.toLowerCase() : b.token;
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO devices (token, player, kind, lang, tz, session, created, seen) VALUES (?1, ?2, ?3, ?4, ?5, ?7, ?6, ?6) ON CONFLICT (token) DO UPDATE SET player = ?2, kind = ?3, lang = ?4, tz = ?5, session = ?7, seen = ?6')
      .bind(token, p.id, b.kind, LANGS.includes(b.lang) ? b.lang : 'en', b.tz, now, p.session),
    db.prepare('DELETE FROM devices WHERE player = ?1 AND rowid NOT IN (SELECT rowid FROM devices WHERE player = ?1 ORDER BY seen DESC, rowid DESC LIMIT ?2)').bind(p.id, DEVICES)
  ]);
}

async function prefs(db, p, request) {
  const b = await body(request);
  const keys = PUSH.filter(k => typeof b[k] === 'boolean');
  if (!keys.length) return fail('push');
  await db.prepare('UPDATE players SET ' + keys.map(k => 'push_' + k + ' = ?').join(', ') + ' WHERE id = ?').bind(...keys.map(k => +b[k]), p.id).run();
}

async function voiceSwitch(db, p, request) {
  const b = await body(request);
  if (typeof b.voice !== 'boolean') return fail('voice');
  await db.prepare('UPDATE players SET voice = ? WHERE id = ?').bind(+b.voice, p.id).run();
}

async function typedSwitch(db, p, request) {
  const b = await body(request);
  if (typeof b.typed !== 'boolean') return fail('typed');
  await db.prepare('UPDATE players SET typed = ? WHERE id = ?').bind(+b.typed, p.id).run();
}

// the app language decides which word lists apply to what this player types and reads
async function langSwitch(db, p, request) {
  const b = await body(request);
  if (!LANGS.includes(b.lang)) return fail('lang');
  await db.prepare('UPDATE players SET lang = ? WHERE id = ?').bind(b.lang, p.id).run();
}

// from the country Cloudflare saw; the dev server (PACE set) has no real one, so the tests pin it by header
function guess(env, request) {
  const h = request.headers;
  if (env.PACE) return h.get('X-Country') ? regionOf(h.get('X-Country'), h.get('X-Continent')) : DEFAULT;
  return regionOf(request.cf && request.cf.country, request.cf && request.cf.continent);
}

// The country the call came from, kept on the account for the chip pack switch. It is the address's, so nothing the player sends
// can change it; the dev server has no real one, so the tests pin it by header.
export async function placed(env, p, request) {
  const h = request.headers;
  const c = env.PACE ? h.get('X-Country') : h.get('CF-IPCountry') || (request.cf && request.cf.country);
  if (!/^[A-Z]{2}$/.test(c || '') || c === 'XX' || c === 'T1' || c === p.country) return;
  await env.DB.prepare('UPDATE players SET country = ? WHERE id = ?').bind(c, p.id).run();
  p.country = c;
}

async function region(env, p, request) {
  const b = await body(request);
  if (!REGIONS.includes(b.region)) return fail('region');
  if (b.region === p.region) return;
  await env.DB.prepare('UPDATE players SET region = ? WHERE id = ?').bind(b.region, p.id).run();
  await env.HUB.get(env.HUB.idFromName('h')).move(p.id, b.region).catch(() => {});
}

// Ends this device's session and its device rows, or every session of the account. The hub drops the sockets that came with them.
async function signout(env, p, request) {
  const all = (await body(request)).all === true;
  const db = env.DB;
  await db.batch(all ? [
    db.prepare('DELETE FROM devices WHERE player = ?').bind(p.id),
    db.prepare('DELETE FROM sessions WHERE player = ?').bind(p.id)
  ] : [
    db.prepare('DELETE FROM devices WHERE player = ?1 AND session = ?2').bind(p.id, p.session),
    db.prepare('DELETE FROM sessions WHERE player = ?1 AND secret_hash = ?2').bind(p.id, p.session)
  ]);
  await env.HUB.get(env.HUB.idFromName('h')).drop(p.id, all ? null : p.session).catch(() => {});
  return json({ ok: true });
}

async function bailout(db, p) {
  if (p.chips >= MIN_ROOM) return fail('rich', 409);
  // the balance read above is part of the claim: a match settling in between makes the top-up miss, and the next try gets it
  const claim = { set: { bail_at: Date.now() }, where: 'bail_at < ? AND chips = ?', args: [today() * DAY, p.chips] };
  if (!await credit(db, p.id, MIN_ROOM - p.chips, 'bailout', null, claim)) return fail('claimed', 409);
}

export const rcBase = env => env.RC_API || 'https://api.revenuecat.com';

export async function api(request, env, ctx) {
  const db = env.DB;
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === '/api/guest' && method === 'POST') {
    if (await limited(env, request)) return fail('slow', 429);
    return guest(db);
  }
  if (path.startsWith('/api/apple') && !env.APPLE_KEY) return fail('apple', 503);
  if (path === '/api/apple/nonce' && method === 'POST') {
    if (env.NONCES && !env.PACE && !(await env.NONCES.limit({ key: request.headers.get('CF-Connecting-IP') || '' })).success) return fail('slow', 429);
    const raw = random(16);
    const now = Date.now();
    await db.batch([
      db.prepare('DELETE FROM nonces WHERE exp < ?').bind(now),
      db.prepare('INSERT INTO nonces (raw, exp) VALUES (?, ?)').bind(raw, now + 600000)
    ]);
    return json({ nonce: raw });
  }
  if (path === '/api/apple' && method === 'POST') return signIn(env, request);
  const p = await verify(db, (request.headers.get('Authorization') || '').replace(/^Bearer /, ''));
  if (!p) return fail('auth', 401);
  if (!p.region) {
    p.region = guess(env, request);
    await db.prepare('UPDATE players SET region = ?1 WHERE id = ?2 AND region IS NULL').bind(p.region, p.id).run();
  }
  await placed(env, p, request);
  if (path === '/api/me' && method === 'DELETE') {
    let token = p.apple_refresh;
    let client = p.apple_client;
    if (p.apple && !token && env.APPLE_KEY) {
      // no token was kept, so Apple has to be asked again before the account goes
      const b = await body(request);
      const a = await appleToken(env, b);
      if (!a || a.sub !== p.apple) return fail('reauth', 409);
      token = await refresh(env, typeof b.code === 'string' ? b.code : null, a.aud);
      if (!token) return fail('apple', 502);
      client = a.aud;
    }
    await revoke(env, token, client);
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM devices WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM chip_log WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM token_log WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM owned WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM active WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM purchases WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM friends WHERE a = ?1 OR b = ?1').bind(p.id),
      db.prepare('DELETE FROM messages WHERE sender = ?1 OR recipient = ?1').bind(p.id),
      db.prepare('DELETE FROM reports WHERE reporter = ?1 OR reported = ?1').bind(p.id),
      db.prepare('DELETE FROM match_seat WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM leaves WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM trade_hits WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM persona_flow WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM friend_day WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM held WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM players WHERE id = ?').bind(p.id)
    ]);
    // RevenueCat keeps the purchase history by account id, so it goes too; a failure there never stops the deletion
    if (env.RC_SECRET_KEY && ctx) ctx.waitUntil(fetch(rcBase(env) + '/v1/subscribers/' + p.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + env.RC_SECRET_KEY } }).catch(() => {}));
    // an old client that did not warn can still tell the player the subscription is theirs to stop
    return json({ ok: true, vip: isVip(p) });
  }
  if (path === '/api/me' && method === 'GET') return json(profile(p));
  if (path === '/api/signout' && method === 'POST') return signout(env, p, request);
  if (path === '/api/device' && method === 'DELETE') {
    const b = await body(request);
    await db.prepare('DELETE FROM devices WHERE (token = ?1 OR token = lower(?1)) AND player = ?2').bind(String(b.token), p.id).run();
    return json({ ok: true });
  }
  if (method !== 'POST') return fail('nope', 404);
  let err = null;
  if (path === '/api/name') err = await reroll(db, p);
  else if (path === '/api/avatar') {
    const b = await body(request);
    if (!Avatar.valid(b.avatar)) return fail('avatar');
    await db.prepare('UPDATE players SET avatar = ? WHERE id = ?').bind(b.avatar.join(','), p.id).run();
  } else if (path === '/api/daily') err = await daily(db, p);
  else if (path === '/api/bailout') err = await bailout(db, p);
  else if (path === '/api/device') err = await device(db, p, request);
  else if (path === '/api/push') err = await prefs(db, p, request);
  else if (path === '/api/region') err = await region(env, p, request);
  else if (path === '/api/typed') err = await typedSwitch(db, p, request);
  else if (path === '/api/voice') err = await voiceSwitch(db, p, request);
  else if (path === '/api/lang') err = await langSwitch(db, p, request);
  else if (path === '/api/apple/link') err = await link(env, request, p);
  else return fail('nope', 404);
  if (err) return err;
  const row = await db.prepare('SELECT * FROM players WHERE id = ?').bind(p.id).first();
  return row ? json(profile(row)) : fail('auth', 401);
}
