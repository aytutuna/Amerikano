import { DurableObject } from 'cloudflare:workers';
import { freeCode } from './room.js';
import { verify, player, seat, STAKES, ENTRY } from './account.js';
import { rel } from './social.js';

const LIFE = 3 * 3600000;
const MAX = 4000;
const BURST = 10;
const EVERY = 500;

const HELLO = 10000;

// a public table, or a private one whose host opened its empty seats
const pool = t => t.pub || t.open;
const people = (tables, stake) => tables.filter(t => pool(t) && t.stake === stake).reduce((n, t) => n + t.seats.filter(Boolean).length, 0);

// One instance for everyone. Every open app keeps a socket here, so it knows where each player is:
// the lobby, training or a table. The tables themselves are Room objects that report here when their seats change.
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.bucket = new WeakMap();
    this.rooms = '';
    this.hello = Math.ceil(HELLO * (Number(env.PACE) || 1));
    ctx.blockConcurrencyWhile(async () => {
      this.tables = (await ctx.storage.get('tables')) || {};
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX) return new Response('busy', { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: '', stake: 0, at: 'lobby', born: Date.now() });
    if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + this.hello);
    return new Response(null, { status: 101, webSocket: client });
  }

  // a socket that has not said hello by now never will
  async alarm() {
    const now = Date.now();
    let next = 0;
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (a.pid || w.readyState !== 1) continue;
      const due = a.born + this.hello;
      if (due <= now) w.close(1000, 'hello');
      else next = next ? Math.min(next, due) : due;
    }
    if (next) await this.ctx.storage.setAlarm(next);
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 200) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object' || !this.allow(ws)) return;
    const a = ws.deserializeAttachment();
    if (m.t === 'hello') {
      if (a.pid) return;
      const p = await verify(this.env.DB, m.auth);
      if (!p) return this.refuse(ws, 'auth');
      // the newest socket of an account wins
      for (const w of this.ctx.getWebSockets()) {
        if (w === ws || w.readyState !== 1 || w.deserializeAttachment().pid !== p.id) continue;
        w.send(JSON.stringify({ t: 'error', k: 'replaced' }));
        w.close(4000, 'replaced');
      }
      ws.serializeAttachment({ pid: p.id, stake: 0, at: m.at === 'training' ? 'training' : 'lobby' });
      ws.send(JSON.stringify({ t: 'hub', stakes: STAKES, entry: ENTRY }));
      ws.send(JSON.stringify({ t: 'rooms', n: this.counts() }));
      return this.tell();
    }
    if (!a.pid) return;
    if (m.t === 'watch') {
      ws.serializeAttachment(Object.assign({}, a, { stake: STAKES.includes(m.stake) ? m.stake : 0 }));
      return this.tell();
    }
    if (m.t === 'at') return ws.serializeAttachment(Object.assign({}, a, { at: m.at === 'training' ? 'training' : 'lobby' }));
    if (m.t === 'sit') return this.queue(() => this.sit(ws, a.pid, m.code));
    if (m.t === 'quick') return this.queue(() => this.quick(ws, a.pid, m.stake));
  }

  webSocketClose() {
    this.tell();
  }

  webSocketError() {
    this.tell();
  }

  // a short burst of messages, then two a second
  allow(ws) {
    const now = Date.now();
    const b = this.bucket.get(ws) || { n: BURST, at: now };
    b.n = Math.min(BURST, b.n + (now - b.at) / EVERY);
    b.at = now;
    this.bucket.set(ws, b);
    if (b.n < 1) return false;
    b.n--;
    return true;
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

  // Where each of these players is; the ones who are offline are left out.
  where(ids) {
    const at = {};
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (w.readyState === 1 && a.pid) at[a.pid] = { w: a.at };
    }
    for (const [code, t] of Object.entries(this.tables)) {
      const free = t.seats.filter(x => !x).length;
      for (const pid of t.pids) if (pid) at[pid] = { w: 'table', code: code, pub: t.pub, stake: t.stake, free: free, started: t.started };
    }
    const out = {};
    for (const id of ids) if (at[id]) out[id] = at[id];
    return out;
  }

  // A table sends this for one of its players. Only a connected friend gets it, wherever they are, and the sender cannot tell why one is missing.
  async invite(from, to, code, stake, pub) {
    const socks = this.ctx.getWebSockets().filter(w => w.readyState === 1 && w.deserializeAttachment().pid === to);
    if (!socks.length || await rel(this.env.DB, from.pid, to) !== 'friend') return false;
    const p = await player(this.env.DB, to);
    if (!p || p.chips < ENTRY * stake) return false;
    const msg = JSON.stringify({ t: 'invited', from: from, code: code, stake: stake, pub: pub });
    for (const w of socks) w.send(msg);
    return true;
  }

  // The Room objects call this when a table changes or closes.
  table(code, t) {
    // a close report that never arrived must not leave a table here for good
    for (const [c, x] of Object.entries(this.tables)) if (Date.now() - x.at > LIFE) delete this.tables[c];
    if (t) this.tables[code] = Object.assign({ at: Date.now() }, this.tables[code], t);
    else delete this.tables[code];
    this.ctx.storage.put('tables', this.tables);
    this.tell();
  }

  open() {
    return Object.entries(this.tables).filter(([, t]) => pool(t) && !t.started && t.seats.some(x => !x));
  }

  list(stake) {
    return this.open().filter(([, t]) => t.stake === stake).map(([code, t]) => ({ code: code, seats: t.seats }));
  }

  // Seated people count too, and a table fills its empty seats on its own, so these include those.
  counts() {
    const all = Object.values(this.tables);
    const socks = this.ctx.getWebSockets().filter(w => w.readyState === 1 && w.deserializeAttachment().pid);
    const n = {};
    for (const s of STAKES) n[s] = people(all, s) + socks.filter(w => w.deserializeAttachment().stake === s).length;
    return n;
  }

  tell() {
    const socks = this.ctx.getWebSockets().filter(w => w.readyState === 1 && w.deserializeAttachment().pid);
    const n = JSON.stringify({ t: 'rooms', n: this.counts() });
    const same = n === this.rooms;
    this.rooms = n;
    for (const w of socks) {
      const stake = w.deserializeAttachment().stake;
      if (!same) w.send(n);
      if (stake) w.send(JSON.stringify({ t: 'tables', stake: stake, tables: this.list(stake) }));
    }
  }

  // whether the account holds a seat at a pool table other than this one
  holds(pid, code) {
    return Object.entries(this.tables).some(([c, t]) => c !== code && (pool(t) || t.started) && t.pids.includes(pid));
  }

  // the player if they can sit at this stake and hold no other seat at a public table, else the refusal is sent and it is null
  async afford(ws, pid, stake, code) {
    const p = await player(this.env.DB, pid);
    if (!p) return this.refuse(ws, 'auth');
    const k = p.chips < ENTRY * stake ? 'poor' : Object.entries(this.tables).some(([c, t]) => c !== code && (pool(t) || t.started) && t.pids.includes(pid)) ? 'busy' : null;
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
    if (!got.token) return false;
    ws.send(JSON.stringify({ t: 'seated', code: code, seat: got.seat, token: got.token }));
    return true;
  }

  async sit(ws, pid, code) {
    const t = this.tables[code];
    if (!t || !pool(t)) return ws.send(JSON.stringify({ t: 'error', k: 'nocode' }));
    if (t.started) return ws.send(JSON.stringify({ t: 'error', k: 'full' }));
    if (await this.seated(ws, pid, t.stake, code) === false) ws.send(JSON.stringify({ t: 'error', k: 'full' }));
  }

  // the open table of the room with the most people, real ones first, else a new one
  async quick(ws, pid, stake) {
    if (!STAKES.includes(stake)) return;
    if (!await this.afford(ws, pid, stake)) return;
    const fill = t => t.seats.filter(Boolean).length;
    const real = t => t.pids.filter(Boolean).length;
    const open = this.open().filter(([, t]) => t.stake === stake).sort((a, b) => real(b[1]) - real(a[1]) || fill(b[1]) - fill(a[1]));
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
