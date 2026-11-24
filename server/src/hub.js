import { DurableObject } from 'cloudflare:workers';
import { freeCode, stub } from './room.js';
import { verify, player, seat, credit, STAKES, ENTRY, BUYINS, prizes } from './account.js';
import { rel, won } from './social.js';
import { claim, release, keep, giveBack, spend, grant } from './persona.js';
import { ring } from './push.js';
import { DEFAULT } from './region.js';
import { on, act, slow, may, shut } from './voice.js';

const LIFE = 3 * 3600000;
const MAX = 4000;
const BURST = 10;
const EVERY = 500;
const DM_BURST = 5;
const DM_EVERY = 3000;

const HELLO = 10000;
const CUP = 8;
const WAIT = 20000;
const JOIN = 4000;
const GRACE = 6000;
const RETRY = 5000;
const RING = 30000;
const DIAL = 4000;
const ID = /^[0-9a-f]{32}$/;

const between = (lo, hi) => Math.round(lo + Math.random() * (hi - lo));

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// a public table, or a private one whose host opened its empty seats
const pool = t => t.pub || t.open;
const reg = p => p.region || DEFAULT;
const slot = (r, buy) => r + ':' + buy;
const people = (tables, stake, fast) => tables.filter(t => pool(t) && t.stake === stake && !!t.fast === fast).reduce((n, t) => n + t.seats.filter(Boolean).length, 0);

