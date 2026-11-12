import Names from '../../www/js/names.js';
import Avatar from '../../www/js/avatar.js';

const DAY = 86400000;
const START = 5000;
const MIN_ROOM = 1000;
export const STAKES = [100, 500, 2500, 10000, 50000];
export const ENTRY = 10;

// the stake back plus the match chips at stake/10 each; negative when the match cost more than the stake
export const payout = (stake, chips) => stake + chips * stake / 10;
const ROLLS = 20;
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
const levelAt = xp => {
  let n = 1;
  while (xp >= 50 * n * (n + 1)) n++;
  return n;
};

function creditStmts(db, id, delta, reason, ref) {
  return [
    db.prepare('UPDATE players SET chips = chips + ?1 WHERE id = ?2 AND chips + ?1 >= 0').bind(delta, id),
    db.prepare('INSERT INTO chip_log (player, delta, reason, at, ref) SELECT ?1, ?2, ?3, ?4, ?5 WHERE changes() > 0').bind(id, delta, reason, Date.now(), ref || null)
  ];
}

// The only way chips change. Returns false when the player is gone or would go below zero.
// A ref makes the change happen once: the unique index fails the batch on a repeat, which counts as done.
export async function credit(db, id, delta, reason, ref) {
  if (!delta) return true;
  // a retry after the balance has moved must still see the first run
  if (ref && await db.prepare('SELECT 1 FROM chip_log WHERE player = ? AND ref = ?').bind(id, ref).first()) return true;
  try {
    const r = await db.batch(creditStmts(db, id, delta, reason, ref));
    return r[0].meta.changes === 1;
  } catch (e) {
    if (ref && /UNIQUE/.test(e.message)) return true;
    throw e;
  }
}

export async function verify(db, token) {
  const m = TOKEN.exec(token || '');
  if (!m) return null;
  const p = await player(db, m[1]);
  return p && p.secret_hash === await hash(m[2]) ? p : null;
}

export function player(db, id) {
  return db.prepare('SELECT * FROM players WHERE id = ?').bind(id).first();
}

export function seat(p) {
  return { pid: p.id, seed: p.name_seed, av: p.avatar.split(',').map(Number), level: p.level };
}

// xp, games and wins for one finished match; a level-up pays 1,000 chips times the new level
export async function award(db, id, add) {
  await db.prepare('UPDATE players SET xp = xp + ?, games = games + 1, wins = wins + ? WHERE id = ?').bind(add.xp, add.win ? 1 : 0, id).run();
  const p = await db.prepare('SELECT xp, level FROM players WHERE id = ?').bind(id).first();
  if (!p) return;
  const to = levelAt(p.xp);
  if (to <= p.level) return;
  // only the settle that moves the level pays for it
  const r = await db.prepare('UPDATE players SET level = ? WHERE id = ? AND level = ?').bind(to, id, p.level).run();
  if (r.meta.changes !== 1) return;
  for (let l = p.level + 1; l <= to; l++) await credit(db, id, 1000 * l, 'level');
}

function profile(p) {
  const last = Math.floor(p.daily_at / DAY);
  const now = today();
  const next = last === now - 1 ? Math.min(p.streak + 1, 7) : 1;
  return {
    seed: p.name_seed, avatar: p.avatar.split(',').map(Number), chips: p.chips, xp: p.xp, level: p.level,
    from: 50 * p.level * (p.level - 1), to: 50 * p.level * (p.level + 1), games: p.games, wins: p.wins,
    daily: { ready: last < now, streak: last >= now - 1 ? p.streak : 0, reward: 500 + 250 * next },
    bailout: p.chips < MIN_ROOM && Math.floor(p.bail_at / DAY) < now
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

async function guest(db) {
  const id = random(16);
  const secret = random(32);
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO players (id, secret_hash, name_seed, avatar, chips, created) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, await hash(secret), Names.pick(), Avatar.random().join(','), START, now),
    db.prepare('INSERT INTO chip_log (player, delta, reason, at) VALUES (?, ?, ?, ?)').bind(id, START, 'start', now)
  ]);
  return json({ id: id, secret: secret });
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
  const now = Date.now();
  const reward = 500 + 250 * streak;
  const r = await db.batch([
    db.prepare("INSERT INTO chip_log (player, delta, reason, at) SELECT id, ?1, 'daily', ?2 FROM players WHERE id = ?3 AND daily_at = ?4").bind(reward, now, p.id, p.daily_at),
    db.prepare('UPDATE players SET daily_at = ?1, streak = ?2, chips = chips + ?3 WHERE id = ?4 AND daily_at = ?5').bind(now, streak, reward, p.id, p.daily_at)
  ]);
  if (r[1].meta.changes !== 1) return fail('claimed', 409);
}

async function bailout(db, p) {
  if (p.chips >= MIN_ROOM) return fail('rich', 409);
  const now = Date.now();
  const r = await db.batch([
    db.prepare("INSERT INTO chip_log (player, delta, reason, at) SELECT id, ?1 - chips, 'bailout', ?2 FROM players WHERE id = ?3 AND chips < ?1 AND bail_at < ?4").bind(MIN_ROOM, now, p.id, today() * DAY),
    db.prepare('UPDATE players SET chips = ?1, bail_at = ?2 WHERE id = ?3 AND chips < ?1 AND bail_at < ?4').bind(MIN_ROOM, now, p.id, today() * DAY)
  ]);
  if (r[1].meta.changes !== 1) return fail('claimed', 409);
}

export async function api(request, env) {
  const db = env.DB;
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (path === '/api/guest' && method === 'POST') {
    // every new account starts with chips, so keep one address from minting them in bulk
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if (env.GUESTS && !(await env.GUESTS.limit({ key: ip })).success) return fail('slow', 429);
    return guest(db);
  }
  const p = await verify(db, (request.headers.get('Authorization') || '').replace(/^Bearer /, ''));
  if (!p) return fail('auth', 401);
  if (path === '/api/me' && method === 'DELETE') {
    await db.batch([
      db.prepare('DELETE FROM chip_log WHERE player = ?').bind(p.id),
      db.prepare('DELETE FROM friends WHERE a = ?1 OR b = ?1').bind(p.id),
      db.prepare('DELETE FROM players WHERE id = ?').bind(p.id)
    ]);
    return json({ ok: true });
  }
  if (path === '/api/me' && method === 'GET') return json(profile(p));
  if (method !== 'POST') return fail('nope', 404);
  let err = null;
  if (path === '/api/name') err = await reroll(db, p);
  else if (path === '/api/avatar') {
    const b = await body(request);
    if (!Avatar.valid(b.avatar)) return fail('avatar');
    await db.prepare('UPDATE players SET avatar = ? WHERE id = ?').bind(b.avatar.join(','), p.id).run();
  } else if (path === '/api/daily') err = await daily(db, p);
  else if (path === '/api/bailout') err = await bailout(db, p);
  else return fail('nope', 404);
  if (err) return err;
  const row = await db.prepare('SELECT * FROM players WHERE id = ?').bind(p.id).first();
  return row ? json(profile(row)) : fail('auth', 401);
}
