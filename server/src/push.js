import Names from '../../www/js/names.js';
import { unb64, b64 } from './apple.js';
import { reward } from './account.js';
import { week, simulate, decline } from './social.js';
import { rollup } from './stats.js';
import { setting } from './admin.js';
import { digest } from './mail.js';
import { dayTotals } from './flow.js';
import { notHeld, pairs } from './friend.js';
import more from './text.js';

const DAY = 86400000;
const TOPIC = 'com.aytutuna.amerikano';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const LIVE = { apns: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com', fcm: 'https://fcm.googleapis.com', token: 'https://oauth2.googleapis.com/token' };
const JWT_LIFE = 50 * 60000;
const SOON = 60000;
// subrequests a run may make, fetches and D1 calls alike; players the budget does not reach wait for the next run
const BUDGET = 900;
const QUIET = [22, 8];
// claiming players, reading their devices and handing back the ones that did not fit: at most 3 calls a round
const ROUND = 3;
// what one player is assumed to cost when choosing how many to claim
const GUESS = 4;
// what one device can cost at worst: two APNs tries and a write, or an FCM send and a drop
const WORST = 3;

// test servers are only honoured on a dev server, like APPLE_BASE
const at = (env, name, live) => (env.PACE && env[name]) || live;

const KIND = {
  invite: { col: 'push_invite', ttl: 600, gap: 600000, tap: v => ({ t: 'invite', code: v.code }) },
  req: { col: 'push_friend', ttl: 86400, gap: DAY, tap: () => ({ t: 'friend' }) },
  accept: { col: 'push_friend', ttl: 86400, gap: DAY, tap: () => ({ t: 'friend' }) },
  daily: { col: 'push_daily', ttl: 10800, tap: () => ({ t: 'daily' }) },
  week: { col: 'push_week', ttl: 86400, tap: () => ({ t: 'week' }) },
  dm: { col: 'push_dm', ttl: 86400, gap: 600000, tap: () => ({ t: 'dm' }) }
};

export const TEXT = {
  en: {
    invite: v => ['Table invite', Names.text(v.seed, 'en') + ' invited you to a table.'],
    req: v => ['Friend request', Names.text(v.seed, 'en') + ' wants to be your friend.'],
    accept: v => ['New friend', Names.text(v.seed, 'en') + ' accepted your friend request.'],
    dm: v => ['New message', Names.text(v.seed, 'en') + ' sent you a message.'],
    daily: v => ['Daily bonus', 'Your daily bonus of ' + v.n.toLocaleString('en') + ' chips is ready.'],
    week: v => ['Weekly leaderboard', 'You won ' + v.won.toLocaleString('en') + ' chips last week and finished #' + v.rank + '.']
  },
  tr: {
    invite: v => ['Masa daveti', Names.text(v.seed, 'tr') + ' seni bir masaya davet etti.'],
    req: v => ['Arkadaşlık isteği', Names.text(v.seed, 'tr') + ' seninle arkadaş olmak istiyor.'],
    accept: v => ['Yeni arkadaş', Names.text(v.seed, 'tr') + ' arkadaşlık isteğini kabul etti.'],
    dm: v => ['Yeni mesaj', Names.text(v.seed, 'tr') + ' sana bir mesaj gönderdi.'],
    daily: v => ['Günlük bonus', v.n.toLocaleString('tr') + ' çiplik günlük bonusun hazır.'],
    week: v => ['Haftalık sıralama', 'Geçen hafta ' + v.won.toLocaleString('tr') + ' çip kazandın ve sıralamada ' + v.rank + '. oldun.']
  }
};
Object.assign(TEXT, more);

const pem = s => unb64(s.replace(/-----[A-Z ]+-----|\s/g, ''));

async function sign(alg, key, head, claims) {
  const enc = o => b64(new TextEncoder().encode(JSON.stringify(o)));
  const data = enc(head) + '.' + enc(claims);
  return data + '.' + b64(await crypto.subtle.sign(alg, key, new TextEncoder().encode(data)));
}

// a cron run hands its budget to the senders through env; a push sent for a request has none
const spend = env => { if (env.bud) env.bud.left--; };

const drop = (env, token) => {
  spend(env);
  return env.DB.prepare('DELETE FROM devices WHERE token = ?').bind(token).run();
};

let apple = null;

async function apnsJwt(env) {
  if (apple && Date.now() - apple.at < JWT_LIFE) return apple.jwt;
  const key = await crypto.subtle.importKey('pkcs8', pem(env.APNS_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const jwt = await sign({ name: 'ECDSA', hash: 'SHA-256' }, key, { alg: 'ES256', kid: env.APNS_KEY_ID }, { iss: env.APPLE_TEAM, iat: Math.floor(Date.now() / 1000) });
  apple = { jwt: jwt, at: Date.now() };
  return jwt;
}

// Production first for a device not known to be a debug build. A token the wrong side calls bad is tried on the other
// side once and the answer is remembered; one both sides call bad is gone.
async function viaApns(env, d, m, tap, ttl) {
  if (!env.APNS_KEY || !env.APNS_KEY_ID) return false;
  const jwt = await apnsJwt(env);
  const hosts = [at(env, 'APNS_BASE', LIVE.apns), at(env, 'APNS_SANDBOX', LIVE.sandbox)];
  const body = JSON.stringify(Object.assign({ aps: { alert: { title: m[0], body: m[1] }, sound: 'default' } }, tap));
  let sand = !!d.sandbox;
  for (let i = 0; i < 2; i++, sand = !sand) {
    spend(env);
    const r = await fetch(hosts[+sand] + '/3/device/' + d.token, {
      method: 'POST',
      headers: { authorization: 'bearer ' + jwt, 'apns-topic': TOPIC, 'apns-push-type': 'alert', 'apns-expiration': String(Math.floor(Date.now() / 1000) + ttl) },
      body: body
    });
    if (r.ok) {
      if (sand !== !!d.sandbox) {
        spend(env);
        await env.DB.prepare('UPDATE devices SET sandbox = ? WHERE token = ?').bind(+sand, d.token).run();
      }
      return true;
    }
    const why = (await r.json().catch(() => ({}))).reason;
    if (why === 'BadDeviceToken' && i === 0) continue;
    if (r.status === 410 || why === 'BadDeviceToken') await drop(env, d.token);
    if (why === 'ExpiredProviderToken' || why === 'InvalidProviderToken') apple = null;
    return false;
  }
}

let google = null;

async function exchange(env) {
  const k = JSON.parse(env.FCM_KEY);
  const url = at(env, 'FCM_TOKEN_URL', LIVE.token);
  const key = await crypto.subtle.importKey('pkcs8', pem(k.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await sign('RSASSA-PKCS1-v1_5', key, { alg: 'RS256', typ: 'JWT' }, { iss: k.client_email, scope: SCOPE, aud: url, iat: now, exp: now + 3600 });
  spend(env);
  const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  if (!r.ok) throw new Error('google ' + r.status);
  return r.json();
}

// One exchange serves every send until shortly before it expires, including sends that start while it is in flight.
function bearer(env) {
  if (!google || google.exp < Date.now() + SOON) {
    const g = google = { exp: Infinity };
    g.token = exchange(env).then(d => {
      g.exp = Date.now() + d.expires_in * 1000;
      return d.access_token;
    }, e => {
      if (google === g) google = null;
      throw e;
    });
  }
  return google.token;
}

async function viaFcm(env, d, m, tap, ttl) {
  if (!env.FCM_KEY || !env.FCM_PROJECT) return false;
  const auth = await bearer(env);
  spend(env);
  const r = await fetch(at(env, 'FCM_BASE', LIVE.fcm) + '/v1/projects/' + env.FCM_PROJECT + '/messages:send', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token: d.token, notification: { title: m[0], body: m[1] }, data: tap, android: { priority: 'HIGH', ttl: ttl + 's' } } })
  });
  if (r.ok) return true;
  const e = (await r.json().catch(() => ({}))).error || {};
  const code = x => (e.details || []).some(y => y.errorCode === x);
  // a 400 is the token's fault only when FCM says so; a bad payload would otherwise drop every device
  if (code('UNREGISTERED') || r.status === 400 && e.status === 'INVALID_ARGUMENT' && code('INVALID_ARGUMENT') && /registration token/i.test(e.message || '') ||
    r.status === 403 && code('SENDER_ID_MISMATCH')) await drop(env, d.token);
  if (r.status === 401) google = null;
  return false;
}

// The devices of one player that want this kind of push.
export async function devices(env, id, k) {
  const { results } = await env.DB.prepare('SELECT d.token, d.kind, d.lang, d.sandbox, d.tz FROM devices d JOIN players p ON p.id = d.player WHERE d.player = ?1 AND p.push_on = 1 AND p.' + KIND[k].col + ' = 1').bind(id).all();
  return results;
}

// One push of this kind from one player to another per gap. The last one is kept in D1, so the gap outlives the hub.
export async function ring(env, from, to, k, v) {
  const now = Date.now();
  // invites and messages do not wake a phone at night; the lists in the app still show them
  const ds = (await devices(env, to, k)).filter(d => !(k === 'invite' || k === 'dm') || !asleep(now, d.tz));
  if (!ds.length) return;
  const r = await env.DB.prepare('INSERT INTO push_log (kind, sender, target, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (kind, sender, target) DO UPDATE SET at = ?4 WHERE at <= ?5')
    .bind(k, from, to, now, now - KIND[k].gap).run();
  if (r.meta.changes) await send(env, ds, k, v);
}

// whether the device's own clock reads a quiet hour; tz is minutes behind UTC
function asleep(now, tz) {
  const h = Math.floor(((now - tz * 60000) % DAY + DAY) % DAY / 3600000);
  return h >= QUIET[0] || h < QUIET[1];
}

// Pushes to these devices in each one's language and returns how many were taken. A sender without its key does nothing.
export async function send(env, ds, k, v) {
  const spec = KIND[k];
  const tap = spec.tap(v);
  const done = await Promise.all(ds.map(async d => {
    try {
      return await (d.kind === 'apns' ? viaApns : viaFcm)(env, d, ((TEXT[d.lang] || {})[k] || TEXT.en[k])(v), tap, spec.ttl);
    } catch (e) {
      return false;
    }
  }));
  return done.filter(Boolean).length;
}

// tz is minutes behind UTC, so a device's clock reads u - tz. These are the tz ranges, for the index, whose clock is
// in one of the n hours from h; the three shifts cover tz from -840 to 840.
function zone(now, h, n) {
  const u = Math.floor(now % DAY / 60000);
  return '(' + [-1, 0, 1].map(j => {
    const hi = u - 60 * h + 1440 * j;
    return '(tz > ' + (hi - 60 * n) + ' AND tz <= ' + hi + ')';
  }).join(' OR ') + ')';
}

async function inZone(env, ids, z) {
  spend(env);
  const { results } = await env.DB.prepare('SELECT player, token, kind, lang, sandbox FROM devices WHERE player IN (' + ids.map(() => '?').join() + ') AND ' + z).bind(...ids).all();
  return results;
}

// Claims players, as many as the rest of the budget can serve, with one statement that also marks them, so two runs never take
// the same player. Then sends to them one at a time. A player the budget turns out too small for is handed back unmarked.
async function serve(env, k, col, claim, z, value) {
  const bud = env.bud;
  while (bud.left >= ROUND + GUESS) {
    const n = Math.floor((bud.left - ROUND) / GUESS);
    spend(env);
    const { results } = await claim(n).all();
    if (!results.length) return;
    const ds = await inZone(env, results.map(p => p.id), z);
    const late = [];
    for (const p of results) {
      const mine = ds.filter(d => d.player === p.id);
      if (bud.left - 1 < WORST * mine.length + 1) late.push(p.id);
      else await send(env, mine, k, value(p));
    }
    if (late.length) {
      spend(env);
      await env.DB.prepare('UPDATE players SET ' + col + ' = 0 WHERE id IN (' + late.map(() => '?').join() + ')').bind(...late).run();
    }
    if (late.length || results.length < n) return;
  }
}

// the evening hours on the device's clock, from 18:00; a run that is late still lands inside them, and daily_sent keeps it to one push
async function dailies(env, now) {
  const z = zone(now, 18, 4);
  const sql = 'UPDATE players SET daily_sent = ?1 WHERE id IN (SELECT id FROM players WHERE id IN (SELECT player FROM devices WHERE ' + z +
    ') AND push_on = 1 AND push_daily = 1 AND daily_at < ?2 AND daily_sent < ?3 ORDER BY daily_sent LIMIT ?4) RETURNING id, daily_at, streak';
  await serve(env, 'daily', 'daily_sent', n => env.DB.prepare(sql).bind(now, Math.floor(now / DAY) * DAY, now - DAY / 2, n), z, p => ({ n: reward(p, now) }));
}

// what a player won in the finished week, which a win this week may already have moved to the prev columns
const fin = (a, w) => 'CASE WHEN ' + a + 'week = ' + w + ' THEN ' + a + 'week_won WHEN ' + a + 'prev_week = ' + w + ' THEN ' + a + 'prev_won ELSE 0 END';

// Monday morning on the device's clock, from 10:00. The hours after it are for zones where the UTC week has not turned yet
// at 10:00 and for a run that was missed; week_sent keeps it to one push.
async function weeklies(env, now) {
  const last = week(now) - 1;
  const z = zone(now, 10, 5) + ' AND (' + Math.floor(now) + ' - tz * 60000) / ' + DAY + ' % 7 = 4 AND (' + Math.floor(now) + ' - 4 * ' + DAY + ') / ' + 7 * DAY + ' = (' + Math.floor(now) + ' - tz * 60000 - 4 * ' + DAY + ') / ' + 7 * DAY;
  const sql = 'UPDATE players SET week_sent = ?1 WHERE id IN (SELECT id FROM players WHERE id IN (SELECT player FROM devices WHERE ' + z +
    ') AND push_on = 1 AND push_week = 1 AND week_sent < ?1 AND ' + fin('', '?1') + ' > 0 AND ' + notHeld('id') + ' ORDER BY week_sent LIMIT ?2) RETURNING id, ' + fin('', '?1') +
    ' AS won, (SELECT count(*) FROM players q WHERE q.week = ?1 AND q.week_won > ' + fin('players.', '?1') + ' AND ' + notHeld('q.id') +
    ') + (SELECT count(*) FROM players q WHERE q.prev_week = ?1 AND q.prev_won > ' + fin('players.', '?1') + ' AND ' + notHeld('q.id') +
    ') + (SELECT count(*) FROM personas q WHERE q.week = ?1 AND q.week_won > ' + fin('players.', '?1') +
    ') + (SELECT count(*) FROM personas q WHERE q.prev_week = ?1 AND q.prev_won > ' + fin('players.', '?1') + ') + 1 AS place';
  await serve(env, 'week', 'week_sent', n => env.DB.prepare(sql).bind(last, n), z, p => ({ won: p.won, rank: p.place }));
}

// the hourly jobs run on the first tick of the hour only
const hourly = now => new Date(now).getUTCMinutes() < 10;

async function cleanup(env, now) {
  if (new Date(now).getUTCHours() !== 3) return;
  spend(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM devices WHERE seen < ?').bind(now - 90 * DAY),
    env.DB.prepare('DELETE FROM push_log WHERE at < ?').bind(now - DAY),
    env.DB.prepare('DELETE FROM messages WHERE at < ?').bind(now - 30 * DAY),
    env.DB.prepare('DELETE FROM reports WHERE at < ?1 AND reporter NOT IN (SELECT player FROM kept) AND reported NOT IN (SELECT player FROM kept)').bind(now - 180 * DAY),
    env.DB.prepare('DELETE FROM match_seat WHERE at < ? AND player NOT IN (SELECT player FROM kept)').bind(now - 35 * DAY),
    env.DB.prepare('DELETE FROM leaves WHERE at < ? AND player NOT IN (SELECT player FROM kept)').bind(now - 35 * DAY),
    env.DB.prepare('DELETE FROM trade_hits WHERE at < ? AND player NOT IN (SELECT player FROM kept)').bind(now - 90 * DAY),
    env.DB.prepare('DELETE FROM persona_flow WHERE at < ?').bind(now - 90 * DAY),
    env.DB.prepare('DELETE FROM mail_log WHERE at < ?').bind(now - 7 * DAY),
    env.DB.prepare('DELETE FROM friend_day WHERE day < ?').bind(Math.floor(now / DAY) - 2),
    env.DB.prepare("DELETE FROM held WHERE state <> 'held' AND done < ?").bind(now - 35 * DAY)
  ]);
  // the records behind a ban stay for a year after the banned account was deleted
  const due = 'SELECT player FROM kept WHERE until < ?1';
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chip_log WHERE player IN (' + due + ')').bind(now),
    env.DB.prepare('DELETE FROM reports WHERE reporter IN (' + due + ') OR reported IN (' + due + ')').bind(now),
    env.DB.prepare('DELETE FROM match_seat WHERE player IN (' + due + ')').bind(now),
    env.DB.prepare('DELETE FROM leaves WHERE player IN (' + due + ')').bind(now),
    env.DB.prepare('DELETE FROM trade_hits WHERE player IN (' + due + ')').bind(now),
    env.DB.prepare('DELETE FROM flags WHERE a IN (' + due + ') OR b IN (' + due + ')').bind(now),
    env.DB.prepare('DELETE FROM kept WHERE until < ? AND hash IS NULL').bind(now)
  ]);
}

export async function cron(env, now) {
  // a test can name a small budget through a settings row, to see the run stop short
  const small = env.PACE && env.DB && await setting(env.DB, 'pushbudget');
  const run = Object.assign({}, env, { bud: { left: small ? Number(small) : BUDGET } });
  const keys = !!(env.APNS_KEY && env.APNS_KEY_ID) || !!(env.FCM_KEY && env.FCM_PROJECT);
  // weeklies first, as they only have work on Mondays; one failing job does not stop the others. The daily push is tried on
  // every tick, so a crowd that does not fit one run is served by the next within its window.
  const jobs = hourly(now) ? [rollup, dayTotals, simulate, decline, pairs, cleanup, digest, ...keys ? [weeklies] : []] : [];
  if (keys) jobs.push(dailies);
  for (const job of jobs) {
    try {
      await job(run, now);
    } catch (e) {
      console.error('cron', job.name, e);
    }
  }
}
