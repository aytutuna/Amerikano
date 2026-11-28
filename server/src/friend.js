import { credit, creditAll, feeFor } from './account.js';
import { grant } from './persona.js';

const DAY = 86400000;
// what one account may take from friend tables in a UTC day before the rest waits for Aytu
export const DAY_CAP = 100000;
// a pair is flagged when one passed the other this much net in a week, or when 16 of one account's last 20 matches went the same way
const PASSED = 50000;
const RUN = 16;
const LAST = 20;
const QUIET = 30 * DAY;

// the sql for "this account is not held back from the rankings by an open pair flag"
export const notHeld = col => col + " NOT IN (SELECT a FROM flags WHERE kind = 'pair' AND cleared IS NULL UNION SELECT b FROM flags WHERE kind = 'pair' AND cleared IS NULL)";

export async function onHold(db, id) {
  return !!await db.prepare("SELECT 1 FROM flags WHERE kind = 'pair' AND cleared IS NULL AND (a = ?1 OR b = ?1)").bind(id).first();
}

// A human's payout at a friend table with a stake. The day's friend-table net is counted per account; what a win takes above the
// cap goes into `held` instead of the balance. The tally and the held row share the batch of the credit, so a repeat adds nothing.
export async function friendPay(db, id, pay, net, match) {
  const day = Math.floor(Date.now() / DAY);
  const ref = match + ':out';
  const sum = await db.prepare('SELECT coalesce(sum(net), 0) AS n FROM friend_day WHERE player = ? AND day = ?').bind(id, day).first();
  const over = Math.max(0, Math.min(net, sum.n + net - DAY_CAP));
  // one tally row per match, so a repeat adds nothing; a payout of nothing leaves no log row, so the tally cannot lean on it
  // a loss the balance could not cover is refused and read again, so the tally waits for the credit that landed
  const landed = pay - over ? ' WHERE EXISTS (SELECT 1 FROM chip_log WHERE player = ?1 AND ref = ?5)' : '';
  const also = [db.prepare('INSERT OR IGNORE INTO friend_day (player, day, match, net) SELECT ?1, ?2, ?3, ?4' + landed).bind(...(landed ? [id, day, match, net, ref] : [id, day, match, net]))];
  if (over) also.push(db.prepare('INSERT INTO held (player, amount, match, at) SELECT ?1, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM chip_log WHERE player = ?1 AND ref = ?2)').bind(id, ref, over, match, Date.now()));
  return credit(db, id, pay - over, 'match', ref, { set: {}, where: '1', args: [], also: also });
}

const still = "EXISTS (SELECT 1 FROM held WHERE id = ? AND state = 'held')";

// Pays held chips out to the player who won them. Null when the row is not held (any more).
export async function releaseHeld(db, id) {
  const h = await db.prepare("SELECT * FROM held WHERE id = ? AND state = 'held'").bind(id).first();
  if (!h) return null;
  const done = db.prepare("UPDATE held SET state = 'released', done = ? WHERE id = ? AND state = 'held'").bind(Date.now(), id);
  return await creditAll(db, [{ id: h.player, delta: h.amount, reason: 'release', ref: 'held:' + id }], still, [id], done) ? h : null;
}

