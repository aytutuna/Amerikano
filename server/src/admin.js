import { json, fail, credit } from './account.js';

const KEYS = ['strong', 'chipsoff'];
const STRONG = ['100', '500', '2500', '10000', '50000', 'cup1000', 'cup5000', 'cup25000'];
const ID = /^[0-9a-f]{32}$/;
const DAY = 86400000;
const enc = s => new TextEncoder().encode(s);

export async function setting(db, key) {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? r.value : null;
}

export function logAdmin(db, who, action, target, detail) {
  return db.prepare('INSERT INTO admin_log (at, who, action, target, detail) VALUES (?, ?, ?, ?, ?)').bind(Date.now(), who, action, target || null, detail === undefined ? null : JSON.stringify(detail)).run();
}

// the strong-seat ladder is an object with a whole number per table, the chips-off list a comma list of country codes
function valid(key, value) {
  if (typeof value !== 'string') return false;
  if (key === 'chipsoff') return /^([A-Z]{2}(,[A-Z]{2})*)?$/.test(value);
  try {
    const o = JSON.parse(value);
    return !!o && typeof o === 'object' && Object.keys(o).length === STRONG.length && STRONG.every(k => Number.isInteger(o[k]) && o[k] >= 0 && o[k] <= 9);
  } catch (e) {
    return false;
  }
}

async function same(a, b) {
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

async function settings(request, env) {
  const db = env.DB;
  if (request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!KEYS.includes(b.key) || !valid(b.key, b.value)) return fail('setting');
    const before = await setting(db, b.key);
    await db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2').bind(b.key, b.value).run();
    await logAdmin(db, 'admin', 'setting', b.key, { from: before, to: b.value });
  }
  const rows = await db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  return json({ settings: Object.fromEntries(rows.results.map(r => [r.key, r.value])) });
}

async function log(env) {
  const rows = await env.DB.prepare('SELECT id, at, who, action, target, detail FROM admin_log ORDER BY id DESC LIMIT 200').all();
  return json({ log: rows.results });
}

// who left public tables over the last week, most first, with what is still on them
async function leavers(env) {
  const now = Date.now();
  const rows = await env.DB.prepare('SELECT l.player AS id, count(*) AS n, max(l.at) AS last, p.name_seed AS seed, p.cool_until AS cool, p.cool_stake AS stake FROM leaves l LEFT JOIN players p ON p.id = l.player WHERE l.at > ? GROUP BY l.player ORDER BY n DESC, last DESC LIMIT 100').bind(now - 7 * 86400000).all();
  return json({ leavers: rows.results });
}


// newest first, with whether each counted, what its reporter has finished and whether the reported seat is a computer player
async function reports(env) {
  const rows = await env.DB.prepare('SELECT r.id, r.at, r.reporter, r.reported, r.ctx, r.match, r.counts, r.text, (SELECT games FROM players WHERE id = r.reporter) AS games, EXISTS (SELECT 1 FROM personas WHERE id = r.reported) AS fake, (SELECT mute_until FROM players WHERE id = r.reported) AS mute, (SELECT banned FROM players WHERE id = r.reported) AS banned FROM reports r ORDER BY r.id DESC LIMIT 200').all();
  return json({ reports: rows.results });
}

// what the page shows, in one call: its tries are limited per address
async function overview(request, env) {
  const parts = await Promise.all([settings(request, env), log(env), leavers(env), reports(env)]);
  return json(Object.assign({}, ...await Promise.all(parts.map(r => r.json()))));
}

async function find(db, id) {
  return ID.test(id) ? db.prepare('SELECT id, mute_until, banned FROM players WHERE id = ?').bind(id).first() : null;
}

async function mute(env, b, on) {
  const p = await find(env.DB, b.id);
  if (!p) return fail('nobody', 404);
  const hours = b.hours === undefined ? 24 : b.hours;
  if (on && !(Number.isInteger(hours) && hours >= 1 && hours <= 720)) return fail('hours');
  const until = on ? Date.now() + hours * 3600000 : 0;
  await env.DB.prepare('UPDATE players SET mute_until = ? WHERE id = ?').bind(until, p.id).run();
  await logAdmin(env.DB, 'admin', on ? 'mute' : 'unmute', p.id, on ? { until: until } : undefined);
  return json({ ok: true });
}

