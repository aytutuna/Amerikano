import { DurableObject } from 'cloudflare:workers';
import { freeCode } from './room.js';
import { verify, player, seat, STAKES, ENTRY } from './account.js';
import { rel } from './social.js';

const LIFE = 3 * 3600000;

const people =(tables, stake) => tables.filter(t => t.stake === stake).reduce((n, t) => n + t.seats.filter(Boolean).length, 0);

// One instance for everyone. It knows who is in the lobby and which public tables are open;
// the tables themselves are Room objects that report here when their seats change.
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.tables = (await ctx.storage.get('tables')) || {};
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: '', stake: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 200) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const a = ws.deserializeAttachment();
    if (m.t === 'hello') {
      if (a.pid) return;
      const p = await verify(this.env.DB, m.auth);
      if (!p) return this.refuse(ws, 'auth');
      ws.serializeAttachment({ pid: p.id, stake: 0 });
      ws.send(JSON.stringify({ t: 'hub', stakes: STAKES, entry: ENTRY }));
      return this.tell();
    }
    if (!a.pid) return;
    if (m.t === 'watch') {
      const stake = STAKES.includes(m.stake) ? m.stake : 0;
      ws.serializeAttachment({ pid: a.pid, stake: stake });
      return this.tell();
    }
    if (m.t === 'sit') return this.queue(() => this.sit(ws, a.pid, m.code));
    if (m.t === 'quick') return this.queue(() => this.quick(ws, a.pid, m.stake));
  }

  webSocketClose() {
    this.tell();
  }

  webSocketError() {
    this.tell();
  }

  refuse(ws, k) {
    ws.send(JSON.stringify({ t: 'error', k: k }));
    ws.close(1000, k);
  }

  // The awaits below let other messages in, so seating is done one request at a time.
  queue(fn) {
    const run = (this.busy || Promise.resolve()).then(fn);
    this.busy = run.catch(() => {});
    return run;
  }

  room(code) {
    return this.env.ROOM.get(this.env.ROOM.idFromName(code));
  }

  // which of these players are in the lobby or at a public table
  online(ids) {
    const here = new Set(this.ctx.getWebSockets().filter(w => w.readyState === 1).map(w => w.deserializeAttachment().pid));
    for (const t of Object.values(this.tables)) for (const pid of t.pids) if (pid) here.add(pid);
    return ids.filter(id => here.has(id));
  }

  // A table sends this for one of its players. Only a friend in the lobby gets it, and the sender cannot tell why one is missing.
  async invite(from, to, code, stake, pub) {
    const socks = this.ctx.getWebSockets().filter(w => w.readyState === 1 && w.deserializeAttachment().pid === to);
    if (!socks.length || await rel(this.env.DB, from.pid, to) !== 'friend') return false;
    const p = await player(this.env.DB, to);
    if (!p || p.chips < ENTRY * stake) return false;
    const msg = JSON.stringify({ t: 'invited', from: from, code: code, stake: stake, pub: pub });
    for (const w of socks) w.send(msg);
    return true;
  }

  // The Room objects call this when a public table changes or closes.
  table(code, t) {
    // a close report that never arrived must not leave a table here for good
    for (const [c, x] of Object.entries(this.tables)) if (Date.now() - x.at > LIFE) delete this.tables[c];
    if (t) this.tables[code] = Object.assign({ at: Date.now() }, this.tables[code], t, { go: t.left === null ? 0 : Date.now() + t.left });
    else delete this.tables[code];
    this.ctx.storage.put('tables', this.tables);
    this.tell();
  }

  open() {
    return Object.entries(this.tables).filter(([, t]) => !t.started && t.seats.some(x => !x));
  }

  list(stake) {
    return this.open().filter(([, t]) => t.stake === stake).map(([code, t]) => ({
      code: code, seats: t.seats, left: t.go ? Math.max(0, t.go - Date.now()) : null
    }));
  }

  tell() {
    const all = Object.values(this.tables);
    const socks = this.ctx.getWebSockets().filter(w => w.readyState === 1 && w.deserializeAttachment().pid);
    const n = {};
    for (const s of STAKES) n[s] = people(all, s) + socks.filter(w => w.deserializeAttachment().stake === s).length;
    for (const w of socks) {
      const stake = w.deserializeAttachment().stake;
      w.send(JSON.stringify({ t: 'rooms', n: n }));
      if (stake) w.send(JSON.stringify({ t: 'tables', stake: stake, tables: this.list(stake) }));
    }
  }

  // the player if they can sit at this stake and hold no other seat here, else the refusal is sent and it is null
  async afford(ws, pid, stake, code) {
    const p = await player(this.env.DB, pid);
    if (!p) return this.refuse(ws, 'auth');
    const k = p.chips < ENTRY * stake ? 'poor' : Object.entries(this.tables).some(([c, t]) => c !== code && t.pids.includes(pid)) ? 'busy' : null;
    if (!k) return p;
    ws.send(JSON.stringify({ t: 'error', k: k }));
    return null;
  }

  async seated(ws, pid, stake, code) {
    const p = await this.afford(ws, pid, stake, code);
    if (!p) return;
    const got = await this.room(code).sit(seat(p));
    if (!got) {
      this.table(code, null);
      return false;
    }
    this.table(code, got.table);
    ws.send(JSON.stringify({ t: 'seated', code: code, seat: got.seat, token: got.token }));
    return true;
  }

  async sit(ws, pid, code) {
    const t = this.tables[code];
    if (!t || t.started) return ws.send(JSON.stringify({ t: 'error', k: 'full' }));
    if (await this.seated(ws, pid, t.stake, code) === false) ws.send(JSON.stringify({ t: 'error', k: 'full' }));
  }

  // the fullest open table of the room, else a new one
  async quick(ws, pid, stake) {
    if (!STAKES.includes(stake)) return;
    if (!await this.afford(ws, pid, stake)) return;
    const fill = t => t.seats.filter(Boolean).length;
    const open = this.open().filter(([, t]) => t.stake === stake).sort((a, b) => fill(b[1]) - fill(a[1]));
    for (const [code] of open) {
      const done = await this.seated(ws, pid, stake, code);
      if (done !== false) return;
    }
    for (let i = 0; i < 3; i++) {
      const code = await freeCode(this.env.ROOM);
      if (!code) break;
      if (!await this.room(code).openTable(code, stake)) continue;
      const done = await this.seated(ws, pid, stake, code);
      if (done !== false) return;
    }
    ws.send(JSON.stringify({ t: 'error', k: 'full' }));
  }
}
