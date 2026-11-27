import { look } from './persona.js';
import { verify, denied, who, worn, isVip, json, fail } from './account.js';
import { setting } from './admin.js';
import { notHeld, onHold } from './friend.js';

const DAY = 86400000;
const CAP = 200;
const TOP = 50;
const ID = /^[0-9a-f]{32}$/;

// weeks run Monday to Monday, UTC; the epoch day 4 was the first Monday
export const week = (now = Date.now()) => Math.floor((now - 4 * DAY) / (7 * DAY));

// A player whose last week was an earlier one starts again from this win, and keeps that week for the weekly push.
export function won(db, id, n) {
  return db.prepare('UPDATE players SET prev_week = CASE WHEN week = ?1 THEN prev_week ELSE week END, prev_won = CASE WHEN week = ?1 THEN prev_won ELSE week_won END, week_won = CASE WHEN week = ?1 THEN week_won + ?2 ELSE ?2 END, week = ?1 WHERE id = ?3').bind(week(), n, id).run();
}

// a computer player's week, the same turnover as a player's: chips won and xp earned at public tables and in tournaments
export function personaWeek(db, id, n, xp) {
  return db.prepare('UPDATE personas SET prev_week = CASE WHEN week = ?1 THEN prev_week ELSE week END, prev_won = CASE WHEN week = ?1 THEN prev_won ELSE week_won END, week_won = CASE WHEN week = ?1 THEN week_won + ?2 ELSE ?2 END, week_xp = CASE WHEN week = ?1 THEN week_xp + ?3 ELSE ?3 END, week = ?1 WHERE id = ?4').bind(week(), n, xp, id).run();
}

// how a stands to b: block (a blocked b), blocked (b blocked a), friend, sent (a asked), got (b asked), none
export async function rel(db, a, b) {
  const { results } = await db.prepare('SELECT a, state FROM friends WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)').bind(a, b).all();
  const has = (mine, s) => results.some(r => (r.a === a) === mine && r.state === s);
  if (has(true, 'block')) return 'block';
  if (has(false, 'block')) return 'blocked';
  if (results.some(r => r.state === 'friend')) return 'friend';
  if (has(false, 'req')) return 'got';
  if (has(true, 'req')) return 'sent';
  return 'none';
}

// everyone who blocked this player or was blocked by them
export async function apart(db, id) {
  const { results } = await db.prepare("SELECT a, b FROM friends WHERE state = 'block' AND (a = ?1 OR b = ?1)").bind(id).all();
  return new Set(results.map(r => r.a === id ? r.b : r.a));
}

// how many messages each sender has waiting for this player
export async function unread(db, id) {
  const { results } = await db.prepare('SELECT sender, count(*) AS n FROM messages WHERE recipient = ? AND seen = 0 GROUP BY sender').bind(id).all();
  return Object.fromEntries(results.map(r => [r.sender, r.n]));
}

const count = async (db, sql, id) => (await db.prepare(sql).bind(id).first()).n;

const mark = r => ({ id: r.id, seed: r.name_seed, avatar: r.avatar.split(',').map(Number), level: r.level });

// a failure is a response; otherwise it says what changed, req or friend, or is null when nothing did
async function befriend(db, p, id) {
  if (id === p.id) return fail('self');
  const q = await who(db, id);
  if (!q) return fail('nobody', 404);
  const r = await rel(db, p.id, id);
  if (r === 'block') return fail('blocked', 403);
  if (r === 'blocked' || r === 'friend' || r === 'sent') return null;
  // requests I sent count as well as friends, so a player cannot pile up either
  if (await count(db, "SELECT count(*) AS n FROM friends WHERE (a = ?1 AND state IN ('friend', 'req')) OR (b = ?1 AND state = 'friend')", p.id) >= CAP) return fail('cap', 409);
  if (r === 'got') {
    // two requests that crossed leave one row each way
    await db.batch([
      db.prepare("UPDATE friends SET state = 'friend' WHERE a = ? AND b = ? AND state = 'req'").bind(id, p.id),
      db.prepare("DELETE FROM friends WHERE a = ? AND b = ? AND state = 'req'").bind(p.id, id)
    ]);
    return 'friend';
  }
  const full = !q.persona && await count(db, "SELECT count(*) AS n FROM friends WHERE b = ? AND state = 'req'", id) >= CAP;
  if (full) return fail('cap', 409);
  // a computer player declines 4 in 10 requests some time between ten minutes and three days later and leaves the rest unanswered
  const decide = q.persona && Math.random() < 0.4 ? Date.now() + 600000 + Math.floor(Math.random() * (3 * DAY - 600000)) : null;
  await db.prepare("INSERT OR IGNORE INTO friends (a, b, state, decide) VALUES (?, ?, 'req', ?)").bind(p.id, id, decide).run();
  return 'req';
}

