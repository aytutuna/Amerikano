const DAY = 86400000;

// the share of the players created n days before this day who were active on it
const back = (db, day, n) => db.prepare('SELECT count(*) AS n, count(a.player) AS k FROM players p LEFT JOIN active a ON a.player = p.id AND a.day = ?1 WHERE p.created >= ?2 AND p.created < ?3')
  .bind(day, (day - n) * DAY, (day - n + 1) * DAY);

// Writes yesterday's row on the first run after midnight UTC; a repeat replaces it with the same numbers.
export async function rollup(env, now) {
  if (new Date(now).getUTCHours() !== 0) return;
  const day = Math.floor(now / DAY) - 1;
  const [mine, dau, matches, d1, d7, d30] = await env.DB.batch([
    env.DB.prepare('SELECT count(*) AS n FROM players WHERE created >= ?1 AND created < ?2').bind(day * DAY, (day + 1) * DAY),
    env.DB.prepare('SELECT count(*) AS n FROM active WHERE day = ?').bind(day),
    env.DB.prepare("SELECT count(DISTINCT substr(ref, 1, length(ref) - 4)) AS n FROM chip_log WHERE reason = 'match' AND ref LIKE '%:out' AND at >= ?1 AND at < ?2").bind(day * DAY, (day + 1) * DAY),
    back(env.DB, day, 1),
    back(env.DB, day, 7),
    back(env.DB, day, 30)
  ]);
  const share = r => (r.results[0].n ? r.results[0].k / r.results[0].n : null);
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO stats (day, new, dau, d1, d7, d30, matches) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(day, mine.results[0].n, dau.results[0].n, share(d1), share(d7), share(d30), matches.results[0].n),
    env.DB.prepare('DELETE FROM active WHERE day < ?').bind(day - 60)
  ]);
}
