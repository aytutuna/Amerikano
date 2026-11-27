const DAY = 86400000;

// what a human's result at a table with computer players was, kept 90 days; one row per match and player
export function flowRow(db, o) {
  return db.prepare('INSERT OR IGNORE INTO persona_flow (match, player, day, kind, stake, sharp, fakes, humans, net, units, won, fake_net, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(o.match, o.player, Math.floor(o.at / DAY), o.kind, o.stake, o.sharp, o.fakes, o.humans, o.net, o.net / o.stake, o.won, o.fakeNet, o.at);
}

// rematches offered and taken, by people and by computer players, added to the day's total
export function rematches(db, kind, stake, o) {
  return db.prepare('INSERT INTO persona_day (day, kind, stake, rm_human, rm_human_yes, rm_fake, rm_fake_yes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (day, kind, stake) DO UPDATE SET rm_human = rm_human + ?4, rm_human_yes = rm_human_yes + ?5, rm_fake = rm_fake + ?6, rm_fake_yes = rm_fake_yes + ?7')
    .bind(Math.floor(Date.now() / DAY), kind, stake, o.human || 0, o.humanYes || 0, o.fake || 0, o.fakeYes || 0).run();
}

// The totals of a finished day are written once, from its rows, and stay when the rows are deleted with an account or after 90 days.
export async function dayTotals(env, now) {
  const today = Math.floor(now / DAY);
  await env.DB.prepare('INSERT INTO persona_day (day, kind, stake, matches, units, wins, fake_net) SELECT day, kind, stake, count(DISTINCT match), sum(units), sum(won), sum(fake_net) FROM persona_flow WHERE day >= ?1 AND day < ?2 GROUP BY day, kind, stake ON CONFLICT (day, kind, stake) DO UPDATE SET matches = excluded.matches, units = excluded.units, wins = excluded.wins, fake_net = excluded.fake_net WHERE persona_day.matches = 0')
    .bind(today - 7, today).run();
}

// per table over the last 14 days: matches, and the average result in units of the stake for the middle half of the players
export async function middle(env, now) {
  const { results } = await env.DB.prepare('SELECT kind, stake, player, count(*) AS n, avg(units) AS units, sum(sharp) AS sharp FROM persona_flow WHERE at > ? GROUP BY kind, stake, player').bind(now - 14 * DAY).all();
  const counts = await env.DB.prepare('SELECT kind, stake, count(DISTINCT match) AS n FROM persona_flow WHERE at > ? GROUP BY kind, stake').bind(now - 14 * DAY).all();
  const games = Object.fromEntries(counts.results.map(r => [r.kind + ' ' + r.stake, r.n]));
  const tables = {};
  for (const r of results) (tables[r.kind + ' ' + r.stake] = tables[r.kind + ' ' + r.stake] || []).push(r);
  return Object.entries(tables).map(([k, rows]) => {
    // each player counts once, by the average of their own matches
    const avg = rows.map(r => r.units).sort((a, b) => a - b);
    const q = Math.floor(avg.length / 4);
    const mid = avg.slice(q, avg.length - q);
    const results = rows.reduce((a, r) => a + r.n, 0);
    const [kind, stake] = k.split(' ');
    return { kind: kind, stake: Number(stake), matches: games[k], players: rows.length, mid: mid.reduce((a, b) => a + b, 0) / mid.length, sharp: rows.reduce((a, r) => a + r.sharp, 0) / results };
  }).sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.stake - b.stake);
}
