import { json, fail } from './account.js';

const KEYS = ['strong', 'chipsoff'];
const STRONG = ['100', '500', '2500', '10000', '50000', 'cup1000', 'cup5000', 'cup25000'];
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
<h2>Settings</h2><div id="settings"></div>
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
  const s = (await api('settings')).settings;
  $('settings').innerHTML = Object.keys(s).map(k => '<div><b>' + esc(k) + '</b><textarea rows="2" data-k="' + esc(k) + '">' + esc(s[k]) + '</textarea><button data-save="' + esc(k) + '">Save</button></div>').join('');
  const l = (await api('log')).log;
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
if (key) open();
</script></body></html>`;
