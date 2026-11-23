import { verify, who, json, fail } from './account.js';
import { rel } from './social.js';
import { clean, mask, contact } from './filter.js';

const DAY = 86400000;
const TEXT = 300;
const PAGE = 50;
const REPORTS = 20;
const ID = /^[0-9a-f]{32}$/;

const hub = env => env.HUB.get(env.HUB.idFromName('h'));

async function send(env, ctx, p, request) {
  let b = {};
  try { b = await request.json(); } catch (e) { /* no body */ }
  if (!ID.test(b.to)) return fail('id');
  const x = clean(b.text, TEXT);
  if (!x) return fail('text');
  if (!p.typed) return fail('typedoff', 403);
  if (p.mute_until > Date.now()) return fail('mute', 403);
  if (!await hub(env).talk(p.id)) return fail('slow', 429);
  // a stranger, a blocked player and one who blocked the sender all get the same answer
  if (await rel(env.DB, p.id, b.to) !== 'friend') return fail('nodm', 403);
  const q = await who(env.DB, b.to);
  if (!q || q.typed === 0) return fail('nodm', 403);
  // contact details are delivered only after the sender has agreed to a warning
  if (contact(x) && b.ok !== true) return fail('contact', 409);
  const text = mask(x, [p.lang, q.lang]);
  const at = Date.now();
  const r = await env.DB.prepare('INSERT INTO messages (sender, recipient, text, at) VALUES (?, ?, ?, ?)').bind(p.id, b.to, text, at).run();
  const m = { id: r.meta.last_row_id, text: text, c: contact(text), at: at };
  ctx.waitUntil(hub(env).dm(p.id, p.name_seed, b.to, m).catch(() => {}));
  return json({ message: Object.assign({ mine: true }, m) });
}

// the newest page, or the one before message `before`; the first page counts as read
async function thread(env, p, id, url) {
  if (!ID.test(id) || await rel(env.DB, p.id, id) !== 'friend') return fail('nodm', 403);
  const page = url.searchParams.get('before');
  if (page !== null && !/^\d{1,15}$/.test(page)) return fail('before');
  const before = page === null ? Number.MAX_SAFE_INTEGER : Number(page);
  const { results } = await env.DB.prepare('SELECT id, sender, text, at FROM messages WHERE ((sender = ?1 AND recipient = ?2) OR (sender = ?2 AND recipient = ?1)) AND id < ?3 ORDER BY id DESC LIMIT ?4')
    .bind(p.id, id, before, PAGE + 1).all();
  if (before === Number.MAX_SAFE_INTEGER) await env.DB.prepare('UPDATE messages SET seen = 1 WHERE recipient = ? AND sender = ? AND seen = 0').bind(p.id, id).run();
  return json({ more: results.length > PAGE, messages: results.slice(0, PAGE).map(r => ({ id: r.id, mine: r.sender === p.id, text: r.text, c: contact(r.text), at: r.at })) });
}

// A report keeps who, what and where: a table code, dm or profile. Three different reporters, each with an account at least a day
// old, within a week and since the last mute ended mute the reported player's typed chat for a day. A persona can be reported like anyone, so a report says nothing about who is one.
async function report(env, p, request) {
  let b = {};
  try { b = await request.json(); } catch (e) { /* no body */ }
  if (!ID.test(b.pid) || b.pid === p.id) return fail('id');
  if (!/^(dm|profile|[A-Z]{4})$/.test(b.ctx)) return fail('ctx');
  const q = await who(env.DB, b.pid);
  if (!q) return fail('nobody', 404);
  const now = Date.now();
  let text = clean(b.text, TEXT);
  // a message of a private conversation is read back from there, not taken from the reporter's word
  if (b.ctx === 'dm') {
    const m = Number.isInteger(b.mid) && await env.DB.prepare('SELECT text FROM messages WHERE id = ? AND sender = ? AND recipient = ?').bind(b.mid, b.pid, p.id).first();
    if (!m) return fail('nomsg', 404);
    text = m.text;
  }
  const sent = await env.DB.prepare('SELECT count(*) AS n FROM reports WHERE reporter = ? AND at > ?').bind(p.id, now - DAY).first();
  if (sent.n >= REPORTS) return fail('slow', 429);
  await env.DB.prepare('INSERT INTO reports (reporter, reported, text, ctx, at) VALUES (?, ?, ?, ?, ?)').bind(p.id, b.pid, text, b.ctx, now).run();
  const since = Math.max(now - 7 * DAY, q.mute_until || 0);
  const n = await env.DB.prepare('SELECT count(DISTINCT r.reporter) AS n FROM reports r JOIN players p ON p.id = r.reporter WHERE r.reported = ? AND r.at > ? AND p.created < ?').bind(b.pid, since, now - DAY).first();
  if (n.n >= 3) await env.DB.prepare('UPDATE players SET mute_until = ?1 WHERE id = ?2 AND mute_until < ?3').bind(now + DAY, b.pid, now).run();
  return json({ ok: true });
}

export async function chat(request, env, ctx) {
  const p = await verify(env.DB, (request.headers.get('Authorization') || '').replace(/^Bearer /, ''));
  if (!p) return fail('auth', 401);
  const url = new URL(request.url);
  const [, , what, arg] = url.pathname.split('/');
  const m = request.method;
  if (what === 'report' && m === 'POST') return report(env, p, request);
  if (what === 'dm' && m === 'POST' && !arg) return send(env, ctx, p, request);
  if (what === 'dm' && m === 'GET' && arg) return thread(env, p, arg, url);
  return fail('nope', 404);
}