// Gives held chips back to the seats that lost them in that match, in proportion to what each lost (the fee is not part of a loss)
// and never more than that, so a computer player's share goes back to its bank. Null when the row is not held or nobody can be paid.
export async function returnHeld(db, id) {
  const h = await db.prepare("SELECT * FROM held WHERE id = ? AND state = 'held'").bind(id).first();
  if (!h) return null;
  const { results } = await db.prepare('SELECT player, stake, net, fake FROM match_seat WHERE match = ? AND net < 0 ORDER BY net, player').bind(h.match).all();
  const lost = results.map(r => Object.assign(r, { loss: -r.net - feeFor(r.stake) })).filter(r => r.loss > 0);
  const total = lost.reduce((n, r) => n + r.loss, 0);
  if (!total) return null;
  for (const r of lost) r.share = Math.floor(h.amount * r.loss / total);
  // what rounding left over goes one chip at a time to the largest losses, never past a loss
  let rest = h.amount - lost.reduce((n, r) => n + r.share, 0);
  for (const r of lost) if (rest > 0 && r.share < r.loss) {
    r.share++;
    rest--;
  }
  const pay = lost.filter(r => r.share > 0);
  const done = db.prepare("UPDATE held SET state = 'returned', done = ? WHERE id = ? AND state = 'held'").bind(Date.now(), id);
  const people = pay.filter(r => !r.fake).map(r => ({ id: r.player, delta: r.share, reason: 'return', ref: 'held:' + id + ':' + r.player }));
  if (!await creditAll(db, people, still, [id], done)) return null;
  for (const r of pay) if (r.fake) await grant(db, r.player, r.share);
  return Object.assign(h, { paid: pay.map(r => [r.player, r.share]) });
}

// log row for something done by the job itself
const logged = (db, id, action, detail, now) => db.prepare("INSERT INTO admin_log (at, who, action, target, detail) VALUES (?, 'auto', ?, ?, ?)").bind(now, action, id, JSON.stringify(detail));

// flags a pair unless it already has an open flag or one cleared in the last 30 days; the account passing is first
async function flag(db, a, b, x, y, now) {
  const r = await db.prepare("INSERT INTO flags (kind, a, b, x, y, at) SELECT 'pair', ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM flags WHERE kind = 'pair' AND ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)) AND (cleared IS NULL OR cleared > ?6))")
    .bind(a, b, x, y, now, now - QUIET).run();
  if (r.meta.changes === 1) await logged(db, a, 'pair', { with: b, chips: x, run: y }, now).run();
}

// Hourly, over the match record. Computer players are never a partner. Gifts are destroyed today, so they are not counted.
export async function pairs(env, now) {
  const db = env.DB;
  // each friend match's loss is split over the winners in proportion to their gains
  const { results } = await db.prepare("SELECT match, player, net, fake, stake FROM match_seat WHERE kind = 'friend' AND stake > 0 AND net IS NOT NULL AND at > ? ORDER BY match").bind(now - 7 * DAY).all();
  const flow = new Map();
  for (let i = 0; i < results.length;) {
    let j = i;
    while (j < results.length && results[j].match === results[i].match) j++;
    const seats = results.slice(i, j);
    i = j;
    const gain = seats.reduce((n, s) => n + Math.max(0, s.net), 0);
    if (!gain) continue;
    for (const l of seats) {
      const loss = -l.net - feeFor(l.stake);
      if (l.fake || loss <= 0) continue;
      for (const w of seats) if (!w.fake && w.net > 0) flow.set(l.player + ' ' + w.player, (flow.get(l.player + ' ' + w.player) || 0) + loss * w.net / gain);
    }
  }
  for (const [k, v] of flow) {
    const [a, b] = k.split(' ');
    const back = flow.get(b + ' ' + a) || 0;
    if (v - back >= PASSED) await flag(db, a, b, Math.round(v - back), 0, now);
  }
  // and one partner in most of an account's recent matches, lost to
  const runs = await db.prepare("WITH last AS (SELECT match, player, net, ROW_NUMBER() OVER (PARTITION BY player ORDER BY at DESC, match) AS n FROM match_seat WHERE net IS NOT NULL AND fake = 0 AND gone = 0 AND player IN (SELECT player FROM match_seat WHERE at > ?)) " +
    'SELECT a.player AS lo, b.player AS wi, count(*) AS k FROM last a JOIN match_seat b ON b.match = a.match AND b.player <> a.player AND b.fake = 0 AND b.net > 0 WHERE a.n <= ? AND a.net < 0 GROUP BY a.player, b.player HAVING count(*) >= ?').bind(now - DAY, LAST, RUN).all();
  for (const r of runs.results) await flag(db, r.lo, r.wi, 0, r.k, now);
}
