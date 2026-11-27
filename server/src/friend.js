import { credit, creditAll, feeFor } from './account.js';
import { grant } from './persona.js';

const DAY = 86400000;
// what one account may take from friend tables in a UTC day before the rest waits for Aytu
export const DAY_CAP = 100000;

// A human's payout at a friend table with a stake. The day's friend-table net is counted per account; what a win takes above the
// cap goes into `held` instead of the balance. The tally and the held row share the batch of the credit, so a repeat adds nothing.
export async function friendPay(db, id, pay, net, match) {
  const day = Math.floor(Date.now() / DAY);
  const ref = match + ':out';
  const sum = await db.prepare('SELECT coalesce(sum(net), 0) AS n FROM friend_day WHERE player = ? AND day = ?').bind(id, day).first();
  const over = Math.max(0, Math.min(net, sum.n + net - DAY_CAP));
  // one tally row per match, so a repeat adds nothing; a payout of nothing leaves no log row, so the tally cannot lean on it
  const also = [db.prepare('INSERT OR IGNORE INTO friend_day (player, day, match, net) VALUES (?, ?, ?, ?)').bind(id, day, match, net)];
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