// removes a friendship or a request in either direction, which also declines and cancels
function unfriend(db, p, id) {
  return db.prepare("DELETE FROM friends WHERE state <> 'block' AND ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1))").bind(p.id, id).run();
}

async function block(db, p, id) {
  if (id === p.id) return fail('self');
  if (!await who(db, id)) return fail('nobody', 404);
  if (await count(db, "SELECT count(*) AS n FROM friends WHERE a = ? AND state = 'block'", p.id) >= CAP) return fail('cap', 409);
  await db.batch([
    db.prepare("DELETE FROM friends WHERE state <> 'block' AND ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1))").bind(p.id, id),
    db.prepare("INSERT OR IGNORE INTO friends (a, b, state) VALUES (?, ?, 'block')").bind(p.id, id)
  ]);
  return null;
}

async function friends(env, p) {
  const { results } = await env.DB.prepare(
    'SELECT f.a, f.state, q.id, q.name_seed, q.avatar, q.level FROM friends f JOIN (SELECT id, name_seed, avatar, level FROM players UNION ALL SELECT id, name_seed, avatar, level FROM personas) q ON q.id = CASE WHEN f.a = ?1 THEN f.b ELSE f.a END WHERE f.a = ?1 OR f.b = ?1'
  ).bind(p.id).all();
  const out = { friends: [], incoming: [], outgoing: [], blocked: [] };
  for (const r of results) {
    const mine = r.a === p.id;
    if (r.state === 'friend') out.friends.push(mark(r));
    else if (r.state === 'req') out[mine ? 'outgoing' : 'incoming'].push(mark(r));
    else if (mine) out.blocked.push(mark(r));
  }
  const waiting = await unread(env.DB, p.id);
  for (const f of out.friends) f.unread = waiting[f.id] || 0;
  const at = out.friends.length ? await env.HUB.get(env.HUB.idFromName('h')).where(out.friends.map(x => x.id)).catch(() => ({})) : {};
  for (const f of out.friends) {
    f.at = at[f.id] || null;
    f.online = !!f.at;
  }
  out.friends.sort((a, b) => b.online - a.online || a.seed - b.seed);
  return json(out);
}

async function rank(db, row) {
  const w = week();
  const cur = row.week === w ? row.week_won : 0;
  // a pair held for a look by the admin is out of the rankings, and so is what it won
  if (!cur || await onHold(db, row.id)) return { won: 0, rank: null };
  const ahead = await db.prepare('SELECT (SELECT count(*) FROM players WHERE week = ?1 AND week_won > ?2 AND ' + notHeld('id') + ') + (SELECT count(*) FROM personas WHERE week = ?1 AND week_won > ?2) AS n').bind(w, cur).first();
  return { won: cur, rank: ahead.n + 1 };
}

// the blocked player sees a stranger
async function shown(db, a, b) {
  const r = await rel(db, a, b);
  return r === 'blocked' ? 'none' : r;
}

async function profile(db, p, id) {
  const row = ID.test(id) && await who(db, id);
  if (!row) return fail('nobody', 404);
  return json(Object.assign(mark(row), await rank(db, row), {
    games: row.games, wins: row.wins, wear: row.persona ? look(row).wear : worn(row, ['frame', 'plate', 'back']), vip: row.persona ? look(row).vip : isVip(row), rel: row.id === p.id ? 'you' : await shown(db, p.id, row.id)
  }));
}

async function top(db, p) {
  const w = week();
  const wk = await db.prepare('SELECT id, name_seed, avatar, level, week_won FROM (SELECT id, name_seed, avatar, level, week_won FROM players WHERE week = ?1 AND week_won > 0 AND ' + notHeld('id') + ' UNION ALL SELECT id, name_seed, avatar, level, week_won FROM personas WHERE week = ?1 AND week_won > 0) ORDER BY week_won DESC, id LIMIT ?2').bind(w, TOP).all();
  const lv = await db.prepare('SELECT id, name_seed, avatar, level, xp FROM (SELECT id, name_seed, avatar, level, xp FROM players WHERE xp > 0 AND ' + notHeld('id') + ' UNION ALL SELECT id, name_seed, avatar, level, xp FROM personas WHERE xp > 0) ORDER BY level DESC, xp DESC, id LIMIT ?').bind(TOP).all();
  let up = null;
  if (p.xp > 0 && !await onHold(db, p.id)) {
    const ahead = await db.prepare('SELECT (SELECT count(*) FROM players WHERE (level > ?1 OR (level = ?1 AND xp > ?2)) AND ' + notHeld('id') + ') + (SELECT count(*) FROM personas WHERE level > ?1 OR (level = ?1 AND xp > ?2)) AS n').bind(p.level, p.xp).first();
    up = ahead.n + 1;
  }
  return json({
    week: wk.results.map(r => Object.assign(mark(r), { won: r.week_won })), you: await rank(db, p),
    level: lv.results.map(r => Object.assign(mark(r), { xp: r.xp })), up: up
  });
}

