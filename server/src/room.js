import { DurableObject } from 'cloudflare:workers';
import Game from '../../www/js/game.js';

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const NAMES = ['Ece', 'Can', 'Deniz', 'Aylin', 'Mert', 'Selin', 'Arda', 'Defne', 'Kerem', 'Nil',
  'Onur', 'Ilke', 'Toprak', 'Su', 'Yaren', 'Baran', 'Mina', 'Ozan', 'Lale', 'Umut'];
const IDLE = 30000;
const GRACE = 8000;
const NEXT = 20000;
const KEEP = 600000;

export async function freeCode(ns) {
  for (let i = 0; i < 8; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    if (await ns.get(ns.idFromName(c)).free()) return c;
  }
  return null;
}

function clean(s) {
  s = typeof s === 'string' ? s : '';
  s = s.replace(/[\p{Cc}\p{Zl}\p{Zp}]|(?!\p{Join_Control})\p{Cf}|\p{Join_Control}(?!\p{Extended_Pictographic})|(?<!\p{Extended_Pictographic}\p{Variation_Selector}?)\p{Join_Control}/gu, '');
  return Array.from(s.trim()).slice(0, 16).join('').trim();
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

  // Called by the quick match queue: k humans at random seats, the rest bots.
  openPublic(code, k) {
    if (this.r) return null;
    const n = 4;
    const seats = Array(n).fill(null);
    this.r = {
      code: code, n: n, games: 8, level: 'relaxed', pub: true, host: -1, seats: seats,
      started: true, over: false, since: 0, ready: [], dead: Date.now() + KEEP * this.k
    };
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    const out = [];
    for (let j = 0; j < n; j++) {
      const i = order[j];
      if (j < k) {
        seats[i] = { name: this.pick(), token: crypto.randomUUID(), gone: Date.now() };
        out.push({ seat: i, token: seats[i].token });
      } else seats[i] = { name: this.pick(), bot: true };
    }
    this.begin();
    return out;
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
    if (r.dead && Date.now() >= r.dead) return this.wipe();
    if (Date.now() >= this.due()) {
      if (!this.st) this.drop();
      else if (this.st.phase === 'gameend') this.advance();
      else this.step();
    } else this.arm();
  }

  // Lobby seats whose player stayed away past the grace period are freed.
  drop() {
    const r = this.r;
    r.seats.forEach((s, i) => {
      if (s && s.gone && Date.now() >= s.gone + GRACE * this.k) r.seats[i] = null;
    });
    if (!r.seats[r.host]) r.host = r.seats.findIndex(Boolean);
    this.save();
    this.send();
    this.arm();
  }

  fail(ws, k, more) {
    ws.send(JSON.stringify(Object.assign({ t: 'error', k: k }, more)));
  }

  refuse(ws, k) {
    this.fail(ws, k);
    ws.close(1000, k);
  }

  create(ws, a, m) {
    if (this.r) return this.refuse(ws, 'taken');
    const n = m.players;
    const g = m.games;
    if (!Number.isInteger(n) || n < 2 || n > 5) return this.fail(ws, 'opts');
    if (!Number.isInteger(g) || g < n || g > 16 || g % n) return this.fail(ws, 'opts');
    this.r = {
      code: a.code, n: n, games: g, level: m.level === 'sharp' ? 'sharp' : 'relaxed', pub: false, host: -1,
      seats: Array(n).fill(null), started: false, over: false, since: 0, ready: [], dead: 0
    };
    this.join(ws, a, m);
  }

  join(ws, a, m) {
    const r = this.r;
    if (!r) return this.refuse(ws, 'nocode');
    if (a.seat >= 0) return;
    let i = typeof m.token === 'string' ? r.seats.findIndex(s => s && s.token === m.token) : -1;
    if (i < 0) {
      if (m.token) return this.refuse(ws, 'nocode');
      if (r.started) return this.refuse(ws, 'started');
      i = r.seats.indexOf(null);
      if (i < 0) return this.refuse(ws, 'full');
      r.seats[i] = { name: clean(m.name) || 'Player ' + (i + 1), token: crypto.randomUUID(), gone: 0 };
      if (r.host < 0) r.host = i;
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
    r.started = true;
    for (let j = 0; j < r.n; j++) if (!r.seats[j]) r.seats[j] = { name: this.pick(), bot: true };
    this.begin();
  }

  begin() {
    const r = this.r;
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
      r.seats[a.seat] = { name: r.seats[a.seat].name, bot: true };
      this.st.players[a.seat].bot = true;
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
    this.save();
    this.send();
    this.arm();
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
    }
    this.save();
    this.send();
    this.arm();
  }

  due() {
    const { r, st, k } = this;
    if (!st) {
      const gone = r.seats.filter(s => s && s.gone).map(s => s.gone + GRACE * k);
      return gone.length ? Math.min(...gone) : Infinity;
    }
    if (st.phase === 'matchend' || !this.humans().length) return Infinity;
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
    const t = Math.min(this.due(), r.dead || Infinity);
    // A lobby with no timer still gets a periodic check
    this.ctx.storage.setAlarm(Math.max(t < Infinity ? t : Date.now() + KEEP * this.k, Date.now()));
  }

  save() {
    this.ctx.storage.put('r', this.r);
    if (this.st) this.ctx.storage.put('st', Game.dump(this.st));
  }

  async wipe() {
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

  lobby(me) {
    const r = this.r;
    return {
      t: 'room', code: r.code, n: r.n, games: r.games, level: r.level, host: r.host, you: me,
      seats: r.seats.map(s => s && { name: s.name })
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
      n: n, games: st.games, gameNo: st.gameNo, level: st.level, pot: st.pot, phase: st.phase,
      task: st.task && st.task.id, tasksLeft: st.tasksLeft.map(x => x.id),
      turn: rot(st.turn), cutter: rot(st.cutter), chooser: rot(st.chooser),
      turns: st.turns, justOpened: st.justOpened, stock: st.stock.length, discard: ids(st.discard),
      melds: st.melds.map(m => ({ id: m.id, t: m.t, ids: ids(m.cards), owner: rot(m.owner) })),
      claim: st.claim && { card: st.claim.card.id, queue: st.claim.queue.map(rot), i: st.claim.i },
      players: per(st.players).map((p, k) => {
        const i = (k + me) % n;
        const o = {
          name: p.name, bot: p.bot, away: !r.seats[i].bot && !here.has(i), n: p.hand.length,
          opened: p.opened, claims: p.claims, chips: p.chips, score: p.score
        };
        if (k === 0) o.hand = ids(p.hand);
        return o;
      }),
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
