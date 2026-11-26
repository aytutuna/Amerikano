import Names from '../../www/js/names.js';
import Avatar from '../../www/js/avatar.js';
import Catalog from '../../www/js/catalog.js';
import { levelAt, ENTRY } from './account.js';

const DAY = 86400000;
const BONUS = 750;
const LIFE = 3 * 3600000;
const POOL = 12;

// Computer players keep their own chips here, outside the chip function and its log: they are not accounts.
// test/play.js (source scan) lists this file as the one place besides account.js that may set chips.
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);

function hex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

// Xp inside the level's band, with games and wins that could have earned it:
// a match is worth 40, plus 5 for each game finished first and 30 for the win.
function history(level) {
  let h;
  for (let i = 0; i < 8; i++) {
    const want = 50 * level * (level - 1) + Math.random() * 100 * level;
    const rate = rnd(0.15, 0.35);
    const games = Math.round(want / (45 + 30 * rate));
    const wins = Math.min(games, Math.max(0, Math.round(games * rate + rnd(-1, 1) * Math.sqrt(games))));
    const firsts = Math.round(games * rnd(0.6, 1.4));
    h = { xp: 40 * games + 30 * wins + 5 * firsts, games: games, wins: wins };
    if (levelAt(h.xp) === level) break;
  }
  return h;
}

// About a third of the personas wear one or two things, cheaper ones more often; chosen once, so a face looks the same each time.
// Items for subscribers and the season pass are never worn, and nobody here owns an emote pack: they never speak.
const worn = i => !i.vip && !i.pass;

function outfit() {
  const wear = {};
  if (Math.random() < 0.35) {
    const slots = ['frame', 'plate', 'back'].sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.4 ? 2 : 1);
    for (const slot of slots) {
      const items = Catalog.ITEMS.filter(i => i.slot === slot && worn(i));
      let u = Math.random() * items.reduce((n, i) => n + 1 / i.price, 0);
      wear[slot] = (items.find(i => (u -= 1 / i.price) <= 0) || items[0]).id;
    }
  }
  return { wear: JSON.stringify(wear), owns: '[]', vip: 0 };
}

// what a persona wears, for the seat; an item for subscribers in an old row is left off
export function look(p) {
  const wear = JSON.parse(p.wear || '{}');
  return { wear: Object.fromEntries(Object.entries(wear).filter(([, id]) => Catalog.item(id) && worn(Catalog.item(id)))), vip: false };
}

async function make(db, code, level, stake, avoid, now) {
  let seed;
  do seed = Names.pick(); while (avoid.includes(seed));
  const h = history(Math.max(1, Math.round(level + rnd(-3, 2))));
  const lv = levelAt(h.xp);
  // what a player of that level would plausibly hold, and enough to sit at this stake
  const chips = Math.round(Math.max(rnd(0.4, 1.6) * (4000 + 500 * lv * (lv + 1)), rnd(1.2, 3.5) * ENTRY * stake) / 10) * 10;
  const p = Object.assign({ id: hex(), name_seed: seed, avatar: Avatar.random().join(','), level: lv, xp: h.xp, games: h.games, wins: h.wins, chips: chips, topup: now, busy: code, busy_at: now, created: now, factor: rnd(0.3, 1.5) }, outfit());
  await db.prepare('INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy, busy_at, created, wear, owns, vip, factor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(p.id, p.name_seed, p.avatar, p.level, p.xp, p.games, p.wins, p.chips, p.topup, p.busy, p.busy_at, p.created, p.wear, p.owns, p.vip, p.factor).run();
  return p;
}

// A free persona near this level who can cover the stake, else a new one. The pool only grows
// while few fit, so the same faces come back without the same few being the only ones.
export async function claim(db, code, level, stake, avoid) {
  const now = Date.now();
  // every full day since the last top-up adds the bonus, counted when the persona is next looked at
  const days = `CAST((?1 - topup) / ${DAY} AS INTEGER)`;
  const seeds = avoid.map((x, i) => '?' + (6 + i)).join(',');
  const where = `level BETWEEN ?3 AND ?4 AND (busy IS NULL OR busy_at < ?5) AND chips + ${days} * ${BONUS} >= ?2 AND name_seed NOT IN (${seeds})`;
  const args = [now, ENTRY * stake, Math.max(1, level - 3), level + 3, now - LIFE, ...avoid];
  const { n } = await db.prepare(`SELECT count(*) AS n FROM personas WHERE ${where}`).bind(...args).first();
  if (Math.random() * POOL < n) {
    const row = await db.prepare(
      `UPDATE personas SET busy = ?${args.length + 1}, busy_at = ?1, chips = chips + ${days} * ${BONUS}, topup = topup + ${days} * ${DAY} ` +
      `WHERE id = (SELECT id FROM personas WHERE ${where} ORDER BY random() LIMIT 1) RETURNING *`
    ).bind(...args, code).first();
    if (row) {
      // a persona made before the shop gets its outfit now
      if (row.wear === null) {
        Object.assign(row, outfit());
        await db.prepare('UPDATE personas SET wear = ?, owns = ?, vip = ? WHERE id = ?').bind(row.wear, row.owns, row.vip, row.id).run();
      }
      return row;
    }
  }
  return make(db, code, level, stake, avoid, now);
}

export function release(db, code) {
  return db.prepare('UPDATE personas SET busy = NULL WHERE busy = ?').bind(code).run();
}

// a persona who stays for a rematch keeps its claim fresh, so a long run is never taken as expired
export function keep(db, id, code) {
  return db.prepare('UPDATE personas SET busy_at = ? WHERE id = ? AND busy = ?').bind(Date.now(), id, code).run();
}

export function giveBack(db, id) {
  return db.prepare('UPDATE personas SET busy = NULL WHERE id = ?').bind(id).run();
}

// the stake for a match; returns what is left
export async function spend(db, id, n) {
  const p = await db.prepare('UPDATE personas SET chips = max(chips - ?1, 0) WHERE id = ?2 RETURNING chips').bind(n, id).first();
  return p ? p.chips : 0;
}

// chips, games, wins and xp for one finished match, as for a player; a level-up pays 1,000 chips times the new level
export async function payoff(db, id, pay, add) {
  const p = await db.prepare('UPDATE personas SET chips = max(chips + ?1, 0), xp = xp + ?2, games = games + 1, wins = wins + ?3 WHERE id = ?4 RETURNING chips, xp, level')
    .bind(pay, add.xp, add.win ? 1 : 0, id).first();
  if (!p) return 0;
  const to = levelAt(p.xp);
  if (to <= p.level) return p.chips;
  let bonus = 0;
  for (let l = p.level + 1; l <= to; l++) bonus += 1000 * l;
  await db.prepare('UPDATE personas SET level = ?1, chips = chips + ?2 WHERE id = ?3').bind(to, bonus, id).run();
  return p.chips + bonus;
}

// a tournament prize, on top of what the match already added
export function grant(db, id, n) {
  return db.prepare('UPDATE personas SET chips = chips + ? WHERE id = ?').bind(n, id).run();
}
