import { DurableObject } from 'cloudflare:workers';
import Game from '../../www/js/game.js';
import Names from '../../www/js/names.js';
import Chat from '../../www/js/chat.js';
import Catalog from '../../www/js/catalog.js';
import { verify, refusal, player, award, seat, credit, charge, strike, unstrike, grantTokens, hold, feeFor, barred, prizes, signedIn, stakeOk, strongFor, ENTRY } from './account.js';
import { owns } from './shop.js';
import { won, personaWeek, rel, apart } from './social.js';
import { clean, mask, contact } from './filter.js';
import { noteTrade } from './chat.js';
import { look, claim, release, giveBack, keep, spend, payoff, grant, stays } from './persona.js';
import { setting } from './admin.js';
import { flowRow, rematches } from './flow.js';
import { friendPay } from './friend.js';
import { on, act, slow, may, shut } from './voice.js';
import { hint, codeRegion, LEADS, PRIVATE, DEFAULT } from './region.js';

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const IDLE = 30000;
const GRACE = 8000;
// a seat gone this long from a started public match counts as a leave
const LAPSE = 90000;
// at the fast test pace a browser or a phone needs longer than the grace to open a socket to the table it was just seated at
const SLOW = 1500;
const NEXT = 20000;
const REMATCH = 15000;
// about one match in fifteen has a computer player away for a while
const AWAY = 1 / 15;
const KEEP = 600000;
const CUP_KEEP = 3 * 3600000;
const BURST = 3;
const LINES = 20;
const TYPED = 120;
const EVERY = 2000;
const GAP = 5000;
const HELLO = 4000;
const STRAYS = 8;
const TRIES = 3;
const DEAL_TRIES = 5;
const DEAL_TIME = 60000;
const DEAL_RETRY = 2000;
// a public table fills inside a window of 4 to 8 s from the first sit; a lobby player may stretch it in these steps up to the most
const MOST = 15000;
const STEP = 2000;
const ID = /^[0-9a-f]{32}$/;

export const stub = (ns, code) => ns.get(ns.idFromName(code), hint(code));

// a whole number below n that nobody can predict
export function pick(n) {
  const u = new Uint32Array(1);
  const top = 2 ** 32 - 2 ** 32 % n;
  do crypto.getRandomValues(u); while (u[0] >= top);
  return u[0] % n;
}

// a table of a region takes a code from that region's letters, any other room from the rest
export async function freeCode(ns, region) {
  const lead = region ? LEADS[region] : PRIVATE;
  for (let i = 0; i < 8; i++) {
    let c = lead[pick(lead.length)];
    for (let j = 0; j < 3; j++) c += LETTERS[pick(LETTERS.length)];
    if (await stub(ns, c).free()) return c;
  }
  return null;
}

function human(p, gone) {
  return { pid: p.pid, name: Names.text(p.seed, 'en'), seed: p.seed, av: p.av, level: p.level, wear: p.wear, vip: !!p.vip, token: crypto.randomUUID(), gone: gone };
}

const between = (lo, hi) => Math.round(lo + Math.random() * (hi - lo));