// One instance for everyone. Every open app keeps a socket here, so it knows where each player is:
// the lobby, training or a table. The tables themselves are Room objects that report here when their seats change.
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.bucket = new WeakMap();
    this.chatty = new Map();
    this.calls = new Map();
    this.dialed = new Map();
    this.limit = new Map();
    this.rooms = {};
    this.k = Number(env.PACE) || 1;
    this.hello = Math.ceil(HELLO * this.k);
    ctx.blockConcurrencyWhile(async () => {
      this.tables = (await ctx.storage.get('tables')) || {};
      this.cups = (await ctx.storage.get('cups')) || { form: {}, run: {} };
      // forms made before regions were keyed by the buy-in alone
      for (const [k, f] of Object.entries(this.cups.form)) {
        if (f.region) continue;
        delete this.cups.form[k];
        f.region = DEFAULT;
        this.cups.form[slot(f.region, f.buy)] = f;
      }
    });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX) return new Response('busy', { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: '', stake: 0, fast: false, at: 'lobby', born: Date.now() });
    const at = await this.ctx.storage.getAlarm();
    if (!at || at > Date.now() + this.hello) await this.ctx.storage.setAlarm(Date.now() + this.hello);
    return new Response(null, { status: 101, webSocket: client });
  }

  // a socket that has not said hello by now never will; a forming tournament takes its next persona
  async alarm() {
    await this.queue(() => this.fill()).catch(() => {});
    await this.queue(() => this.resume()).catch(() => {});
    await this.queue(() => this.sweep()).catch(() => {});
    // after the awaits, so a socket that connected meanwhile is counted
    const now = Date.now();
    let next = 0;
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (a.pid || w.readyState !== 1) continue;
      const due = a.born + this.hello;
      if (due <= now) w.close(1000, 'hello');
      else next = next ? Math.min(next, due) : due;
    }
    for (const f of Object.values(this.cups.form)) {
      const at = f.hs.length ? f.next : f.drop;
      next = next ? Math.min(next, at) : at;
    }
    for (const c of Object.values(this.cups.run)) {
      const at = c.aborting || Object.keys(c.plan).length || !Object.keys(c.tabs).length ? now + RETRY * this.k : c.at + LIFE + 1000;
      next = next ? Math.min(next, at) : at;
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
      this.ctx.waitUntil(this.env.DB.prepare('INSERT OR IGNORE INTO active (player, day) VALUES (?, ?)').bind(p.id, Math.floor(Date.now() / 86400000)).run().catch(() => {}));
      // the newest socket of an account wins
      for (const w of this.ctx.getWebSockets()) {
        if (w === ws || w.readyState !== 1 || w.deserializeAttachment().pid !== p.id) continue;
        w.send(JSON.stringify({ t: 'error', k: 'replaced' }));
        w.close(4000, 'replaced');
      }
      ws.serializeAttachment({ pid: p.id, stake: 0, fast: false, region: reg(p), at: m.at === 'training' ? 'training' : 'lobby' });
      this.put(ws, { t: 'hub', stakes: STAKES, entry: ENTRY, voice: on(this.env) });
      const c = this.inCall(p.id);
      if (c) {
        clearTimeout(c.gone[p.id]);
        this.put(ws, this.brief(c, p.id));
      }
      this.put(ws, this.counts(reg(p)));
      const f = this.forming(p.id);
      if (f) this.put(ws, this.state(f));
      else if (!this.inCup(p.id)) this.put(ws, { t: 'cup', buy: 0 });
      for (const c of Object.values(this.cups.run)) this.notify(c, p.id);
      return this.tell();
    }
    if (!a.pid) return;
    if (m.t === 'watch') {
      ws.serializeAttachment(Object.assign({}, a, { stake: STAKES.includes(m.stake) ? m.stake : 0, fast: m.fast === true }));
      return this.tell();
    }
    if (m.t === 'at') return ws.serializeAttachment(Object.assign({}, a, { at: m.at === 'training' ? 'training' : 'lobby' }));
    if (m.t === 'sit') return this.queue(() => this.sit(ws, a.pid, m.code));
    if (m.t === 'quick') return this.queue(() => this.quick(ws, a.pid, m.stake, m.fast === true));
    if (m.t === 'cup') return this.queue(() => this.enter(ws, a.pid, m.buy));
    if (m.t === 'call') return this.queue(() => this.dial(ws, a.pid, m.to));
    if (m.t === 'accept') return this.accept(a.pid, m.id);
    if (m.t === 'hang') return this.hang(a.pid, m.id);
  }

  webSocketClose(ws) {
    this.away(ws);
    this.tell();
  }

  webSocketError(ws) {
    this.away(ws);
    this.tell();
  }

  // closing the app withdraws a player from a tournament that has not started
  away(ws) {
    const { pid } = ws.deserializeAttachment();
    if (!pid) return;
    // a call survives a short loss of the connection
    const c = this.inCall(pid);
    if (c && !this.online(pid)) c.gone[pid] = setTimeout(() => !this.online(pid) && this.finish(c, c.st === 'on' ? 'dropped' : 'missed').catch(() => {}), GRACE * this.k);
    this.queue(async () => {
      const f = this.forming(pid);
      if (f && !this.online(pid)) await this.leave(f, pid);
    }).catch(() => {});
  }

  online(pid) {
    return this.ctx.getWebSockets().some(w => w.readyState === 1 && w.deserializeAttachment().pid === pid);
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

  // a socket can close while the hub waits on the database, and sending on it throws
  put(ws, o) {
    if (ws.readyState === 1) ws.send(JSON.stringify(o));
  }

  refuse(ws, k) {
    this.put(ws, { t: 'error', k: k });
    if (ws.readyState === 1) ws.close(1000, k);
  }

  // The awaits below let other messages in, so seating is done one request at a time.
  queue(fn) {
    const run = (this.busy || Promise.resolve()).then(fn);
    this.busy = run.catch(() => {});
    return run;
  }

  room(code) {
    return stub(this.env.ROOM, code);
  }

  // the account changed its region: its sockets follow, tables and tournaments it is in stay as they are
  move(pid, r) {
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (w.readyState !== 1 || a.pid !== pid) continue;
      w.serializeAttachment(Object.assign({}, a, { region: r }));
      w.send(JSON.stringify(this.counts(r)));
      if (a.stake) w.send(JSON.stringify({ t: 'tables', stake: a.stake, fast: !!a.fast, tables: this.list(a.stake, !!a.fast, r) }));
    }
  }

  // Where each of these players is; the ones who are offline are left out.
  where(ids) {
    const at = {};
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (w.readyState === 1 && a.pid) at[a.pid] = { w: a.at };
    }
    // a player waiting for the final is still at the table of the first round
    for (const c of Object.values(this.cups.run)) {
      if (!c.aborting) for (const m of c.mem) if (at[m.pid] && m.at && c.held.includes(m.pid)) at[m.pid] = { w: 'table', code: m.at.code, pub: false, stake: 0, free: 0, started: true };
    }
    for (const [code, t] of Object.entries(this.tables)) {
      const free = t.seats.filter(x => !x).length;
      for (const pid of t.pids) if (pid) at[pid] = { w: 'table', code: code, pub: t.pub, stake: t.stake, free: free, started: t.started };
    }
    const out = {};
    for (const id of ids) if (at[id]) out[id] = at[id];
    return out;
  }

  // A push for a player whose app has no socket here.
  async ring(from, to, k, v) {
    if (!this.online(to)) await ring(this.env, from, to, k, v);
  }

  inCall(pid) {
    for (const c of this.calls.values()) if (c.a === pid || c.b === pid) return c;
    return null;
  }

  // what each side of a call is told: the callee rings, the caller waits, and both hear when it is on
  brief(c, pid) {
    if (c.st === 'on') return { t: 'call', id: c.id, st: 'on', with: pid === c.a ? c.b : c.a };
    return pid === c.b ? { t: 'ring', id: c.id, from: c.from } : { t: 'call', id: c.id, st: 'ring' };
  }

  // Rings a friend. Whatever stops it, the answer is only that it did not go through, so nobody learns who blocked or muted them.
  async dial(ws, pid, to) {
    if (!on(this.env) || typeof to !== 'string' || !ID.test(to) || to === pid) return;
    const no = why => this.put(ws, { t: 'call', st: 'end', why: why });
    const now = Date.now();
    if (this.dialed.size > 1000) this.dialed.clear();
    if (now - (this.dialed.get(pid) || 0) < DIAL * this.k) return no('slow');
    this.dialed.set(pid, now);
    const db = this.env.DB;
    // offline first, so a persona, which is never online, answers like a friend who is away
    if (!this.online(to)) return no('away');
    const [p, q] = await Promise.all([player(db, pid), player(db, to)]);
    if (!p || !q || !p.voice || !q.voice || await rel(db, pid, to) !== 'friend') return no('no');
    if (this.inCall(pid) || this.inCall(to)) return no('busy');
    const c = { id: crypto.randomUUID(), a: pid, b: to, st: 'ring', from: seat(p), vx: {}, gone: {} };
    c.timer = setTimeout(() => this.finish(c, 'missed').catch(() => {}), RING * this.k);
    this.calls.set(c.id, c);
    this.to(pid, this.brief(c, pid));
    this.to(to, this.brief(c, to));
  }

  accept(pid, id) {
    const c = this.calls.get(id);
    if (!c || c.b !== pid || c.st !== 'ring') return;
    clearTimeout(c.timer);
    c.st = 'on';
    this.to(c.a, this.brief(c, c.a));
    this.to(c.b, this.brief(c, c.b));
  }

  // hanging up while it rings is a decline for the callee and a missed call for the caller
  hang(pid, id) {
    const c = this.calls.get(id);
    // a call this hub no longer knows is over, so the app is told and lets go of it
    if (!c) return this.to(pid, { t: 'call', id: id, st: 'end', why: 'ended' });
    if (c.a !== pid && c.b !== pid) return;
    return this.finish(c, c.st === 'on' ? 'ended' : pid === c.b ? 'declined' : 'missed');
  }

  // A missed or declined call leaves a line in the conversation, written before the two sides hear that it ended so that reloading finds it.
  async finish(c, why) {
    if (this.calls.get(c.id) !== c) return;
    this.calls.delete(c.id);
    clearTimeout(c.timer);
    for (const x of Object.values(c.gone)) clearTimeout(x);
    for (const e of Object.values(c.vx)) this.ctx.waitUntil(shut(this.env, e));
    if (why === 'missed' || why === 'declined') {
      await this.env.DB.prepare("INSERT INTO messages (sender, recipient, text, at, seen, kind) VALUES (?1, ?2, '', ?3, ?4, ?5)")
        .bind(c.a, c.b, Date.now(), why === 'declined' ? 1 : 0, why).run().catch(() => {});
    }
    const m = { t: 'call', id: c.id, st: 'end', why: why };
    this.to(c.a, m);
    this.to(c.b, m);
  }

  // Voice of a call through the SFU proxy: only the two people of a call that is on, still friends and not blocked, with voice on.
  async vox(pid, op, b) {
    const c = this.calls.get(b.id);
    if (!on(this.env) || !c || c.st !== 'on' || c.a !== pid && c.b !== pid) return { status: 403, body: { error: 'call' } };
    if (slow(this.limit, pid)) return { status: 429, body: { error: 'slow' } };
    const other = pid === c.a ? c.b : c.a;
    const p = await player(this.env.DB, pid);
    if (!p || !p.voice || this.calls.get(c.id) !== c) return { status: 403, body: { error: 'off' } };
    const res = await act(this.env, c.vx, op, pid, b, async q => q === other && await may(this.env.DB, pid, q, true));
    if (res.status === 200 && (op === 'mic' || op === 'stop')) this.to(other, { t: 'voice', id: c.id, pid: pid, on: op === 'mic' });
    return res;
  }

  // Private messages: a short burst per sender, then one every three seconds. Kept in memory, so a restart only forgives.
  talk(pid) {
    const now = Date.now();
    if (this.chatty.size > 1000) for (const [k, v] of this.chatty) if (now - v.at > 60000) this.chatty.delete(k);
    const b = this.chatty.get(pid) || { n: DM_BURST, at: now };
    b.n = Math.min(DM_BURST, b.n + (now - b.at) / DM_EVERY);
    b.at = now;
    this.chatty.set(pid, b);
    if (b.n < 1) return false;
    b.n--;
    return true;
  }

  // A message for a friend: every open socket of theirs gets it, and a closed app gets a push.
  dm(from, seed, to, m) {
    if (this.online(to)) this.to(to, { t: 'dm', from: from, seed: seed, m: m });
    else return this.ring(from, to, 'dm', { seed: seed });
  }

  // A table sends this for one of its players. Only a friend gets it, by socket wherever they are, and one whose app is closed gets a push
  // after the answer. The answer is false for both, whatever the push does, so the sender cannot tell why one is missing.
  async invite(from, to, code, stake, pub) {
    const socks = this.ctx.getWebSockets().filter(w => w.readyState === 1 && w.deserializeAttachment().pid === to);
    if (this.inCup(to) || await rel(this.env.DB, from.pid, to) !== 'friend') return false;
    const p = await player(this.env.DB, to);
    if (!p || p.chips < ENTRY * stake) return false;
    if (!socks.length) {
      this.ctx.waitUntil(this.ring(from.pid, to, 'invite', { seed: from.seed, code: code }).catch(() => {}));
      return false;
    }
    const msg = JSON.stringify({ t: 'invited', from: from, code: code, stake: stake, pub: pub });
    for (const w of socks) w.send(msg);
    return true;
  }

  // The Room objects call this when a table changes or closes.
  table(code, t) {
    // a close report that never arrived must not leave a table here for good
    for (const [c, x] of Object.entries(this.tables)) if (Date.now() - x.at > LIFE) delete this.tables[c];
    if (t) this.tables[code] = Object.assign({}, this.tables[code], t, { at: Date.now() });
    else delete this.tables[code];
    this.ctx.storage.put('tables', this.tables);
    // a player who left a tournament table forfeits the prize and is let go; the order of a finished final is fixed
    const c = t && t.cup && this.cups.run[t.cup];
    if (c && !c.aborting && !(t.over && c.tabs[code] === 'final')) {
      for (const m of c.mem) if (m.at && m.at.code === code && c.held.includes(m.pid) && !t.pids.includes(m.pid)) this.forfeit(c, m.pid);
      this.save();
    }
    this.tell();
  }

  open() {
    return Object.entries(this.tables).filter(([, t]) => pool(t) && !t.started && t.seats.some(x => !x));
  }

  list(stake, fast, r) {
    return this.open().filter(([, t]) => t.region === r && t.stake === stake && !!t.fast === fast).map(([code, t]) => ({ code: code, seats: t.seats }));
  }

  // Seated people count too, and a table fills its empty seats on its own, so these include those.
  counts(r) {
    const all = Object.values(this.tables).filter(t => t.region === r);
    const socks = this.ctx.getWebSockets().filter(w => w.readyState === 1 && w.deserializeAttachment().region === r);
    const out = { t: 'rooms', n: {}, f: {} };
    for (const s of STAKES) {
      const here = socks.map(w => w.deserializeAttachment()).filter(a => a.stake === s);
      out.n[s] = people(all, s, false) + here.filter(a => !a.fast).length;
      out.f[s] = people(all, s, true) + here.filter(a => a.fast).length;
    }
    return out;
  }

  tell() {
    const socks = this.ctx.getWebSockets().filter(w => w.readyState === 1 && w.deserializeAttachment().pid);
    const now = {};
    for (const w of socks) {
      const { stake, fast, region } = w.deserializeAttachment();
      const n = now[region] || (now[region] = JSON.stringify(this.counts(region)));
      if (n !== this.rooms[region]) w.send(n);
      if (stake) w.send(JSON.stringify({ t: 'tables', stake: stake, fast: !!fast, tables: this.list(stake, !!fast, region) }));
    }
    this.rooms = now;
  }

  // whether the account holds a seat at a pool table other than this one, or is in a tournament
  holds(pid, code) {
    return this.inCup(pid) ||
      Object.entries(this.tables).some(([c, t]) => c !== code && (pool(t) || t.started && !t.cup) && t.pids.includes(pid));
  }

  // the player if they can sit at this stake and hold no other seat at a public table, else the refusal is sent and it is null
  async afford(ws, pid, stake, code) {
    const p = await player(this.env.DB, pid);
    if (!p) return this.refuse(ws, 'auth');
    const k = p.chips < ENTRY * stake ? 'poor' : this.holds(pid, code) ? 'busy' : null;
    if (!k) return p;
    this.put(ws, { t: 'error', k: k });
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
    this.put(ws, { t: 'seated', code: code, seat: got.seat, token: got.token });
    return true;
  }

  async sit(ws, pid, code) {
    const t = this.tables[code];
    if (!t || !pool(t)) return this.put(ws, { t: 'error', k: 'nocode' });
    if (t.started) return this.put(ws, { t: 'error', k: 'full' });
    if (await this.seated(ws, pid, t.stake, code) === false) this.put(ws, { t: 'error', k: 'full' });
  }

  // the open table of the room with the most people, real ones first, else a new one
  async quick(ws, pid, stake, fast) {
    if (!STAKES.includes(stake)) return;
    const p = await this.afford(ws, pid, stake);
    if (!p) return;
    const r = reg(p);
    const fill = t => t.seats.filter(Boolean).length;
    const real = t => t.pids.filter(Boolean).length;
    const open = this.open().filter(([, t]) => t.region === r && t.stake === stake && !!t.fast === fast).sort((a, b) => real(b[1]) - real(a[1]) || fill(b[1]) - fill(a[1]));
    for (const [code] of open) {
      const done = await this.seated(ws, pid, stake, code);
      if (done !== false) return;
    }
    for (let i = 0; i < 3; i++) {
      const code = await freeCode(this.env.ROOM, r);
      if (!code) break;
      if (!await this.room(code).openTable(code, stake, fast, r)) continue;
      const done = await this.seated(ws, pid, stake, code);
      if (done !== false) return;
    }
    this.put(ws, { t: 'error', k: 'full' });
  }

  inCup(pid) {
    return !!this.forming(pid) || Object.values(this.cups.run).some(c => c.held.includes(pid));
  }

  forming(pid) {
    return Object.values(this.cups.form).find(f => f.hs.some(h => h.pid === pid));
  }

  // the count never says who is a persona
  state(f) {
    return { t: 'cup', buy: f.buy, n: f.hs.length + f.ps.length, left: Math.max(0, f.due - Date.now()) };
  }

  announce(f) {
    for (const h of f.hs) this.to(h.pid, this.state(f));
  }

  to(pid, o) {
    const msg = JSON.stringify(o);
    for (const w of this.ctx.getWebSockets()) if (w.readyState === 1 && w.deserializeAttachment().pid === pid) w.send(msg);
  }

  save() {
    this.ctx.storage.put('cups', this.cups);
  }

  // Registers for the forming tournament at this buy-in; 0 withdraws from it.
  async enter(ws, pid, buy) {
    const f = this.forming(pid);
    if (buy === 0) return f && this.leave(f, pid);
    if (!BUYINS.includes(buy)) return;
    const now = Date.now();
    await this.sweep().catch(() => {});
    const p = await player(this.env.DB, pid);
    if (!p) return this.refuse(ws, 'auth');
    const k = p.chips < buy ? 'poor' : this.holds(pid) ? 'busy' : null;
    if (k) return this.put(ws, { t: 'error', k: k });
    const r = reg(p);
    const g = this.cups.form[slot(r, buy)] || (this.cups.form[slot(r, buy)] = { id: crypto.randomUUID(), buy: buy, region: r, hs: [], ps: [], due: now + WAIT * this.k, next: now + between(JOIN, 2 * JOIN) * this.k });
    // a form that is full is waiting to start
    if (g.hs.length + g.ps.length >= CUP) return this.put(ws, { t: 'error', k: 'starting' });
    if (!g.hs.length) {
      if (!g.ps.length) g.due = now + WAIT * this.k;
      g.drop = 0;
    }
    g.hs.push(seat(p));
    this.save();
    this.announce(g);
    if (g.hs.length + g.ps.length >= CUP) return this.start(g);
    const at = await this.ctx.storage.getAlarm();
    if (!at || at > g.next) await this.ctx.storage.setAlarm(g.next);
  }

  // When the last human withdraws the others stay a few seconds, so signing straight back in finds the same count
  // instead of showing that they were never people. Then the form is dropped and its personas let go.
  async leave(f, pid) {
    // the buy-ins of a form that is starting may already be taken
    if (f.hs.length + f.ps.length >= CUP) return this.to(pid, this.state(f));
    f.hs = f.hs.filter(h => h.pid !== pid);
    this.to(pid, { t: 'cup', buy: 0 });
    if (!f.hs.length) f.drop = Date.now() + between(GRACE, 2 * GRACE) * this.k;
    this.save();
    this.announce(f);
    if (!f.hs.length) {
      const at = await this.ctx.storage.getAlarm();
      if (!at || at > f.drop) await this.ctx.storage.setAlarm(f.drop);
    }
  }

  // a persona who fits the humans registered so far
  async persona(f, mem) {
    const hs = mem.filter(x => !x.fake);
    const avg = hs.length ? Math.round(hs.reduce((n, x) => n + x.level, 0) / hs.length) : 1;
    const p = await claim(this.env.DB, f.id, avg, f.buy / ENTRY, mem.map(x => x.seed));
    return { pid: p.id, seed: p.name_seed, av: p.avatar.split(',').map(Number), level: p.level, fake: true };
  }

  // Personas join one at a time at uneven moments, a little quicker once the wait is over.
  async fill() {
    for (const f of Object.values(this.cups.form)) {
      if (!f.hs.length) {
        if (f.drop > Date.now()) continue;
        delete this.cups.form[slot(f.region, f.buy)];
        this.save();
        await release(this.env.DB, f.id);
        continue;
      }
      for (const h of f.hs.slice()) if (!this.online(h.pid)) await this.leave(f, h.pid);
      if (!f.hs.length) continue;
      if (f.next > Date.now()) continue;
      if (f.hs.length + f.ps.length >= CUP) {
        await this.start(f);
        continue;
      }
      f.next = Date.now() + (Date.now() >= f.due ? between(200, 900) : between(1500, 5000)) * this.k;
      const p = await this.persona(f, [...f.hs, ...f.ps]);
      if (this.cups.form[slot(f.region, f.buy)] !== f) {
        await giveBack(this.env.DB, p.pid);
        continue;
      }
      f.ps.push(p);
      this.save();
      this.announce(f);
      if (f.hs.length + f.ps.length >= CUP) await this.start(f);
    }
  }

  // Takes the buy-ins, once, and seats the eight at two tables. The form stays until the run is saved, so a
  // failure before that tries again later: the buy-in refs make a repeat charge a no-op.
  async start(f) {
    const db = this.env.DB;
    let c;
    try {
      const hs = [];
      for (const h of f.hs) {
        if (await credit(db, h.pid, -f.buy, 'cup', f.id + ':in')) hs.push(h);
        else {
          f.hs = f.hs.filter(x => x.pid !== h.pid);
          this.save();
          this.to(h.pid, { t: 'error', k: 'poor' });
          this.to(h.pid, { t: 'cup', buy: 0 });
        }
      }
      if (!hs.length) {
        delete this.cups.form[slot(f.region, f.buy)];
        this.save();
        return release(db, f.id);
      }
      while (hs.length + f.ps.length < CUP) f.ps.push(await this.persona(f, [...hs, ...f.ps]));
      const mem = shuffle([...hs, ...f.ps]);
      c = { id: f.id, buy: f.buy, region: f.region, mem: mem, held: hs.map(h => h.pid), tabs: {}, plan: {}, done: {}, fails: 0, at: Date.now() };
      this.cups.run[c.id] = c;
      delete this.cups.form[slot(f.region, f.buy)];
      this.save();
    } catch (e) {
      f.next = Date.now() + RETRY * this.k;
      this.save();
      return;
    }
    try {
      for (const p of c.mem.filter(m => m.fake)) {
        await spend(db, p.pid, c.buy);
        await keep(db, p.pid, c.id);
      }
      await this.plan(c, 'first', c.mem.slice(0, 4));
      await this.plan(c, 'first', c.mem.slice(4));
      this.save();
      await this.reseat(c);
    } catch (e) {
      return this.abort(c);
    }
    this.notify(c);
  }

  // Chooses the table for these four and writes it down before it is opened, so a restart can finish the job.
  async plan(c, round, mem) {
    let code;
    do code = await freeCode(this.env.ROOM, c.region); while (code && c.tabs[code]);
    if (!code) throw new Error('no table');
    c.tabs[code] = round;
    c.plan[code] = mem.map(m => m.pid);
    const at = Date.now() + RETRY * this.k;
    const set = await this.ctx.storage.getAlarm();
    if (!set || set > at) await this.ctx.storage.setAlarm(at);
  }

  // opens the planned tables and remembers where each human sits; opening one again gives back the same seats
  async reseat(c) {
    for (let n = 0, code; (code = Object.keys(c.plan)[0]); n++) {
      const mem = c.plan[code].map(pid => c.mem.find(m => m.pid === pid));
      const round = c.tabs[code];
      const tokens = n < 6 && await this.room(code).openCup(code, { id: c.id, round: round, buy: c.buy }, mem);
      if (!tokens) {
        if (n >= 6) throw new Error('no table');
        await this.plan(c, round, mem);
        delete c.tabs[code];
        delete c.plan[code];
        continue;
      }
      mem.forEach((m, j) => {
        if (tokens[j]) m.at = { code: code, seat: j, token: tokens[j] };
      });
      delete c.plan[code];
      this.save();
      if (round !== 'final') continue;
      for (const k of Object.keys(c.tabs)) if (c.tabs[k] === 'first') await this.room(k).cupClose(c.id).catch(() => {});
    }
  }

  // finishes opening tables after a restart or a failed call; a cup that cannot be opened is cancelled
  async resume() {
    for (const c of Object.values(this.cups.run)) {
      if (c.aborting) {
        await this.abort(c).catch(() => {});
        continue;
      }
      // no tables at all means start() was cut off before it planned the first round
      const fresh = !Object.keys(c.tabs).length;
      if (!fresh && !Object.keys(c.plan).length) continue;
      try {
        if (fresh) {
          await this.plan(c, 'first', c.mem.slice(0, 4));
          await this.plan(c, 'first', c.mem.slice(4));
          this.save();
        }
        await this.reseat(c);
        c.fails = 0;
        this.save();
        this.notify(c);
      } catch (e) {
        if (++c.fails >= 3) await this.abort(c);
        else this.save();
      }
    }
  }

  // a run that outlived its time is cancelled like a failed one
  async sweep() {
    for (const c of Object.values(this.cups.run)) if (Date.now() - c.at > LIFE) await this.abort(c);
  }

  // The buy-ins go back and the tables that did open are closed. The run is kept until every refund is made,
  // so a call that fails halfway is finished by the next resume.
  async abort(c) {
    c.aborting = true;
    this.save();
    for (const code of Object.keys(c.tabs)) await this.room(code).cupClose(c.id, true).catch(() => {});
    // no prize was paid, so everyone who bought in gets it back, those already out too; a player who left gave it up
    for (const m of c.mem) {
      if (m.fake || m.left || m.paid || m.back) continue;
      await credit(this.env.DB, m.pid, c.buy, 'cup', c.id + ':back');
      m.back = true;
      c.held = c.held.filter(x => x !== m.pid);
      this.save();
      this.to(m.pid, { t: 'error', k: 'cupoff' });
      this.to(m.pid, { t: 'cup', buy: 0 });
    }
    delete this.cups.run[c.id];
    this.save();
    await release(this.env.DB, c.id);
  }

  // tells the humans still in where to sit
  notify(c, pid) {
    if (c.aborting) return;
    for (const m of c.mem) {
      if (pid && m.pid !== pid || !m.at || !c.held.includes(m.pid)) continue;
      this.to(m.pid, Object.assign({ t: 'seated', cup: c.tabs[m.at.code] }, m.at));
    }
  }

  forfeit(c, pid) {
    c.held = c.held.filter(x => x !== pid);
    c.mem.find(m => m.pid === pid).left = true;
  }

  // A table reports how it ended; the same report may arrive again and finds the work done.
  cupDone(id, code, order) {
    return this.queue(async () => {
      const c = this.cups.run[id];
      if (!c || c.aborting || !c.tabs[code]) return true;
      if (!c.done[code]) {
        c.done[code] = order;
        for (const e of order) if (e.left && c.held.includes(e.pid)) this.forfeit(c, e.pid);
        this.save();
      }
      const done = c.done[code];
      if (c.tabs[code] === 'final') await this.pay(c, done);
      else {
        for (const e of done.slice(2)) await this.out(c, e.pid);
        await this.advance(c);
      }
      return true;
    });
  }

  async out(c, pid) {
    const m = c.mem.find(x => x.pid === pid);
    if (m.fake) {
      // once: by a repeat the persona may already sit at another table
      if (m.out) return;
      await giveBack(this.env.DB, pid);
      m.out = true;
      this.save();
      return;
    }
    if (!c.held.includes(pid)) return;
    c.held = c.held.filter(x => x !== pid);
    this.save();
    this.to(pid, { t: 'cupout', buy: c.buy });
  }

  // the top two of each first table meet at the final table; a qualifier who left plays as a bot
  async advance(c) {
    const firsts = Object.keys(c.tabs).filter(k => c.tabs[k] === 'first');
    if (Object.values(c.tabs).includes('final') || !firsts.every(k => c.done[k])) return;
    const four = shuffle(firsts.flatMap(k => c.done[k].slice(0, 2).map(e => c.mem.find(m => m.pid === e.pid))));
    for (const m of four) if (m.fake) await keep(this.env.DB, m.pid, c.id);
    await this.plan(c, 'final', four);
    this.save();
    await this.reseat(c);
    this.notify(c);
  }

  // prizes by place; a human who left gets none and the share stays unpaid
  async pay(c, order) {
    const db = this.env.DB;
    const prize = prizes(c.buy);
    for (const [i, e] of order.entries()) {
      const m = c.mem.find(x => x.pid === e.pid);
      if (m.paid || m.left || e.left) continue;
      if (m.fake) {
        m.paid = true;
        this.save();
        await grant(db, m.pid, prize[i]);
        continue;
      }
      await credit(db, m.pid, prize[i], 'cup', c.id + ':out');
      m.paid = true;
      this.save();
      if (e.played && prize[i] > c.buy) await won(db, m.pid, prize[i] - c.buy);
      this.to(m.pid, { t: 'cupend', buy: c.buy, place: i + 1, prize: prize[i] });
    }
    c.held = [];
    delete this.cups.run[c.id];
    this.save();
    await release(db, c.id);
  }
}
