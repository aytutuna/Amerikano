import { Room, freeCode, stub } from './room.js';
import { Hub } from './hub.js';
import { api } from './account.js';
import { social } from './social.js';
import { chat } from './chat.js';
import { voice } from './voice.js';
import { shop } from './shop.js';
import { cron } from './push.js';
import { admin } from './admin.js';
import { peer } from './peer.js';

export { Room, Hub };

const ORIGIN = /^(https:\/\/([a-z0-9-]+\.)?amerikano\.pages\.dev|https?:\/\/localhost(:\d+)?|capacitor:\/\/localhost|http:\/\/127\.0\.0\.1(:\d+)?)$/;
const SOCIAL = /^\/api\/(friends?|block|player|top)(\/|$)/;
const VOICE = /^\/api\/voice\//;
const CHAT = /^\/api\/(dm|report)(\/|$)/;
const SHOP = /^\/api\/(shop|rc)(\/|$)/;

async function account(request, env, ctx, origin) {
  const cors = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin'
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const path = new URL(request.url).pathname;
  const res = await (SOCIAL.test(path) ? social : CHAT.test(path) ? chat : VOICE.test(path) ? voice : SHOP.test(path) ? shop : api)(request, env, ctx);
  for (const k in cors) res.headers.set(k, cors[k]);
  return res;
}

export default {
  async scheduled(event, env) {
    await cron(env, event.scheduledTime);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    // the admin page talks to its own Worker only
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return origin && origin !== url.origin ? new Response('forbidden', { status: 403 }) : admin(request, env);
    if (origin && !ORIGIN.test(origin)) return new Response('forbidden', { status: 403 });
    if (url.pathname.startsWith('/api/')) return account(request, env, ctx, origin);
    const m = url.pathname.match(/^\/ws\/(new|hub|[A-Z]{4})$/);
    if (!m || request.headers.get('Upgrade') !== 'websocket') return new Response('not found', { status: 404 });
    const ip = peer(request, env);
    // a test that sends no address is not limited
    if (ip || !env.PACE) {
      if (env.SOCKETS && !(await env.SOCKETS.limit({ key: ip })).success) return new Response('slow', { status: 429 });
      if (m[1] === 'new' && env.NEWCODES && !(await env.NEWCODES.limit({ key: ip })).success) return new Response('slow', { status: 429 });
    }
    // what a client sends under these names is never believed: the address is ours, and only a code made here may be created
    const forward = (to, made) => {
      const r = new Request(to, request);
      r.headers.delete('X-Amk-New');
      r.headers.set('X-Amk-Addr', ip);
      if (made) r.headers.set('X-Amk-New', '1');
      return r;
    };
    if (m[1] === 'hub') return env.HUB.get(env.HUB.idFromName('h')).fetch(forward(request.url));
    let code = m[1];
    if (code === 'new') {
      code = await freeCode(env.ROOM);
      if (!code) return new Response('busy', { status: 503 });
      url.pathname = '/ws/' + code;
    }
    return stub(env.ROOM, code).fetch(forward(url, m[1] === 'new'));
  }
};
