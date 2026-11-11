import { Room, freeCode } from './room.js';
import { Quick } from './quick.js';

export { Room, Quick };

const ORIGIN = /^(https:\/\/([a-z0-9-]+\.)?amerikano\.pages\.dev|https?:\/\/localhost(:\d+)?|capacitor:\/\/localhost|http:\/\/127\.0\.0\.1(:\d+)?)$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/(new|quick|[A-Z]{4})$/);
    if (!m || request.headers.get('Upgrade') !== 'websocket') return new Response('not found', { status: 404 });
    const origin = request.headers.get('Origin');
    if (origin && !ORIGIN.test(origin)) return new Response('forbidden', { status: 403 });
    if (m[1] === 'quick') return env.QUICK.get(env.QUICK.idFromName('q')).fetch(request);
    let code = m[1];
    if (code === 'new') {
      code = await freeCode(env.ROOM);
      if (!code) return new Response('busy', { status: 503 });
      url.pathname = '/ws/' + code;
    }
    return env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(url, request));
  }
};
