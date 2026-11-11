import { DurableObject } from 'cloudflare:workers';
import { freeCode } from './room.js';

const WAIT = 20000;

export class Quick extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.k = Number(env.PACE) || 1;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ at: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 200) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || m.t !== 'quick' || ws.deserializeAttachment().at) return;
    ws.serializeAttachment({ at: Date.now() });
    await this.fill();
  }

  async webSocketClose() {
    await this.fill();
  }

  async alarm() {
    await this.fill();
  }

  waiting() {
    return this.ctx.getWebSockets()
      .filter(w => w.readyState === 1 && w.deserializeAttachment().at)
      .sort((a, b) => a.deserializeAttachment().at - b.deserializeAttachment().at);
  }

  // The awaits below let other events in, so runs are chained to keep one group from matching twice.
  fill() {
    const run = (this.busy || Promise.resolve()).then(() => this.match());
    this.busy = run.catch(() => {});
    return run;
  }

  async open(k) {
    for (let i = 0; i < 3; i++) {
      const code = await freeCode(this.env.ROOM);
      if (!code) break;
      const seats = await this.env.ROOM.get(this.env.ROOM.idFromName(code)).openPublic(code, k);
      if (seats) return { code, seats };
    }
    return null;
  }

  async match() {
    let w = this.waiting();
    const old = () => Date.now() - w[0].deserializeAttachment().at >= WAIT * this.k;
    while (w.length >= 4 || (w.length >= 2 && old())) {
      const group = w.slice(0, 4);
      const room = await this.open(group.length);
      if (!room) break;
      w = w.slice(4);
      group.forEach((ws, i) => {
        try {
          ws.send(JSON.stringify({ t: 'matched', code: room.code, seat: room.seats[i].seat, token: room.seats[i].token }));
          ws.close(1000, 'matched');
        } catch (e) {}
      });
    }
    w = w.filter(ws => ws.readyState === 1);
    for (const ws of w) ws.send(JSON.stringify({ t: 'queue', n: w.length }));
    if (w.length) {
      const due = w[0].deserializeAttachment().at + WAIT * this.k;
      await this.ctx.storage.setAlarm(Math.max(due, Date.now() + 1000 * this.k));
    } else await this.ctx.storage.deleteAlarm();
  }
}
