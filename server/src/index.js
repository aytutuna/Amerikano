import { Room, freeCode } from './room.js';
import { Hub } from './hub.js';
import { api } from './account.js';
import { social } from './social.js';

export { Room, Hub };

const ORIGIN = /^(https:\/\/([a-z0-9-]+\.)?amerikano\.pages\.dev|https?:\/\/localhost(:\d+)?|capacitor:\/\/localhost|http:\/\/127\.0\.0\.1(:\d+)?)$/;
const SOCIAL = /^\/api\/(friends?|block|player|top)(\/|$)/;

async function account(request, env, origin) {
  const cors = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin'
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const res = await (SOCIAL.test(new URL(request.url).pathname) ? social : api)(request, env);
  for (const k in cors) res.headers.set(k, cors[k]);
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (origin && !ORIGIN.test(origin)) return new Response('forbidden', { status: 403 });
    if (url.pathname.startsWith('/api/')) return account(request, env, origin);
    const m = url.pathname.match(/^\/ws\/(new|hub|[A-Z]{4})$/);
    if (!m || request.headers.get('Upgrade') !== 'websocket') return new Response('not found', { status: 404 });
    if (m[1] === 'hub') return env.HUB.get(env.HUB.idFromName('h')).fetch(request);
    let code = m[1];
    if (code === 'new') {
      code = await freeCode(env.ROOM);
      if (!code) return new Response('busy', { status: 503 });
      url.pathname = '/ws/' + code;
    }
    return env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(url, request));
  }
};