// per hour when no person has played enough to go by
const START = { won: 60, xp: 30 };
const MATCH_XP = 45;

// The middle of what people with 5 or more public or tournament matches this week have won and earned per hour so far.
async function pace(env, now) {
  const start = (week(now) * 7 + 4) * DAY;
  const hours = Math.max(1, (now - start) / 3600000);
  const { results } = await env.DB.prepare("SELECT m.player AS id, count(*) AS n, coalesce(p.week_won * (p.week = ?1), 0) AS won FROM match_seat m JOIN players p ON p.id = m.player WHERE m.at >= ?2 AND m.kind <> 'friend' AND m.fake = 0 GROUP BY m.player HAVING n >= 5").bind(week(now), start).all();
  if (results.length < 3) return START;
  const mid = a => a.sort((x, y) => x - y)[a.length >> 1];
  return { won: mid(results.map(r => r.won / hours)), xp: mid(results.map(r => r.n * MATCH_XP / hours)) };
}

// Hourly, each computer player in use lately that is not at a table adds wins and xp as a player who plays every week would: its own
// factor, fixed when it was made, times that rate, a little different each hour, with the games and wins that would have earned it.
// Real results at public tables add to it. One not claimed for two weeks is left alone, so its card does not grow for nobody.
// (a match is worth about 45 xp, and about a quarter of the games are won)
export async function simulate(env, now) {
  const set = env.PACE && await setting(env.DB, 'simrate');
  const rate = set ? JSON.parse(set) : await pace(env, now);
  const jitter = '(0.7 + abs(random()) % 600 / 1000.0)';
  await env.DB.prepare('UPDATE personas SET prev_week = CASE WHEN week = ?1 THEN prev_week ELSE week END, prev_won = CASE WHEN week = ?1 THEN prev_won ELSE week_won END, ' +
    'week_won = CASE WHEN week = ?1 THEN week_won ELSE 0 END + CAST(?2 * factor * ' + jitter + ' AS INTEGER), ' +
    'week_xp = CASE WHEN week = ?1 THEN week_xp ELSE 0 END + CAST(?3 * factor * ' + jitter + ' AS INTEGER), ' +
    'games = games + CAST(?3 * factor / 45 + abs(random()) % 1000 / 1000.0 AS INTEGER), wins = wins + CAST(?3 * factor / 180 + abs(random()) % 1000 / 1000.0 AS INTEGER), ' +
    'week = ?1 WHERE (busy IS NULL OR busy_at < ?4) AND busy_at >= ?5')
    .bind(week(now), Math.round(rate.won), Math.round(rate.xp), now - 3 * 3600000, now - 14 * 86400000).run();
}

// the requests to computer players whose time has come are dropped, as a person declining would
export function decline(env, now) {
  return env.DB.prepare("DELETE FROM friends WHERE state = 'req' AND decide IS NOT NULL AND decide <= ?").bind(now).run();
}

export async function social(request, env, ctx) {
  const db = env.DB;
  const p = await verify(db, (request.headers.get('Authorization') || '').replace(/^Bearer /, ''));
  if (!p) return denied(db, request);
  const [, , what, arg] = new URL(request.url).pathname.split('/');
  const m = request.method;
  if (what === 'top' && m === 'GET') return top(db, p);
  if (what === 'friends' && m === 'GET') return friends(env, p);
  if (what === 'player' && m === 'GET') return profile(db, p, arg);
  let err = null;
  if (what === 'friend' && m === 'POST') {
    let id;
    try { id = (await request.json()).id; } catch (e) { /* no body */ }
    if (!ID.test(id)) return fail('id');
    const r = await befriend(db, p, id);
    if (r instanceof Response) err = r;
    // the hub knows whether the other player's app is open, and only an app that is closed gets a push
    // and it runs after the answer, so the answer takes the same time whoever the other player is
    else if (r) ctx.waitUntil(env.HUB.get(env.HUB.idFromName('h')).ring(p.id, id, r === 'req' ? 'req' : 'accept', { seed: p.name_seed }).catch(() => {}));
  } else if ((what === 'friend' || what === 'block') && ID.test(arg) && (m === 'DELETE' || what === 'block' && m === 'POST')) {
    if (what === 'friend') await unfriend(db, p, arg);
    else if (m === 'POST') err = await block(db, p, arg);
    else await db.prepare("DELETE FROM friends WHERE a = ? AND b = ? AND state = 'block'").bind(p.id, arg).run();
  } else return fail('nope', 404);
  return err || json({ ok: true });
}