// How long a bot takes over its next move: mostly quick, now and then a long think,
// and very rarely nearly the whole clock.
function think(phase, idle) {
  const u = Math.random();
  if (u < 0.004) return between(0.75 * idle, 0.92 * idle);
  const f = idle / IDLE;
  if (u < 0.05) return Math.round(f * (phase === 'claim' ? between(4000, 9000) : between(6000, 15000)));
  const [lo, hi] = phase === 'play' ? [2500, 6500] : phase === 'claim' ? [1200, 3000] : [1500, 3500];
  return Math.round(f * (lo + (hi - lo) * Math.random() ** 2));
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
    // the test clock is no shorter than this, or a busy machine would lose its clients
    this.hello = Math.ceil(HELLO * Math.max(this.k, 0.2));
    this.bucket = {};
    this.asked = {};
    this.lines = [];
    this.vx = {};
    this.limit = new Map();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.r = (await ctx.storage.get('r')) || null;
      const s = await ctx.storage.get('st');
      this.st = s ? Game.load(s) : null;
      this.vx = (await ctx.storage.get('vx')) || {};
      if (this.r && this.r.over && !this.r.paid) ctx.storage.setAlarm(Date.now());
    });
  }

  free() {
    return !this.r;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const code = new URL(request.url).pathname.split('/')[2];
    if (this.ctx.getWebSockets().filter(w => w.readyState === 1 && w.deserializeAttachment().seat < 0).length >= STRAYS) return new Response('busy', { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    // only a test may ask for a longer wait
    const wait = this.env.PACE && Number(request.headers.get('X-Hello')) || this.hello;
    // the address and the made flag come from the Worker, which strips what a client sends under these names
    server.serializeAttachment({ seat: -1, sent: 0, code: code, due: now + wait, tries: 0, ip: request.headers.get('X-Amk-Addr') || '', made: request.headers.has('X-Amk-New') });
    const at = await this.ctx.storage.getAlarm();
    if (!at || at > now + wait) await this.ctx.storage.setAlarm(now + wait);
    return new Response(null, { status: 101, webSocket: client });
  }

  // when the first socket that has not taken a seat is due to be closed
  strays() {
    let t = Infinity;
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (w.readyState === 1 && a.seat < 0) t = Math.min(t, a.due);
    }
    return t;
  }

  // a socket that has not joined within the hello window never will; this also runs for a room that was never made
  sweep() {
    const now = Date.now();
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (w.readyState === 1 && a.seat < 0 && a.due <= now) w.close(1000, 'idle');
    }
  }

  // Called by the Hub. A public table is an ordinary room whose seats the Hub hands out.
  openTable(code, stake, region, scale) {
    if (this.r) return false;
    this.r = {
      code: code, n: 4, games: 4, pub: true, stake: stake, region: region, scale: scale, host: -1, seats: Array(4).fill(null),
      started: false, over: false, since: 0, go: 0, ready: [], dead: Date.now() + KEEP * this.k
    };
    this.save();
    this.arm();
    return true;
  }

  // Called by the Hub for a tournament table: a private room that is full and starts at once. Chips never
  // move here (the stake is 0), so the match runs as usual and the Hub settles the prizes. Returns the seat tokens,
  // the same ones again if the Hub asks twice for the same tournament.
  openCup(code, cup, seats) {
    if (this.r) return this.r.cup && this.r.cup.id === cup.id ? this.r.seats.map(s => s.bot ? null : s.token) : null;
    const bot = (s, more) => Object.assign({ pid: s.pid, name: Names.text(s.seed, 'en'), seed: s.seed, av: s.av, level: s.level, wear: s.wear, vip: !!s.vip, bot: true }, more);
    this.r = {
      code: code, n: 4, games: 4, pub: false, stake: 0, host: -1, cup: cup,
      seats: seats.map(s => s.fake ? bot(s, { fake: true, gone: 0 }) : s.left ? bot(s) : human(s, Date.now())),
      started: false, over: false, since: 0, go: 0, ready: [], dead: Date.now() + KEEP * this.k
    };
    this.save();
    this.ctx.waitUntil(this.go());
    return this.r.seats.map(s => s.bot ? null : s.token);
  }

  // The Hub is done with a first-round table once the final is seated, or at once when the tournament is cancelled.
  async cupClose(id, now) {
    const r = this.r;
    if (!r || !r.cup || r.cup.id !== id) return;
    if (now) return this.wipe();
    r.dead = Date.now() + KEEP * this.k;
    this.save();
    this.arm();
  }

  // Called by the Hub for a player it has checked. The socket joins afterwards with the token.
  // A refusal still carries the table as it is now, so the Hub keeps it listed.
  sit(p) {
    const r = this.r;
    if (!r || !(r.pub || r.open)) return null;
    let i = r.seats.findIndex(s => s && s.pid === p.pid);
    if (r.started || i < 0 && !r.seats.includes(null)) return { table: this.summary() };
    const since = Date.now() + Math.max(0, SLOW - GRACE * this.k);
    if (i >= 0) r.seats[i].gone = since;
    else {
      i = r.seats.indexOf(null);
      r.seats[i] = human(p, since);
      if (!r.go) this.window();
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
    if ((m.t === 'create' || m.t === 'join') && a.seat < 0) {
      a.tries = (a.tries || 0) + 1;
      ws.serializeAttachment(a);
      if (a.tries > TRIES) return ws.close(1008, 'tries');
    }
    if (m.t === 'create') return this.create(ws, a, m);
    if (m.t === 'join') return this.join(ws, a, m);
    if (a.seat < 0) return this.fail(ws, 'join');
    if (m.t === 'start') return this.start(ws, a.seat);
    if (m.t === 'leave') return this.leave(ws, a);
    if (m.t === 'back') return this.back(a.seat);
    if (m.t === 'rematch') return this.rematch(ws, a.seat);
    if (m.t === 'act') return this.act(ws, a.seat, m);
    if (m.t === 'say') return this.say(a.seat, m);
    if (m.t === 'text') return this.text(ws, a.seat, m);
    if (m.t === 'gift') return this.gift(ws, a.seat, m);
    if (m.t === 'invite') return this.invite(ws, a.seat, m);
  }

  webSocketClose(ws) {
    if (ws.deserializeAttachment().seat >= 0) this.left(ws);
  }

  webSocketError(ws) {
    if (ws.deserializeAttachment().seat >= 0) this.left(ws);
  }

  async alarm() {
    this.sweep();
    const r = this.r;
    if (!r) {
      const t = this.strays();
      if (t < Infinity) await this.ctx.storage.setAlarm(Math.max(t, Date.now() + 1));
      return;
    }
    await this.lapse();
    if (this.st) this.returned();
    if (r.over && !r.paid) await this.settle().catch(() => {});
    if (this.owes() && r.paid) await this.sendCup().catch(() => {});
    if (r.rm) return this.tick();
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
  async drop() {
    const r = this.r;
    r.seats.forEach((s, i) => {
      if (s && s.gone && Date.now() >= s.gone + GRACE * this.k) r.seats[i] = null;
    });
    if (this.pooled() && this.lonely()) return this.wipe();
    if (this.pooled() && !r.go) this.window();
    if (r.go && Date.now() >= this.fillAt()) return this.fill();
    if (!r.pub && !r.seats[r.host]) r.host = this.firstHuman();
    this.save();
    this.send();
    this.arm();
    this.report();
  }

  fail(ws, k, more) {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(Object.assign({ t: 'error', k: k }, more)));
  }

  refuse(ws, k, more) {
    this.fail(ws, k, more);
    ws.close(1000, k);
  }

  hub() {
    return this.env.HUB.get(this.env.HUB.idFromName('h'));
  }

  // A join that failed counts against the account and the address; past the budget even a good code is refused. An unknown, full
  // or started table gets the same answer. A code that exists says why its seat is refused (level, chips), since the invited need
  // to know; guessing codes is held back by the address budget on the misses.
  async miss(ws, a, p, k, more, late) {
    // only an unknown code is a probe; a full or started table (an invite tapped too late) and a refusal for level, games, chips or
    // a busy account are ordinary ones, charged to the account alone so people sharing an address are not shut out by each other
    const probe = !late && (!k || ['nocode', 'auth', 'banned'].includes(k));
    const over = probe && !!a.ip && !!this.env.PROBES && !(await this.env.PROBES.limit({ key: a.ip })).success;
    await this.hub().miss(p ? p.id : null, probe ? a.ip : null, over).catch(() => {});
    this.refuse(ws, k || 'nocode', more);
  }

  async create(ws, a, m) {
    // only a code handed out by /ws/new may be made, so a code cannot be tried by making it
    if (!a.made) return this.miss(ws, a, null);
    if (this.r) return this.refuse(ws, 'taken');
    const n = m.players;
    const g = m.games;
    // a stake left out means no chips
    const stake = m.stake === undefined ? 0 : m.stake;
    if (!stakeOk(stake)) return this.fail(ws, 'opts');
    if (!Number.isInteger(n) || n < 3 || n > 5) return this.fail(ws, 'opts');
    if (!Number.isInteger(g) || g < n || g > 16 || g % n) return this.fail(ws, 'opts');
    const p = await verify(this.env.DB, m.auth);
    if (ws.readyState !== 1) return;
    if (!p) return this.refuse(ws, await refusal(this.env.DB, m.auth));
    if (this.r) return this.refuse(ws, 'taken');
    const no = barred(p, stake, false);
    if (no) return this.refuse(ws, no.k, no);
    if (p.chips < ENTRY * stake) return this.refuse(ws, 'poor');
    this.r = {
      code: a.code, n: n, games: g, pub: false, stake: stake, region: p.region || DEFAULT, host: -1, scale: this.env.PACE ? Number(m.scale) || undefined : undefined,
      seats: Array(n).fill(null), started: false, over: false, since: 0, ready: [], dead: 0
    };
    this.join(ws, a, m, p);
  }

  async join(ws, a, m, p) {
    if (a.seat >= 0) return;
    // the account is looked at first, so a code that exists and one that does not get the same answer
    if (!m.token && !p) {
      p = await verify(this.env.DB, m.auth);
      if (ws.readyState !== 1) return;
      if (!p) return this.miss(ws, a, null, await refusal(this.env.DB, m.auth));
      if (await this.hub().probing(p.id, a.ip).catch(() => false)) return this.refuse(ws, 'nocode');
    }
    if (!this.r || this.r.pub && !m.token) return this.miss(ws, a, p);
    const rejoin = typeof m.token === 'string' && this.r.seats.some(s => s && s.token === m.token);
    // an opened room takes a seat from the same pool as a public table
    if (!rejoin && !m.token && this.r.open && !this.r.started && await this.hub().holds(p.id, this.r.code)) return this.miss(ws, a, p, 'busy');
    const r = this.r;
    if (!r) return this.miss(ws, a, p);
    let i = typeof m.token === 'string' ? r.seats.findIndex(s => s && s.token === m.token) : -1;
    if (i < 0) {
      if (m.token) return this.miss(ws, a, p);
      i = r.seats.findIndex(s => s && s.pid === p.id);
      // a seat the player left is played on by a stand-in and is not theirs any more
      if (i >= 0 && r.seats[i].bot && !r.seats[i].fake) return this.refuse(ws, 'left');
      if (i < 0) {
        if (r.started) return this.miss(ws, a, p, 'nocode', null, true);
        const no = barred(p, r.stake, false);
        if (no) return this.miss(ws, a, p, no.k, no);
        if (p.chips < ENTRY * r.stake) return this.miss(ws, a, p, 'poor');
        i = r.seats.indexOf(null);
        if (i < 0) return this.miss(ws, a, p, 'nocode', null, true);
        r.seats[i] = human(seat(p), 0);
        if (r.host < 0) r.host = i;
      }
    }
    const s = r.seats[i];
    s.gone = 0;
    if (!r.over) r.dead = 0;
    for (const w of this.socks()) if (w.deserializeAttachment().seat === i) w.close(4000, 'replaced');
    ws.serializeAttachment(Object.assign({}, a, { seat: i, sent: 0 }));
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'joined', code: r.code, seat: i, token: s.token }));
    this.save();
    this.send();
    this.arm();
    if (!r.over) this.report();
    if (r.open && !r.started && r.seats.every(Boolean)) this.ctx.waitUntil(this.go());
    await this.replay(ws, i);
  }

  // a private room whose host starts with empty seats looks for players like a public table
  async start(ws, i) {
    const r = this.r;
    if (i !== r.host || r.started) return this.fail(ws, 'host');
    if (r.open) return;
    // an account seated at a pool table elsewhere would pay two stakes
    const hub = this.env.HUB.get(this.env.HUB.idFromName('h'));
    for (const [k, s] of r.seats.entries()) {
      if (!s || s.fake || !await hub.holds(s.pid, r.code)) continue;
      for (const w of this.socks()) if (w.deserializeAttachment().seat === k) this.fail(w, 'elsewhere');
      return this.fail(ws, 'held', { seat: k });
    }
    if (r.open || r.started) return;
    if (r.seats.every(Boolean)) return this.go();
    r.open = true;
    this.window();
    this.save();
    this.send();
    this.arm();
    this.report();
  }

  idle() {
    return IDLE;
  }

  lag(lo, hi) {
    return between(lo, hi) * this.k;
  }

  pooled() {
    return this.r.pub || this.r.open;
  }

  firstHuman() {
    return this.r.seats.findIndex(s => s && !s.fake);
  }

  go() {
    const r = this.r;
    r.started = true;
    r.go = 0;
    delete r.first;
    delete r.next;
    this.report();
    this.arm();
    return this.begin();
  }

  // a persona who fits the humans seated now, one who is not already at this table
  async persona() {
    const { r } = this;
    const hs = r.seats.filter(s => s && !s.fake);
    const avg = hs.length ? Math.round(hs.reduce((n, s) => n + s.level, 0) / hs.length) : 1;
    const p = await claim(this.env.DB, r.code, avg, r.stake, r.seats.filter(Boolean).map(s => s.seed), feeFor(r.stake));
    return { pid: p.id, name: Names.text(p.name_seed, 'en'), seed: p.name_seed, av: p.avatar.split(',').map(Number), level: p.level, bank: p.chips, bot: true, fake: true, gone: 0, ...look(p) };
  }

  // The room may be gone or full again after the wait, and a player may have taken the seat meanwhile. With keep, the last
  // open seat is left for a person.
  async seatOne(keep) {
    const r = this.r;
    const p = await this.persona();
    const i = this.r === r && !r.started && !(keep && r.seats.filter(s => !s).length < 2) ? r.seats.indexOf(null) : -1;
    if (i < 0) {
      await giveBack(this.env.DB, p.pid);
      return false;
    }
    r.seats[i] = p;
    return true;
  }

  // The table fills inside one window that ends 4 to 8 s after the first person sat, and the match starts at its end.
  // A persona sits every 1 to 2 s meanwhile, but never in the last open seat.
  window() {
    const r = this.r;
    const f = r.scale && this.env.PACE ? r.scale : 1;
    r.first = Date.now();
    r.go = r.first + this.lag(4000, 8000) * f;
    r.next = r.first + this.lag(1000, 2000) * f;
  }

  // when the table next has something to do: a persona for a seat that is not the last one, or the end of the window
  fillAt() {
    const r = this.r;
    return r.seats.filter(s => !s).length > 1 ? Math.min(r.go, r.next) : r.go;
  }

  async fill() {
    const r = this.r;
    const now = Date.now();
    const f = r.scale && this.env.PACE ? r.scale : 1;
    if (now < r.go) {
      r.next = now + this.lag(1000, 2000) * f;
      await this.seatOne(true);
      if (this.r !== r || r.started) return;
      this.save();
      this.send();
      this.arm();
      return this.report();
    }
    // somebody of the region who is looking at the lobby may be on the way, so the last seat waits a little longer
    const cap = r.first + MOST * this.k * f;
    if (r.go < cap && await this.hub().lobbied(r.region || codeRegion(r.code)).catch(() => false)) {
      if (this.r !== r || r.started) return;
      r.go = Math.min(r.go + STEP * this.k * f, cap);
      this.save();
      return this.arm();
    }
    while (r.seats.includes(null)) if (!await this.seatOne()) return;
    this.send();
    return this.go();
  }

  // a second call while the stakes are being taken waits for the first
  begin() {
    return this.starting || (this.starting = this.attempt().finally(() => { this.starting = null; }));
  }

  // A deal that fails is tried again a little later; after DEAL_TRIES tries or DEAL_TIME the table gives up and
  // everything taken is given back, so a table can never hold stakes for a match that does not start.
  async attempt() {
    const r = this.r;
    if (r.giveup) return this.giveUp();
    if (!r.dealt) r.dealt = Date.now();
    try {
      await this.deal();
    } catch (e) {
      if (this.r !== r) return;
      r.tries = (r.tries || 0) + 1;
      console.error('deal', r.code, r.tries, e && e.message);
      if (r.tries >= DEAL_TRIES || Date.now() - r.dealt >= DEAL_TIME * this.k) return this.giveUp();
      r.retry = Date.now() + DEAL_RETRY * this.k;
      this.save();
      this.arm();
    }
  }

  // the test hook: a settings row names the kind of table, how many more times to fail and at which seat
  async broken(i) {
    if (!this.env.PACE) return;
    const row = await setting(this.env.DB, 'faildeal');
    const h = row && JSON.parse(row);
    const kind = this.r.cup ? 'cup' : this.r.pub ? 'pub' : 'friend';
    if (!h || h.n <= 0 || h.kind !== kind || h.seat !== i) return;
    await this.env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'faildeal'").bind(JSON.stringify(Object.assign({}, h, { n: h.n - 1 }))).run();
    // a wait stalls the deal at this seat, for a test that acts while it is in flight
    if (h.wait) return new Promise(res => setTimeout(res, h.wait));
    throw new Error('forced failure');
  }

  // Stakes go back with the ref <match>:back, a computer player's with its bank. Each seat is marked as it is done,
  // so a failure in the middle is finished by the next call.
  async giveUp() {
    const { r } = this;
    r.giveup = true;
    this.save();
    try {
      for (const s of r.seats) {
        if (!s || !s.esc || s.back) continue;
        if (s.fake) {
          s.back = true;
          this.save();
          await grant(this.env.DB, s.pid, this.heldOf(s) + this.feeOf(s));
        } else {
          await credit(this.env.DB, s.pid, this.heldOf(s), 'escrow', r.id + ':back');
          await credit(this.env.DB, s.pid, this.feeOf(s), 'fee', r.id + ':feeback');
          // a leave during a deal that failed never was a leave: its row goes and an extra stake it cost comes back
          if (s.left) await unstrike(this.env.DB, s.pid, r.id);
          s.back = true;
          this.save();
        }
      }
    } catch (e) {
      r.retry = Date.now() + DEAL_RETRY * this.k;
      this.save();
      return this.arm();
    }
    r.aborted = true;
    this.save();
    for (const w of this.socks()) this.fail(w, 'dealfail');
    // a tournament table is the Hub's to end, which returns the buy-ins; a public table is wiped
    if (r.cup) return this.ctx.waitUntil(this.hub().cupFail(r.cup.id).catch(() => {}));
    if (r.pub) return this.wipe();
    // a friend table starts over with whoever is still seated, as a rematch does
    const gone = r.seats.map(s => s && (s.fake || s.bot && s.pid));
    for (const w of this.socks()) {
      const a = w.deserializeAttachment();
      if (gone[a.seat]) {
        w.serializeAttachment(Object.assign({}, a, { seat: -1 }));
        w.close(1000, 'poor');
      }
    }
    for (const s of r.seats) if (s && s.fake) await giveBack(this.env.DB, s.pid);
    r.seats = r.seats.map((s, i) => gone[i] ? null : s);
    for (const s of r.seats) if (s) for (const k of ['esc', 'held', 'fee', 'from', 'bank', 'back', 'acts', 'autos', 'auto', 'misses', 'cover', 'awayAt', 'away']) delete s[k];
    for (const k of ['id', 'res', 'paid', 'wait', 'tries', 'dealt', 'retry', 'giveup', 'aborted', 'sharp', 'rolled']) delete r[k];
    Object.assign(r, { started: false, over: false, since: 0, go: 0, ready: [], dead: 0 });
    if (r.open) this.window();
    if (!r.seats.some(s => s && s.pid && !s.fake)) r.dead = Date.now() + KEEP * this.k;
    if (r.host >= 0 && !r.seats[r.host]) r.host = this.firstHuman();
    this.st = null;
    this.ctx.storage.delete('st');
    this.save();
    this.send();
    this.arm();
    this.report();
  }

  lonely() {
    return this.firstHuman() < 0;
  }

  async deal() {
    const r = this.r;
    if (!r.id) r.id = crypto.randomUUID();
    this.save();
    const held = hold(r.stake, r.games);
    const fee = feeFor(r.stake);
    for (let i = 0; i < r.n; i++) {
      const s = r.seats[i];
      if (s.fake) {
        if (!s.esc) {
          await this.broken(i);
          s.bank = await spend(this.env.DB, s.pid, held + fee);
          Object.assign(s, { esc: true, held: held, fee: fee });
          this.save();
        }
        continue;
      }
      if (!s.pid || s.bot || s.esc) continue;
      await this.broken(i);
      // what is held and the fee go together; a player who can no longer cover both is replaced by a bot and pays nothing
      // a ban lands while the table waits, when match_seat holds no row yet: the seat is taken out here and costs nothing
      const banned = await this.env.DB.prepare('SELECT banned FROM players WHERE id = ?').bind(s.pid).first();
      // a leave swaps the seat for a copy, so after every wait the seat is looked up again; one already left is not charged
      if (r.seats[i] !== s) continue;
      if (!(banned && banned.banned) && await charge(this.env.DB, s.pid, held, fee, r.id)) {
        // saved at once: if the next read fails for good, the refund still knows what was taken
        const cur = r.seats[i];
        Object.assign(cur, { esc: true, held: held, fee: fee });
        if (cur !== s) {
          // the player left while the charge was in flight: the stand-in settles the real result and the row is written now
          cur.left = true;
          this.ctx.waitUntil(this.gone(cur, i, false).catch(e => console.error('leave', e)));
        }
        this.save();
        const p = await player(this.env.DB, s.pid);
        cur.bank = p ? p.chips : 0;
        cur.from = p ? p.xp : 0;
        this.save();
        continue;
      }
      if (r.seats[i] !== s) continue;
      r.seats[i] = { pid: s.pid, name: s.name, seed: s.seed, av: s.av, level: s.level, wear: s.wear, vip: !!s.vip, bot: true };
      for (const w of this.socks()) {
        if (w.deserializeAttachment().seat !== i) continue;
        if (banned && banned.banned) w.close(4002, 'banned');
        else {
          this.fail(w, 'poor');
          w.close(1000, 'poor');
        }
      }
      this.report();
    }
    await this.record();
    const sharp = await this.sharpSeats();
    await this.awayRoll();
    const st = Game.newMatch({ players: r.n, games: r.games, level: 'relaxed', allBots: true });
    st.players.forEach((p, i) => {
      p.name = r.seats[i].name;
      p.bot = !!r.seats[i].bot;
      p.level = sharp.includes(i) ? 'sharp' : 'relaxed';
    });
    this.st = st;
    this.moved();
  }

  // Which computer seats play sharp: as many as the ladder gives this table, picked at random once per match. Only the stake, the
  // buy-in and the number of computer seats count, never anything about the people seated.
  async sharpSeats() {
    const { r } = this;
    if (!r.sharp) {
      const ladder = JSON.parse(await setting(this.env.DB, 'strong') || '{}');
      const fakes = r.seats.map((s, i) => s.fake ? i : -1).filter(i => i >= 0);
      r.sharp = [];
      for (let n = Math.min(strongFor(ladder, r.stake, r.cup && r.cup.buy), fakes.length); n > 0; n--) r.sharp.push(fakes.splice(pick(fakes.length), 1)[0]);
      this.save();
    }
    return r.sharp;
  }

  // Once per match, one computer seat may be set to go away a while after the start; the odds are a guess the daily totals let us retune.
  async awayRoll() {
    const { r } = this;
    if (r.rolled) return;
    r.rolled = true;
    const odds = this.env.PACE ? Number(await setting(this.env.DB, 'awayodds')) || AWAY : AWAY;
    const fakes = r.seats.map((s, i) => s.fake ? i : -1).filter(i => i >= 0);
    if (fakes.length && Math.random() < odds) r.seats[fakes[pick(fakes.length)]].awayAt = Date.now() + between(10000, 60000) * this.k;
    this.save();
  }

  // a computer player in the middle of its time away
  away(s) {
    return !!s && !!s.fake && s.away > Date.now();
  }

  // when the first computer player now away is due back
  awayEnd() {
    return Math.min(Infinity, ...this.r.seats.filter(s => this.away(s)).map(s => s.away));
  }

  // a computer player whose time is up is back, and the table is told
  returned() {
    let any = false;
    for (const s of this.r.seats) {
      if (s && s.away && s.away <= Date.now()) {
        delete s.away;
        any = true;
      }
    }
    if (!any) return;
    this.save();
    this.send();
  }

  // one row per seat that took part, computer players too; a repeat of the deal leaves the first rows as they are
  seatRow(s, i, at) {
    const { r } = this;
    return this.env.DB.prepare('INSERT OR IGNORE INTO match_seat (match, code, kind, stake, player, fake, seat, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(r.id, r.code, r.cup ? 'cup' : r.pub ? 'pub' : 'friend', r.stake, s.pid, s.fake ? 1 : 0, i, at);
  }

  record() {
    const rows = this.r.seats.map((s, i) => s.esc && this.seatRow(s, i, Date.now())).filter(Boolean);
    return rows.length ? this.env.DB.batch(rows) : null;
  }

  // The seat keeps its escrow and counters, so the match settles it by its real result; it plays on as a relaxed stand-in with no
  // token of its own, and nothing from a match left early counts for xp, tokens or wins.
  leave(ws, a) {
    const r = this.r;
    if (r.seats[a.seat]) this.hush(r.seats[a.seat].pid);
    ws.serializeAttachment(Object.assign({}, a, { seat: -1 }));
    this.release(a.seat, r.pub && !r.cup);
    ws.close(1000, 'left');
    this.left(ws);
  }

  // the seat of a started match becomes a relaxed stand-in that settles by the real result; count says whether it is a counted leave
  release(i, count) {
    const r = this.r;
    if (r.started) {
      const { token, gone, auto, misses, cover, ...s } = r.seats[i];
      const live = !!r.id && !r.over && !!s.esc;
      r.seats[i] = Object.assign(s, { bot: true, left: live || undefined });
      if (this.st) {
        this.st.players[i].bot = true;
        this.st.players[i].level = 'relaxed';
      }
      if (live) this.ctx.waitUntil(this.gone(r.seats[i], i, count).catch(e => console.error('leave', e)));
    } else {
      r.seats[i] = null;
      if (r.host === i) r.host = this.firstHuman();
    }
  }

  // a banned player is taken out like a leaver, at no cost
  ban(pid) {
    const r = this.r;
    const i = r ? r.seats.findIndex(s => s && s.pid === pid && !s.bot) : -1;
    if (i < 0) return;
    this.hush(pid);
    const mine = this.socks().filter(w => w.deserializeAttachment().seat === i);
    for (const w of mine) w.serializeAttachment(Object.assign({}, w.deserializeAttachment(), { seat: -1 }));
    this.release(i, false);
    for (const w of mine) w.close(4002, 'banned');
    this.left(mine[0]);
  }

  // The row is made too, in case the deal had not recorded it yet. A leave from a public table is counted and may cost chips.
  async gone(s, i, count) {
    const { r } = this;
    const now = Date.now();
    await this.env.DB.batch([
      this.seatRow(s, i, now),
      this.env.DB.prepare('UPDATE match_seat SET gone = 1, gone_at = ? WHERE match = ? AND player = ?').bind(now, r.id, s.pid)
    ]);
    if (count) await strike(this.env.DB, s.pid, r.id, r.code, r.stake, now);
  }

  // the test pace keeps a floor, so a slow machine can still come back in time
  lapseMs() {
    return LAPSE * Math.max(this.k, 0.05);
  }

  // a human seat gone from a started public match for that long
  lapseAt() {
    const { r } = this;
    if (!r.pub || r.cup || !r.started || r.over || !this.st) return Infinity;
    const due = r.seats.filter(s => s && s.gone && !s.bot && !s.lv && s.esc).map(s => s.gone + this.lapseMs());
    return due.length ? Math.min(...due) : Infinity;
  }

  async lapse() {
    const { r } = this;
    if (!r || this.lapseAt() > Date.now()) return;
    for (const [i, s] of r.seats.entries()) {
      if (!s || !s.gone || s.bot || s.lv || !s.esc || Date.now() < s.gone + this.lapseMs()) continue;
      s.lv = true;
      this.save();
      await this.gone(s, i, true).catch(e => console.error('lapse', e));
    }
  }

  left(ws) {
    const r = this.r;
    if (!r) return;
    const i = ws ? ws.deserializeAttachment().seat : -1;
    const rest = this.socks().filter(w => w !== ws);
    if (i >= 0 && !rest.some(w => w.deserializeAttachment().seat === i)) {
      r.seats[i].gone = Date.now();
      this.hush(r.seats[i].pid);
    }
    if (!rest.length && !r.over) r.dead = Date.now() + KEEP * this.k;
    if (this.pooled() && !r.started && this.lonely()) return this.ctx.waitUntil(this.wipe());
    this.save();
    this.send();
    this.arm();
    if (!r.over || r.rm || r.cup) this.report();
    if (r.rm) this.hurry();
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
    this.resume(r.seats[i]);
    r.seats[i].acts = (r.seats[i].acts || 0) + 1;
    this.moved();
  }

  // a short burst of chat or gifts, then one every two seconds; kept in memory, so a restart only forgives
  allow(i) {
    const now = Date.now();
    const b = this.bucket[i] || (this.bucket[i] = { n: BURST, at: now });
    b.n = Math.min(BURST, b.n + (now - b.at) / EVERY);
    b.at = now;
    if (b.n < 1) return false;
    b.n--;
    return true;
  }

  // sends each seated socket a message built with the seat numbers as that viewer counts them
  cast(make) {
    const n = this.r.n;
    for (const w of this.socks()) {
      const me = w.deserializeAttachment().seat;
      w.send(JSON.stringify(make(i => (i - me + n) % n)));
    }
  }

  async say(i, m) {
    const pack = Catalog.pack(m.k);
    if (!this.st || !(Chat.SAY.includes(m.k) || Chat.EMO.includes(m.k) || pack) || !this.allow(i)) return;
    // an extra emote is for whoever bought its pack
    if (pack) {
      const s = this.r.seats[i];
      if (!s.pid || !await owns(this.env.DB, s.pid, pack.id)) return;
      if (!this.st || this.r.seats[i] !== s) return;
    }
    this.cast(rot => ({ t: 'said', p: rot(i), k: m.k }));
  }

  // Typed chat reaches the people at this table, except those who blocked the sender or were blocked by them or switched typed
  // chat off. The last few lines are kept in memory for a player who reconnects.
  async text(ws, i, m) {
    const s = this.r.seats[i];
    const x = clean(m.x, TYPED);
    if (!this.st || !x || !s.pid || s.bot || !this.allow('t' + i)) return;
    // contact details go out only once the sender has agreed to a warning
    const c = contact(x);
    if (c && m.ok !== true) return ws.readyState === 1 && ws.send(JSON.stringify({ t: 'confirm', k: 'contact' }));
    const ids = this.r.seats.filter(q => q && q.pid && !q.bot).map(q => q.pid);
    const [away, rows] = await Promise.all([apart(this.env.DB, s.pid),
      this.env.DB.prepare('SELECT id, typed, mute_until, lang FROM players WHERE id IN (' + ids.map(() => '?').join() + ')').bind(...ids).all()]);
    if (!this.r) return;
    const me = rows.results.find(q => q.id === s.pid);
    if (!me || !me.typed) return this.fail(ws, 'typedoff');
    if (me.mute_until > Date.now()) return this.fail(ws, 'mute');
    for (const q of rows.results) if (!q.typed) away.add(q.id);
    await noteTrade(this.env.DB, s.pid, this.r.code, x);
    if (!this.r) return;
    this.lines.push({ i: i, pid: s.pid, lang: me.lang, x: x, c: c });
    if (this.lines.length > LINES) this.lines.shift();
    const n = this.r.n;
    // each reader gets the words masked for their own language and the sender's
    for (const w of this.socks()) {
      const at = w.deserializeAttachment().seat;
      const you = this.r.seats[at].pid;
      if (!away.has(you)) w.send(JSON.stringify({ t: 'typed', p: (i - at + n) % n, x: mask(x, [me.lang, (rows.results.find(q => q.id === you) || {}).lang]), c: c }));
    }
  }

  async replay(ws, i) {
    if (!this.lines.length) return;
    const pid = this.r.seats[i].pid;
    const [away, me] = await Promise.all([apart(this.env.DB, pid), player(this.env.DB, pid)]);
    if (!this.r || ws.readyState !== 1 || !me || !me.typed) return;
    const n = this.r.n;
    for (const l of this.lines) {
      // a line whose sender no longer sits in that seat is left out
      if (away.has(l.pid) || !this.r.seats[l.i] || this.r.seats[l.i].pid !== l.pid) continue;
      ws.send(JSON.stringify({ t: 'typed', p: (l.i - i + n) % n, x: mask(l.x, [l.lang, me.lang]), c: l.c, old: true }));
    }
  }

  // The cost is the whole point: nobody receives chips, so gifts only take them out of play.
  async gift(ws, i, m) {
    const { r, st } = this;
    const g = Chat.GIFTS.find(x => x.k === m.k);
    if (!st || r.over || !g || !Number.isInteger(m.to) || m.to < 1 || m.to >= r.n || !this.allow(i)) return;
    const to = (i + m.to) % r.n;
    const s = r.seats[i];
    const t = r.seats[to];
    if (!s.pid) return;
    const me = await player(this.env.DB, s.pid);
    if (!me || !signedIn(me)) return this.fail(ws, 'guest');
    if (t.pid) {
      // a player who was blocked is not told
      const k = await rel(this.env.DB, s.pid, t.pid);
      if (k === 'blocked') return;
      if (k === 'block') return this.fail(ws, 'blocked');
    }
    if (!await credit(this.env.DB, s.pid, -g.cost, 'gift', r.id + ':gift:' + crypto.randomUUID())) return this.fail(ws, 'broke');
    const p = await player(this.env.DB, s.pid);
    s.bank = p ? p.chips : 0;
    this.save();
    this.send();
    this.cast(rot => ({ t: 'gifted', from: rot(i), to: rot(to), k: g.k }));
  }

  // Voice at the table goes through the Worker's SFU proxy: only people seated here with voice on can publish or listen, and nobody
  // hears a player who blocked them or was blocked by them.
  async vox(pid, op, b) {
    const seated = q => !!this.r && this.r.seats.some(s => s && s.pid === q && !s.bot);
    if (!on(this.env) || !seated(pid)) return { status: 403, body: { error: 'seat' } };
    if (slow(this.limit, pid)) return { status: 429, body: { error: 'slow' } };
    const p = await player(this.env.DB, pid);
    if (!p || !p.voice || !seated(pid)) return { status: 403, body: { error: 'off' } };
    const res = await act(this.env, this.vx, op, pid, b, async q => seated(q) && await may(this.env.DB, pid, q));
    if (this.r) this.ctx.storage.put('vx', this.vx);
    if (res.status === 200 && (op === 'mic' || op === 'stop')) await this.voiced(pid, op === 'mic');
    return res;
  }

  // tells the table that a player started or stopped talking, except those who must not hear them
  async voiced(pid, live) {
    const away = await apart(this.env.DB, pid);
    if (!this.r) return;
    for (const w of this.socks()) {
      const q = this.r.seats[w.deserializeAttachment().seat];
      if (q && q.pid !== pid && !away.has(q.pid)) w.send(JSON.stringify({ t: 'voice', pid: pid, on: live }));
    }
  }

  // a player who left or lost the connection no longer talks
  hush(pid) {
    const e = this.vx[pid];
    if (!e) return;
    delete this.vx[pid];
    this.ctx.storage.put('vx', this.vx);
    this.ctx.waitUntil(Promise.all([shut(this.env, e), this.voiced(pid, false)]).catch(() => {}));
  }

  // the Hub knows who is in the lobby, so the table asks it to pass the invitation on
  async invite(ws, i, m) {
    const r = this.r;
    const s = r.seats[i];
    const reply = ok => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'sent', to: m.to, ok: ok }));
    if (!s.pid || typeof m.to !== 'string' || !ID.test(m.to)) return;
    if (r.started || !r.seats.includes(null) || !this.allow(i)) return reply(false);
    if (Date.now() - (this.asked[m.to] || 0) < GAP) return reply(true);
    const hub = this.env.HUB.get(this.env.HUB.idFromName('h'));
    const ok = await hub.invite({ pid: s.pid, seed: s.seed, av: s.av, level: s.level }, m.to, r.code, r.stake, r.pub).catch(() => false);
    if (ok) this.asked[m.to] = Date.now();
    reply(ok);
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

  // the turn in progress, the same for every phase of it
  turn() {
    return this.st.gameNo + ':' + this.st.turns;
  }

  // a seat that plays for itself again: no missed turns, no stand-in
  resume(s) {
    s.auto = false;
    s.misses = 0;
    delete s.cover;
  }

  // The player is back: the stand-in stops and the clock of the seat starts afresh.
  back(i) {
    const { r, st } = this;
    const s = r.seats[i];
    if (!st || !s || s.bot || !(s.auto || s.misses || s.cover)) return;
    this.resume(s);
    if (st.phase !== 'gameend' && st.phase !== 'matchend' && this.actor() === i) r.since = Date.now();
    this.save();
    this.send();
    this.arm();
  }

  // The stand-in plays for a human whose clock ran out or who is gone. A missed turn is played to its end with safe moves and the
  // player keeps control; the second missed turn in a row, or a lost connection, sets the seat to away until the player is back.
  step() {
    const st = this.st;
    const i = this.actor();
    const r = this.r;
    const s = r.seats[i];
    if (s.awayAt && Date.now() >= s.awayAt) {
      delete s.awayAt;
      s.away = Date.now() + between(10000, 40000) * this.k;
    }
    if (!s.bot) {
      s.autos = (s.autos || 0) + 1;
      if (st.phase !== 'claim' && s.cover !== this.turn()) {
        s.cover = this.turn();
        s.misses = (s.misses || 0) + 1;
      }
      if (s.misses >= 2 || !this.here(i)) s.auto = true;
    }
    if (st.justOpened) st.played = true;
    // a computer player away plays what a stand-in for a person would, so the two look alike
    if (s.bot) this.away(s) ? Game.safeStep(st) : Game.botStep(st);
    else if (s.lv) {
      // a counted leave plays like one that pressed Leave, but the seat can still be taken back by its player
      const p = st.players[i];
      const bot = p.bot;
      Object.assign(p, { bot: true, level: 'relaxed' });
      Game.botStep(st);
      p.bot = bot;
    } else Game.safeStep(st);
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
      // a first-round table stays until the Hub closes it, as its qualifiers wait on the other table
      r.dead = Date.now() + (r.cup && r.cup.round === 'first' ? CUP_KEEP : KEEP) * this.k;
      this.outcome();
      if (!this.humans().length) this.report(true);
    } else if (this.st.phase !== 'matchend') r.wait = think(this.st.phase, this.idle()) * this.k;
    this.save();
    this.send();
    this.arm();
    if (r.over && !r.paid) this.ctx.waitUntil(this.settle().catch(() => {}));
  }

  // What a seat had set aside and paid as the fee, as recorded at the deal. A match dealt before the money rules changed
  // (a restart can land in the middle of one) set aside only the stake and took no fee.
  heldOf(s) {
    return s.held === undefined ? this.r.stake : s.held;
  }

  feeOf(s) {
    return s.fee === undefined ? 0 : s.fee;
  }

  // What each human gets, worked out once at the end, and xp only when this one played.
  outcome() {
    const { r, st } = this;
    const fin = st.stats.map(x => x.fin);
    // a friend table for no chips is a place to play with friends, not a way to earn
    const free = !r.stake && !r.cup;
    // only public tables count for the weekly board; a tournament's prizes are counted by the Hub
    const board = r.pub && !r.cup;
    r.res = r.seats.map((s, i) => {
      if (!s.pid || !s.esc) return null;
      const win = st.final.low === i;
      const held = this.heldOf(s);
      const fee = this.feeOf(s);
      let pay = held + st.players[i].chips * r.stake / 10;
      // what is held covers the worst loss, so this is only a guard
      // a match dealt before the hold took only the stake and charged the rest of a loss from the balance (see pay())
      if (pay < 0 && s.held !== undefined) {
        console.error('loss past the hold', r.code, s.pid, pay);
        pay = 0;
      }
      const played = !free && !s.left && !s.lv && (s.fake || (s.acts || 0) > (s.autos || 0));
      const xp = played ? 10 * st.stats.length + (win ? 30 : 0) + 5 * fin.filter(f => f === i).length : 0;
      return { pid: s.pid, pay: pay, net: pay - held - fee, xp: xp, from: s.from, win: win, won: board && played && pay > held ? pay - held : 0, fake: s.fake, done: false };
    });
    // taken now: a seat that leaves after the end must not change what the Hub is told
    if (r.cup) r.cup.order = st.final.order.map(i => ({ pid: r.seats[i].pid, left: !r.seats[i].fake && !!r.seats[i].bot, played: !!(r.res[i] && r.res[i].xp), sharp: (r.sharp || []).length, fakes: r.seats.filter(q => q.fake).length }));
  }

  net(pid, n) {
    return this.env.DB.prepare('UPDATE match_seat SET net = ? WHERE match = ? AND player = ?').bind(n, this.r.id, pid).run();
  }

  // a second call while the first is running waits for it
  settle() {
    return this.settling || (this.settling = this.pay().finally(() => { this.settling = null; }));
  }

  // Pays out and awards xp. Safe to run again: paid seats are skipped and the credit carries a ref.
  async pay() {
    const r = this.r;
    for (const [i, x] of r.res.entries()) {
      if (!x || x.done) continue;
      if (x.fake) {
        // set first: a repeat would pay the persona twice, and nobody can see the difference
        x.done = true;
        this.save();
        if (r.stake) r.seats[i].bank = await payoff(this.env.DB, x.pid, x.pay, x);
        if (r.pub && !r.cup) await personaWeek(this.env.DB, x.pid, x.won, x.xp);
        await this.net(x.pid, x.net);
        continue;
      }
      if (x.pay < 0) {
        const p = await player(this.env.DB, x.pid);
        x.pay = Math.max(x.pay, -(p ? p.chips : 0));
        this.save();
      }
      // a friend table's winnings count toward the day's cap, and what is over it waits for the admin
      if (r.stake && !r.pub && !r.cup) await friendPay(this.env.DB, x.pid, x.pay, x.net, r.id);
      else await credit(this.env.DB, x.pid, x.pay, 'match', r.id + ':out');
      await this.net(x.pid, x.net);
      x.done = true;
      this.save();
      if (x.xp) await award(this.env.DB, x.pid, { xp: x.xp, win: x.win, pub: r.pub && !r.cup });
      // a finished match pays tokens up to the day's cap; a seat taken over by a bot did not finish it
      if (x.xp && !r.seats[i].bot && await grantTokens(this.env.DB, x.pid, Catalog.MATCH, 'match', r.id + ':' + x.pid + ':tok', Catalog.DAILY)) x.tok = Catalog.MATCH;
      if (x.won) await won(this.env.DB, x.pid, x.won);
      const p = await player(this.env.DB, x.pid);
      if (p) r.seats[i].bank = p.chips;
    }
    await this.flow();
    if (r.cup) r.paid = true;
    else if (this.humans().length) {
      r.paid = true;
      this.ask();
    } else {
      await release(this.env.DB, r.code);
      r.paid = true;
      this.report(true);
    }
    this.save();
    this.send();
    if (r.cup) await this.sendCup();
  }

  // What each human got against computer players at a table with a stake, for the admin page; a seat that left is not counted.
  async flow() {
    const { r } = this;
    const fakes = r.seats.filter(s => s.fake).length;
    if (!r.stake || r.cup || !fakes) return;
    const at = Date.now();
    const fakeNet = r.res.reduce((n, x) => n + (x && x.fake ? x.net : 0), 0);
    const humans = r.seats.filter(s => !s.fake).length;
    const rows = r.seats.map((s, i) => {
      const x = r.res[i];
      return x && !x.fake && !s.left && !s.lv && flowRow(this.env.DB, { match: r.id, player: x.pid, at: at, kind: r.pub ? 'pub' : 'friend', stake: r.stake, sharp: (r.sharp || []).length, fakes: fakes, humans: humans, net: x.net, won: x.win ? 1 : 0, fakeNet: fakeNet });
    }).filter(Boolean);
    if (rows.length) await this.env.DB.batch(rows);
  }

  // The Hub gets the finishing order, and again on the next alarm until it has taken it.
  async sendCup() {
    const { r } = this;
    await this.env.HUB.get(this.env.HUB.idFromName('h')).cupDone(r.cup.id, r.code, r.cup.order);
    r.cup.sent = true;
    this.save();
  }

  // personas stay claimed and the table stays held by the hub until the window closes
  ask() {
    const { r } = this;
    const now = Date.now();
    const p = {};
    r.seats.forEach((s, i) => {
      if (s.fake) p[i] = { at: now + between(2000, 12000) * this.k, stay: stays(this.st.final.low === i, s.bank >= ENTRY * r.stake + feeFor(r.stake)) };
    });
    const fakes = Object.keys(p).length;
    r.rm = { end: now + REMATCH * this.k, want: [], p: p, fakes: fakes };
    // who was offered a rematch and who took it goes into the day's totals, for tables with a computer player
    if (fakes) this.ctx.waitUntil(rematches(this.env.DB, r.pub ? 'pub' : 'friend', r.stake, { human: this.humans().length, fake: fakes }).catch(() => {}));
    this.report();
    this.arm();
  }

  async rematch(ws, i) {
    const { r } = this;
    const rm = r.rm;
    if (!rm) return this.fail(ws, 'phase');
    if (rm.want.includes(i)) return;
    const p = await player(this.env.DB, r.seats[i].pid);
    if (!p || p.chips < ENTRY * r.stake) return this.fail(ws, 'poor');
    if (r.rm !== rm || rm.want.includes(i)) return;
    rm.want.push(i);
    this.save();
    this.send();
    this.hurry();
  }

  // a player who pressed and then dropped is not charged for the next match
  wanting() {
    const { r } = this;
    return r.rm.want.filter(i => r.seats[i] && (r.seats[i].fake || !r.seats[i].bot && this.here(i)));
  }

  hurry() {
    const { r } = this;
    const rm = r.rm;
    if (!Object.keys(rm.p).length && this.humans().every(i => rm.want.includes(i))) this.ctx.waitUntil(this.close());
    else this.arm();
  }

  async tick() {
    const { r } = this;
    const rm = r.rm;
    for (const [i, d] of Object.entries(rm.p)) {
      if (d.at > Date.now()) continue;
      delete rm.p[i];
      if (d.stay) {
        rm.want.push(Number(i));
        await keep(this.env.DB, r.seats[i].pid, r.code);
      } else await giveBack(this.env.DB, r.seats[i].pid);
    }
    if (r.rm !== rm) return;
    if (Date.now() >= rm.end) return this.close();
    this.save();
    this.send();
    this.hurry();
  }

  async close() {
    const { r } = this;
    const rm = r.rm;
    if (!rm) return;
    const want = this.wanting();
    r.rm = null;
    if (rm.fakes) {
      const fakeYes = want.filter(i => r.seats[i].fake).length;
      this.ctx.waitUntil(rematches(this.env.DB, r.pub ? 'pub' : 'friend', r.stake, { humanYes: want.length - fakeYes, fakeYes: fakeYes }).catch(() => {}));
    }
    this.lines = [];
    if (!want.some(i => !r.seats[i].fake)) {
      await release(this.env.DB, r.code);
      this.report(true);
      this.save();
      this.send();
      return this.arm();
    }
    for (const w of this.socks()) {
      const a = w.deserializeAttachment();
      if (want.includes(a.seat)) {
        w.serializeAttachment(Object.assign({}, a, { sent: 0 }));
        continue;
      }
      w.serializeAttachment(Object.assign({}, a, { seat: -1 }));
      w.close(1000, 'rematch');
    }
    r.seats = r.seats.map((s, i) => {
      if (!want.includes(i)) return null;
      for (const k of ['esc', 'held', 'fee', 'from', 'acts', 'autos', 'auto', 'misses', 'cover', 'lv', 'awayAt', 'away']) delete s[k];
      return s;
    });
    for (const k of ['id', 'res', 'paid', 'wait', 'sharp', 'rolled', 'tries', 'dealt', 'retry', 'giveup']) delete r[k];
    Object.assign(r, { started: false, over: false, since: 0, go: 0, ready: [], dead: r.pub ? Date.now() + KEEP * this.k : 0 });
    this.st = null;
    this.ctx.storage.delete('st');
    if (r.seats.every(Boolean)) return this.go();
    if (!r.pub) {
      r.open = true;
      r.host = this.firstHuman();
    }
    this.window();
    this.save();
    this.send();
    this.arm();
    this.report();
  }

  // Stakes are held for a started match, so the bots play it out even when nobody is connected.
  owes() {
    const r = this.r;
    if (r.aborted) return false;
    return r.started && !r.paid && (!!r.cup || r.seats.some(s => s && s.esc)) || !!r.cup && r.paid && !r.cup.sent;
  }

  due() {
    const { r, st, k } = this;
    if (!st) {
      if (r.started) return r.aborted ? Infinity : r.retry || 0;
      const due = r.seats.filter(s => s && s.gone).map(s => s.gone + GRACE * k);
      if (r.go) due.push(this.fillAt());
      return due.length ? Math.min(...due) : Infinity;
    }
    if (st.phase === 'matchend') {
      if (r.rm) return Math.min(r.rm.end, ...Object.values(r.rm.p).map(d => d.at));
      return r.paid && !this.owes() ? Infinity : Date.now() + 5000 * k;
    }
    if (!this.humans().length && !this.owes()) return Infinity;
    if (st.phase === 'gameend') return r.since + NEXT * k;
    const i = this.actor();
    const s = r.seats[i];
    const wait = r.wait || 1000 * k;
    if (s.bot || s.auto || s.cover === this.turn()) return r.since + wait;
    if (!this.here(i)) return Math.max(r.since + wait, s.gone + GRACE * k);
    return r.since + this.idle() * k;
  }

  // How long the acting human has before the bot steps in; null when no clock is running.
  clock() {
    const { r, st } = this;
    if (st.phase === 'gameend' || st.phase === 'matchend') return null;
    const i = this.actor();
    const s = r.seats[i];
    if (s.auto || s.cover === this.turn() || this.away(s) || !s.bot && !this.here(i)) return null;
    return { p: i, left: Math.max(0, r.since + this.idle() * this.k - Date.now()), span: this.idle() * this.k };
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
    const t = Math.min(this.due(), dead, this.strays(), this.lapseAt(), this.awayEnd());
    // A lobby with no timer still gets a periodic check
    // Whole milliseconds, and never the time of the alarm that just ran: that one is dropped.
    const at = Math.max(Math.ceil(t < Infinity ? t : Date.now() + KEEP * this.k), Date.now() + 1);
    this.ctx.storage.setAlarm(at);
  }

  save() {
    this.ctx.storage.put('r', this.r);
    if (this.st) this.ctx.storage.put('st', Game.dump(this.st));
  }

  async wipe() {
    const code = this.r && this.r.code;
    this.report(true);
    for (const w of this.ctx.getWebSockets()) w.close(1000, 'closed');
    this.r = this.st = null;
    this.lines = [];
    this.vx = {};
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (code) await release(this.env.DB, code).catch(() => {});
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
      pub: r.pub, open: !!r.open, region: r.region || codeRegion(r.code), stake: r.stake, started: r.started, over: r.over, cup: r.cup ? r.cup.id : null,
      seats: r.seats.map(s => s && { seed: s.seed, av: s.av, level: s.level }),
      pids: r.seats.map(s => s && !s.bot ? s.pid : null)
    };
  }

  report(gone) {
    const r = this.r;
    if (!r) return;
    const hub = this.env.HUB.get(this.env.HUB.idFromName('h'));
    this.ctx.waitUntil(hub.table(r.code, gone ? null : this.summary()).catch(() => {}));
  }

  lobby(me) {
    const r = this.r;
    return {
      t: 'room', code: r.code, n: r.n, games: r.games, host: r.host, you: me,
      stake: r.stake, fee: feeFor(r.stake), hold: hold(r.stake, r.games), pub: r.pub, cup: r.cup && { round: r.cup.round, buy: r.cup.buy, prizes: prizes(r.cup.buy) }, finding: this.pooled() ? r.seats.filter(s => !s).length : 0,
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
    const clock = this.clock();
    const place = st.final ? st.final.order.indexOf(me) + 1 : 0;
    return {
      t: 'state', lb: sent,
      n: n, auto: !!r.seats[me].auto, stake: r.stake, pub: r.pub && !r.cup, fee: feeFor(r.stake), hold: hold(r.stake, r.games), games: st.games, gameNo: st.gameNo, pot: st.pot, phase: st.phase,
      task: st.task && st.task.id, tasksLeft: st.tasksLeft.map(x => x.id),
      turn: rot(st.turn), cutter: rot(st.cutter), chooser: rot(st.chooser),
      turns: st.turns, justOpened: st.justOpened, stock: st.stock.length, discard: ids(st.discard),
      clock: clock && { p: rot(clock.p), left: clock.left, span: clock.span },
      melds: st.melds.map(m => ({ id: m.id, t: m.t, ids: ids(m.cards), owner: rot(m.owner) })),
      claim: st.claim && { card: st.claim.card.id, queue: st.claim.queue.map(rot), i: st.claim.i },
      players: per(st.players).map((p, k) => {
        const i = (k + me) % n;
        const o = {
          name: p.name, pid: r.seats[i].pid, seed: r.seats[i].seed, av: r.seats[i].av, level: r.seats[i].level, wear: r.seats[i].wear || {}, vip: !!r.seats[i].vip,
          bank: r.seats[i].bank, away: !r.seats[i].bot && (!here.has(i) || !!r.seats[i].auto) || this.away(r.seats[i]), n: p.hand.length,
          opened: p.opened, claims: p.claims, chips: p.chips, score: p.score
        };
        if (k === 0) o.hand = ids(p.hand);
        return o;
      }),
      cup: r.cup && { round: r.cup.round, buy: r.cup.buy, prizes: prizes(r.cup.buy), place: place || undefined, through: r.cup.round === 'first' && place ? place <= 2 : undefined },
      rm: r.rm && { left: Math.max(0, r.rm.end - Date.now()), want: this.wanting().length, mine: r.rm.want.includes(me) },
      res: r.res && r.res[me] ? { net: r.res[me].net, xp: r.res[me].xp, tok: r.res[me].tok, from: r.res[me].from } : undefined,
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