// The account is shut out everywhere: sessions and devices go, the hub closes its sockets and a started match settles the seat
// as for a leaver. Only the account is banned, nothing about its address or its purchases.
async function ban(env, b) {
  const p = await find(env.DB, b.id);
  if (!p) return fail('nobody', 404);
  if (p.banned) return json({ ok: true });
  const now = Date.now();
  const why = typeof b.why === 'string' ? b.why.slice(0, 200) : null;
  await env.DB.batch([
    env.DB.prepare('UPDATE players SET banned = 1, banned_why = ?, banned_at = ? WHERE id = ?').bind(why, now, p.id),
    env.DB.prepare('DELETE FROM sessions WHERE player = ?').bind(p.id),
    env.DB.prepare('DELETE FROM devices WHERE player = ?').bind(p.id)
  ]);
  await logAdmin(env.DB, 'admin', 'ban', p.id, { why: why });
  await env.HUB.get(env.HUB.idFromName('h')).drop(p.id, null).catch(() => {});
  // the tables it is still seated at: a started match without a result or a leave
  const { results } = await env.DB.prepare('SELECT DISTINCT code FROM match_seat WHERE player = ? AND net IS NULL AND gone = 0 AND at > ?').bind(p.id, now - 3 * 3600000).all();
  for (const x of results) await env.ROOM.get(env.ROOM.idFromName(x.code)).ban(p.id).catch(() => {});
  return json({ ok: true });
}

async function unban(env, b) {
  const p = await find(env.DB, b.id);
  if (!p) return fail('nobody', 404);
  await env.DB.prepare('UPDATE players SET banned = 0, banned_why = NULL, banned_at = NULL WHERE id = ?').bind(p.id).run();
  await logAdmin(env.DB, 'admin', 'unban', p.id);
  return json({ ok: true });
}

async function unsay(env, b) {
  if (!Number.isInteger(b.id)) return fail('id');
  const r = await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(b.id).run();
  if (r.meta.changes !== 1) return fail('nomsg', 404);
  await logAdmin(env.DB, 'admin', 'unsay', String(b.id));
  return json({ ok: true });
}

// through the one chip function; the same ref twice changes nothing, and a balance cannot go below zero
async function balance(env, b) {
  const p = await find(env.DB, b.id);
  if (!p) return fail('nobody', 404);
  if (!Number.isInteger(b.delta) || !b.delta || Math.abs(b.delta) > 1e9) return fail('delta');
  if (typeof b.ref !== 'string' || !/^[\w.-]{1,40}$/.test(b.ref)) return fail('ref');
  const ref = 'admin:' + b.ref;
  const done = await env.DB.prepare('SELECT 1 FROM chip_log WHERE player = ? AND ref = ?').bind(p.id, ref).first();
  if (!done && !await credit(env.DB, p.id, b.delta, 'admin', ref)) return fail('below', 409);
  if (!done) await logAdmin(env.DB, 'admin', 'balance', p.id, { delta: b.delta, ref: ref });
  return json({ ok: true });
}

async function body(request) {
  const b = await request.json().catch(() => null);
  return b && typeof b === 'object' ? b : {};
}

