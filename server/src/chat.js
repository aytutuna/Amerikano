import { verify, json, fail } from './account.js';
import { rel, unread } from './social.js';
import { typed } from './filter.js';

const TEXT = 300;
const PAGE = 50;
const ID = /^[0-9a-f]{32}$/;

const hub = env => env.HUB.get(env.HUB.idFromName('h'));

async function send(env, ctx, p, request) {
  let b = {};
  try { b = await request.json(); } catch (e) { /* no body */ }
  if (!ID.test(b.to)) return fail('id');
  const x = typed(b.text, TEXT);
  if (!x) return fail('text');
  if (!await hub(env).talk(p.id)) return fail('slow', 429);
  // a stranger, a blocked player and one who blocked the sender all get the same answer
  if (await rel(env.DB, p.id, b.to) !== 'friend') return fail('nodm', 403);
  const at = Date.now();
  const r = await env.DB.prepare('INSERT INTO messages (sender, recipient, text, at) VALUES (?, ?, ?, ?)').bind(p.id, b.to, x, at).run();
  const m = { id: r.meta.last_row_id, text: x, at: at };
  ctx.waitUntil(hub(env).dm(p.id, p.name_seed, b.to, m).catch(() => {}));
  return json({ message: Object.assign({ mine: true }, m) });
}

// the newest page, or the one before message `before`; the first page counts as read
async function thread(env, p, id, url) {
  if (!ID.test(id) || await rel(env.DB, p.id, id) !== 'friend') return fail('nodm', 403);
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare('SELECT id, sender, text, at FROM messages WHERE ((sender = ?1 AND recipient = ?2) OR (sender = ?2 AND recipient = ?1)) AND id < ?3 ORDER BY id DESC LIMIT ?4')
    .bind(p.id, id, before, PAGE + 1).all();
  if (before === Number.MAX_SAFE_INTEGER) await env.DB.prepare('UPDATE messages SET seen = 1 WHERE recipient = ? AND sender = ? AND seen = 0').bind(p.id, id).run();
  return json({ more: results.length > PAGE, messages: results.slice(0, PAGE).map(r => ({ id: r.id, mine: r.sender === p.id, text: r.text, at: r.at })) });
}

export async function chat(request, env, ctx) {
  const p = await verify(env.DB, (request.headers.get('Authorization') || '').replace(/^Bearer /, ''));
  if (!p) return fail('auth', 401);
  const url = new URL(request.url);
  const [, , what, arg] = url.pathname.split('/');
  const m = request.method;
  if (what === 'dm' && m === 'POST' && !arg) return send(env, ctx, p, request);
  if (what === 'dm' && m === 'GET' && arg) return thread(env, p, arg, url);
  if (what === 'dm' && m === 'GET') return json({ unread: await unread(env.DB, p.id) });
  return fail('nope', 404);
}
