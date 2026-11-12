import { DurableObject } from 'cloudflare:workers';
import Game from '../../www/js/game.js';
import Names from '../../www/js/names.js';
import { verify, player, award, seat, credit, payout, STAKES, ENTRY } from './account.js';

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const NAMES = ['Ece', 'Can', 'Deniz', 'Aylin', 'Mert', 'Selin', 'Arda', 'Defne', 'Kerem', 'Nil',
  'Onur', 'Ilke', 'Toprak', 'Su', 'Yaren', 'Baran', 'Mina', 'Ozan', 'Lale', 'Umut'];
const IDLE = 30000;
const GRACE = 8000;
const NEXT = 20000;
const WAIT = 20000;
const KEEP = 600000;

export async function freeCode(ns) {
  for (let i = 0; i < 8; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    if (await ns.get(ns.idFromName(c)).free()) return c;
  }
  return null;
}

function human(p, gone) {
  return { pid: p.pid, name: Names.text(p.seed, 'en'), seed: p.seed, av: p.av, level: p.level, token: crypto.randomUUID(), gone: gone };
}

function card(i) {
  return Number.isInteger(i) ? Game.CARDS[i] : undefined;
}

function cards(ids) {
  if (!Array.isArray(ids) || ids.length > 20) return null;
  const out = ids.map(card);
  return out.every(Boolean) ? out : null;
}