export async function admin(request, env) {
  if (!env.ADMIN_KEY) return new Response('not set up', { status: 503 });
  const path = new URL(request.url).pathname;
  if (path === '/admin') return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (!path.startsWith('/admin/api/')) return new Response('not found', { status: 404 });
  // every call counts, so the key cannot be tried faster than this
  if (env.ADMIN && !(await env.ADMIN.limit({ key: request.headers.get('CF-Connecting-IP') || '' })).success) return fail('slow', 429);
  if (!await same((request.headers.get('Authorization') || '').replace(/^Bearer /, ''), env.ADMIN_KEY)) return fail('auth', 401);
  if (path === '/admin/api/settings') return settings(request, env);
  if (path === '/admin/api/log' && request.method === 'GET') return log(env);
  if (path === '/admin/api/leavers' && request.method === 'GET') return leavers(env);
  if (path === '/admin/api/reports' && request.method === 'GET') return reports(env);
  if (path === '/admin/api/overview' && request.method === 'GET') return overview(request, env);
  if (request.method === 'POST') {
    const act = { mute: b => mute(env, b, true), unmute: b => mute(env, b, false), ban: b => ban(env, b), unban: b => unban(env, b), unsay: b => unsay(env, b), balance: b => balance(env, b) }[path.slice(11)];
    if (act) return act(await body(request));
  }
  return fail('nope', 404);
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin</title>
<style>
body{font:15px system-ui,sans-serif;margin:0;padding:12px;background:#f4f1ea;color:#222}
h2{margin:18px 0 6px;font-size:17px}
input,textarea,button{font:inherit;padding:8px;box-sizing:border-box}
textarea,input{width:100%;margin:4px 0}
button{background:#2b5d3a;color:#fff;border:0;border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-bottom:1px solid #ccc;padding:4px;text-align:left;vertical-align:top;word-break:break-all}
.err{color:#a00}
</style></head><body>
<h1>Admin</h1>
<div id="msg" class="err"></div>
<div id="in"><input id="key" type="password" placeholder="Key"><button id="go">Open</button></div>
<div id="main" hidden>
<h2>Reports</h2><table id="reports"></table>
<h2>Player</h2>
<input id="pid" placeholder="Player id">
<button data-do="mute">Mute 24 h</button> <button data-do="unmute">Unmute</button> <button data-do="ban">Ban</button> <button data-do="unban">Unban</button>
<input id="amount" placeholder="Chips to add or take (negative)" inputmode="numeric">
<input id="ref" placeholder="Reference, one use only">
<button data-do="balance">Correct balance</button>
<input id="mid" placeholder="Message id" inputmode="numeric">
<button data-do="unsay">Delete message</button>
<h2>Settings</h2><div id="settings"></div>
<h2>Leavers, last 7 days</h2><table id="leavers"></table>
<h2>Log</h2><table id="log"></table>
</div>
<script>
const $ = id => document.getElementById(id);
let key = sessionStorage.getItem('adminKey');
async function api(path, body) {
  const r = await fetch('/admin/api/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => '&#' + c.charCodeAt(0) + ';'); }
async function show() {
  $('msg').textContent = '';
  const o = await api('overview');
  const s = o.settings;
  $('settings').innerHTML = Object.keys(s).map(k => '<div><b>' + esc(k) + '</b><textarea rows="2" data-k="' + esc(k) + '">' + esc(s[k]) + '</textarea><button data-save="' + esc(k) + '">Save</button></div>').join('');
  const rp = o.reports;
  $('reports').innerHTML = '<tr><th>Report</th><th>Reporter</th><th>Reported</th><th>Where</th><th>Counted</th></tr>' + rp.map(x => '<tr><td>' + x.id + '<br>' + new Date(x.at).toISOString().slice(0, 16).replace('T', ' ') + '<br>' + esc(x.text) + '</td><td data-id="' + esc(x.reporter) + '">' + esc(x.reporter) + '<br>' + (x.games == null ? 'gone' : x.games + ' matches') + '</td><td data-id="' + esc(x.reported) + '">' + esc(x.reported) + (x.fake ? '<br>computer player' : '') + (x.banned ? '<br>banned' : x.mute > Date.now() ? '<br>muted' : '') + '</td><td>' + esc(x.ctx) + '</td><td>' + (x.counts ? 'yes' : 'no') + '</td></tr>').join('');
  const v = o.leavers;
  $('leavers').innerHTML = '<tr><th>Player</th><th>Leaves</th><th>Last</th><th>Cooling until</th></tr>' + v.map(x => '<tr><td>' + esc(x.id) + '</td><td>' + x.n + '</td><td>' + new Date(x.last).toISOString().slice(0, 16).replace('T', ' ') + '</td><td>' + (x.cool > Date.now() ? new Date(x.cool).toISOString().slice(0, 16).replace('T', ' ') + ' from ' + x.stake : '') + '</td></tr>').join('');
  const l = o.log;
  $('log').innerHTML = '<tr><th>Time</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr>' + l.map(x => '<tr><td>' + new Date(x.at).toISOString().slice(0, 16).replace('T', ' ') + '</td><td>' + esc(x.who) + '</td><td>' + esc(x.action) + '</td><td>' + esc(x.target) + '</td><td>' + esc(x.detail) + '</td></tr>').join('');
}
async function open() {
  try {
    await show();
    sessionStorage.setItem('adminKey', key);
    $('in').hidden = true;
    $('main').hidden = false;
  } catch (e) {
    sessionStorage.removeItem('adminKey');
    $('in').hidden = false;
    $('msg').textContent = e.message;
  }
}
$('go').onclick = () => { key = $('key').value; open(); };
$('settings').onclick = async e => {
  const k = e.target.dataset.save;
  if (!k) return;
  try {
    await api('settings', { key: k, value: document.querySelector('textarea[data-k="' + k + '"]').value.trim() });
    await show();
  } catch (err) {
    $('msg').textContent = 'Not saved: ' + err.message;
  }
};
$('reports').onclick = e => {
  const id = e.target.closest('td[data-id]');
  if (id) $('pid').value = id.dataset.id;
};
document.querySelector('[data-do=mute]').parentNode.addEventListener('click', async e => {
  const what = e.target.dataset.do;
  if (!what) return;
  const body = what === 'unsay' ? { id: Number($('mid').value) } : { id: $('pid').value.trim() };
  if (what === 'balance') Object.assign(body, { delta: Number($('amount').value), ref: $('ref').value.trim() });
  if (what === 'ban') body.why = prompt('Why?') || undefined;
  try {
    await api(what, body);
    $('msg').textContent = '';
    await show();
  } catch (err) {
    $('msg').textContent = what + ': ' + err.message;
  }
});
if (key) open();
</script></body></html>`;
