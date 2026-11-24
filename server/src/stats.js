const DAY = 86400000;

// the share of the players created n days before this day who were active on it
const back = (db, day, n) => db.prepare('SELECT count(*) AS n, count(a.player) AS k FROM players p LEFT JOIN active a ON a.player = p.id AND a.day = ?1 WHERE p.created >= ?2 AND p.created < ?3')
  .bind(day, (day - n) * DAY, (day - n + 1) * DAY);

// Fills the days of the last week that have no row yet, never before the first day with active rows.
export async function rollup(env, now) {
  const today = Math.floor(now / DAY);
  const first = await env.DB.prepare('SELECT min(day) AS d FROM active').first();
  if (!first || first.d === null) return;
  const have = await env.DB.prepare('SELECT day FROM stats WHERE day >= ?').bind(today - 7).all();
  const done = new Set(have.results.map(r => r.day));
  for (let day = Math.max(today - 7, first.d); day < today; day++) {
    if (!done.has(day)) await fill(env, day);
  }
  await env.DB.prepare('DELETE FROM active WHERE day < ?').bind(today - 61).run();
}

// dN in a row is the retention of the cohort created N days before that row's day
async function fill(env, day) {
  const [mine, dau, matches, d1, d7, d30] = await env.DB.batch([
    env.DB.prepare('SELECT count(*) AS n FROM players WHERE created >= ?1 AND created < ?2').bind(day * DAY, (day + 1) * DAY),
    env.DB.prepare('SELECT count(*) AS n FROM active WHERE day = ?').bind(day),
    env.DB.prepare("SELECT count(DISTINCT substr(ref, 1, length(ref) - 3)) AS n FROM chip_log WHERE reason = 'escrow' AND at >= ?1 AND at < ?2").bind(day * DAY, (day + 1) * DAY),
    back(env.DB, day, 1),
    back(env.DB, day, 7),
    back(env.DB, day, 30)
  ]);
  const share = r => (r.results[0].n ? r.results[0].k / r.results[0].n : null);
  await env.DB.prepare('INSERT OR REPLACE INTO stats (day, new, dau, d1, d7, d30, matches) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(day, mine.results[0].n, dau.results[0].n, share(d1), share(d7), share(d30), matches.results[0].n).run();
}