function melds(list) {
  if (!Array.isArray(list) || list.length > 8) return null;
  const out = list.map(m => ({ t: m && m.t, cards: cards(m && m.ids) }));
  return out.every(m => (m.t === 'set' || m.t === 'run') && m.cards) ? out : null;
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.k = Number(env.PACE) || 1;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.r = (await ctx.storage.get('r')) || null;
      const s = await ctx.storage.get('st');
      this.st = s ? Game.load(s) : null;
      if (this.r && this.r.over && !this.r.paid) ctx.storage.setAlarm(Date.now());
    });
  }

  free() {
    return !this.r;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const code = new URL(request.url).pathname.split('/')[2];
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat: -1, sent: 0, code: code });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Called by the Hub. A public table is an ordinary room whose seats the Hub hands out.
  openTable(code, stake) {
    if (this.r) return false;
    this.r = {
      code: code, n: 4, games: 4, level: 'relaxed', pub: true, stake: stake, host: -1, seats: Array(4).fill(null),
      started: false, over: false, since: 0, go: 0, ready: [], dead: Date.now() + KEEP * this.k
    };
    this.save();
    this.arm();
    return true;
  }

  // Called by the Hub for a player it has checked. The socket joins afterwards with the token.
  sit(p) {
    const r = this.r;
    if (!r || !r.pub || r.started) return null;
    let i = r.seats.findIndex(s => s && s.pid === p.pid);
    if (i >= 0) r.seats[i].gone = Date.now();
    else {
      i = r.seats.indexOf(null);
      if (i < 0) return null;
      r.seats[i] = human(p, Date.now());
      // the first two humans each restart the wait; later ones do not
      if (r.seats.filter(Boolean).length <= 2) r.go = Date.now() + WAIT * this.k;
    }
    const token = r.seats[i].token;
    if (r.seats.every(Boolean)) this.ctx.waitUntil(this.go());
    else {
      this.save();
      this.send();
      this.arm();
    }
    return { seat: i, token: token, table: this.summary() };
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 2000) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const a = ws.deserializeAttachment();
    if (m.t === 'create') return this.create(ws, a, m);
    if (m.t === 'join') return this.join(ws, a, m);
    if (a.seat < 0) return this.fail(ws, 'join');
    if (m.t === 'start') return this.start(ws, a.seat);
    if (m.t === 'leave') return this.leave(ws, a);
    if (m.t === 'act') return this.act(ws, a.seat, m);
  }

  webSocketClose(ws) {
    if (ws.deserializeAttachment().seat >= 0) this.left(ws);
  }

  webSocketError(ws) {
    if (ws.deserializeAttachment().seat >= 0) this.left(ws);
  }

  async alarm() {
    const r = this.r;
    if (!r) return;
    if (r.over && !r.paid) await this.settle().catch(() => {});
    if (r.dead && Date.now() >= r.dead && (!r.over || r.paid) && !this.owes()) return this.wipe();
    if (r.over) return this.arm();
    if (Date.now() >= this.due()) {
      if (!this.st) {
        if (r.started) await this.begin();
        else await this.drop();
      } else if (this.st.phase === 'gameend') this.advance();
      else this.step();
    } else this.arm();
  }

  // Lobby seats whose player stayed away past the grace period are freed.
  drop() {
    const r = this.r;
    r.seats.forEach((s, i) => {
      if (s && s.gone && Date.now() >= s.gone + GRACE * this.k) r.seats[i] = null;
    });
    if (r.pub && !r.seats.some(Boolean)) return this.wipe();
    if (r.go && Date.now() >= r.go) return this.go();
    if (!r.pub && !r.seats[r.host]) r.host = r.seats.findIndex(Boolean);
    this.save();
    this.send();
    this.arm();
    this.report();
  }

  fail(ws, k, more) {
    ws.send(JSON.stringify(Object.assign({ t: 'error', k: k }, more)));
  }

  refuse(ws, k) {
    this.fail(ws, k);
    ws.close(1000, k);
  }

  async create(ws, a, m) {
    if (this.r) return this.refuse(ws, 'taken');
    const n = m.players;
    const g = m.games;
    const stake = m.stake === undefined ? STAKES[0] : m.stake;
    if (!STAKES.includes(stake)) return this.fail(ws, 'opts');
    if (!Number.isInteger(n) || n < 2 || n > 5) return this.fail(ws, 'opts');
    if (!Number.isInteger(g) || g < n || g > 16 || g % n) return this.fail(ws, 'opts');
    const p = await verify(this.env.DB, m.auth);
    if (ws.readyState !== 1) return;
    if (!p) return this.refuse(ws, 'auth');
    if (this.r) return this.refuse(ws, 'taken');
    if (p.chips < ENTRY * stake) return this.refuse(ws, 'poor');
    this.r = {
      code: a.code, n: n, games: g, level: m.level === 'sharp' ? 'sharp' : 'relaxed', pub: false, stake: stake, host: -1,
      seats: Array(n).fill(null), started: false, over: false, since: 0, ready: [], dead: 0
    };
    this.join(ws, a, m, p);
  }

  async join(ws, a, m, p) {
    if (!this.r) return this.refuse(ws, 'nocode');
    if (a.seat >= 0) return;
    if (this.r.pub && !m.token) return this.refuse(ws, 'nocode');
    const rejoin = typeof m.token === 'string' && this.r.seats.some(s => s && s.token === m.token);
    if (!rejoin && !m.token && !p) {
      p = await verify(this.env.DB, m.auth);
      if (ws.readyState !== 1) return;
      if (!p) return this.refuse(ws, 'auth');
    }
    const r = this.r;
    if (!r) return this.refuse(ws, 'nocode');
    let i = typeof m.token === 'string' ? r.seats.findIndex(s => s && s.token === m.token) : -1;
    if (i < 0) {
      if (m.token) return this.refuse(ws, 'nocode');
      i = r.seats.findIndex(s => s && s.pid === p.id);
      if (i < 0) {
        if (r.started) return this.refuse(ws, 'started');
        if (p.chips < ENTRY * r.stake) return this.refuse(ws, 'poor');
        i = r.seats.indexOf(null);
        if (i < 0) return this.refuse(ws, 'full');
        r.seats[i] = human(seat(p), 0);
        if (r.host < 0) r.host = i;
      }
    }
    const s = r.seats[i];
    s.gone = 0;
    s.auto = false;
    if (!r.over) r.dead = 0;
    for (const w of this.socks()) if (w.deserializeAttachment().seat === i) w.close(4000, 'replaced');
    ws.serializeAttachment(Object.assign({}, a, { seat: i, sent: 0 }));
    ws.send(JSON.stringify({ t: 'joined', code: r.code, seat: i, token: s.token }));
    this.save();
    this.send();
    this.arm();
  }

  start(ws, i) {
    const r = this.r;
    if (i !== r.host || r.started) return this.fail(ws, 'host');
    return this.go();
  }

  // bots take the empty seats
  go() {
    const r = this.r;
    r.started = true;
    r.go = 0;
    for (let j = 0; j < r.n; j++) if (!r.seats[j]) r.seats[j] = { name: this.pick(), bot: true };
    this.report();
    this.arm();
    return this.begin();
  }

  // a second call while the stakes are being taken waits for the first
  begin() {
    return this.starting || (this.starting = this.deal().finally(() => { this.starting = null; }));
  }

  async deal() {
    const r = this.r;
    if (!r.id) r.id = crypto.randomUUID();
    this.save();
    for (let i = 0; i < r.n; i++) {
      const s = r.seats[i];
      if (!s.pid || s.esc) continue;
      // the escrow is the stake; a player who can no longer cover it is replaced by a bot
      if (await credit(this.env.DB, s.pid, -r.stake, 'escrow', r.id + ':in')) {
        s.esc = true;
        this.save();
        continue;
      }
      r.seats[i] = { name: s.name, seed: s.seed, av: s.av, level: s.level, bot: true };
      for (const w of this.socks()) {
        if (w.deserializeAttachment().seat !== i) continue;
        this.fail(w, 'poor');
        w.close(1000, 'poor');
      }
    }
    r.duo = r.seats.filter(s => s.pid).length > 1;
    const st = Game.newMatch({ players: r.n, games: r.games, level: r.level, allBots: true });
    st.players.forEach((p, i) => {
      p.name = r.seats[i].name;
      p.bot = !!r.seats[i].bot;
    });
    this.st = st;
    this.moved();
  }

  leave(ws, a) {
    const r = this.r;
    ws.serializeAttachment(Object.assign({}, a, { seat: -1 }));
    if (r.started) {
      const s = r.seats[a.seat];
      r.seats[a.seat] = { name: s.name, seed: s.seed, av: s.av, level: s.level, bot: true };
      if (this.st) this.st.players[a.seat].bot = true;
    } else {
      r.seats[a.seat] = null;
      if (r.host === a.seat) r.host = r.seats.findIndex(Boolean);
    }
    ws.close(1000, 'left');
    this.left(ws);
  }

  left(ws) {
    const r = this.r;
    if (!r) return;
    const i = ws.deserializeAttachment().seat;
    const rest = this.socks().filter(w => w !== ws);
    if (i >= 0 && !rest.some(w => w.deserializeAttachment().seat === i)) r.seats[i].gone = Date.now();
    if (!rest.length && !r.over) r.dead = Date.now() + KEEP * this.k;
    if (r.pub && !r.started && !r.seats.some(Boolean)) return this.ctx.waitUntil(this.wipe());
    this.save();
    this.send();
    this.arm();
    if (!r.over) this.report();
  }

  act(ws, i, m) {
    const st = this.st;
    const r = this.r;
    if (!st) return this.fail(ws, 'phase');
    if (m.a === 'next') {
      if (st.phase !== 'gameend') return this.fail(ws, 'phase');
      if (!r.ready.includes(i)) {
        r.ready.push(i);
        this.save();
      }
      if (this.humans().every(j => r.ready.includes(j))) this.advance();
      return;
    }
    if (st.phase === 'gameend' || st.phase === 'matchend' || this.actor() !== i) return this.fail(ws, 'turn');
    const res = this.apply(m);
    if (!res.ok) {
      const { ok, err, ...more } = res;
      return this.fail(ws, err, more);
    }
    r.seats[i].auto = false;
    r.seats[i].acted = true;
    this.moved();
  }

  apply(m) {
    const st = this.st;
    const bad = { ok: false, err: 'bad' };
    switch (m.a) {
      case 'choose': return Game.chooseTask(st, m.id);
      case 'draw': return Game.drawStock(st);
      case 'take': return Game.takeDiscard(st);
      case 'claim': return Game.claimTake(st);
      case 'pass': return Game.claimPass(st);
      case 'discard': return Game.discard(st, card(m.id));
      case 'open': case 'finish': {
        const ms = melds(m.melds);
        if (!ms) return bad;
        return m.a === 'open' ? Game.open(st, ms) : Game.finishHand(st, ms);
      }
      case 'lay': {
        const cs = cards(m.ids);
        return cs ? Game.layMeld(st, cs, m.type) : bad;
      }
      case 'add': {
        const cs = cards(m.ids);
        return cs ? Game.addToMeld(st, m.mid, cs) : bad;
      }
    }
    return bad;
  }

  actor() {
    const st = this.st;
    return st.phase === 'claim' ? Game.claimer(st) : st.turn;
  }

  socks() {
    return this.ctx.getWebSockets().filter(w => w.readyState === 1 && w.deserializeAttachment().seat >= 0);
  }

  here(i) {
    return this.socks().some(w => w.deserializeAttachment().seat === i);
  }

  humans() {
    return this.r.seats.map((s, i) => i).filter(i => !this.r.seats[i].bot && this.here(i));
  }

  // The bot plays for a human who stays away or idle, and keeps doing so until they act again.
  step() {
    const st = this.st;
    const i = this.actor();
    const s = this.r.seats[i];
    const p = st.players[i];
    if (!s.bot) s.auto = true;
    if (st.justOpened) st.played = true;
    p.bot = true;
    Game.botStep(st);
    p.bot = !!s.bot;
    this.moved();
  }

  advance() {
    Game.nextGame(this.st);
    this.r.ready = [];
    this.moved();
  }

  moved() {
    const r = this.r;
    r.since = Date.now();
    if (this.st.phase === 'matchend' && !r.over) {
      r.over = true;
      r.dead = Date.now() + KEEP * this.k;
      this.outcome();
      this.report(true);
    }
    this.save();
    this.send();
    this.arm();
    if (r.over && !r.paid) this.ctx.waitUntil(this.settle().catch(() => {}));
  }

  // What each human gets, worked out once at the end, and xp only when two humans started and this one played.
  outcome() {
    const { r, st } = this;
    const fin = st.stats.map(x => x.fin);
    r.res = r.seats.map((s, i) => {
      if (!s.pid || !s.esc) return null;
      const win = st.final.low === i;
      const pay = payout(r.stake, st.players[i].chips);
      const xp = r.duo && s.acted ? 10 * st.stats.length + (win ? 30 : 0) + 5 * fin.filter(f => f === i).length : 0;
      return { pid: s.pid, pay: pay, net: pay - r.stake, xp: xp, win: win, done: false };
    });
  }

  // a second call while the first is running waits for it
  settle() {
    return this.settling || (this.settling = this.pay().finally(() => { this.settling = null; }));
  }

  // Pays out and awards xp. Safe to run again: paid seats are skipped and the credit carries a ref.
  // A loss beyond the stake is taken from the balance, never below zero.
  async pay() {
    const r = this.r;
    for (const x of r.res) {
      if (!x || x.done) continue;
      let pay = x.pay;
      if (pay < 0) {
        const p = await player(this.env.DB, x.pid);
        pay = Math.max(pay, -(p ? p.chips : 0));
      }
      await credit(this.env.DB, x.pid, pay, 'match', r.id + ':out');
      x.done = true;
      this.save();
      if (x.xp) await award(this.env.DB, x.pid, { xp: x.xp, win: x.win });
    }
    r.paid = true;
    this.save();
  }

  // Stakes are held for a started match, so the bots play it out even when nobody is connected.
  owes() {
    const r = this.r;
    return r.started && !r.paid && r.seats.some(s => s.esc);
  }

  due() {
    const { r, st, k } = this;
    if (!st) {
      if (r.started) return 0;
      const due = r.seats.filter(s => s && s.gone).map(s => s.gone + GRACE * k);
      if (r.go) due.push(r.go);
      return due.length ? Math.min(...due) : Infinity;
    }
    if (st.phase === 'matchend') return r.paid ? Infinity : Date.now() + 5000 * k;
    if (!this.humans().length && !this.owes()) return Infinity;
    if (st.phase === 'gameend') return r.since + NEXT * k;
    const i = this.actor();
    const s = r.seats[i];
    const pace = (st.phase === 'claim' ? 500 : st.phase === 'draw' ? 800 : 1000) * k;
    if (s.bot || s.auto) return r.since + pace;
    if (!this.here(i)) return Math.max(r.since + pace, s.gone + GRACE * k);
    return r.since + IDLE * k;
  }

  arm() {
    const r = this.r;
    if (!r) return;
    // Sockets lost without a close event (a redeploy) never trigger left(), so notice here.
    if (!r.dead && !this.socks().length) {
      r.dead = Date.now() + KEEP * this.k;
      this.save();
    }
    const dead = (r.over && !r.paid) || this.owes() ? Infinity : r.dead || Infinity;
    const t = Math.min(this.due(), dead);
    // A lobby with no timer still gets a periodic check
    this.ctx.storage.setAlarm(Math.max(t < Infinity ? t : Date.now() + KEEP * this.k, Date.now()));
  }

  save() {
    this.ctx.storage.put('r', this.r);
    if (this.st) this.ctx.storage.put('st', Game.dump(this.st));
  }

  async wipe() {
    this.report(true);
    for (const w of this.ctx.getWebSockets()) w.close(1000, 'closed');
    this.r = this.st = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  pick() {
    const used = this.r.seats.map(s => s && s.name);
    const free = NAMES.filter(x => !used.includes(x));
    return free[Math.floor(Math.random() * free.length)];
  }

  send() {
    const here = new Set();
    for (const w of this.socks()) here.add(w.deserializeAttachment().seat);
    for (const w of this.socks()) {
      const a = w.deserializeAttachment();
      if (a.seat < 0) continue;
      if (this.st) {
        w.send(JSON.stringify(this.view(a.seat, a.sent, here)));
        w.serializeAttachment(Object.assign({}, a, { sent: this.st.log.length }));
      } else w.send(JSON.stringify(this.lobby(a.seat)));
    }
  }

  // what the Hub lists for a public table
  summary() {
    const r = this.r;
    return {
      stake: r.stake, started: r.started,
      seats: r.seats.map(s => s && !s.bot ? { seed: s.seed, av: s.av, level: s.level } : null),
      pids: r.seats.map(s => s && s.pid),
      left: r.go && !r.started ? Math.max(0, r.go - Date.now()) : null
    };
  }

  report(gone) {
    const r = this.r;
    if (!r || !r.pub) return;
    const hub = this.env.HUB.get(this.env.HUB.idFromName('h'));
    this.ctx.waitUntil(hub.table(r.code, gone ? null : this.summary()).catch(() => {}));
  }

  lobby(me) {
    const r = this.r;
    return {
      t: 'room', code: r.code, n: r.n, games: r.games, level: r.level, host: r.host, you: me,
      stake: r.stake, pub: r.pub, left: r.go && !r.started ? Math.max(0, r.go - Date.now()) : null,
      seats: r.seats.map(s => s && { name: s.name, seed: s.seed, av: s.av, level: s.level })
    };
  }

  // The view is rotated so the receiving seat is player 0 and the others follow in turn order;
  // every player index in it (turn, owner, queue, log p, ...) is in those terms. Actions
  // need no mapping since they name cards and melds, and the sender is the actor.
  view(me, sent, here) {
    const { r, st } = this;
    const n = st.n;
    const rot = i => (i < 0 ? i : (i - me + n) % n);
    const per = a => a.map((x, k) => a[(k + me) % n]);
    const ids = cs => cs.map(c => c.id);
    const res = st.result;
    return {
      t: 'state', lb: sent,
      n: n, stake: r.stake, games: st.games, gameNo: st.gameNo, level: st.level, pot: st.pot, phase: st.phase,
      task: st.task && st.task.id, tasksLeft: st.tasksLeft.map(x => x.id),
      turn: rot(st.turn), cutter: rot(st.cutter), chooser: rot(st.chooser),
      turns: st.turns, justOpened: st.justOpened, stock: st.stock.length, discard: ids(st.discard),
      melds: st.melds.map(m => ({ id: m.id, t: m.t, ids: ids(m.cards), owner: rot(m.owner) })),
      claim: st.claim && { card: st.claim.card.id, queue: st.claim.queue.map(rot), i: st.claim.i },
      players: per(st.players).map((p, k) => {
        const i = (k + me) % n;
        const o = {
          name: p.name, seed: r.seats[i].seed, av: r.seats[i].av, level: r.seats[i].level,
          bot: p.bot, away: !r.seats[i].bot && !here.has(i), n: p.hand.length,
          opened: p.opened, claims: p.claims, chips: p.chips, score: p.score
        };
        if (k === 0) o.hand = ids(p.hand);
        return o;
      }),
      res: r.res && r.res[me] ? { net: r.res[me].net, xp: r.res[me].xp } : undefined,
      result: res && { rows: per(res.rows), finisher: rot(res.finisher) },
      stats: st.stats.map(x => ({ fin: rot(x.fin), turns: x.turns, task: x.task })),
      lastFin: st.lastFin === undefined ? undefined : rot(st.lastFin),
      final: st.final && {
        order: st.final.order.map(rot), low: rot(st.final.low), finisher: rot(st.final.finisher),
        pay: per(st.final.pay), pot: st.final.pot
      },
      log: st.log.slice(sent).map(e => (e.p === undefined ? e : Object.assign({}, e, { p: rot(e.p) })))
    };
  }
}
