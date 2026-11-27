import { verify, denied, player, json, fail } from './account.js';
import { rel } from './social.js';
import { hint } from './region.js';

const SFU = 'https://rtc.live.cloudflare.com/v1';
const BURST = 30;
const EVERY = 1000;
const SDP = 10000;
const ID = /^[0-9a-f]{32}$/;
const OPS = ['who', 'mic', 'stop', 'pull', 'answer'];

export const on = env => !!env.REALTIME_APP_ID;

const out = (body, status) => ({ status: status || 200, body: body });

// PACE only exists on a dev server, so a stray RTC_BASE can never point production at another SFU
async function sfu(env, method, path, body) {
  const root = (env.PACE && env.RTC_BASE) || SFU;
  const r = await fetch(root + '/apps/' + env.REALTIME_APP_ID + path, {
    method: method,
    headers: { Authorization: 'Bearer ' + env.REALTIME_APP_TOKEN, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.errorCode || (j.tracks || []).some(t => t.errorCode)) throw new Error('sfu ' + r.status);
  return j;
}

// a burst of requests, then one a second; the map is the caller's, so it lives as long as the object does
export function slow(map, pid) {
  const now = Date.now();
  if (map.size > 1000) map.clear();
  const b = map.get(pid) || { n: BURST, at: now };
  b.n = Math.min(BURST, b.n + (now - b.at) / EVERY);
  b.at = now;
  map.set(pid, b);
  if (b.n < 1) return true;
  b.n--;
  return false;
}

// both have voice on and neither blocked the other; a call also needs them to be friends
export async function may(db, a, b, friends) {
  const { results } = await db.prepare('SELECT voice FROM players WHERE id IN (?1, ?2)').bind(a, b).all();
  if (results.length !== 2 || results.some(r => !r.voice)) return false;
  const k = await rel(db, a, b);
  return friends ? k === 'friend' : k !== 'block' && k !== 'blocked';
}

// closes a published track; the SFU drops it by itself once the connection is gone, so a failure does not matter
export async function shut(env, e) {
  if (!e.sid) return;
  const sid = e.sid;
  const mid = e.mid;
  delete e.sid;
  delete e.name;
  delete e.mid;
  await sfu(env, 'PUT', '/sessions/' + sid + '/tracks/close', { tracks: [{ mid: mid }], force: true }).catch(() => {});
}

const audio = sdp => typeof sdp === 'string' && sdp.length <= SDP && (sdp.match(/^m=/gm) || []).length === 1 && /^m=audio /m.test(sdp);

// One step of the voice exchange for a table or a call. st maps a player to what they published ({sid, name, mid}) and to the
// session they listen through ({sub}). The names of tracks are made here, so a client never learns or sends another's; ok(pid)
// says whether the caller may hear that player.
export async function act(env, st, op, pid, b, ok) {
  const me = st[pid] || (st[pid] = {});
  try {
    if (op === 'who') {
      const pids = [];
      for (const q of Object.keys(st)) if (q !== pid && st[q].name && await ok(q)) pids.push(q);
      return out({ pids: pids });
    }
    if (op === 'stop') {
      await shut(env, me);
      return out({});
    }
    if (op === 'mic') {
      if (!audio(b.sdp) || !/^\d{1,3}$/.test(b.mid)) return out({ error: 'sdp' }, 400);
      await shut(env, me);
      const s = await sfu(env, 'POST', '/sessions/new');
      const name = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
      const r = await sfu(env, 'POST', '/sessions/' + s.sessionId + '/tracks/new', {
        sessionDescription: { type: 'offer', sdp: b.sdp },
        tracks: [{ location: 'local', mid: b.mid, trackName: name }]
      });
      Object.assign(me, { sid: s.sessionId, name: name, mid: b.mid });
      return out({ sdp: r.sessionDescription.sdp });
    }
    if (op === 'pull') {
      const e = ID.test(b.pid) && b.pid !== pid && st[b.pid];
      if (!e || !e.name || !await ok(b.pid)) return out({ error: 'none' }, 404);
      if (!me.sub || b.fresh === true) me.sub = (await sfu(env, 'POST', '/sessions/new')).sessionId;
      const r = await sfu(env, 'POST', '/sessions/' + me.sub + '/tracks/new', { tracks: [{ location: 'remote', sessionId: e.sid, trackName: e.name }] });
      return out({ sdp: r.sessionDescription && r.sessionDescription.sdp, mid: r.tracks[0].mid, pid: b.pid });
    }
    // the answer carries a section for every track pulled so far
    if (!me.sub || typeof b.sdp !== 'string' || b.sdp.length > 5 * SDP) return out({ error: 'sdp' }, 400);
    await sfu(env, 'PUT', '/sessions/' + me.sub + '/renegotiate', { sessionDescription: { type: 'answer', sdp: b.sdp } });
    return out({});
  } catch (e) {
    return out({ error: 'sfu' }, 502);
  }
}

// The Worker holds the SFU token and passes every call through, to the table's room or to the hub for a call, which decide who may do what.
export async function voice(request, env) {
  if (!on(env) || request.method !== 'POST') return fail('nope', 404);
  const p = await verify(env.DB, (request.headers.get('Authorization') || '').replace(/^Bearer /, ''));
  if (!p) return denied(env.DB, request);
  const op = new URL(request.url).pathname.split('/')[3];
  if (!OPS.includes(op)) return fail('nope', 404);
  let b = null;
  try { b = await request.json(); } catch (e) { /* no body */ }
  if (!b || typeof b !== 'object') b = {};
  let r;
  if (b.scope === 'table' && /^[A-Z]{4}$/.test(b.code)) r = await env.ROOM.get(env.ROOM.idFromName(b.code), hint(b.code)).vox(p.id, op, b);
  else if (b.scope === 'call' && typeof b.id === 'string') r = await env.HUB.get(env.HUB.idFromName('h')).vox(p.id, op, b);
  else return fail('scope');
  return json(r.body, r.status);
}
