import { verify, who, json, fail } from './account.js';

const DAY = 86400000;
const CAP = 200;
const TOP = 50;
const ID = /^[0-9a-f]{32}$/;

// weeks run Monday to Monday, UTC; the epoch day 4 was the first Monday
export const week = () => Math.floor((Date.now() - 4 * DAY) / (7 * DAY));

// A player whose last week was an earlier one starts again from this win.
export function won(db, id, n) {
  return db.prepare('UPDATE players SET week_won = CASE WHEN week = ?1 THEN week_won + ?2 ELSE ?2 END, week = ?1 WHERE id = ?3').bind(week(), n, id).run();
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

const count = async (db, sql, id) => (await db.prepare(sql).bind(id).first()).n;

const mark = r => ({ id: r.id, seed: r.name_seed, avatar: r.avatar.split(',').map(Number), level: r.level });

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
    return null;
  }
  const full = !q.persona && await count(db, "SELECT count(*) AS n FROM friends WHERE b = ? AND state = 'req'", id) >= CAP;
  if (full) return fail('cap', 409);
  await db.prepare("INSERT OR IGNORE INTO friends (a, b, state) VALUES (?, ?, 'req')").bind(p.id, id).run();
  return null;
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
  if (!cur) return { won: 0, rank: null };
  const ahead = await db.prepare('SELECT count(*) AS n FROM players WHERE week = ?1 AND week_won > ?2').bind(w, cur).first();
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
    games: row.games, wins: row.wins, rel: row.id === p.id ? 'you' : await shown(db, p.id, row.id)
  }));
}

async function top(db, p) {
  const w = week();
  const wk = await db.prepare('SELECT id, name_seed, avatar, level, week_won FROM players WHERE week = ? AND week_won > 0 ORDER BY week_won DESC, id LIMIT ?').bind(w, TOP).all();
  const lv = await db.prepare('SELECT id, name_seed, avatar, level, xp FROM players WHERE xp > 0 ORDER BY level DESC, xp DESC, id LIMIT ?').bind(TOP).all();
  let up = null;
  if (p.xp > 0) {
    const ahead = await db.prepare('SELECT count(*) AS n FROM players WHERE level > ?1 OR (level = ?1 AND xp > ?2)').bind(p.level, p.xp).first();
    up = ahead.n + 1;
  }
  return json({
    week: wk.results.map(r => Object.assign(mark(r), { won: r.week_won })), you: await rank(db, p),
    level: lv.results.map(r => Object.assign(mark(r), { xp: r.xp })), up: up
  });
}

export async function social(request, env) {
  const db = env.DB;
  const p = await verify(db, (request.headers.get('Authorization') || '').replace(/^Bearer /, ''));
  if (!p) return fail('auth', 401);
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
    err = await befriend(db, p, id);
  } else if ((what === 'friend' || what === 'block') && ID.test(arg) && (m === 'DELETE' || what === 'block' && m === 'POST')) {
    if (what === 'friend') await unfriend(db, p, arg);
    else if (m === 'POST') err = await block(db, p, arg);
    else await db.prepare("DELETE FROM friends WHERE a = ? AND b = ? AND state = 'block'").bind(p.id, arg).run();
  } else return fail('nope', 404);
  return err || json({ ok: true });
}
