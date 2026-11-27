// Run it with `npm test` (test/run.js): free ports, throwaway keys, a fresh database and the dev server, all stopped after.
// By hand, start `wrangler dev --env-file <file> --test-scheduled` with the variables devVars() in run.js writes, and set URL, PERSIST and PORT_<name> to match.
// Plays whole matches through the socket API; the fakes of Apple, APNs, FCM, Google, RevenueCat and the Realtime SFU listen on the ports given.
const assert = require('assert');
const WebSocket = require('ws');
const Game = require('../../www/js/game.js');
const Chat = require('../../www/js/chat.js');

const { execFileSync } = require('child_process');
const fs = require('fs');
const Names = require('../../www/js/names.js');
const crypto = require('crypto');
const Catalog = require('../../www/js/catalog.js');
const httpServer = require('http');
let payout, hold, feeFor, maxLoss, barred, cupBarred, strongFor;
// what a seat's chips change by over a whole match: the payout less what was held and the fee
const change = (stake, games, chips) => payout(stake, games, chips) - hold(stake, games) - feeFor(stake);

// A fake of someone else's server: whatever a handler throws becomes a 500, and a port that is taken stops the run with its name.
function fake(name, port, fn) {
  const s = httpServer.createServer(async (q, r) => {
    try {
      await fn(q, r);
    } catch (e) {
      console.error(name + ' fake: ' + q.method + ' ' + q.url + ': ' + e.message);
      if (!r.headersSent) r.writeHead(500, { 'content-type': 'application/json' });
      r.end('{}');
    }
  });
  s.on('error', e => {
    console.error(name + ' fake cannot listen on ' + port + ': ' + e.message);
    process.exit(1);
  });
  s.listening$ = new Promise(res => s.listen(port, res));
  return s;
}

// a run that stops without reaching the end must not look like a pass
let reached = false;
process.on('exit', code => {
  if (code === 0 && !reached) {
    console.error('the run stopped before the end');
    process.exitCode = 1;
  }
});

// run.js hands over its free ports and database; by hand the old fixed ones apply
const port = (k, d) => +process.env['PORT_' + k] || d;
const PERSIST = process.env.PERSIST;
const WATCHDOG = (+process.env.WATCHDOG_MIN || 60) * 60000;
const base = process.env.URL || 'ws://localhost:' + port('WORKER', 8787);
const http = base.replace(/^ws/, 'http');
const TOP = new Set(['t', 'lb', 'n', 'auto', 'stake', 'pub', 'fee', 'hold', 'res', 'games', 'gameNo', 'pot', 'phase', 'task', 'tasksLeft', 'turn', 'cutter',
  'chooser', 'clock', 'rm', 'cup', 'turns', 'justOpened', 'stock', 'discard', 'melds', 'claim', 'players', 'result', 'stats', 'lastFin', 'final', 'log']);
const RM = new Set(['left', 'want', 'mine']);
const CUP = new Set(['round', 'buy', 'prizes', 'place', 'through']);
const SEAT = new Set(['name', 'pid', 'seed', 'av', 'level', 'bank', 'away', 'n', 'opened', 'claims', 'chips', 'score', 'hand', 'wear', 'vip']);

let ips = 0;

async function call(method, path, acc, body, origin, extra) {
  // an account link() made has no Apple token to answer with, so it goes back to a guest before it is deleted
  if (method === 'DELETE' && path === '/api/me' && acc) sql("UPDATE players SET apple = NULL WHERE id = '" + acc.id + "' AND apple LIKE 'test-%'");
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extra);
  if (acc) headers.Authorization = 'Bearer ' + acc.id + '.' + acc.secret;
  if (origin) headers.Origin = origin;
  // guests are rate limited per address
  if (path === '/api/guest' || path === '/api/apple') headers['CF-Connecting-IP'] = '10.0.0.' + (++ips % 250);
  const go = () => fetch(http + path, { method: method, headers: headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  // the dev server drops idle connections while sql() runs
  const r = await go().catch(go).catch(e => { throw new Error(method + ' ' + path + ': ' + e.message); });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

async function guest() {
  const r = await call('POST', '/api/guest');
  assert.strictEqual(r.status, 200, 'guest ' + r.status);
  return Object.assign(r.body, { auth: r.body.id + '.' + r.body.secret });
}

// friend tables with a stake are for accounts with an Apple identity and 10 public matches; this gives each of these both
function link(...accs) {
  sql("UPDATE players SET apple = 'test-' || id, pub_games = 10 WHERE apple IS NULL AND id IN (" + accs.map(a => "'" + a.id + "'").join(', ') + ')');
  return accs[0];
}

// the tables from 500 up need a level; this gives these accounts one
function level(n, ...accs) {
  sql('UPDATE players SET level = ' + n + " WHERE id IN (" + accs.map(a => "'" + a.id + "'").join(', ') + ')');
  return accs[0];
}

// the dev server and this script share the local database
function sql(q) {
  const args = [__dirname + '/../node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'amerikano', '--local', '--json'].concat(PERSIST ? ['--persist-to', PERSIST] : [], ['--command', q]);
  const run = () => execFileSync(process.execPath, args, { cwd: __dirname + '/..', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, killSignal: 'SIGKILL' });
  // wrangler occasionally dies on a busy machine; a real sql error fails the same way each time
  let out;
  for (let i = 0; ; i++) {
    try { out = run(); break; } catch (e) {
      if (i === 2) throw new Error('sql failed: ' + q.slice(0, 100) + '\n' + (e.stderr || e.stdout || e.message).toString().slice(-1500));
    }
  }
  return JSON.parse(out)[0].results;
}

// extra is for headers only the dev server honours: X-Addr is the address a limit counts, X-Hello how long a silent socket may stay
function client(path, origin, extra) {
  const c = { handlers: [], log: [], errors: [], seen: 0, recent: [] };
  c.ws = new WebSocket(base + path, { headers: Object.assign(origin ? { Origin: origin } : {}, extra) });
  c.ready = new Promise((res, rej) => {
    c.ws.on('open', res);
    c.ws.on('unexpected-response', (q, r) => rej(new Error('http ' + r.statusCode)));
    c.ws.on('error', rej);
    c.ws.on('close', () => rej(new Error(path + ': closed before it opened')));
  });
  c.ready.catch(() => {});
  // a closed socket fails every wait at once
  c.down = null;
  const fail = why => {
    if (c.down) return;
    c.down = new Error(path + ': ' + why);
    for (const h of c.handlers.slice()) if (h.fail) h.fail(c.down);
  };
  c.ws.on('close', (code, reason) => fail('closed (' + code + (reason && reason.length ? ' ' + reason : '') + ')'));
  c.ws.on('error', e => fail('error ' + e.message));
  c.ws.on('message', d => {
    const m = JSON.parse(d);
    c.seen++;
    c.recent = c.recent.concat(d.toString().slice(0, 120)).slice(-12);
    for (const h of c.handlers.slice()) h(m);
  });
  c.send = o => c.ws.send(JSON.stringify(o));
  c.next = (pred, ms) => {
    const what = String(pred).replace(/\s+/g, ' ').slice(0, 90);
    const p = new Promise((res, rej) => {
      if (c.down) return rej(new Error('waiting for ' + what + ' on ' + c.down.message));
      const done = () => {
        clearTimeout(timer);
        const i = c.handlers.indexOf(h);
        if (i >= 0) c.handlers.splice(i, 1);
      };
      const timer = setTimeout(() => { done(); rej(new Error(path + ': no message for ' + what + ' within ' + (ms || 90000) / 1000 + ' s, last seen ' + c.recent.join(' | '))); }, ms || 90000);
      const h = m => {
        if (!pred(m)) return;
        done();
        res(m);
      };
      h.fail = e => { done(); rej(new Error('waiting for ' + what + ' on ' + e.message)); };
      c.handlers.push(h);
    });
    // a wait nobody reaches must not crash the run when it fails
    p.catch(() => {});
    return p;
  };
  return c;
}

function leakCheck(m) {
  for (const k of Object.keys(m)) assert(TOP.has(k), 'unexpected key ' + k);
  assert.strictEqual(typeof m.stock, 'number');
  if (m.rm) for (const k of Object.keys(m.rm)) assert(RM.has(k), 'unexpected rematch key ' + k);
  if (m.cup) for (const k of Object.keys(m.cup)) assert(CUP.has(k), 'unexpected tournament key ' + k);
  if (m.clock) assert(m.clock.p >= 0 && m.clock.p < m.n && m.clock.left >= 0 && m.clock.left <= m.clock.span, 'bad clock');
  m.players.forEach((p, k) => {
    for (const x of Object.keys(p)) assert(SEAT.has(x), 'unexpected player key ' + x);
    assert.strictEqual('hand' in p, k === 0, 'hand on seat ' + k);
    assert.strictEqual(typeof p.wear, 'object', 'every seat carries wear, bots too');
    assert.strictEqual(typeof p.vip, 'boolean', 'and a vip flag, bots too');
  });
}

function mine(m) {
  return m.phase === 'claim' ? m.claim.queue[m.claim.i] === 0 : m.phase !== 'gameend' && m.turn === 0;
}

function choose(m) {
  const hand = m.players[0].hand.map(i => Game.CARDS[i]);
  if (m.phase === 'choose') return { a: 'choose', id: m.tasksLeft[0] };
  if (m.phase === 'draw') return m.discard.length && Math.random() < 0.3 ? { a: 'take' } : { a: 'draw' };
  if (m.phase === 'claim') return Math.random() < 0.3 ? { a: 'claim' } : { a: 'pass' };
  const p = m.players[0];
  const fake = { phase: 'play', turn: 0, task: Game.TASKS.find(t => t.id === m.task), players: [{ hand: hand, opened: p.opened }] };
  if (!p.opened) {
    const ms = Game.openPlan(fake);
    if (ms) return { a: m.task === 'ara' ? 'finish' : 'open', melds: ms.map(x => ({ t: x.t, ids: x.cards.map(c => c.id) })) };
  } else if (!m.justOpened) {
    const ms = Game.partition(hand).melds;
    if (ms.length) return { a: 'lay', ids: ms[0].cards.map(c => c.id) };
  }
  return { a: 'discard', id: hand[0].id };
}

function play(c, o) {
  let last = '';
  let hold = false;
  const h = m => {
    if (m.t === 'joined') Object.assign(c, { seat: m.seat, token: m.token, code: m.code });
    if (m.t === 'error') {
      c.errors.push(m.k);
      if (c.st && c.st.phase === 'play' && m.k !== 'turn') c.send({ t: 'act', a: 'discard', id: c.st.players[0].hand[0] });
    }
    if (m.t !== 'state') return;
    leakCheck(m);
    if (m.lb === 0) c.log = [];
    assert.strictEqual(m.lb, c.log.length, 'log gap');
    c.log = c.log.concat(m.log);
    c.st = m;
    if (m.phase === 'matchend') return o.finish(c);
    if (hold) return;
    react(m);
  };
  // a socket that closes before the match ends fails the finish promise instead of leaving it open
  h.fail = e => { if (o.abort) o.abort(e); };
  c.handlers.push(h);

  function react(m) {
    const key = [m.gameNo, m.phase, m.turn, c.log.length, m.claim && m.claim.i, m.players[0].hand.length].join();
    if (key === last) return;
    if (m.phase === 'gameend') {
      last = key;
      return c.send({ t: 'act', a: 'next' });
    }
    if (!mine(m)) return;
    if (o.stall && m.gameNo === 2 && m.phase === 'draw') {
      o.stall = false;
      hold = true;
      const from = c.log.length;
      setTimeout(() => {
        hold = false;
        const gone = c.log.slice(from).filter(e => e.p === 0 && (e.k === 'draw' || e.k === 'take'));
        assert(gone.length, 'idle player was not covered');
        console.log('idle: bot drew for the stalled player while connected');
        react(c.st);
      }, 1500);
      return;
    }
    if (o.drop && m.gameNo === 1 && m.phase === 'draw') {
      o.drop = false;
      last = key;
      return o.dropped(c);
    }
    last = key;
    c.send(Object.assign({ t: 'act' }, choose(m)));
  }
  return c;
}

async function friends() {
  const done = {};
  const finished = new Promise(res => { done.res = res; });
  const fin = [];
  const o = { finish: c => { if (!fin.includes(c)) fin.push(c); if (fin.length === 2) done.res(); } };

  const accA = await guest();
  const accB = await guest();
  link(accA, accB);
  sql("UPDATE players SET xp = 95 WHERE id = '" + accA.id + "'");
  const a = client('/ws/new', 'https://amerikano.pages.dev');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: 5, games: 5, stake: 100 });
  const ja = await a.next(m => m.t === 'joined');
  const code = ja.code;
  assert(/^[A-HJKMNP-Z]{4}$/.test(code), 'code ' + code);
  const room = await a.next(m => m.t === 'room');
  const me = (await call('GET', '/api/me', accA)).body;
  assert.strictEqual(room.seats[0].seed, me.seed);
  assert.deepStrictEqual(room.seats[0].av, me.avatar);
  console.log('room', code, 'host seat:', JSON.stringify(room.seats[0]));

  const b = client('/ws/' + code, 'capacitor://localhost');
  await b.ready;
  b.send({ t: 'join', auth: accB.auth });
  Object.assign(b, await b.next(m => m.t === 'joined'));
  b.send({ t: 'start' });
  assert.strictEqual((await b.next(m => m.t === 'error')).k, 'host');
  a.send({ t: 'act', a: 'draw' });
  assert.strictEqual((await a.next(m => m.t === 'error')).k, 'phase');

  const bad = client('/ws/' + code, 'https://evil.example');
  await bad.ready.then(() => assert.fail('bad origin accepted'), e => assert.strictEqual(e.message, 'http 403'));
  console.log('foreign origin refused');
  const nope = client('/ws/ZZZZ');
  await nope.ready;
  nope.send({ t: 'join', auth: accA.auth });
  assert.strictEqual((await nope.next(m => m.t === 'error')).k, 'nocode');
  const anon = client('/ws/' + code);
  await anon.ready;
  anon.send({ t: 'join', name: 'Typed' });
  assert.strictEqual((await anon.next(m => m.t === 'error')).k, 'auth');
  const forged = client('/ws/' + code);
  await forged.ready;
  forged.send({ t: 'join', auth: accA.id + '.' + '0'.repeat(64) });
  assert.strictEqual((await forged.next(m => m.t === 'error')).k, 'auth');
  console.log('join without a valid account refused');

  Object.assign(a, { seat: ja.seat, token: ja.token });
  play(a, Object.assign({ stall: true }, o));
  let b2 = null;
  play(b, Object.assign({
    drop: true,
    dropped: async c => {
      const dropLen = c.log.length;
      const { token } = c;
      c.ws.terminate();
      await new Promise(r => setTimeout(r, 700));
      b2 = client('/ws/' + code);
      await b2.ready;
      b2.send({ t: 'join', token: token });
      play(b2, o);
      const first = await b2.next(m => m.t === 'state');
      assert.strictEqual(first.lb, 0);
      assert.strictEqual(b2.seat === undefined, false);
      const covered = b2.log.slice(dropLen).filter(e => e.p === 0 && (e.k === 'draw' || e.k === 'take'));
      assert(covered.length, 'bot did not move for the dropped player');
      console.log('reconnect: same seat, own hand back (' + first.players[0].hand.length + ' cards), bot covered', covered.length, 'draw while away');
    }
  }, o));

  a.send({ t: 'start' });
  await Promise.race([finished, new Promise((r, j) => setTimeout(() => j(new Error('timeout')), 120000))]);
  console.log('match over for both. games:', a.st.gameNo, 'of', a.st.games, 'log entries', a.log.length, (b2 || b).log.length);
  assert.strictEqual(a.log.length, (b2 || b).log.length);
  assert.deepStrictEqual(a.st.players.map(p => p.name).sort(), (b2 || b).st.players.map(p => p.name).sort());
  const names = a.st.players.map(p => p.name);
  const bs = b2 || b;
  const meB = (await call('GET', '/api/me', accB)).body;
  assert.strictEqual(a.st.players[(bs.seat - a.seat + 5) % 5].seed, meB.seed);
  assert.strictEqual(bs.st.players[0].seed, meB.seed);
  assert.strictEqual(bs.st.players[0].level, 1);
  await new Promise(r => setTimeout(r, 500));
  for (const [acc, who] of [[accA, 'host'], [accB, 'guest']]) {
    const p = (await call('GET', '/api/me', acc)).body;
    assert.strictEqual(p.games, 1, who + ' games');
    const rounds = a.st.gameNo;
    assert(p.xp >= 10 * rounds, who + ' xp ' + p.xp);
    assert.strictEqual((p.xp - 10 * rounds - p.wins * 30) % 5, 0, who + ' xp parts');
    const view = (acc === accA ? a : bs).st;
    const net = change(100, 5, view.players[0].chips);
    const bonus = acc === accA ? 2000 : 0;
    assert.strictEqual(p.chips, 5000 + net + bonus, who + ' chips after escrow, fee and payout');
    assert.strictEqual(view.res.net, net, who + ' result in the view');
    assert.deepStrictEqual([p.tokens, view.res.tok], [2, 2], who + ' earned tokens for the match');
    if (acc === accA) {
      assert.strictEqual(p.level, 2, 'level up');
      assert.strictEqual(sql("SELECT count(*) AS n FROM chip_log WHERE reason = 'level' AND player = '" + acc.id + "'")[0].n, 1);
    }
    console.log(who, 'after the match: games', p.games, 'wins', p.wins, 'xp', p.xp, 'level', p.level, 'chips', p.chips);
  }
  console.log('players seen by host (rotated, seat 0 = host):', names.join(', '));
  console.log('final pay for host view:', JSON.stringify(a.st.final.pay), 'low:', a.st.final.low);
  console.log('errors seen: host', a.errors.join() || '-', 'guest', bs.errors.join() || '-');
  a.ws.close();
  bs.ws.close();
}

async function math() {
  ({ payout, hold, feeFor, maxLoss, barred, cupBarred, strongFor } = await import('../src/account.js'));
  // what is held is the stake plus a tenth of it for each chip the match can cost: 10 + 4 per game
  assert.strictEqual(maxLoss(4), 26);
  assert.strictEqual(maxLoss(15), 70);
  assert.strictEqual(hold(100, 4), 260);
  assert.strictEqual(hold(500, 3), 1100);
  assert.strictEqual(hold(0, 4), 0);
  assert.strictEqual(payout(100, 4, 0), 260);
  assert.strictEqual(payout(100, 4, 25), 510);
  assert.strictEqual(payout(500, 4, -10), 800);
  assert.strictEqual(payout(500, 4, -26), 0, 'the worst match pays nothing back');
  assert.strictEqual(payout(2500, 4, 40), 16500);
  assert.strictEqual(payout(50000, 5, -30), 0);
  assert.deepStrictEqual([100, 500, 2500, 10000, 50000, 3000, 70, 20, 0].map(feeFor), [5, 25, 125, 700, 4000, 125, 3, 1, 0], 'the fee of the highest public stake at or below, 5 % under 100');
  // whole matches between computer players: nobody ends below what is held, and the chips only move around
  let least = 0;
  for (let k = 0; k < 120; k++) {
    const n = 3 + k % 3;
    const opts = [];
    for (let g = n; g <= 16; g += n) opts.push(g);
    const games = opts[k % opts.length];
    const st = Game.newMatch({ players: n, games: games, level: k % 2 ? 'sharp' : 'relaxed', allBots: true });
    for (let guard = 0; st.phase !== 'matchend'; guard++) {
      assert(guard < 200000, 'a match that does not end');
      if (st.phase === 'gameend') Game.nextGame(st);
      else assert(Game.botStep(st), 'stuck in ' + st.phase);
    }
    assert.strictEqual(st.players.reduce((x, p) => x + p.chips, 0), 0, 'the match chips only change hands');
    for (const p of st.players) least = Math.min(least, p.chips + maxLoss(games));
  }
  assert.strictEqual(least, 0, 'a seat never loses more than maxLoss(games)');
  // a seat's own level beats the match's: only a relaxed seat ever slips, and the level survives dump and load
  const slips = relaxed => {
    let st = Game.newMatch({ players: 4, games: 4, level: 'sharp', allBots: true });
    if (relaxed) st.players[2].level = 'relaxed';
    st = Game.load(Game.dump(st));
    assert.strictEqual(st.players[2].level, relaxed ? 'relaxed' : undefined);
    let draws = 0;
    st.rnd = () => { draws++; return 0.5; };
    for (let guard = 0; st.phase !== 'matchend'; guard++) {
      assert(guard < 200000, 'a match that does not end');
      if (st.phase === 'gameend') {
        const was = draws;
        Game.nextGame(st);
        draws = was;
      } else assert(Game.botStep(st), 'stuck in ' + st.phase);
    }
    return draws;
  };
  assert.strictEqual(slips(false), 0, 'a sharp table never slips');
  assert(slips(true) > 0, 'one relaxed seat does');
  const p = (level, apple) => ({ level: level, apple: apple ? 'x' : null });
  assert.strictEqual(barred(p(1, false), 0, false), null, 'a table for nothing is open to anyone');
  assert.deepStrictEqual(barred(p(1, true), 500, true), { k: 'level', need: 4 });
  assert.strictEqual(barred(p(4, true), 500, true), null);
  assert.deepStrictEqual(barred(p(30, false), 100, false), { k: 'guest' }, 'a guest never plays a friend table with a stake');
  assert.deepStrictEqual(barred(p(30, false), 2500, true), { k: 'guest' });
  assert.strictEqual(barred(p(30, false), 500, true), null);
  assert.deepStrictEqual(barred(p(9, true), 3000, false), { k: 'level', need: 10 }, 'a friend table takes the gate below its stake');
  assert.strictEqual(barred(p(1, true), 90, false), null, 'and none under the lowest table');
  const cool = Object.assign(p(30, true), { cool_until: Date.now() + 60000, cool_stake: 500 });
  assert.strictEqual(barred(cool, 500, true).k, 'cool');
  assert.strictEqual(barred(cool, 2500, true).k, 'cool', 'and every larger table');
  assert.strictEqual(barred(cool, 100, true), null, 'a smaller one is open');
  assert.strictEqual(barred(cool, 500, false), null, 'friend tables are not covered');
  assert.strictEqual(barred(Object.assign({}, cool, { cool_until: Date.now() - 1 }), 500, true), null, 'and it ends');
  assert.deepStrictEqual([cupBarred(p(1, true), 1000), cupBarred(p(10, true), 5000), cupBarred(p(20, true), 25000)], [null, null, null]);
  assert.deepStrictEqual(cupBarred(p(19, true), 25000), { k: 'level', need: 20 });
  assert.deepStrictEqual(cupBarred(p(30, false), 1000), { k: 'guest' });
  console.log('payout: the held amount back plus chips at stake/10, the worst loss is covered');
}

// the dev clock gives a socket 200 ms to say hello, which a busy machine can miss, so a closed socket is tried again
async function hello(msg, pred) {
  for (let i = 0; ; i++) {
    const c = client('/ws/hub');
    try {
      await c.ready;
      const w = c.next(pred);
      c.send(Object.assign({ t: 'hello' }, msg));
      return [c, await w];
    } catch (e) {
      c.ws.terminate();
      if (i === 2) throw e;
    }
  }
}

async function hub(acc) {
  const [c, m] = await hello({ auth: acc.auth }, m => m.t === 'hub');
  assert.deepStrictEqual(m.stakes, [100, 500, 2500, 10000, 50000]);
  return c;
}

function seated(m) {
  const c = client('/ws/' + m.code);
  c.ready.then(() => c.send({ t: 'join', token: m.token }));
  return c;
}

async function tables() {
  const [, err] = await hello({ auth: '0'.repeat(32) + '.' + '0'.repeat(64) }, m => m.t === 'error');
  assert.strictEqual(err.k, 'auth');

  const accA = await guest();
  const accB = await guest();
  const poor = level(4, await guest());
  sql("UPDATE players SET chips = 4999 WHERE id = '" + poor.id + "'");
  const p = await hub(poor);
  const no = p.next(m => m.t === 'error');
  p.send({ t: 'quick', stake: 500 });
  assert.strictEqual((await no).k, 'poor');
  p.ws.close();

  const a = await hub(accA);
  const b = await hub(accB);
  const sa = a.next(m => m.t === 'seated');
  a.send({ t: 'quick', stake: 100 });
  const A = await sa;
  const sb = b.next(m => m.t === 'seated');
  b.send({ t: 'quick', stake: 100 });
  const B = await sb;
  assert.strictEqual(B.code, A.code, 'quick play sits at the fullest open table');
  assert.notStrictEqual(B.seat, A.seat);
  console.log('hub: two quick plays share table', A.code, 'seats', A.seat, B.seat);

  const direct = client('/ws/' + A.code);
  await direct.ready;
  direct.send({ t: 'join', auth: accA.auth });
  assert.strictEqual((await direct.next(m => m.t === 'error')).k, 'nocode');
  console.log('a public table cannot be joined around the hub');

  const fin = [];
  const finished = new Promise(res => { fin.res = res; });
  const o = { finish: c => { if (!fin.includes(c)) fin.push(c); if (fin.length === 2) fin.res(); } };
  const ra = seated(A);
  const rb = seated(B);
  const room = await ra.next(m => m.t === 'room');
  assert.strictEqual(room.pub, true);
  assert.strictEqual(room.stake, 100);
  assert(!('left' in room), 'no countdown at a table that fills itself');
  play(ra, o);
  play(rb, o);
  await Promise.race([finished, new Promise((r, j) => setTimeout(() => j(new Error('timeout')), 120000))]);
  assert.strictEqual(ra.st.stake, 100);
  assert([accA.id, accB.id].every(id => ra.st.players.some(x => x.pid === id)));
  await new Promise(r => setTimeout(r, 600));
  for (const [acc, c, who] of [[accA, ra, 'A'], [accB, rb, 'B']]) {
    const back = payout(100, 4, c.st.players[0].chips);
    const me = (await call('GET', '/api/me', acc)).body;
    assert.strictEqual(me.chips, 5000 - 5 + back - 260, who + ' chips');
    assert.strictEqual(c.st.res.net, back - 265);
    const rows = sql("SELECT reason, delta FROM chip_log WHERE player = '" + acc.id + "' AND reason IN ('escrow', 'fee', 'match') ORDER BY id");
    assert.deepStrictEqual(rows.map(x => x.reason), back ? ['escrow', 'fee', 'match'] : ['escrow', 'fee']);
    assert.deepStrictEqual([rows[0].delta, rows[1].delta], [-260, -5]);
    console.log(who, 'stake 100, payout', back, 'chips', me.chips, 'xp', me.xp);
  }
  const keys = sql("SELECT ref FROM chip_log WHERE player = '" + accA.id + "' AND reason = 'escrow'");
  assert.throws(() => sql("INSERT INTO chip_log (player, delta, reason, at, ref) VALUES ('" + accA.id + "', -100, 'escrow', 0, '" + keys[0].ref + "')"));
  console.log('a second escrow with the same ref is refused');
  ra.ws.close();
  rb.ws.close();
  a.ws.close();
  b.ws.close();
}

async function lone() {
  const acc = level(4, await guest());
  const h = await hub(acc);
  const s = h.next(m => m.t === 'seated');
  h.send({ t: 'quick', stake: 500 });
  const sat = await s;
  const began = Date.now();
  const r = seated(sat);
  const st = await r.next(m => m.t === 'state');
  assert(Date.now() - began <= 8000 * 0.02 + 1500, 'a lone player starts inside the window: ' + (Date.now() - began) + 'ms');
  leakCheck(st);
  assert.strictEqual(st.players.filter(p => p.pid && personaIds([p.pid]) === 1).length, 3);
  assert.strictEqual(st.stake, 500);
  await new Promise(x => setTimeout(x, 300));
  assert.strictEqual((await call('GET', '/api/me', acc)).body.chips, 5000 - 1300 - 25);
  console.log('lone player: bots fill the table after the wait, 1,300 held and the 25 fee taken');
  r.ws.close();
  h.ws.close();
  // With nobody connected the bots still finish the match and the stake is settled. A match that
  // ends level pays nothing back and leaves no log row, so the personas being freed is the sign.
  const held = () => sql("SELECT count(*) AS n FROM personas WHERE busy = '" + sat.code + "'")[0].n;
  const t0 = Date.now();
  for (let i = 0; i < 240 && held(); i++) await new Promise(x => setTimeout(x, 500));
  assert.strictEqual(held(), 0, 'an abandoned match settles');
  const me = (await call('GET', '/api/me', acc)).body;
  assert.strictEqual(me.chips, sql("SELECT sum(delta) AS n FROM chip_log WHERE player = '" + acc.id + "'")[0].n, 'every chip change is logged');
  assert.strictEqual(sql("SELECT count(*) AS n FROM chip_log WHERE player = '" + acc.id + "' AND reason = 'escrow'")[0].n, 1);
  console.log('abandoned match: the bots played it out and the stake was settled in ' + Math.round((Date.now() - t0) / 1000) + 's');
}

async function busy() {
  const acc = level(4, await guest());
  const poor = level(4, await guest());
  sql("UPDATE players SET chips = 4999 WHERE id = '" + poor.id + "'");
  const h = await hub(poor);
  const no = h.next(m => m.t === 'error');
  h.send({ t: 'quick', stake: 500 });
  assert.strictEqual((await no).k, 'poor');
  h.ws.close();

  const a = await hub(acc);
  const s = a.next(m => m.t === 'seated');
  a.send({ t: 'quick', stake: 100 });
  const r = seated(await s);
  await r.next(m => m.t === 'room');
  const again = a.next(m => m.t === 'error');
  a.send({ t: 'quick', stake: 500 });
  assert.strictEqual((await again).k, 'busy');
  console.log('one seat per account');
  r.ws.close();
  a.ws.close();
}

async function forfeit() {
  const accA = await guest();
  const accB = await guest();
  link(accA, accB);
  level(4, accA, accB);
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: 3, games: 3, stake: 500 });
  const ja = await a.next(m => m.t === 'joined');
  const b = client('/ws/' + ja.code);
  await b.ready;
  b.send({ t: 'join', auth: accB.auth });
  await b.next(m => m.t === 'joined');
  const poor = level(4, link(await guest()));
  sql("UPDATE players SET chips = 4999 WHERE id = '" + poor.id + "'");
  const c = client('/ws/' + ja.code);
  await c.ready;
  c.send({ t: 'join', auth: poor.auth });
  assert.strictEqual((await c.next(m => m.t === 'error')).k, 'poor');
  const fin = played(Object.assign(a, { seat: ja.seat }));
  a.send({ t: 'start' });
  await b.next(m => m.t === 'state');
  const before = sql('SELECT xp, tokens, games, wins, week_won FROM players WHERE id = ' + who(accB))[0];
  b.send({ t: 'leave' });
  await within(fin, 120000, 'match end');
  await sleep(800);
  // the seat is settled by its real result, as if the player had stayed: the hold is paid back with the chips the stand-in won or lost
  const seatB = a.st.players.find(p => p.pid === accB.id);
  const back = payout(500, 3, seatB.chips);
  assert.strictEqual((await call('GET', '/api/me', accB)).body.chips, 5000 - 1100 - 25 + back, 'the leaver gets the real payout');
  assert.deepStrictEqual(sql("SELECT reason FROM chip_log WHERE player = " + who(accB) + " AND reason <> 'start' ORDER BY id").map(x => x.reason), back ? ['escrow', 'fee', 'match'] : ['escrow', 'fee']);
  assert.deepStrictEqual(sql('SELECT xp, tokens, games, wins, week_won FROM players WHERE id = ' + who(accB))[0], before, 'a match left early gives no xp, tokens or wins');
  const rows = seatsOf(ja.code);
  assert.deepStrictEqual(rows.find(x => x.player === accB.id).gone, 1);
  assert.strictEqual(rows.find(x => x.player === accB.id).net, back - 1125);
  assert.strictEqual(rows.reduce((n, x) => n + x.net, 0), -75, 'the seats together lose only the fees');
  assert.strictEqual((await call('GET', '/api/me', accA)).body.chips, 5000 - 1125 + payout(500, 3, a.st.players[0].chips));
  console.log('forfeit: the leaver is settled by the real result,', back, 'back of the 1,100 held, nothing credited');

  // a leave once the match is over changes nothing
  const mine = sql('SELECT chips, xp FROM players WHERE id = ' + who(accA))[0];
  a.send({ t: 'leave' });
  await sleep(600);
  assert.deepStrictEqual(sql('SELECT chips, xp FROM players WHERE id = ' + who(accA))[0], mine);
  assert.strictEqual(seatsOf(ja.code).find(x => x.player === accA.id).gone, 0, 'a leave after the end is not recorded');
  a.ws.close();
}

async function lobby() {
  const acc = await guest();
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', auth: acc.auth, players: 3, games: 3 });
  const ja = await a.next(m => m.t === 'joined');
  a.ws.close();
  await new Promise(r => setTimeout(r, 100));
  const b = client('/ws/' + ja.code);
  await b.ready;
  b.send({ t: 'join', token: ja.token });
  const back = await b.next(m => m.t === 'joined');
  assert.strictEqual(back.seat, ja.seat);
  const room = await b.next(m => m.t === 'room');
  assert.strictEqual(room.host, ja.seat);
  b.ws.close();
  console.log('lobby: host token reconnect keeps the seat');
}

async function races() {
  const acc = await guest();
  sql("UPDATE players SET chips = 0 WHERE id = '" + acc.id + "'");
  const rs = await Promise.all([call('POST', '/api/daily', acc), call('POST', '/api/bailout', acc), call('POST', '/api/daily', acc)]);
  assert.strictEqual(rs.filter(x => x.status === 200).length, 2);
  const chips = (await call('GET', '/api/me', acc)).body.chips;
  const sum = sql("SELECT sum(delta) AS n FROM chip_log WHERE player = '" + acc.id + "'")[0].n;
  assert.strictEqual(sum, 5000 + chips, 'every chip change is logged');
  assert(chips === 1000 || chips === 1750, 'chips ' + chips);
  const fresh = await guest();
  const names = await Promise.all(Array.from({ length: 40 }, () => call('POST', '/api/name', fresh)));
  assert.strictEqual(names.filter(x => x.status === 200).length, 20);
  console.log('parallel daily, bailout and rerolls stay within their limits');
}

async function solo() {
  const acc = link(await guest());
  const c = client('/ws/new');
  await c.ready;
  c.send({ t: 'create', auth: acc.auth, players: 3, games: 3, stake: 100 });
  await c.next(m => m.t === 'joined');
  const rooms = [];
  c.handlers.push(m => { if (m.t === 'room') rooms.push(m); });
  c.send({ t: 'start' });
  await c.next(m => m.t === 'state' && m.phase === 'matchend');
  await new Promise(r => setTimeout(r, 500));
  const p = (await call('GET', '/api/me', acc)).body;
  assert.strictEqual(p.games + p.xp + p.tokens, 0, 'a player who never moved earns nothing');
  assert.strictEqual(sql("SELECT week_won AS n FROM players WHERE id = '" + acc.id + "'")[0].n, 0, 'nor weekly chips');
  assert(rooms.some(m => m.finding === 2), 'the waiting view says two seats are being filled');
  c.ws.close();
  console.log('solo room: the empty seat is looked for, an idle player earns nothing');
}

async function accounts() {
  const bad = await call('GET', '/api/me', { id: '0'.repeat(32), secret: '0'.repeat(64) });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual((await call('GET', '/api/me')).status, 401);
  assert.strictEqual((await call('GET', '/api/me', null, null, 'https://evil.example')).status, 403);
  const pre = await fetch(http + '/api/me', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'GET' }, signal: AbortSignal.timeout(30000) });
  assert.strictEqual(pre.status, 204);
  assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'http://localhost:8080');

  const acc = await guest();
  assert(/^[0-9a-f]{32}$/.test(acc.id) && /^[0-9a-f]{64}$/.test(acc.secret));
  const me = (await call('GET', '/api/me', acc)).body;
  assert.strictEqual(me.chips, 5000);
  assert.strictEqual(me.level, 1);
  assert.strictEqual(me.to, 100);
  assert.deepStrictEqual(me.daily, { ready: true, streak: 0, reward: 750 });
  assert.strictEqual(me.bailout, false);
  assert.strictEqual(me.avatar.length, 4);
  console.log('guest', acc.id.slice(0, 8), 'seed', me.seed, 'avatar', me.avatar.join());

  const back = days => sql("UPDATE players SET daily_at = daily_at - " + days * 86400000 + " WHERE id = '" + acc.id + "'");
  let r = await call('POST', '/api/daily', acc);
  assert.strictEqual(r.body.chips, 5750);
  assert.strictEqual(r.body.daily.ready, false);
  assert.strictEqual(r.body.daily.streak, 1);
  assert.strictEqual((await call('POST', '/api/daily', acc)).status, 409);
  console.log('daily claimed once, second claim refused');
  back(1);
  r = await call('POST', '/api/daily', acc);
  assert.strictEqual(r.body.chips, 5750 + 1000);
  assert.strictEqual(r.body.daily.streak, 2);
  back(3);
  r = await call('POST', '/api/daily', acc);
  assert.strictEqual(r.body.daily.streak, 1);
  assert.strictEqual(r.body.chips, 5750 + 1000 + 750);
  sql("UPDATE players SET streak = 7 WHERE id = '" + acc.id + "'");
  back(1);
  r = await call('POST', '/api/daily', acc);
  assert.strictEqual(r.body.daily.streak, 7);
  assert.strictEqual(r.body.chips, 5750 + 1000 + 750 + 2250);
  console.log('streak grows, resets after a missed day, caps at 7');

  assert.strictEqual((await call('POST', '/api/bailout', acc)).status, 409);
  sql("UPDATE players SET chips = 200 WHERE id = '" + acc.id + "'");
  assert.strictEqual((await call('GET', '/api/me', acc)).body.bailout, true);
  r = await call('POST', '/api/bailout', acc);
  assert.strictEqual(r.body.chips, 1000);
  sql("UPDATE players SET chips = 10 WHERE id = '" + acc.id + "'");
  assert.strictEqual((await call('POST', '/api/bailout', acc)).status, 409);
  console.log('bailout tops up to 1,000 once a day');

  // the same claim fired at once pays once and writes one log row
  const racer = await guest();
  const count = reason => sql("SELECT count(*) AS n FROM chip_log WHERE player = '" + racer.id + "' AND reason = '" + reason + "'")[0].n;
  let race = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/daily', racer)));
  assert.strictEqual(race.filter(x => x.status === 200).length, 1);
  sql("UPDATE players SET chips = 200 WHERE id = '" + racer.id + "'");
  race = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/bailout', racer)));
  assert.strictEqual(race.filter(x => x.status === 200).length, 1);
  assert.deepStrictEqual([count('daily'), count('bailout')], [1, 1]);
  assert.strictEqual((await call('GET', '/api/me', racer)).body.chips, 1000);
  assert.strictEqual(sql("SELECT sum(delta) AS n FROM chip_log WHERE player = '" + racer.id + "' AND reason <> 'start'")[0].n, 750 + 800);
  console.log('daily and bailout fired together pay once');

  r = await call('POST', '/api/avatar', acc, { avatar: [8, 6, 15, 8] });
  assert.deepStrictEqual(r.body.avatar, [8, 6, 15, 8]);
  for (const v of [[9, 0, 0, 0], [0, 0, 0], [0, 0, 0, -1], 'x', [0, 0, 0, 1.5]]) {
    assert.strictEqual((await call('POST', '/api/avatar', acc, { avatar: v })).status, 400);
  }
  console.log('avatar saved, out of range parts refused');

  const seed = (await call('GET', '/api/me', acc)).body.seed;
  r = await call('POST', '/api/name', acc);
  assert.notStrictEqual(r.body.seed, seed);
  for (let i = 1; i < 20; i++) assert.strictEqual((await call('POST', '/api/name', acc)).status, 200);
  assert.strictEqual((await call('POST', '/api/name', acc)).status, 429);
  console.log('name reroll stops after 20 a day');

  const rolls = await Promise.all(Array.from({ length: 40 }, () => call('POST', '/api/name', acc)));
  assert.strictEqual(rolls.filter(x => x.status === 200).length, 0);

  const rows = sql("SELECT delta, reason FROM chip_log WHERE player = '" + acc.id + "' ORDER BY id");
  assert.deepStrictEqual(rows.map(x => x.reason), ['start', 'daily', 'daily', 'daily', 'daily', 'bailout']);
  assert.deepStrictEqual(rows.map(x => x.delta), [5000, 750, 1000, 750, 2250, 800]);

  assert.strictEqual((await call('DELETE', '/api/me', acc)).status, 200);
  assert.strictEqual((await call('GET', '/api/me', acc)).status, 401);
  assert.strictEqual(sql("SELECT count(*) AS n FROM chip_log WHERE player = '" + acc.id + "'")[0].n, 0);
  console.log('account deleted with its rows');

  // the old column opens nothing any more; migration 0015 copies it into a session before it is emptied, so no tester is locked out
  const old = { id: crypto.randomBytes(16).toString('hex'), secret: crypto.randomBytes(32).toString('hex') };
  const oh = crypto.createHash('sha256').update(old.secret).digest('hex');
  sql("INSERT INTO players (id, secret_hash, name_seed, avatar, chips, created) VALUES ('" + old.id + "', '" + oh + "', 1, '0,0,0,0', 5000, 0)");
  assert.strictEqual((await call('GET', '/api/me', old)).status, 401, 'the old column is not a login');
  const migration = fs.readFileSync(__dirname + '/../migrations/0015_foundations.sql', 'utf8');
  const copy = /INSERT OR IGNORE INTO sessions[^;]*;/.exec(migration)[0].replace('WHERE secret_hash', "WHERE id = '" + old.id + "' AND secret_hash").replace(/\s+/g, ' ');
  sql(copy);
  sql("UPDATE players SET secret_hash = '' WHERE id = '" + old.id + "'");
  assert.strictEqual((await call('GET', '/api/me', old)).status, 200, 'a guest the migration copied still gets in');
  assert.strictEqual(sql("SELECT secret_hash AS h FROM players WHERE id = '" + old.id + "'")[0].h, '');
  const fresh = await guest();
  assert.strictEqual(sql("SELECT secret_hash AS h FROM players WHERE id = '" + fresh.id + "'")[0].h, '', 'a new guest keeps no secret in the old column');
  assert.strictEqual(sql("SELECT count(*) AS n FROM sessions WHERE player = '" + fresh.id + "'")[0].n, 1);
  console.log('the old secret column opens nothing, the migration copy keeps old guests in');
}

const b64u = x => Buffer.from(x).toString('base64url');

async function apple() {
  const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const good = pair();
  const kid = 'k' + Date.now();
  const jwk = Object.assign(good.publicKey.export({ format: 'jwk' }), { kid: kid, alg: 'RS256', use: 'sig' });
  const spent = new Set();
  const revoked = [];
  const form = req => new Promise(res => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => res(Object.fromEntries(new URLSearchParams(d)))); });
  const stub = fake('apple', port('APPLE', 8791), async (q, r) => {
    if (q.url === '/auth/keys') return r.end(JSON.stringify({ keys: [jwk] }));
    if (q.method !== 'POST' || !/^\/auth\/(token|revoke)$/.test(q.url)) {
      r.statusCode = 404;
      return r.end('{}');
    }
    const f = await form(q);
    if (!f.client_secret || f.client_secret.split('.').length !== 3) r.statusCode = 400;
    else if (q.url === '/auth/revoke') revoked.push({ token: f.token, client: f.client_id });
    else if (!f.code || spent.has(f.code) || f.code.startsWith('bad') || (f.client_id === 'com.aytutuna.amerikano.web') !== (f.redirect_uri === 'https://amerikano.pages.dev/')) r.statusCode = 400;
    else {
      spent.add(f.code);
      return r.end(JSON.stringify({ refresh_token: 'rt.' + f.code }));
    }
    r.end('{}');
  });
  await stub.listening$;
  const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
  const mint = (o, key) => {
    o = Object.assign({ iss: 'https://appleid.apple.com', aud: 'com.aytutuna.amerikano', exp: Math.floor(Date.now() / 1000) + 600 }, o);
    const head = b64u(JSON.stringify({ alg: 'RS256', kid: kid })) + '.' + b64u(JSON.stringify(o));
    return head + '.' + crypto.sign('RSA-SHA256', Buffer.from(head), (key || good).privateKey).toString('base64url');
  };
  // what the client sends once Apple has signed the nonce the server handed out
  const cred = async (o, key, code) => {
    o = Object.assign({ sub: 'sub.' + crypto.randomBytes(6).toString('hex') }, o);
    const n = (await call('POST', '/api/apple/nonce')).body.nonce;
    return { token: mint(Object.assign({ nonce: sha(n) }, o), key), nonce: n, code: code, sub: o.sub };
  };
  const post = (path, acc, c) => call('POST', path, acc, { token: c.token, nonce: c.nonce, code: c.code });
  const row = id => sql("SELECT apple, apple_refresh, apple_client FROM players WHERE id = '" + id + "'")[0];
  const sessions = id => sql("SELECT count(*) AS n FROM sessions WHERE player = '" + id + "'")[0].n;
  const APP = 'com.aytutuna.amerikano';
  const WEB = APP + '.web';

  const t = await cred({}, null, 'c1');
  let r = await post('/api/apple', null, t);
  assert.strictEqual(r.status, 200);
  const acc = r.body;
  const me = (await call('GET', '/api/me', acc)).body;
  assert.strictEqual(me.chips, 5000);
  assert.strictEqual(me.apple, true);
  assert.deepStrictEqual(row(acc.id), { apple: t.sub, apple_refresh: 'rt.c1', apple_client: APP });
  assert.strictEqual((await post('/api/apple', null, t)).status, 401);
  const again = await post('/api/apple', null, await cred({ sub: t.sub }, null, 'c2'));
  assert.strictEqual(again.body.id, acc.id);
  assert.notStrictEqual(again.body.secret, acc.secret);
  assert.strictEqual((await call('GET', '/api/me', acc)).status, 200);
  assert.strictEqual((await call('GET', '/api/me', again.body)).status, 200);
  assert.strictEqual(row(acc.id).apple_refresh, 'rt.c2');
  assert.strictEqual(sessions(acc.id), 2);
  const web = await post('/api/apple', null, await cred({ aud: WEB }, null, 'w1'));
  assert.strictEqual(web.status, 200);
  assert.deepStrictEqual(row(web.body.id).apple_client, WEB);
  assert.deepStrictEqual(row(web.body.id).apple_refresh, 'rt.w1');
  console.log('apple sign-in makes an account, the same subject gets it back, every device stays signed in');

  // a banned account cannot sign in again, and can once it is unbanned
  const bn = await post('/api/apple', null, await cred({}, null, 'ban1'));
  assert.strictEqual(bn.status, 200);
  assert.strictEqual((await adm('POST', 'ban', ADMIN, { id: bn.body.id }, '10.9.2.1')).status, 200);
  assert.strictEqual((await call('GET', '/api/me', bn.body)).status, 401);
  const barred = await post('/api/apple', null, await cred({ sub: row(bn.body.id).apple }, null, 'ban2'));
  assert.deepStrictEqual([barred.status, barred.body.error], [403, 'banned']);
  assert.strictEqual(sessions(bn.body.id), 0, 'no session was made');
  assert.strictEqual((await adm('POST', 'unban', ADMIN, { id: bn.body.id }, '10.9.2.1')).status, 200);
  assert.strictEqual((await post('/api/apple', null, await cred({ sub: row(bn.body.id).apple }, null, 'ban3'))).status, 200);
  console.log('apple: a banned account is refused until it is unbanned');

  // sign-out ends that device's session, its device row and its hub socket, and nothing else
  const so = 'out.' + t.sub;
  const au = b => Object.assign(b, { auth: b.id + '.' + b.secret });
  const s1 = au((await post('/api/apple', null, await cred({ sub: so }, null, 'o1'))).body);
  const s2 = au((await post('/api/apple', null, await cred({ sub: so }, null, 'o2'))).body);
  const s3 = au((await post('/api/apple', null, await cred({ sub: so }, null, 'o3'))).body);
  const k1 = fcmTok();
  const k2 = fcmTok();
  await reg(s1, 'fcm', k1, 'en', 0);
  await reg(s2, 'fcm', k2, 'en', 0);
  const h2 = await hub(s2);
  const shut = c => new Promise(res => c.ws.on('close', (code, why) => res([code, String(why)])));
  const closed2 = shut(h2);
  assert.strictEqual((await call('POST', '/api/signout')).status, 401);
  assert.strictEqual((await call('POST', '/api/signout', s2)).status, 200);
  assert.strictEqual((await call('GET', '/api/me', s2)).status, 401, 'the signed-out secret is dead');
  assert.deepStrictEqual(await within(closed2, 5000, 'the hub socket of the signed-out device closes'), [4001, 'signout']);
  assert.strictEqual((await call('GET', '/api/me', s1)).status, 200);
  assert.deepStrictEqual(devs(s1).map(d => d.token), [k1], 'only the signed-out device row went');
  assert.strictEqual(sessions(s1.id), 2);
  const h3 = await hub(s3);
  const closed3 = shut(h3);
  assert.strictEqual((await call('POST', '/api/signout', s1, { all: true })).status, 200);
  assert.strictEqual(sessions(s1.id), 0);
  assert.strictEqual((await call('GET', '/api/me', s3)).status, 401, 'all: true ends every session');
  assert.strictEqual(devs(s1).length, 0);
  await within(closed3, 5000, 'and every socket');
  console.log('sign-out ends one session or all of them, with the device rows and hub sockets');

  const racer = 'race.' + t.sub;
  const burst = await Promise.all([1, 2, 3, 4].map(async i => post('/api/apple', null, await cred({ sub: racer }, null, 'r' + i))));
  assert.strictEqual(new Set(burst.map(x => x.body.id)).size, 1);
  assert.ok(row(burst[0].body.id).apple_refresh);
  assert.strictEqual(sessions(burst[0].body.id), 4);
  for (let i = 0; i < 12; i++) await post('/api/apple', null, await cred({ sub: racer }, null, 'm' + i));
  assert.strictEqual(sessions(burst[0].body.id), 10);
  console.log('parallel first sign-ins keep the token, a player keeps at most 10 devices');

  const first = await post('/api/apple', null, await cred({ sub: 'dev.' + t.sub }, null, 'p0'));
  await reg(first.body, 'fcm', fcmTok(), 'en', 0);
  const held = () => sql("SELECT count(*) AS n FROM devices WHERE player = '" + first.body.id + "'")[0].n;
  let newest;
  for (let i = 1; i < 10; i++) newest = await post('/api/apple', null, await cred({ sub: 'dev.' + t.sub }, null, 'p' + i));
  assert.strictEqual(held(), 1, 'ten sessions keep their devices');
  await reg(newest.body, 'fcm', fcmTok(), 'en', 0);
  await post('/api/apple', null, await cred({ sub: 'dev.' + t.sub }, null, 'p10'));
  assert.strictEqual((await call('GET', '/api/me', first.body)).status, 401);
  assert.strictEqual(held(), 1, 'the eleventh sign-in prunes the oldest session and its device, and only that');
  console.log('a pruned session takes its device with it');

  const g = await guest();
  await call('POST', '/api/daily', g);
  const chips = (await call('GET', '/api/me', g)).body.chips;
  assert.strictEqual((await call('GET', '/api/me', g)).body.apple, false);
  const mine = await cred({}, null, 'l1');
  r = await post('/api/apple/link', g, mine);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.apple, true);
  assert.strictEqual(r.body.chips, chips);
  assert.strictEqual(row(g.id).apple_refresh, 'rt.l1');
  assert.strictEqual((await post('/api/apple/link', g, mine)).status, 401);
  const back = await post('/api/apple', null, await cred({ sub: mine.sub }, null, 'l2'));
  assert.strictEqual(back.body.id, g.id);
  r = await post('/api/apple/link', back.body, await cred({ sub: mine.sub }));
  assert.strictEqual(r.status, 200);
  r = await post('/api/apple/link', back.body, await cred({}));
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(r.body, { k: 'linked' });
  console.log('a guest keeps its chips when linking');

  const other = await guest();
  r = await post('/api/apple/link', other, await cred({ sub: t.sub }));
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(r.body, { k: 'taken' });
  assert.strictEqual((await call('GET', '/api/me', other)).body.apple, false);
  assert.strictEqual((await post('/api/apple/link', null, await cred({ sub: t.sub }))).status, 401);
  console.log('a subject owned by another account is refused, nothing merged');

  const now = Math.floor(Date.now() / 1000);
  const bad = [
    await cred({ aud: 'com.example.other' }), await cred({ iss: 'https://evil.example' }), await cred({ exp: now - 10 }),
    await cred({ nonce: sha('n2') }), await cred({}, pair()), { token: 'x.y.z', nonce: 'n1' }, { token: t.token }, {}
  ];
  for (const b of bad) assert.strictEqual((await call('POST', '/api/apple', null, b)).status, 401, JSON.stringify(b).slice(0, 60));
  const wrong = await cred({});
  assert.strictEqual((await call('POST', '/api/apple', null, { token: wrong.token, nonce: 'n1' })).status, 401);
  const stale = await cred({});
  sql("UPDATE nonces SET exp = 1 WHERE raw = '" + stale.nonce + "'");
  assert.strictEqual((await post('/api/apple', null, stale)).status, 401);
  assert.strictEqual(sql("SELECT count(*) AS n FROM players WHERE apple IN ('" + wrong.sub + "', '" + stale.sub + "')")[0].n, 0);
  console.log('bad audience, issuer, expiry, nonce and signature are refused, a nonce works once');

  const none = await post('/api/apple', null, await cred({}, null, 'bad1'));
  assert.strictEqual(none.status, 200);
  assert.strictEqual(row(none.body.id).apple_refresh, null);
  r = await call('DELETE', '/api/me', none.body);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'reauth');
  r = await call('DELETE', '/api/me', none.body, await cred({}, null, 'd1'));
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await call('GET', '/api/me', none.body)).status, 200);
  const sub = row(none.body.id).apple;
  assert.strictEqual((await call('DELETE', '/api/me', none.body, await cred({ sub: sub }, null, 'bad2'))).status, 502);
  assert.strictEqual((await call('GET', '/api/me', none.body)).status, 200);
  assert.strictEqual((await call('DELETE', '/api/me', none.body, await cred({ sub: sub }, null, 'd2'))).status, 200);
  assert.deepStrictEqual(revoked.pop(), { token: 'rt.d2', client: APP });
  assert.strictEqual(sessions(none.body.id), 0);

  assert.strictEqual((await call('DELETE', '/api/me', web.body)).status, 200);
  assert.deepStrictEqual(revoked.pop(), { token: 'rt.w1', client: WEB });
  assert.strictEqual((await call('DELETE', '/api/me', acc)).status, 200);
  assert.deepStrictEqual(revoked.pop(), { token: 'rt.c2', client: APP });
  assert.strictEqual((await call('GET', '/api/me', again.body)).status, 401);
  assert.strictEqual((await call('DELETE', '/api/me', g)).status, 200);
  assert.strictEqual((await call('DELETE', '/api/me', other)).status, 200);
  console.log('deleting an account revokes its Apple token with the client it came from');
  for (const a of burst) await call('DELETE', '/api/me', a.body);
  stub.close();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WEEK = () => Math.floor((Date.now() - 4 * 86400000) / (7 * 86400000));
const who = acc => "'" + acc.id + "'";

// two humans in a private room; begin() starts it
async function pair(n, games, accs, stake = 100) {
  const accA = accs ? accs[0] : await guest();
  const accB = accs ? accs[1] : await guest();
  if (stake) link(accA, accB);
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: n, games: games, stake: stake });
  const ja = await a.next(m => m.t === 'joined');
  const b = client('/ws/' + ja.code);
  await b.ready;
  b.send({ t: 'join', auth: accB.auth });
  const jb = await b.next(m => m.t === 'joined');
  return { accA, accB, a, b, ja, jb, code: ja.code };
}

async function begin(g) {
  const sa = g.a.next(m => m.t === 'state');
  const sb = g.b.next(m => m.t === 'state');
  // a refusal (held, host, elsewhere) shows as itself, not as a missing state
  const no = g.a.next(m => m.t === 'error').then(m => { throw new Error('start refused: ' + m.k); });
  no.catch(() => {});
  g.a.send({ t: 'start' });
  return Promise.race([Promise.all([sa, sb]), no]);
}

async function friendRules() {
  const [a, b, c, d] = [await guest(), await guest(), await guest(), await guest()];
  const list = async acc => (await call('GET', '/api/friends', acc)).body;
  const ids = xs => xs.map(x => x.id);
  const rows = (x, y) => sql('SELECT count(*) AS n FROM friends WHERE (a = ' + who(x) + ' AND b = ' + who(y) + ') OR (a = ' + who(y) + ' AND b = ' + who(x) + ')')[0].n;
  assert.strictEqual((await call('POST', '/api/friend', a, { id: a.id })).status, 400);
  assert.strictEqual((await call('POST', '/api/friend', a, { id: 'x' })).status, 400);
  assert.strictEqual((await call('POST', '/api/friend', a, { id: '0'.repeat(32) })).status, 404);
  assert.strictEqual((await call('GET', '/api/friends')).status, 401);
  assert.strictEqual((await call('POST', '/api/friend', a, { id: b.id })).status, 200);
  assert.strictEqual((await call('POST', '/api/friend', a, { id: b.id })).status, 200);
  assert.deepStrictEqual(ids((await list(a)).outgoing), [b.id]);
  assert.deepStrictEqual(ids((await list(b)).incoming), [a.id]);
  assert.strictEqual((await list(a)).friends.length, 0);
  assert.strictEqual(rows(a, b), 1, 'asking twice keeps one row');
  assert.strictEqual((await call('POST', '/api/friend', b, { id: a.id })).status, 200);
  assert.deepStrictEqual(ids((await list(a)).friends), [b.id]);
  assert.deepStrictEqual(ids((await list(b)).friends), [a.id]);
  assert.strictEqual((await list(b)).incoming.length, 0);
  const prof = (await call('GET', '/api/player/' + b.id, a)).body;
  assert.strictEqual(prof.rel, 'friend');
  assert.strictEqual(prof.games, 0);
  assert.strictEqual('chips' in prof, false, 'the public profile shows no chips');
  assert.strictEqual((await call('GET', '/api/player/' + a.id, a)).body.rel, 'you');
  console.log('friends: request, accept, public profile');

  await call('DELETE', '/api/friend/' + a.id, b);
  assert.strictEqual(rows(a, b), 0, 'either side can remove a friend');
  await call('POST', '/api/friend', a, { id: b.id });
  await call('DELETE', '/api/friend/' + a.id, b);
  assert.strictEqual((await list(a)).outgoing.length, 0, 'a declined request is gone');
  await call('POST', '/api/friend', a, { id: b.id });
  await call('POST', '/api/friend', b, { id: a.id });

  await call('POST', '/api/block/' + b.id, a);
  assert.strictEqual((await list(a)).friends.length, 0, 'blocking ends the friendship');
  assert.deepStrictEqual(ids((await list(a)).blocked), [b.id]);
  assert.strictEqual((await list(b)).blocked.length, 0, 'the blocked player is not told');
  assert.strictEqual((await call('POST', '/api/friend', b, { id: a.id })).status, 200, 'the blocked player is not told');
  assert.strictEqual((await list(a)).incoming.length, 0, 'and nothing reaches the blocker');
  assert.strictEqual((await call('POST', '/api/friend', a, { id: b.id })).status, 403);
  assert.strictEqual((await call('GET', '/api/player/' + a.id, b)).body.rel, 'none');
  await call('DELETE', '/api/block/' + b.id, a);
  assert.strictEqual((await call('POST', '/api/friend', b, { id: a.id })).status, 200);
  sql("INSERT INTO friends (a, b, state) VALUES (" + who(a) + ", " + who(b) + ", 'req')");
  assert.strictEqual((await call('POST', '/api/friend', a, { id: b.id })).status, 200);
  assert.strictEqual(rows(a, b), 1, 'requests that crossed become one friendship');
  assert.deepStrictEqual(ids((await list(a)).friends), [b.id]);
  console.log('friends: remove, decline, block stops requests, unblock, crossed requests');

  sql("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 199) INSERT INTO friends (a, b, state) SELECT " + who(c) + ", substr('00000000000000000000000000000000' || i, -32), 'friend' FROM n");
  assert.strictEqual((await call('POST', '/api/friend', c, { id: d.id })).status, 200, 'the 200th is allowed');
  assert.strictEqual((await call('POST', '/api/friend', c, { id: a.id })).status, 409, 'the 201st is not');
  console.log('friends: capped at 200');

  assert.strictEqual((await call('DELETE', '/api/me', b)).status, 200);
  assert.strictEqual((await list(a)).incoming.length, 0, 'a deleted account leaves no requests');
  assert.strictEqual(rows(a, b), 0);
}

async function chat() {
  const g = await pair(3, 3);
  const [sa, sb] = await begin(g);
  assert.strictEqual(sa.players[0].pid, g.accA.id);
  assert.strictEqual(sb.players[0].pid, g.accB.id);
  assert.strictEqual(sa.players.filter(p => p.pid).length, 3);
  assert.strictEqual(sa.players.filter(p => personaIds([p.pid])).length, 1);
  const got = [];
  const seatA = sb.players.findIndex(p => p.pid === g.accA.id);
  g.b.handlers.push(m => { if (m.t === 'said' && m.p === seatA) got.push(m); });
  const mine = g.a.next(m => m.t === 'said' && m.p === 0);
  g.a.send({ t: 'say', k: 'nope' });
  g.a.send({ t: 'say', k: 'hello' });
  const e = await mine;
  assert.deepStrictEqual([e.p, e.k], [0, 'hello']);
  await sleep(200);
  assert.strictEqual(got.length, 1, 'an unknown phrase is dropped');
  assert.deepStrictEqual([got[0].p, got[0].k], [seatA, 'hello'], 'the other player sees the seat as theirs');
  g.a.send({ t: 'say', k: 'smile' });
  for (let i = 0; i < 6; i++) g.a.send({ t: 'say', k: 'luck' });
  await sleep(500);
  assert.strictEqual(got.length, 3, 'a burst of 3 passes, the rest is dropped: ' + got.length);
  console.log('chat: relayed with the seat rotated, unknown keys and floods dropped');
  g.a.ws.close();
  g.b.ws.close();
}

async function words() {
  const { mask, clean, typed, contact, LANGS } = await import('../src/filter.js');
  for (const [from, to] of [['You are a Fuck', 'You are a ****'], ['what the sh1t', 'what the ****'], ['FUUUUCK you', '******* you'], ['ŞİKTİR git', '****** git'],
    ['a$$hole', '*******'], ['Scheiße', '*******'], ['ПИЗДЕЦ тут', '****** тут'], ['хуй тебе', '*** тебе'], ['كسمك', '****'], ['씨발 뭐야', '** 뭐야'], ['他妈的真烦', '***真烦']]) {
    assert.strictEqual(mask(from, LANGS), to, from);
  }
  for (const ok of ['I got a pass at the class', 'Scunthorpe assess classic', 'send pic', 'Amina says hi', 'as is', 'sikayet var', 'I have 500 chips and 2500', 'やくそく', 'go to the park.']) {
    assert.strictEqual(mask(ok), ok, ok);
  }
  // contact details are only flagged, never changed
  for (const from of ['visit www.evil.com now', 'mail bob@mail.com ok', 'call 416-555-1234 now', '(555) 123-4567', '+90 (532) 123 45 67', '555/123/4567', 'call 416.555.1234.',
    'ｗｗｗ．ｅｘａｍｐｌｅ．ｃｏｍ', 'example。com ok', 'see foo.xyz/a', 'add @bobby now', 'a@b.com', 'go to x.de now']) {
    assert.strictEqual(contact(from), true, from);
    assert.strictEqual(mask(from), from.normalize('NFKC'), from);
  }
  for (const ok of ['12.500.000 chips', 'I have 1,250,000 chips', 'pay 25.000 now', 'I have 500 chips and 2500', 'me @ home', 'so e.g. this', 'go to the park.', 'sık sık']) {
    assert.strictEqual(contact(ok), false, ok);
  }
  for (const ok of ['Fukuoka', 'sık sık', 'siktir git', 'the pede']) assert.strictEqual(mask(ok), ok, ok);
  assert.strictEqual(typed('f\u00adu\u2060c\ufe0fk exam\u00adple.com', 120), '**** example.com', 'format characters do not hide a word');
  assert.strictEqual(contact(clean('exam\u00adple\u2060.com', 120)), true, 'nor a link');
  assert.strictEqual(mask('siktir git', ['tr']), '****** git', 'a language list applies when that language is in play');
  assert.strictEqual(mask('on pede', ['pt']), 'on pede');
  assert.strictEqual(mask('on pede', ['fr']), 'on ****');
  assert.strictEqual(mask('kurwa mac', ['pl', 'tr']), '***** mac');
  assert.strictEqual(clean('  a\x00b\x07 \n\t c  ', 120), 'ab c');
  assert.strictEqual(clean('x'.repeat(200), 120).length, 120);
  assert.strictEqual(clean(5, 120), '');
  console.log('filter: case, accents, look-alikes, repeats, words masked, contact details only flagged, amounts left alone');
}

async function talk() {
  const g = await pair(3, 3);
  const out = await pair(3, 3);
  const [sa, sb] = await begin(g);
  await begin(out);
  const seatA = sb.players.findIndex(p => p.pid === g.accA.id);
  const seatB = sa.players.findIndex(p => p.pid === g.accB.id);
  const line = (c, from) => c.next(m => m.t === 'typed' && m.p === from);
  const heard = [];
  for (const c of [out.a, out.b]) c.handlers.push(m => { if (m.t === 'typed') heard.push(m); });
  const atB = line(g.b, seatA);
  const own = line(g.a, 0);
  g.a.send({ t: 'text', x: '  hello\x00 there\n\n  all   ' + 'x'.repeat(200) });
  const e = await atB;
  assert.strictEqual(e.x.length, 120, 'cut to 120 characters');
  assert(e.x.startsWith('hello there all x'), 'control characters dropped and whitespace collapsed: ' + e.x);
  assert.strictEqual((await own).x, e.x, 'the sender sees it too');
  g.a.send({ t: 'text', x: 'ok ' });
  assert.strictEqual((await line(g.b, seatA)).x, 'ok');
  g.a.send({ t: 'text', x: '   ' });
  g.a.send({ t: 'text', x: 5 });
  g.a.send({ t: 'text' });
  await sleep(300);
  assert.deepStrictEqual(heard, [], 'another table hears nothing');
  console.log('table chat: reaches the table, trimmed, cleaned and cut; nothing for other tables or empty text');

  await sleep(4100);
  const tail = 'you sh1t, see www.example.com or mail me@x.org';
  const ask = g.a.next(m => m.t === 'confirm');
  const early = [];
  g.b.handlers.push(m => { if (m.t === 'typed') early.push(m); });
  g.a.send({ t: 'text', x: tail });
  assert.strictEqual((await ask).k, 'contact', 'contact details need a yes first');
  await sleep(300);
  assert.deepStrictEqual(early, [], 'and nothing is delivered before it');
  const masked = line(g.b, seatA);
  g.a.send({ t: 'text', x: tail, ok: true });
  const shown = await masked;
  assert.deepStrictEqual([shown.x, shown.c], ['you ****, see www.example.com or mail me@x.org', true], 'words masked, contact details kept and flagged');
  console.log('table chat: filtered, and contact details confirmed then delivered with a flag');

  // a burst of 3, then one every 2 seconds; phrases have a budget of their own
  const flood = await pair(3, 3);
  await begin(flood);
  const got = [];
  flood.b.handlers.push(m => { if (m.t === 'typed') got.push(m.x); });
  for (let i = 0; i < 8; i++) flood.a.send({ t: 'text', x: 'n' + i });
  flood.a.send({ t: 'say', k: 'hello' });
  const said = flood.b.next(m => m.t === 'said');
  await said;
  await sleep(400);
  assert.deepStrictEqual(got, ['n0', 'n1', 'n2'], 'the rate limit keeps the first three');
  console.log('table chat: rate limited, phrases unaffected');
  flood.a.ws.close();
  flood.b.ws.close();

  // a player who reconnects gets the recent lines back, marked old
  const jb = g.jb;
  g.b.ws.close();
  await sleep(200);
  const b2 = client('/ws/' + g.code);
  await b2.ready;
  const old = [];
  b2.handlers.push(m => { if (m.t === 'typed') old.push(m); });
  b2.send({ t: 'join', token: jb.token });
  await b2.next(m => m.t === 'state');
  await sleep(400);
  assert.strictEqual(old.length, 3, 'three lines kept');
  assert(old.every(m => m.old && m.p === seatA));
  assert.deepStrictEqual([old[2].x, old[2].c], ['you ****, see www.example.com or mail me@x.org', true]);
  assert.strictEqual(old[0].c, false, 'a plain line carries no flag');
  console.log('table chat: recent lines replayed on rejoin');

  // a block hides typed chat both ways
  await call('POST', '/api/block/' + g.accB.id, g.accA);
  await sleep(2100);
  const mineA = line(g.a, 0);
  const mineB = line(b2, 0);
  const lost = [];
  g.a.handlers.push(m => { if (m.t === 'typed' && m.p === seatB) lost.push(m); });
  b2.handlers.push(m => { if (m.t === 'typed' && m.p === seatA) lost.push(m); });
  g.a.send({ t: 'text', x: 'blocked one' });
  b2.send({ t: 'text', x: 'blocked two' });
  assert.strictEqual((await mineA).x, 'blocked one');
  assert.strictEqual((await mineB).x, 'blocked two');
  await sleep(400);
  assert.deepStrictEqual(lost, [], 'neither side sees the other');
  const b3 = client('/ws/' + g.code);
  await b3.ready;
  const again = [];
  b3.handlers.push(m => { if (m.t === 'typed') again.push(m); });
  b3.send({ t: 'join', token: jb.token });
  await b3.next(m => m.t === 'state');
  await sleep(400);
  assert.deepStrictEqual(again.map(m => m.x), ['blocked two'], 'the replay leaves out a blocked sender');
  console.log('table chat: a block hides typed lines both ways, live and replayed');
  for (const c of [g.a, g.b, b2, b3, out.a, out.b]) c.ws.close();
}

async function tongues() {
  const g = await pair(3, 3);
  const [sa, sb] = await begin(g);
  const seatA = sb.players.findIndex(p => p.pid === g.accA.id);
  const seatB = sa.players.findIndex(p => p.pid === g.accB.id);
  assert.strictEqual((await call('POST', '/api/lang', g.accA, { lang: 'xx' })).status, 400);
  assert.strictEqual((await call('POST', '/api/lang', g.accA, {})).status, 400);
  assert.strictEqual((await call('POST', '/api/lang', g.accA, { lang: 'en' })).body.lang, 'en');
  assert.strictEqual((await call('POST', '/api/lang', g.accB, { lang: 'tr' })).body.lang, 'tr');
  // English only checks English; a Turkish reader or sender brings the Turkish list in
  const atB = g.b.next(m => m.t === 'typed' && m.p === seatA);
  const mine = g.a.next(m => m.t === 'typed' && m.p === 0);
  g.a.send({ t: 'text', x: 'siktir git' });
  assert.strictEqual((await atB).x, '****** git', 'the Turkish reader gets it masked');
  assert.strictEqual((await mine).x, 'siktir git', 'the English sender sees their own line');
  const atA = g.a.next(m => m.t === 'typed' && m.p === seatB);
  g.b.send({ t: 'text', x: 'siktir git' });
  assert.strictEqual((await atA).x, '****** git', 'a Turkish sender is masked for everyone');
  console.log('languages: table lines are masked per reader with the sender language and their own');

  await befriend(g.accA, g.accB);
  const dm = (from, to) => call('POST', '/api/dm', from, { to: to.id, text: 'siktir git' });
  assert.strictEqual((await dm(g.accA, g.accB)).body.message.text, '****** git');
  const c = await guest();
  await befriend(g.accA, c);
  assert.strictEqual((await dm(g.accA, c)).body.message.text, 'siktir git', 'two English players share no Turkish list');
  g.a.ws.close();
  g.b.ws.close();
  console.log('languages: private messages are masked for the pair');
}

async function gifts() {
  const g = await pair(3, 3);
  await begin(g);
  const sent = [];
  g.b.handlers.push(m => { if (m.t === 'gifted') sent.push(m); });
  const chips = async acc => (await call('GET', '/api/me', acc)).body.chips;
  assert.strictEqual(await chips(g.accA), 4775);
  const seen = g.a.next(m => m.t === 'gifted');
  const bank = g.a.next(m => m.t === 'state' && m.players[0].bank === 4725);
  g.a.send({ t: 'gift', to: 1, k: 'tea' });
  const e = await seen;
  assert.deepStrictEqual([e.from, e.to, e.k], [0, 1, 'tea']);
  await bank;
  await sleep(100);
  // B sits after A, so B counts A as the last seat and itself as 0
  assert.deepStrictEqual([sent[0].from, sent[0].to], [2, 0], 'the target sees the gift as sent to them');
  assert.strictEqual(await chips(g.accA), 4725);
  assert.strictEqual(await chips(g.accB), 4775, 'nobody receives the chips');
  assert.deepStrictEqual(sql('SELECT delta, reason FROM chip_log WHERE player = ' + who(g.accA) + " AND reason = 'gift'"), [{ delta: -50, reason: 'gift' }]);
  console.log('gift: 50 chips charged once, shown to both, not paid to the target');

  g.a.send({ t: 'gift', to: 0, k: 'tea' });
  g.a.send({ t: 'gift', to: 3, k: 'tea' });
  g.a.send({ t: 'gift', to: 1, k: 'gold' });
  await sleep(300);
  assert.strictEqual(sent.length, 1, 'self, out of range and unknown gifts are dropped');
  assert.strictEqual(await chips(g.accA), 4725);
  const bot = g.a.next(m => m.t === 'gifted' && m.to === 2);
  g.a.send({ t: 'gift', to: 2, k: 'tea' });
  await bot;
  assert.strictEqual(await chips(g.accA), 4675, 'a bot seat is charged too');

  await sleep(2100);
  await call('POST', '/api/block/' + g.accB.id, g.accA);
  const no = g.a.next(m => m.t === 'error');
  g.a.send({ t: 'gift', to: 1, k: 'tea' });
  assert.strictEqual((await no).k, 'blocked');
  await call('DELETE', '/api/block/' + g.accB.id, g.accA);
  sql('UPDATE players SET chips = 40 WHERE id = ' + who(g.accA));
  const poor = g.a.next(m => m.t === 'error');
  g.a.send({ t: 'gift', to: 1, k: 'tea' });
  assert.strictEqual((await poor).k, 'broke');
  assert.strictEqual(await chips(g.accA), 40);
  console.log('gift: refused to a player who blocked the sender, refused when poor');
  g.a.ws.close();
  g.b.ws.close();
}

async function invites() {
  const g = await pair(3, 3);
  const f = link(await guest());
  const n = await guest();
  await call('POST', '/api/friend', g.accA, { id: f.id });
  await call('POST', '/api/friend', f, { id: g.accA.id });
  const hf = await hub(f);
  const hn = await hub(n);
  const fl = (await call('GET', '/api/friends', g.accA)).body.friends;
  assert.deepStrictEqual(fl.map(x => [x.id, x.online]), [[f.id, true]], 'a friend in the lobby shows as online');
  assert.deepStrictEqual(fl[0].at, { w: 'lobby' });
  hf.send({ t: 'at', at: 'training' });
  await sleep(100);
  assert.deepStrictEqual((await call('GET', '/api/friends', g.accA)).body.friends[0].at, { w: 'training' });
  g.b.ws.close();

  sql('UPDATE players SET chips = 500 WHERE id = ' + who(f));
  const poor = g.a.next(m => m.t === 'sent');
  g.a.send({ t: 'invite', to: f.id });
  assert.strictEqual((await poor).ok, false, 'a friend who cannot cover the stake is not invited');
  sql('UPDATE players SET chips = 5000 WHERE id = ' + who(f));
  await sleep(2100);

  const inv = hf.next(m => m.t === 'invited');
  const ack = g.a.next(m => m.t === 'sent');
  g.a.send({ t: 'invite', to: f.id });
  const m = await inv;
  assert.deepStrictEqual([m.code, m.stake, m.pub, m.from.pid], [g.code, 100, false, g.accA.id]);
  assert.deepStrictEqual(await ack, { t: 'sent', to: f.id, ok: true });
  let twice = 0;
  hf.handlers.push(x => { if (x.t === 'invited') twice++; });
  const dup = g.a.next(x => x.t === 'sent');
  g.a.send({ t: 'invite', to: f.id });
  assert.deepStrictEqual(await dup, { t: 'sent', to: f.id, ok: true });
  assert.strictEqual(twice, 0, 'the same friend is not invited twice within a few seconds');
  const miss = g.a.next(x => x.t === 'sent');
  g.a.send({ t: 'invite', to: n.id });
  assert.strictEqual((await miss).ok, false, 'a stranger gets nothing');
  hf.ws.close();
  await sleep(300);
  assert.strictEqual((await call('GET', '/api/friends', g.accA)).body.friends[0].online, false);
  hn.ws.close();
  console.log('invite: delivered to a friend in training, once, nothing to a stranger');
  g.a.ws.close();
}

function personaIds(ids) {
  return sql('SELECT count(*) AS n FROM personas WHERE id IN (' + ids.map(x => "'" + x + "'").join(',') + ')')[0].n;
}

// a lone human at a stake table: personas fill the seats one at a time and the match settles as before
async function personas() {
  // a pool that is there already, so a fresh database does not make the first fills slow
  sql('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 15) INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy, busy_at, created) ' +
    "SELECT lower(hex(randomblob(16))), 500 + i, '1,1,1,0', 4, 400, 8, 2, 100000, " + Date.now() + ', NULL, 0, 2 FROM n');
  const acc = level(4, await guest());
  const h = await hub(acc);
  const t0 = Date.now();
  const s = h.next(m => m.t === 'seated');
  h.send({ t: 'quick', stake: 500 });
  const sat = await s;
  const r = seated(sat);
  const all = [];
  const stamps = [];
  r.handlers.push(m => {
    all.push(m);
    if (m.t === 'state') stamps.push([Date.now(), m]);
  });
  const fin = played(r);
  const counts = [];
  const first = r.next(m => m.t === 'room');
  first.then(m => assert.strictEqual(m.finding, 3, 'the waiting view counts the seats being filled'));
  r.handlers.push(m => { if (m.t === 'room') counts.push([Date.now(), m.seats.filter(Boolean).length]); });
  await Promise.race([fin, new Promise((x, j) => setTimeout(() => j(new Error('timeout')), 120000))]);
  assert(!all.some(m => /bot|fake|persona/i.test(JSON.stringify(m))), 'nothing at the table says bot');
  const steps = counts.map(x => x[1]);
  assert.deepStrictEqual(steps.filter((n, i) => i === 0 || n !== steps[i - 1]), [1, 2, 3, 4], 'seats fill one at a time, the last one when the window ends');
  const two = counts.find(x => x[1] === 2)[0];
  assert(two - t0 <= 8000 * 0.02 + 1500, 'the first fill comes inside the window: ' + (two - t0) + 'ms');
  const st = r.st;
  assert.strictEqual(st.players.length, 4);
  const others = st.players.slice(1);
  assert.strictEqual(personaIds(others.map(p => p.pid)), 3);
  for (const p of others) {
    const row = sql("SELECT vip, wear FROM personas WHERE id = '" + p.pid + "'")[0];
    assert(!row.vip, 'a computer player is never a VIP: ' + row.vip);
    assert.strictEqual(p.vip, false, 'the seat shows no badge');
    const card = (await call('GET', '/api/player/' + p.pid, acc)).body;
    assert.strictEqual(card.vip, false, 'nor does the card');
    assert(![...Object.values(JSON.parse(row.wear)), ...Object.values(p.wear), ...Object.values(card.wear)].some(id => Catalog.item(id).vip), 'and none wears an item for subscribers');
  }
  for (const p of others) {
    assert(p.level >= 1 && p.level <= 7, 'level near the human (4): ' + p.level);
    assert(p.bank >= 500 * 10 - 1325, 'plausible chips: ' + p.bank);
    assert.strictEqual(p.away, false);
  }
  assert.strictEqual(new Set(others.map(p => p.seed)).size, 3, 'no name twice at a table');
  // a persona never reads as instant: the gaps between moves it makes
  const gaps = [];
  for (let i = 1; i < stamps.length; i++) {
    const [at, m] = stamps[i];
    const prev = stamps[i - 1][1];
    if (m.lb > 0 && m.log.length && prev.phase === m.phase && prev.turn !== 0 && prev.phase !== 'claim' && prev.phase !== 'gameend') gaps.push(at - stamps[i - 1][0]);
  }
  // messages that queue up on a loaded machine arrive together, so the middle gap says it, not the smallest
  const mid = gaps.sort((x, y) => x - y)[gaps.length >> 1];
  assert(gaps.length > 8 && mid >= 15, 'bot moves are paced: ' + mid + ' (smallest ' + gaps[0] + ')');
  assert(!all.some(m => m.t === 'said' || m.t === 'typed'), 'no computer player says or types anything');
  await sleep(600);
  const me = (await call('GET', '/api/me', acc)).body;
  assert.strictEqual(me.chips, 5000 - 1300 - 25 + payout(500, 4, st.players[0].chips));
  assert.strictEqual(sql("SELECT count(*) AS n FROM chip_log WHERE player IN (SELECT id FROM personas)")[0].n, 0, 'personas never touch the chip log');
  assert.strictEqual(sql("SELECT count(*) AS n FROM players WHERE id IN (SELECT id FROM personas)")[0].n, 0);
  assert(me.xp >= 40 && me.games === 1, 'a match against personas counts: xp ' + me.xp);
  assert.strictEqual(me.xp, 40 + (st.final.low === 0 ? 30 : 0) + 5 * st.stats.filter(x => x.fin === 0).length);
  const board = (await call('GET', '/api/player/' + acc.id, acc)).body;
  assert.strictEqual(board.won, Math.max(0, payout(500, 4, st.players[0].chips) - hold(500, 4)), 'and so does the weekly board');
  console.log('personas: a lone human got a full table, silent, ' + gaps.length + ' paced moves, settled');

  // profile, friend request and the lists look the same as for a real player
  const pid = others[0].pid;
  const real = (await call('GET', '/api/player/' + (await guest()).id, acc)).body;
  const pr = await call('GET', '/api/player/' + pid, acc);
  assert.strictEqual(pr.status, 200);
  assert.deepStrictEqual(Object.keys(pr.body).sort(), Object.keys(real).sort());
  assert.strictEqual(pr.body.rel, 'none');
  assert.strictEqual(pr.body.avatar.length, 4);
  assert.strictEqual((await call('POST', '/api/friend', acc, { id: pid })).status, 200);
  assert.strictEqual((await call('GET', '/api/player/' + pid, acc)).body.rel, 'sent');
  const l = (await call('GET', '/api/friends', acc)).body;
  assert.deepStrictEqual(l.outgoing.map(x => x.id), [pid]);
  assert.strictEqual(l.friends.length + l.incoming.length, 0);
  assert.deepStrictEqual(Object.keys(l.outgoing[0]).sort(), ['avatar', 'id', 'level', 'seed']);
  assert.strictEqual((await call('DELETE', '/api/friend/' + pid, acc)).status, 200);
  assert.strictEqual((await call('GET', '/api/player/' + pid, acc)).body.rel, 'none');
  assert.strictEqual((await call('GET', '/api/friends', acc)).body.outgoing.length, 0);
  console.log('persona profile: same shape, friend request stays pending and can be cancelled');
  // a row from before: a subscriber badge and gold items on a computer player show nowhere, and the migration strips them
  const old = 'f'.repeat(32);
  sql("INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy_at, created, wear, owns, vip) VALUES ('" + old + "', 55, '1,1,1,0', 3, 300, 9, 3, 5000, 0, 0, 0, '{\"frame\":\"frame-gold\",\"plate\":\"plate-oak\",\"back\":\"back-vip\"}', '[]', 1)");
  const shown = (await call('GET', '/api/player/' + old, acc)).body;
  assert.strictEqual(shown.vip, false);
  assert.deepStrictEqual(shown.wear, { plate: 'plate-oak' }, 'only the item anyone can buy is shown');
  const text = fs.readFileSync(__dirname + '/../migrations/0018_computers.sql', 'utf8');
  for (const q of text.split('\n').filter(l => /^UPDATE personas SET (vip|wear) /.test(l))) sql(q);
  const row = sql("SELECT vip, wear FROM personas WHERE id = '" + old + "'")[0];
  assert.strictEqual(row.vip, 0);
  assert.deepStrictEqual(JSON.parse(row.wear), { plate: 'plate-oak' }, 'the migration strips the subscriber items');
  sql("DELETE FROM personas WHERE id = '" + old + "'");
  sql('DELETE FROM personas WHERE created = 2');
  console.log('personas: no subscriber badge or items, in the seats, the cards or the old rows');
  r.ws.close();
  h.ws.close();

  // a second hub socket for the same account replaces the first
  const one = await hub(acc);
  const gone = new Promise(res => one.ws.on('close', code => res(code)));
  const msg = one.next(m => m.t === 'error');
  const two2 = await hub(acc);
  assert.strictEqual((await msg).k, 'replaced');
  assert.strictEqual(await within(gone, 5000, 'the old hub socket closing'), 4000);
  two2.ws.close();
  console.log('hub: the newest socket of an account wins');
}

// where friends are, an invite to a player who is not in the lobby, and joining a friend's table
async function whereabouts() {
  const [a, f, c, poor] = [await guest(), await guest(), await guest(), await guest()];
  level(4, a, f, c, poor);
  for (const x of [f, c, poor]) {
    await call('POST', '/api/friend', a, { id: x.id });
    await call('POST', '/api/friend', x, { id: a.id });
  }
  sql("UPDATE players SET chips = 1000 WHERE id = '" + poor.id + "'");
  const at = async id => (await call('GET', '/api/friends', a)).body.friends.find(x => x.id === id).at;
  assert.strictEqual(await at(f.id), null);
  const hf = await hub(f);
  const hp = await hub(poor);
  assert.deepStrictEqual(await at(f.id), { w: 'lobby' });
  hf.send({ t: 'at', at: 'training' });
  await sleep(100);
  assert.deepStrictEqual(await at(f.id), { w: 'training' });

  // a public table
  const ha = await hub(a);
  const sa = ha.next(m => m.t === 'seated');
  ha.send({ t: 'quick', stake: 500 });
  const A = await sa;
  const ra = seated(A);
  await ra.next(m => m.t === 'room');
  const seen = (await call('GET', '/api/friends', f)).body.friends.find(x => x.id === a.id).at;
  assert.deepStrictEqual(seen, { w: 'table', code: A.code, pub: true, stake: 500, free: 3, started: false });

  // an invite reaches a friend who is in training, and carries what is needed to sit
  const inv = hf.next(m => m.t === 'invited');
  ra.send({ t: 'invite', to: f.id });
  const m = await inv;
  assert.deepStrictEqual([m.code, m.stake, m.pub, m.from.pid], [A.code, 500, true, a.id]);
  console.log('invite: reached a friend in training');

  // joining: too poor is refused, a friend sits at the host's table
  const no = hp.next(m => m.t === 'error');
  hp.send({ t: 'sit', code: A.code });
  assert.strictEqual((await no).k, 'poor');
  const sf = hf.next(m => m.t === 'seated');
  hf.send({ t: 'sit', code: m.code });
  const F = await sf;
  assert.strictEqual(F.code, A.code);
  assert.notStrictEqual(F.seat, A.seat);
  const rf = seated(F);
  await rf.next(m => m.t === 'room');
  ra.ws.close();
  rf.ws.close();
  ha.ws.close();
  hf.ws.close();
  hp.ws.close();
  console.log('join a friend: poor refused, public table sat through the hub');
  // the public table can start before the sockets close, and leaving then costs the stake
  sql("UPDATE players SET chips = 5000 WHERE id IN ('" + a.id + "', '" + f.id + "')");

  // a private room is joined by its code, with the same chip check
  link(a, f, poor);
  const host = client('/ws/new');
  await host.ready;
  host.send({ t: 'create', auth: a.auth, players: 3, games: 3, stake: 500 });
  const ja = await host.next(m => m.t === 'joined');
  await sleep(100);
  const w = (await call('GET', '/api/friends', f)).body.friends.find(x => x.id === a.id).at;
  assert.deepStrictEqual(w, { w: 'table', code: ja.code, pub: false, stake: 500, free: 2, started: false });
  const hub2 = await hub(f);
  const no2 = hub2.next(m => m.t === 'error');
  hub2.send({ t: 'sit', code: ja.code });
  assert.strictEqual((await no2).k, 'nocode', 'a private room is not sat through the hub');
  const lowc = client('/ws/' + ja.code);
  await lowc.ready;
  lowc.send({ t: 'join', auth: poor.auth });
  assert.strictEqual((await lowc.next(m => m.t === 'error')).k, 'poor');
  const fc = client('/ws/' + ja.code);
  await fc.ready;
  fc.send({ t: 'join', auth: f.auth });
  await fc.next(m => m.t === 'joined');
  await sleep(100);
  assert.strictEqual((await call('GET', '/api/friends', c)).body.friends.length, 1);
  assert.strictEqual((await call('GET', '/api/friends', a)).body.friends.find(x => x.id === f.id).at.code, ja.code);
  // the host starts with an empty seat and it is looked for in the pool
  const st = host.next(m => m.t === 'state');
  const finding = host.next(m => m.t === 'room' && m.finding === 1);
  // the public table it left may have started before the socket closed, and then it holds the account until its
  // match is over; ask again only when told so
  for (let i = 0; i < 180; i++) {
    const no = host.next(m => m.t === 'error' && m.k === 'held');
    host.send({ t: 'start' });
    const r = await Promise.race([finding.then(() => 'ok'), no.then(() => 'held')]);
    if (r === 'ok') break;
    await sleep(500);
  }
  await finding;
  const view = await st;
  assert.strictEqual(personaIds(view.players.map(p => p.pid)), 1);
  leakCheck(view);
  const started = (await call('GET', '/api/friends', a)).body.friends.find(x => x.id === f.id).at;
  assert.strictEqual(started.started, true);
  console.log('join a friend: private room by code, host start fills the empty seat');
  host.ws.close();
  fc.ws.close();
  hub2.ws.close();
}


async function board() {
  const [a, b, c, old] = [await guest(), await guest(), await guest(), await guest()];
  const w = WEEK();
  const base = Math.floor(Date.now() / 1000) * 10;
  const set = (x, wk, won, lv) => sql('UPDATE players SET week = ' + wk + ', week_won = ' + won + ', xp = ' + (base + lv) + ', level = ' + (base + lv) + ' WHERE id = ' + who(x));
  set(a, w, base + 5, 5);
  set(b, w, base + 3, 3);
  set(c, w, base + 1, 1);
  set(old, w - 1, base + 9, 0);
  const top = (await call('GET', '/api/top', c)).body;
  assert.deepStrictEqual(top.week.slice(0, 3).map(x => x.id), [a.id, b.id, c.id]);
  assert(!top.week.some(x => x.id === old.id), 'last week does not count');
  assert.deepStrictEqual(top.you, { won: base + 1, rank: 3 });
  assert.strictEqual(top.week[0].won, base + 5);
  assert.strictEqual(top.week[0].avatar.length, 4);
  assert.strictEqual('secret_hash' in top.week[0], false);
  assert.deepStrictEqual(top.level.slice(0, 3).map(x => x.id), [a.id, b.id, c.id]);
  assert.strictEqual(top.up, 3);
  assert(top.week.length <= 50 && top.level.length <= 50);
  assert.deepStrictEqual((await call('GET', '/api/top', old)).body.you, { won: 0, rank: null });
  assert.strictEqual((await call('GET', '/api/player/' + old.id, a)).body.rank, null);
  console.log('leaderboard: ordered by chips won this week and by level, last week left out, own rank');

  // two humans at a friend table: whoever wins, it counts for nobody and an old week is left as it was
  const g = await pair(3, 3);
  sql('UPDATE players SET week = ' + (w - 1) + ', week_won = 999 WHERE id IN (' + who(g.accA) + ', ' + who(g.accB) + ')');
  const fin = [];
  const finished = new Promise(res => { fin.res = res; });
  const o = { finish: x => { if (!fin.includes(x)) fin.push(x); if (fin.length === 2) fin.res(); } };
  Object.assign(g.a, { seat: g.ja.seat });
  play(g.a, o);
  play(g.b, o);
  g.a.send({ t: 'start' });
  await Promise.race([finished, new Promise((r, j) => setTimeout(() => j(new Error('timeout')), 60000))]);
  await sleep(600);
  for (const [acc, x] of [[g.accA, g.a], [g.accB, g.b]]) {
    const net = x.st.res.net;
    const p = (await call('GET', '/api/player/' + acc.id, acc)).body;
    assert.strictEqual(p.won, 0, 'weekly chips ' + p.won + ' for net ' + net);
    assert.strictEqual(sql('SELECT week AS n FROM players WHERE id = ' + who(acc))[0].n, w - 1);
    const pv = sql('SELECT prev_week, prev_won FROM players WHERE id = ' + who(acc))[0];
    assert.deepStrictEqual([pv.prev_week, pv.prev_won], [0, 0], 'nothing rolled over');
    console.log('two humans: net', net, 'counted', p.won);
  }
  g.a.ws.close();
  g.b.ws.close();
}

// computer players are on the boards like anyone: what they win at public tables counts, a friend table counts for nobody, and the
// hourly job adds what keeps them looking like players who play every week
async function boards() {
  const w = WEEK();
  const big = 2e9;
  const hex = c => c.repeat(32);
  const bot = (c, won, level, xp, factor = 1) => sql("INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy_at, created, week, week_won, factor) VALUES ('" + hex(c) + "', 950, '1,1,1,0', " + level + ', ' + xp + ', 9, 3, 5000, 0, 0, 6, ' + w + ', ' + won + ', ' + factor + ')');
  sql('DELETE FROM personas WHERE created = 6');
  const me = await guest();
  const set = n => sql('UPDATE players SET week = ' + w + ', week_won = ' + n + ', xp = 5, level = 1 WHERE id = ' + who(me));
  set(big + 100);
  bot('a', big + 500, 100000, 1e12);
  bot('b', big + 200, 3, 300);
  bot('c', big + 100, 3, 300);
  let top = (await call('GET', '/api/top', me)).body;
  assert.deepStrictEqual(top.week.slice(0, 2).map(x => x.id), [hex('a'), hex('b')], 'computer players are on the weekly board');
  assert.strictEqual(top.week[0].won, big + 500);
  assert.deepStrictEqual(top.you, { won: big + 100, rank: 3 }, 'a human rank counts them');
  assert.strictEqual(top.level[0].id, hex('a'), 'and on the level board, with their level');
  assert.strictEqual(top.level[0].level, 100000);
  assert(top.up >= 2, 'the level rank counts them too: ' + top.up);
  assert.deepStrictEqual(Object.keys(top.week[0]).sort(), ['avatar', 'id', 'level', 'seed', 'won'], 'the same fields as a person');
  const card = (await call('GET', '/api/player/' + hex('b'), me)).body;
  assert.deepStrictEqual([card.won, card.rank], [big + 200, 2], 'the card has real numbers');
  sql('DELETE FROM personas WHERE created = 6');
  top = (await call('GET', '/api/top', me)).body;
  assert.deepStrictEqual(top.you, { won: big + 100, rank: 1 });
  console.log('boards: computer players rank on both boards and in a human rank');

  // a match at a public table counts for them; one at a friend table counts for nobody
  const [a, b] = [link(level(4, await guest())), link(level(4, await guest()))];
  sql('UPDATE players SET chips = 50000 WHERE id IN (' + who(a) + ', ' + who(b) + ')');
  const pub = await quickAt(a, 100);
  const fr = await friendAt(b, 4, 100);
  const [sp, sf] = await Promise.all([pub.first, fr.first]);
  const bots = m => m.players.slice(1).map(p => p.pid);
  const snap = ids => sql("SELECT id, week, week_won, week_xp FROM personas WHERE id IN ('" + ids.join("','") + "')");
  const before = snap(bots(sf));
  const start = snap(bots(sp));
  await Promise.all([within(pub.done, 240000, 'public match'), within(fr.done, 240000, 'friend match')]);
  await sleep(1000);
  assert.deepStrictEqual(snap(bots(sf)), before, 'a friend table counts for no computer player');
  assert.deepStrictEqual(sql('SELECT week, week_won FROM players WHERE id = ' + who(b))[0], { week: 0, week_won: 0 }, 'nor for a person');
  const st = pub.r.st;
  st.players.slice(1).forEach((p, j) => {
    const k = j + 1;
    const row = snap([p.pid])[0];
    const was = start.find(x => x.id === p.pid);
    // a computer player may already have a week behind it from the hourly job or an earlier table
    const base = was.week === w ? was : { week_won: 0, week_xp: 0 };
    const win = st.final.low === k;
    const fin = st.stats.filter(f => f.fin === k).length;
    const gain = Math.max(0, payout(100, 4, p.chips) - hold(100, 4));
    assert.strictEqual(row.week, w);
    assert.strictEqual(row.week_won - base.week_won, gain, 'a computer player counts what it won at the table');
    assert.strictEqual(row.week_xp - base.week_xp, 40 + (win ? 30 : 0) + 5 * fin, 'and the xp of the match');
  });
  assert.strictEqual(sp.players.length, 4);
  console.log('boards: a public table counts for the computer players, a friend table for nobody');
  for (const x of [pub, fr]) {
    x.r.ws.close();
    if (x.h) x.h.ws.close();
  }

  // the hourly job: a free computer player gains inside its band, one at a table nothing; the rate can be set by a test
  sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('simrate', '{\"won\":1000,\"xp\":100}')");
  bot('d', 0, 3, 300, 0.5);
  sql("UPDATE personas SET week = 0, week_won = 77, week_xp = 5 WHERE id = '" + hex('d') + "'");
  bot('e', 0, 3, 300, 1.5);
  sql("UPDATE personas SET busy = 'table', busy_at = " + Date.now() + " WHERE id = '" + hex('e') + "'");
  bot('f', 0, 3, 300, 1);
  const hour = Math.floor(Date.now() / 3600000) * 3600000;
  await tick(hour);
  const row = c => sql("SELECT week, week_won, week_xp, prev_week, prev_won FROM personas WHERE id = '" + hex(c) + "'")[0];
  const d = row('d');
  assert.strictEqual(d.week, w, 'the week turns over');
  assert.deepStrictEqual([d.prev_week, d.prev_won], [0, 77], 'last week moves to the prev columns');
  assert(d.week_won >= 1000 * 0.5 * 0.7 && d.week_won <= 1000 * 0.5 * 1.3, 'inside the band of its factor: ' + d.week_won);
  assert(d.week_xp >= 100 * 0.5 * 0.7 && d.week_xp <= 100 * 0.5 * 1.3, 'xp too: ' + d.week_xp);
  assert.deepStrictEqual(row('e'), { week: w, week_won: 0, week_xp: 0, prev_week: 0, prev_won: 0 }, 'not while it is at a table');
  const fr1 = row('f');
  assert(fr1.week_won >= 700 && fr1.week_won <= 1300 && fr1.week_xp >= 70 && fr1.week_xp <= 130, 'a factor of one: ' + fr1.week_won + ' ' + fr1.week_xp);
  await tick(hour);
  assert(row('f').week_won > fr1.week_won, 'every hour adds');
  sql("DELETE FROM settings WHERE key = 'simrate'");
  sql('DELETE FROM personas WHERE created = 6');
  console.log('boards: the hourly job adds wins and xp inside the band, and skips a table');
}

// A computer player is now and then away for a while and plays only safe moves then, and between matches it stays for a rematch at
// the rates the daily totals count. The odds of an away match can be raised by a setting only a test can use.
async function rematchPersona() {
  const { stays } = await import('../src/persona.js');
  let won = 0;
  let lost = 0;
  const N = 6000;
  for (let i = 0; i < N; i++) {
    won += stays(true, true) ? 1 : 0;
    lost += stays(false, true) ? 1 : 0;
  }
  assert(won / N > 0.67 && won / N < 0.73, 'a winner stays about 0.7 of the time: ' + won / N);
  assert(lost / N > 0.47 && lost / N < 0.53, 'a loser about 0.5: ' + lost / N);
  assert(!stays(true, false) && !stays(false, false), 'one that cannot cover entry and fee never stays');
  console.log('rematch: stay rates ' + (won / N).toFixed(2) + ' after a win and ' + (lost / N).toFixed(2) + ' after a loss');

  sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('awayodds', '1')");
  const acc = link(level(4, await guest()));
  sql('UPDATE players SET chips = 50000 WHERE id = ' + who(acc));
  const day = Math.floor(Date.now() / DAY);
  const total = () => sql("SELECT coalesce(sum(rm_human), 0) AS h, coalesce(sum(rm_human_yes), 0) AS hy, coalesce(sum(rm_fake), 0) AS f, coalesce(sum(rm_fake_yes), 0) AS fy FROM persona_day WHERE day = " + day)[0];
  const before = total();
  const run = await quickAt(acc, 100);
  const away = [];
  let first = true;
  let flagged = 0;
  const forbidden = ['take', 'claim', 'open', 'lay', 'add', 'finish'];
  run.r.handlers.push(m => {
    if (m.t !== 'state') return;
    const aw = m.players.map(p => p.away);
    if (first) {
      first = false;
      assert(!aw.some(Boolean), 'nobody is away in the first state');
    }
    aw.forEach((x, k) => {
      if (k && x) {
        flagged++;
        for (const e of m.log) if (e.p === k) assert(!forbidden.includes(e.k), 'an away seat makes only safe moves: ' + e.k);
      }
    });
    away.push(aw.slice(1).some(Boolean));
  });
  await within(run.done, 240000, 'match end');
  await sleep(1500);
  assert(away.includes(true), 'a computer player was shown away');
  assert(away.lastIndexOf(true) < away.length - 1 && away.slice(away.indexOf(true)).includes(false), 'and it came back');
  assert(flagged > 0 && run.r.st.phase === 'matchend', 'the match went on to its end');
  const after = total();
  assert(after.f - before.f >= 3 && after.fy <= after.f && after.fy - before.fy <= after.f - before.f, 'the computer players\' rematch offers are counted: ' + JSON.stringify([before, after]));
  assert(after.h - before.h >= 1 && after.hy - before.hy <= after.h - before.h, 'and the person\'s');
  sql("DELETE FROM settings WHERE key = 'awayodds'");
  console.log('rematch: a computer player went away and came back inside a match, the totals count the offers');
  run.r.ws.close();
  run.h.ws.close();
}

// requests to computer players: some are declined after a while, the rest never answered, and they never accept
async function computerFriends() {
  const me = await guest();
  const human = await guest();
  sql("DELETE FROM personas WHERE created = 7");
  sql('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60) INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy, busy_at, created) ' +
    "SELECT lower(printf('%02x', i)) || lower(printf('%02x', i)) || '0000000000000000000000000000', 300 + i, '1,1,1,0', 3, 300, 9, 3, 5000, 0, 'parked', 0, 7 FROM n");
  const pids = sql('SELECT id FROM personas WHERE created = 7 ORDER BY name_seed').map(x => x.id);
  const mine = await call('POST', '/api/friend', me, { id: human.id });
  assert.deepStrictEqual([mine.status, mine.body], [200, { ok: true }]);
  const t0 = Date.now();
  for (const id of pids) {
    const r = await call('POST', '/api/friend', me, { id: id });
    assert.deepStrictEqual([r.status, r.body], [mine.status, mine.body], 'the answer is the one a person would get');
  }
  const rows = sql("SELECT b, decide FROM friends WHERE a = " + who(me) + " AND b IN (SELECT id FROM personas WHERE created = 7)");
  assert.strictEqual(rows.length, 60);
  const timed = rows.filter(x => x.decide !== null);
  assert(timed.length >= 10 && timed.length <= 38, 'about 40 percent get a time: ' + timed.length + ' of 60');
  assert(timed.every(x => x.decide >= t0 + 600000 && x.decide <= Date.now() + 3 * DAY), 'between ten minutes and three days away');
  assert.strictEqual(sql('SELECT decide FROM friends WHERE a = ' + who(me) + ' AND b = ' + who(human))[0].decide, null, 'a person\'s request has no time');

  // the sweep removes what is due and nothing else
  const [due, later] = [timed[0].b, timed[1].b];
  const never = rows.find(x => x.decide === null).b;
  const hour = Math.floor(Date.now() / 3600000) * 3600000;
  sql("UPDATE friends SET decide = " + (hour - 1000) + " WHERE a = " + who(me) + " AND b = '" + due + "'");
  await tick(hour);
  const left = sql('SELECT b FROM friends WHERE a = ' + who(me)).map(x => x.b);
  assert(!left.includes(due), 'a request whose time has passed is gone, like a decline');
  assert(left.includes(later) && left.includes(never) && left.includes(human.id), 'the others are still waiting');
  assert.strictEqual((await call('GET', '/api/player/' + due, me)).body.rel, 'none');
  assert.strictEqual((await call('GET', '/api/player/' + never, me)).body.rel, 'sent');
  assert.strictEqual(sql("SELECT count(*) AS n FROM friends WHERE state = 'friend' AND (a IN (SELECT id FROM personas) OR b IN (SELECT id FROM personas))")[0].n, 0, 'they never accept');
  assert.deepStrictEqual((await call('GET', '/api/friends', me)).body.friends, []);
  sql('DELETE FROM personas WHERE created = 7');
  sql('DELETE FROM friends WHERE a = ' + who(me));
  console.log('friends: ' + timed.length + ' of 60 requests got a time, the due one was swept, none accepted, answers match a person\'s');
}

function schema() {
  const text = require('fs').readFileSync(__dirname + '/../migrations/0004_personas.sql', 'utf8');
  assert(!/insert/i.test(text), 'the migration only creates the table');
  console.log('personas: nothing seeded, they are made when a table needs one');
}

async function silent() {
  const c = client('/ws/hub');
  await c.ready;
  // the local dev server can leave the socket half closed after the server's close frame, so closing counts
  for (let i = 0; c.ws.readyState === 1; i++) {
    assert(i < 200, 'a socket that never said hello is still open');
    await sleep(100);
  }
  console.log('hub: a socket without hello is closed');

  // the lobby list that a watch message used to ask for is gone, and the message is ignored
  const h = await hub(await guest());
  const seen = [];
  h.handlers.push(m => seen.push(m.t));
  h.send({ t: 'watch', stake: 100 });
  await sleep(500);
  assert(!seen.includes('tables') && h.ws.readyState === 1, 'a watch message does nothing: ' + seen);
  h.ws.close();
  console.log('hub: an old watch message is ignored');
}

// personas are shared by id: busy at one table, chips and stats settled, only the ones who can cover the stake
async function pool() {
  fairPlay();
  const day = 86400000;
  const now = Date.now();
  sql('DELETE FROM personas WHERE created = 1');
  sql('UPDATE personas SET chips = 100, topup = ' + now + ', busy = NULL');
  sql('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 19) INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy, busy_at, created) ' +
    "SELECT lower(hex(randomblob(16))), i, '1,1,1,0', 10, 0, 0, 0, 100000, " + (now - 3 * day) + ', NULL, 0, 1 FROM n');
  const rich = sql('SELECT id FROM personas WHERE created = 1').map(x => x.id);
  assert.strictEqual(rich.length, 20);

  const stakes = [100, 500, 2500];
  const accs = [await guest(), await guest(), await guest()];
  link(...accs);
  level(10, ...accs);
  sql('UPDATE players SET chips = 100000 WHERE id IN (' + accs.map(who).join(',') + ')');
  const runs = [];
  for (const [n, stake] of stakes.entries()) {
    const acc = accs[n];
    const h = await hub(acc);
    const s = h.next(m => m.t === 'seated');
    h.send({ t: 'quick', stake: stake });
    const r = seated(await s);
    const run = { stake, acc, h, r, first: null, done: null };
    run.first = r.next(m => m.t === 'state');
    run.done = played(r);
    runs.push(run);
  }
  const firsts = await Promise.all(runs.map(x => x.first));
  const ids = [];
  firsts.forEach((m, n) => {
    for (const p of m.players.slice(1)) {
      assert(rich.includes(p.pid), 'only personas with enough chips are picked');
      assert.strictEqual(p.bank, 100000 + 3 * 750 - hold(runs[n].stake, 4) - feeFor(runs[n].stake), 'the days since the last top-up are paid before what is held and the fee are taken');
      ids.push(p.pid);
    }
  });
  assert.strictEqual(new Set(ids).size, 9, 'a persona is at one table at a time');
  assert.strictEqual(sql('SELECT count(*) AS n FROM personas WHERE busy IS NOT NULL')[0].n, 9);
  const tops = sql("SELECT topup FROM personas WHERE id IN ('" + ids.join("','") + "')");
  assert(tops.every(x => x.topup === now), 'the top-up date moves by whole days');
  await within(Promise.all(runs.map(x => x.done)), 120000, 'match end');
  await sleep(800);
  assert.strictEqual(sql('SELECT count(*) AS n FROM personas WHERE busy IS NOT NULL')[0].n, 0, 'they are free again after the match');

  runs.forEach((x, n) => {
    const st = x.r.st;
    st.players.slice(1).forEach((p, j) => {
      const k = j + 1;
      const row = sql("SELECT * FROM personas WHERE id = '" + p.pid + "'")[0];
      const win = st.final.low === k;
      const fin = st.stats.filter(f => f.fin === k).length;
      assert.strictEqual(row.chips, Math.max(firsts[n].players[k].bank + payout(x.stake, 4, p.chips), 0), 'chips settled like a player');
      assert.deepStrictEqual([row.games, row.wins, row.xp], [1, win ? 1 : 0, 40 + (win ? 30 : 0) + 5 * fin]);
    });
  });
  assert.strictEqual(sql("SELECT count(*) AS n FROM chip_log WHERE player IN (SELECT id FROM personas)")[0].n, 0);
  for (const x of runs) {
    x.r.ws.close();
    x.h.ws.close();
  }
  sql('DELETE FROM personas WHERE created = 1');
  console.log('personas: busy while seated, topped up by day, chips games wins and xp settled');

  // entry plus the table fee: a computer player 5 chips short of it is passed over, one with exactly enough is taken
  sql("UPDATE personas SET busy = 'hold', busy_at = " + Date.now() + ' WHERE busy IS NULL');
  const each = (chips, mark) => sql('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 19) INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy, busy_at, created) ' +
    "SELECT lower(hex(randomblob(16))), " + mark + " + i, '1,1,1,0', 1, 0, 0, 0, " + chips + ', ' + Date.now() + ', NULL, 0, 3 FROM n');
  each(1000, 700);
  each(1005, 800);
  const short = sql('SELECT id FROM personas WHERE created = 3 AND chips = 1000').map(x => x.id);
  const fit = sql('SELECT id FROM personas WHERE created = 3 AND chips = 1005').map(x => x.id);
  const poor = await guest();
  const hp = await hub(poor);
  const sp = hp.next(m => m.t === 'seated');
  hp.send({ t: 'quick', stake: 100 });
  const rp = seated(await sp);
  const first = rp.next(m => m.t === 'state');
  const done = played(rp);
  const st0 = await first;
  const seats = st0.players.slice(1);
  assert(seats.every(x => fit.includes(x.pid)) && !seats.some(x => short.includes(x.pid)), 'only computer players who cover entry and fee are picked');
  assert(seats.every(x => x.bank === 1005 - hold(100, 4) - feeFor(100)), 'their bank pays the stake held and the fee: ' + seats.map(x => x.bank));
  await within(done, 120000, 'match end');
  await sleep(500);
  const after = sql("SELECT chips FROM personas WHERE id IN ('" + seats.map(x => x.pid).join("','") + "')");
  assert(after.every(x => x.chips >= 0), 'a bank does not floor at zero, it simply never needs to');
  sql('DELETE FROM personas WHERE created = 3');
  sql("UPDATE personas SET busy = NULL WHERE busy = 'hold'");
  rp.ws.close();
  hp.ws.close();
  console.log('personas: entry plus fee decides who is picked, the bank pays what is held and the fee');
}

// A sharp seat decides from what it can see: its own hand, the discard, the melds and the task. Cards that are hidden from it, the
// stock and the other hands, are shuffled between them and the move must come out the same.
function fairPlay() {
  const lcg = seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let steps = 0;
  const kinds = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const rnd = lcg(seed);
    const st = Game.newMatch({ players: 4, games: 4, level: 'sharp', allBots: true, rnd: rnd });
    for (let i = 0; i < 1500 && st.phase !== 'matchend'; i++) {
      if (st.phase === 'gameend') {
        Game.nextGame(st);
        continue;
      }
      const alt = Game.load(Game.dump(st), { rnd: lcg(seed + 1000) });
      const me = st.phase === 'claim' ? Game.claimer(st) : st.turn;
      const hidden = [...alt.stock];
      const others = alt.players.filter((p, k) => k !== me);
      for (const p of others) hidden.push(...p.hand);
      for (let k = hidden.length - 1; k > 0; k--) {
        const j = Math.floor(lcg(seed * 7919 + k + i)() * (k + 1));
        [hidden[k], hidden[j]] = [hidden[j], hidden[k]];
      }
      alt.stock = hidden.splice(0, alt.stock.length);
      for (const p of others) p.hand = hidden.splice(0, p.hand.length);
      const n = st.log.length;
      Game.botStep(st);
      Game.botStep(alt);
      assert.deepStrictEqual(alt.log.slice(n), st.log.slice(n), 'the move does not depend on cards the seat cannot see (phase ' + st.phase + ')');
      steps++;
      kinds.add(st.log.slice(n).map(e => e.k).join());
    }
  }
  assert(steps > 1000 && kinds.size >= 5, 'enough different moves were compared: ' + steps + ' steps, ' + kinds.size + ' kinds');
  console.log('fair play: ' + steps + ' sharp moves identical with the hidden cards shuffled');
}

// a quick match at this stake, played to the end by one human against computer players
async function quickAt(acc, stake) {
  const h = await hub(acc);
  const s = h.next(m => m.t === 'seated');
  h.send({ t: 'quick', stake: stake });
  const sat = await s;
  const r = seated(sat);
  const first = r.next(m => m.t === 'state');
  return { h: h, r: r, code: sat.code, first: first, done: played(r) };
}

// a friend room the host opens to the pool with its empty seats and plays to the end
async function friendAt(acc, players, stake) {
  const c = client('/ws/new');
  await c.ready;
  const room = c.next(m => m.t === 'room');
  c.send({ t: 'create', auth: acc.auth, players: players, games: players, stake: stake });
  const j = await c.next(m => m.t === 'joined');
  assert(!('level' in await room), 'the table sheet carries no table level');
  const first = c.next(m => m.t === 'state');
  Object.assign(c, { seat: j.seat });
  const done = played(c);
  c.send({ t: 'start' });
  return { r: c, code: j.code, first: first, done: done };
}

const sharpRows = acc => sql('SELECT kind, stake, sharp, fakes, humans, net, units, won, fake_net, day FROM persona_flow WHERE player = ' + who(acc));

// which computer seats play sharp comes from the ladder in the settings, by stake, buy-in or friend table stake
async function strong() {
  // the ladder as a function: a public table by its stake, a cup by its buy-in, a friend table by the stake at or below it
  const ladder = { 100: 0, 500: 1, 2500: 2, 10000: 9, 50000: 9, cup1000: 1, cup5000: 2, cup25000: 9 };
  const want = [[[0], 0], [[50], 0], [[100], 0], [[499], 0], [[500], 1], [[700], 1], [[3000], 2], [[20000], 9], [[60000], 9], [[0, 1000], 1], [[0, 5000], 2], [[0, 25000], 9]];
  for (const [args, n] of want) assert.strictEqual(strongFor(ladder, ...args), n, 'ladder at ' + args);
  assert.strictEqual(strongFor({}, 500), 0, 'a ladder with no entry gives none');

  // one seat of a match has its own level: only a relaxed seat slips, and the level survives a dump and a load
  let calls = 0;
  const rnd = () => { calls++; return Math.random(); };
  const st = Game.newMatch({ players: 4, games: 2, level: 'sharp', allBots: true, rnd: rnd });
  st.players.forEach((p, i) => { p.level = i === 1 ? 'relaxed' : 'sharp'; });
  const slipped = { sharp: 0, relaxed: 0 };
  for (let i = 0; i < 3000 && st.phase !== 'matchend'; i++) {
    if (st.phase === 'gameend') {
      Game.nextGame(st);
      continue;
    }
    const me = st.phase === 'claim' ? Game.claimer(st) : st.turn;
    const before = calls;
    const copy = Game.load(Game.dump(st));
    assert.deepStrictEqual(copy.players.map(p => p.level), st.players.map(p => p.level), 'a seat keeps its level through dump and load');
    Game.botStep(st);
    slipped[st.players[me].level] += calls - before;
  }
  assert.strictEqual(slipped.sharp, 0, 'a sharp seat never asks for a chance');
  assert(slipped.relaxed > 5, 'a relaxed seat among sharp ones does: ' + slipped.relaxed);
  console.log('strong: the ladder reads right, a relaxed seat slips among sharp ones');

  // a human alone at each table gets the computer seats the ladder asks for
  const mk = async () => {
    const a = link(level(30, await guest()));
    sql('UPDATE players SET chips = 300000 WHERE id = ' + who(a));
    return a;
  };
  // the accounts come first: sql() blocks this process, and a socket that waits to join is closed after a moment
  const accs = [];
  for (let i = 0; i < 7; i++) accs.push(await mk());
  const quick = [];
  for (const stake of [100, 500, 2500, 10000]) quick.push({ acc: accs[quick.length], stake: stake, want: quick.length, run: await quickAt(accs[quick.length], stake) });
  const f3000 = { acc: accs[4], stake: 3000, want: 2 };
  f3000.run = await friendAt(f3000.acc, 4, 3000);
  const f50 = { acc: accs[5], stake: 50, want: 0 };
  f50.run = await friendAt(f50.acc, 3, 50);
  const all = [...quick, f3000, f50];
  const states = await Promise.all(all.map(x => x.run.first));
  for (const m of states) {
    leakCheck(m);
    assert(!('level' in m), 'the table state carries no table level');
  }
  // the ladder is edited on the admin page and the next table reads it
  const rung = JSON.parse(sql("SELECT value FROM settings WHERE key = 'strong'")[0].value);
  assert.strictEqual((await adm('POST', 'settings', ADMIN, { key: 'strong', value: JSON.stringify(Object.assign({}, rung, { 100: 9 })) })).status, 200);
  const edited = { acc: accs[6], stake: 100, want: 3 };
  edited.run = await friendAt(edited.acc, 4, 100);
  const room = await edited.run.first;
  assert(!('level' in room));
  assert.strictEqual((await adm('POST', 'settings', ADMIN, { key: 'strong', value: JSON.stringify(rung) })).status, 200);
  const ran = [...all, edited];
  await Promise.all(ran.map(x => within(x.run.done, 240000, 'match end at ' + x.stake)));
  await sleep(800);
  for (const x of ran) {
    const [row] = sharpRows(x.acc);
    assert(row, 'a flow row at ' + x.stake);
    assert.strictEqual(row.sharp, x.want, 'sharp seats at ' + x.stake + ': ' + row.sharp);
    assert.strictEqual(row.fakes, x.run.r.st.players.filter(p => personaIds([p.pid]) === 1).length);
  }
  console.log('strong: 0, 1, 2 and all computer seats sharp at 100, 500, 2,500 and 10,000, by stake at a friend table, and the ladder is editable');
  for (const x of ran) {
    x.run.r.ws.close();
    if (x.run.h) x.run.h.ws.close();
  }
}

// what each human's match against computer players is worth is written down, with daily totals that outlive the rows
async function flow() {
  const mk = async () => {
    const a = link(level(4, await guest()));
    sql('UPDATE players SET chips = 50000 WHERE id = ' + who(a));
    return a;
  };
  const [a, b] = [await mk(), await mk()];
  const full = await quickAt(a, 100);
  const early = await quickAt(b, 500);
  await Promise.all([early.first, full.first]);
  // a seat that leaves a started match is not counted
  early.r.send({ t: 'leave' });
  await within(full.done, 120000, 'match end');
  for (let i = 0; i < 240 && sql("SELECT count(*) AS n FROM personas WHERE busy = '" + early.code + "'")[0].n; i++) await sleep(500);
  await sleep(1500);
  const rows = sharpRows(a);
  assert.strictEqual(rows.length, 1, 'one row for the match');
  const st = full.r.st;
  const net = st.res.net;
  const fakeNet = st.players.slice(1).reduce((n, p) => n + change(100, 4, p.chips), 0);
  assert.deepStrictEqual(rows[0], { kind: 'pub', stake: 100, sharp: 0, fakes: 3, humans: 1, net: net, units: net / 100, won: st.final.low === 0 ? 1 : 0, fake_net: fakeNet, day: Math.floor(Date.now() / DAY) });
  assert.strictEqual(net, change(100, 4, st.players[0].chips), 'the net is what the chips show, fee included');
  sql("INSERT OR IGNORE INTO persona_flow SELECT match, player, day, kind, stake, 3, fakes, humans, net + 1, units, won, fake_net, at FROM persona_flow WHERE player = " + who(a));
  assert.deepStrictEqual(sharpRows(a), rows, 'settling again writes nothing more');
  assert.strictEqual(sharpRows(b).length, 0, 'a match left early writes none');
  console.log('flow: a match with three computer players wrote one row with the right net and sharp count, a left match none');

  // the daily total appears once the day is over, and stays when the rows go
  sql('UPDATE persona_flow SET day = day - 1 WHERE player = ' + who(a));
  const hour = Math.floor(Date.now() / 3600000) * 3600000;
  await tick(hour);
  const day = Math.floor(Date.now() / DAY) - 1;
  const total = sql("SELECT matches, units, wins, fake_net FROM persona_day WHERE day = " + day + " AND kind = 'pub' AND stake = 100")[0];
  assert(total && total.matches >= 1, 'the total is there after the rollup');
  const mine = sql("SELECT count(*) AS n, sum(units) AS u, sum(won) AS w, sum(fake_net) AS f FROM persona_flow WHERE day = " + day + " AND kind = 'pub' AND stake = 100")[0];
  assert.deepStrictEqual([total.matches, total.units, total.wins, total.fake_net], [mine.n, mine.u, mine.w, mine.f]);
  await tick(hour);
  assert.strictEqual(sql("SELECT matches FROM persona_day WHERE day = " + day + " AND kind = 'pub' AND stake = 100")[0].matches, mine.n, 'a second run leaves it as it is');
  // the admin page shows each table's matches and the middle half's average result
  sql('UPDATE persona_flow SET day = day + 1 WHERE player = ' + who(a));
  const shown = (await adm('GET', 'flow', ADMIN)).body;
  const t100 = shown.flow.find(x => x.kind === 'pub' && x.stake === 100);
  assert(t100 && t100.matches >= 1 && t100.players >= 1 && typeof t100.mid === 'number' && t100.sharp === 0, 'the table is listed: ' + JSON.stringify(t100));
  assert(shown.days.some(x => x.day === day && x.kind === 'pub' && x.stake === 100 && x.matches === mine.n), 'and so are the day totals');
  // two people at one table are one match
  const ins = p => sql("INSERT INTO persona_flow (match, player, day, kind, stake, sharp, fakes, humans, net, units, won, fake_net, at) VALUES ('two', '" + p + "', " + Math.floor(Date.now() / DAY) + ", 'pub', 7, 0, 2, 2, 0, 0, 0, 0, " + Date.now() + ')');
  ins('p1');
  ins('p2');
  const two = (await adm('GET', 'flow', ADMIN)).body.flow.find(x => x.kind === 'pub' && x.stake === 7);
  assert.deepStrictEqual([two.matches, two.players], [1, 2], 'one match with two players: ' + JSON.stringify(two));
  sql("DELETE FROM persona_flow WHERE match = 'two'");
  sql('UPDATE persona_flow SET day = day - 1 WHERE player = ' + who(a));
  assert.strictEqual((await call('DELETE', '/api/me', a)).status, 200);
  assert.strictEqual(sql("SELECT count(*) AS n FROM persona_flow WHERE player = " + who(a))[0].n, 0, 'the account takes its rows with it');
  assert.strictEqual(sql("SELECT matches FROM persona_day WHERE day = " + day + " AND kind = 'pub' AND stake = 100")[0].matches, mine.n, 'the day total stays');
  console.log('flow: the day total is written once and outlives the rows and the account');

  // rows are kept 90 days
  // a time of its own: a run for tomorrow would write today's stats row before the metrics section does
  const T = Date.UTC(2032, 2, 9, 3, 5);
  const old = (id, at) => sql("INSERT INTO persona_flow (match, player, day, kind, stake, sharp, fakes, humans, net, units, won, fake_net, at) VALUES ('" + id + "', 'purge', " + Math.floor(at / DAY) + ", 'pub', 100, 0, 3, 1, 0, 0, 0, 0, " + at + ')');
  old('old', T - 91 * DAY);
  old('new', T - 89 * DAY);
  await tick(T);
  assert.deepStrictEqual(sql("SELECT match FROM persona_flow WHERE player = 'purge'").map(x => x.match), ['new'], 'rows older than 90 days go');
  sql("DELETE FROM persona_flow WHERE player = 'purge'");
  console.log('flow: kept 90 days');
  for (const x of [full, early]) {
    x.r.ws.close();
    x.h.ws.close();
  }
}

// a private room whose host starts with empty seats is found by quick play, and the match counts for both humans
async function openRoom() {
  const [host, x] = [await guest(), await guest()];
  link(host, x);
  level(4, host, x);
  const c = client('/ws/new');
  await c.ready;
  c.send({ t: 'create', auth: host.auth, players: 4, games: 4, stake: 500 });
  const ja = await c.next(m => m.t === 'joined');
  const rooms = [];
  c.handlers.push(m => { if (m.t === 'room') rooms.push(m); });
  await sleep(400);
  assert(rooms.every(m => m.finding === 0 && m.seats.filter(Boolean).length === 1), 'nobody comes before the host starts');
  const hx = await hub(x);
  const open = c.next(m => m.t === 'room' && m.finding === 3);
  c.send({ t: 'start' });
  await open;
  const sx = hx.next(m => m.t === 'seated');
  hx.send({ t: 'quick', stake: 500 });
  const S = await sx;
  assert.strictEqual(S.code, ja.code, 'quick play lands in the opened room');
  const fin = [];
  const finished = new Promise(res => { fin.res = res; });
  const o = { finish: z => { if (!fin.includes(z)) fin.push(z); if (fin.length === 2) fin.res(); } };
  Object.assign(c, { seat: ja.seat });
  const rx = seated(S);
  play(c, o);
  play(rx, o);
  await Promise.race([finished, new Promise((r, j) => setTimeout(() => j(new Error('timeout')), 120000))]);
  assert.strictEqual(c.st.players.filter(p => p.pid && personaIds([p.pid]) === 1).length, 2, 'the other two seats were filled by the pool');
  await sleep(600);
  for (const acc of [host, x]) {
    const p = (await call('GET', '/api/me', acc)).body;
    assert(p.games === 1 && p.xp >= 40, 'the match counts: games ' + p.games + ' xp ' + p.xp);
  }
  console.log('open friend room: strangers via quick play, personas for the rest, both humans credited');
  c.ws.close();
  rx.ws.close();
  hx.ws.close();
}

async function fixes() {
  const [a, b] = [await guest(), await guest()];
  await call('POST', '/api/friend', a, { id: b.id });
  await call('POST', '/api/friend', b, { id: a.id });
  const [h] = await hello({ auth: a.auth, at: 'training' }, m => m.t === 'hub');
  const at = async () => (await call('GET', '/api/friends', b)).body.friends.find(x => x.id === a.id).at;
  assert.deepStrictEqual(await at(), { w: 'training' }, 'hello carries where the player is');

  // a seat at a public table keeps the account out of an opened room too
  const s = h.next(m => m.t === 'seated');
  h.send({ t: 'quick', stake: 100 });
  const mine = seated(await s);
  await mine.next(m => m.t === 'room');
  link(a, b);
  const host = client('/ws/new');
  await host.ready;
  host.send({ t: 'create', auth: b.auth, players: 4, games: 4, stake: 100 });
  const ja = await host.next(m => m.t === 'joined');
  const open = host.next(m => m.t === 'room' && m.finding === 3);
  host.send({ t: 'start' });
  await open;
  const late = client('/ws/' + ja.code);
  await late.ready;
  late.send({ t: 'join', auth: a.auth });
  assert.strictEqual((await late.next(m => m.t === 'error')).k, 'busy');
  console.log('hello carries the whereabouts, an opened room refuses an account seated at a public table');
  for (const c of [mine, host, h]) c.ws.close();
}

// the host's start is refused without closing the host's socket, and the seated player is told why
async function held() {
  const [a, b] = [await guest(), await guest()];
  const h = await hub(a);
  const s = h.next(m => m.t === 'seated');
  h.send({ t: 'quick', stake: 100 });
  const mine = seated(await s);
  await mine.next(m => m.t === 'room');
  link(a, b);
  const host = client('/ws/new');
  await host.ready;
  host.send({ t: 'create', auth: b.auth, players: 4, games: 4, stake: 100 });
  const ja = await host.next(m => m.t === 'joined');
  const guestSock = client('/ws/' + ja.code);
  await guestSock.ready;
  guestSock.send({ t: 'join', auth: a.auth });
  const gj = await guestSock.next(m => m.t === 'joined');
  const no = host.next(m => m.t === 'error');
  const why = guestSock.next(m => m.t === 'error');
  host.send({ t: 'start' });
  const e = await no;
  assert.strictEqual(e.k, 'held');
  assert.strictEqual(e.seat, gj.seat);
  assert.strictEqual((await why).k, 'elsewhere');
  await sleep(300);
  assert.strictEqual(host.ws.readyState, 1, 'the host stays connected');
  for (const c of [mine, host, guestSock, h]) c.ws.close();

  // a started private room holds its players too
  const g = await pair(3, 3);
  await begin(g);
  const hx = await hub(g.accB);
  const busy = hx.next(m => m.t === 'error');
  hx.send({ t: 'quick', stake: 100 });
  assert.strictEqual((await busy).k, 'busy');
  console.log('start refused with held and the socket kept, a started private room counts as a seat');
  for (const c of [g.a, g.b, hx]) c.ws.close();
}

// the pace switch is gone: a stray fast flag makes an ordinary table, and nothing says fast or counts it apart
async function pace() {
  const [a, b] = [await guest(), await guest()];
  const [ha, hb] = [await hub(a), await hub(b)];
  const sit = async (h, fastOn) => {
    const s = h.next(m => m.t === 'seated');
    h.send({ t: 'quick', stake: 100, fast: fastOn });
    const sat = await s;
    const r = seated(sat);
    const room = await r.next(m => m.t === 'room');
    assert(!('fast' in room), 'the table sheet has no fast flag');
    return [sat, r];
  };
  const rooms = ha.next(m => m.t === 'rooms' && m.n[100] > 0, 10000);
  const [sa, ra] = await sit(ha, true);
  const [sb, rb] = await sit(hb, false);
  assert.strictEqual(sa.code, sb.code, 'a stray fast flag sits at the same table as everybody');
  assert(!('f' in await rooms), 'the room counts are one list');
  const st = await ra.next(m => m.t === 'state' && m.clock);
  leakCheck(st);
  assert(!('fast' in st));
  const k = st.clock.span / 30000;
  assert(k > 0 && k < 1, 'the clock is the normal one');
  console.log('pace: a fast flag from an old client is ignored, one table pool, normal clock');
  const host = link(await guest());
  const c = client('/ws/new');
  await c.ready;
  c.send({ t: 'create', auth: host.auth, players: 3, games: 3, stake: 100, fast: true, level: 'sharp' });
  const room = await c.next(m => m.t === 'room');
  assert(!('fast' in room));
  assert(!('level' in room), 'the server stops reading the level a client asks for, and a table has none');
  for (const x of [ra, rb, c, ha, hb]) x.ws.close();
}

// friend tables: 3 to 5 players, any stake in tens (0 moves no chips), guests only for nothing
async function friendTables() {
  const host = level(30, link(await guest()));
  const visitor = level(4, await guest());
  const made = async (acc, o) => {
    const c = client('/ws/new');
    await c.ready;
    const r = c.next(m => m.t === 'joined' || m.t === 'error');
    c.send(Object.assign({ t: 'create', auth: acc.auth }, o));
    return [await r, c];
  };
  const refused = async (acc, o, k) => {
    const [m, c] = await made(acc, o);
    assert.strictEqual(m.k, k, JSON.stringify(o) + ' gave ' + (m.k || m.t));
    c.ws.close();
  };
  const allowed = async (acc, o) => {
    const [m, c] = await made(acc, o);
    assert.strictEqual(m.t, 'joined', JSON.stringify(o) + ' gave ' + m.k);
    return c;
  };
  for (const n of [2, 6]) await refused(host, { players: n, games: n === 2 ? 2 : 6, stake: 0 }, 'opts');
  for (const n of [3, 4, 5]) (await allowed(host, { players: n, games: n, stake: 0 })).ws.close();
  (await allowed(host, { players: 3, games: 3, stake: 10 })).ws.close();
  for (const stake of [15, -10, 5, 1e9 + 10, 1.5, '100']) await refused(host, { players: 3, games: 3, stake: stake }, 'opts');
  await refused(host, { players: 3, games: 3, stake: 1e9 }, 'poor');
  await refused(host, { players: 3, games: 3, stake: 3000 }, 'poor');
  (await allowed(host, { players: 3, games: 3, stake: 500 })).ws.close();
  console.log('friend tables: 3 to 5 players, stakes in tens from 0, nothing else');

  // a guest sits at a table for nothing, never at one with a stake
  await refused(visitor, { players: 3, games: 3, stake: 10 }, 'guest');
  (await allowed(visitor, { players: 3, games: 3 })).ws.close();
  const [paid, pc] = await made(host, { players: 5, games: 5, stake: 500 });
  const g1 = client('/ws/' + paid.code);
  await g1.ready;
  const no = g1.next(m => m.t === 'error' || m.t === 'joined');
  g1.send({ t: 'join', auth: visitor.auth });
  assert.strictEqual((await no).k, 'guest', 'a guest cannot join a table with a stake');
  const [free, fc] = await made(host, { players: 3, games: 3, stake: 0 });
  const g2 = client('/ws/' + free.code);
  await g2.ready;
  g2.send({ t: 'join', auth: visitor.auth });
  assert.strictEqual((await g2.next(m => m.t === 'joined' || m.t === 'error')).t, 'joined', 'but can join one for nothing');
  console.log('friend tables: a guest is refused a stake, plays for nothing');
  for (const c of [g1, g2, fc]) c.ws.close();

  // the table stays a friend table when it is opened to others: a guest is not seated through quick play or the hub
  const hv = await hub(visitor);
  const hg = await hub(await guest());
  const hs = await hub(level(4, link(await guest())));
  const open = pc.next(m => m.t === 'room' && m.finding === 4);
  pc.send({ t: 'start' });
  await open;
  // all three at once, while the computer players are still arriving
  const sat = hv.next(m => m.t === 'seated');
  const e = hg.next(m => m.t === 'error');
  const sat2 = hs.next(m => m.t === 'seated');
  hg.send({ t: 'sit', code: paid.code });
  hs.send({ t: 'quick', stake: 500 });
  hv.send({ t: 'quick', stake: 500 });
  assert.strictEqual((await e).k, 'guest', 'a guest cannot sit at an opened table with a stake by its code');
  assert.strictEqual((await sat2).code, paid.code, 'a signed-in account lands in it');
  assert.notStrictEqual((await sat).code, paid.code, 'and quick play does not seat a guest there');
  console.log('friend tables: an opened table keeps its kind on every way in');
  for (const x of [pc, hv, hg, hs]) x.ws.close();

  // for nothing: no chips move, no xp, no tokens, even with a computer player in the third seat
  const [a, b] = [link(await guest()), await guest()];
  const ca = client('/ws/new');
  await ca.ready;
  ca.send({ t: 'create', auth: a.auth, players: 3, games: 3, stake: 0 });
  const ja = await ca.next(m => m.t === 'joined');
  const cb = client('/ws/' + ja.code);
  await cb.ready;
  cb.send({ t: 'join', auth: b.auth });
  await cb.next(m => m.t === 'joined');
  const fin = [played(Object.assign(ca, { seat: ja.seat })), played(cb)];
  ca.send({ t: 'start' });
  await within(Promise.all(fin), 120000, 'match end');
  await sleep(800);
  assert.strictEqual(personaIds(ca.st.players.map(p => p.pid)), 1, 'a computer player filled the third seat');
  for (const acc of [a, b]) {
    const p = (await call('GET', '/api/me', acc)).body;
    assert.deepStrictEqual([p.chips, p.xp, p.games, p.wins, p.tokens], [5000, 0, 0, 0, 0], 'nothing earned');
    assert.deepStrictEqual(sql('SELECT reason FROM chip_log WHERE player = ' + who(acc)).map(x => x.reason), ['start'], 'no chip rows');
    assert.strictEqual(sql('SELECT week_won AS n FROM players WHERE id = ' + who(acc))[0].n, 0);
  }
  assert.strictEqual(ca.st.res.xp, 0);
  const rows = seatsOf(ja.code);
  assert.deepStrictEqual(rows.map(x => [x.kind, x.stake, x.net]), [['friend', 0, 0], ['friend', 0, 0], ['friend', 0, 0]]);
  console.log('friend tables: a table for nothing moves no chips and earns nothing');
  ca.ws.close();
  cb.ws.close();
}

// a seat that was left is not given back to a join without its token
async function noRetake() {
  const [a, b, c] = [link(await guest()), await guest(), await guest()];
  link(b, c);
  const host = client('/ws/new');
  await host.ready;
  host.send({ t: 'create', auth: a.auth, players: 3, games: 3, stake: 100 });
  const ja = await host.next(m => m.t === 'joined');
  const join = async acc => {
    const x = client('/ws/' + ja.code);
    await x.ready;
    const r = x.next(m => m.t === 'joined' || m.t === 'error');
    x.send({ t: 'join', auth: acc.auth });
    const m = await r;
    return [m, x];
  };
  // before the start a seat is simply free again
  let [jb, xb] = await join(b);
  assert.strictEqual(jb.t, 'joined');
  xb.send({ t: 'leave' });
  await sleep(200);
  [jb, xb] = await join(b);
  assert.strictEqual(jb.t, 'joined', 'a pre-start leave frees the seat');
  const [jc, xc] = await join(c);
  assert.strictEqual(jc.t, 'joined');
  const going = [host, xb, xc].map(x => x.next(m => m.t === 'state'));
  host.send({ t: 'start' });
  await within(Promise.all(going), 20000, 'the match starts');
  xb.send({ t: 'leave' });
  await sleep(300);
  const [again] = await join(b);
  assert.strictEqual(again.k, 'left', 'the seat was left');
  // not listed again: the account can sit somewhere else
  const hb = await hub(b);
  const sat = hb.next(m => m.t === 'seated' || m.t === 'error');
  hb.send({ t: 'quick', stake: 100 });
  assert.strictEqual((await sat).t, 'seated', 'and is not held by the table it left');
  // a player who only lost the connection comes back with the token
  xc.ws.close();
  await sleep(200);
  const back = client('/ws/' + ja.code);
  await back.ready;
  const r = back.next(m => m.t === 'joined' || m.t === 'error');
  back.send({ t: 'join', token: jc.token });
  assert.strictEqual((await r).t, 'joined', 'the token still brings its owner back');
  console.log('noRetake: a left seat is refused, a dropped one is not');
  for (const x of [host, xb, back, hb]) x.ws.close();
}

const within = (p, ms, what) => {
  let t;
  const lim = new Promise((r, j) => { t = setTimeout(() => j(new Error('timeout: ' + what)), ms); });
  return Promise.race([p, lim]).finally(() => clearTimeout(t));
};
// plays a client to the end of the match; the promise fails if its socket closes first
const played = (c, o) => {
  const p = new Promise((res, rej) => play(c, Object.assign({ finish: res, abort: rej }, o)));
  p.catch(() => {});
  return p;
};

// an account whose first call came from this country, as the dev server is told by header
async function from(country, continent) {
  const acc = await guest();
  const r = await call('GET', '/api/me', acc, null, null, { 'X-Country': country, 'X-Continent': continent });
  return Object.assign(acc, { region: r.body.region });
}

// quick play, the public lists and tournaments are split by region; friends, invites and joining a table are not
async function regions() {
  const { REGIONS, LEADS, regionOf, hint } = await import('../src/region.js');
  const map = [['TR', 'AS', 'tr'], ['DE', 'EU', 'eu'], ['RU', 'EU', 'eu'], ['CY', 'AS', 'eu'], ['GE', 'AS', 'eu'], ['AM', 'AS', 'eu'], ['US', 'NA', 'am'], ['MX', 'NA', 'am'],
    ['BR', 'SA', 'am'], ['EG', 'AF', 'mea'], ['ZA', 'AF', 'mea'], ['SA', 'AS', 'mea'], ['AE', 'AS', 'mea'], ['IR', 'AS', 'mea'], ['IL', 'AS', 'mea'], ['YE', 'AS', 'mea'],
    ['IN', 'AS', 'ap'], ['JP', 'AS', 'ap'], ['KZ', 'AS', 'ap'], ['AU', 'OC', 'ap'], ['NZ', 'OC', 'ap'], ['T1', 'T1', 'eu'], [undefined, undefined, 'eu']];
  for (const [c, k, r] of map) assert.strictEqual(regionOf(c, k), r, c + ' ' + k);
  assert.deepStrictEqual(hint('GABC'), { locationHint: 'eeur' });
  assert.deepStrictEqual(REGIONS.map(r => hint(LEADS[r][0] + 'AAA').locationHint), ['enam', 'weur', 'eeur', 'me', 'apac']);
  assert.strictEqual(hint('SAAA'), undefined, 'a private code has no hint');

  // the first call sets it from the country and later ones leave it; the player can change it
  const tr = await from('TR', 'AS');
  assert.strictEqual(tr.region, 'tr');
  assert.strictEqual((await call('GET', '/api/me', tr, null, null, { 'X-Country': 'JP', 'X-Continent': 'AS' })).body.region, 'tr');
  assert.strictEqual((await call('POST', '/api/region', tr, { region: 'xx' })).status, 400);
  assert.strictEqual((await call('POST', '/api/region', tr)).status, 400);
  assert.strictEqual((await call('POST', '/api/region', tr, { region: 'ap' })).body.region, 'ap');
  assert.strictEqual((await call('GET', '/api/me', tr)).body.region, 'ap');
  assert.strictEqual((await call('POST', '/api/region', { id: tr.id, secret: '0'.repeat(64) }, { region: 'am' })).status, 401);
  assert.strictEqual((await from('US', 'NA')).region, 'am');
  assert.strictEqual((await call('GET', '/api/me', await guest())).body.region, 'eu', 'no country means Europe');
  console.log('regions: set from the country on the first call, changed by the player');

  // quick play never crosses regions and a public list shows its own region only
  // the table fills with computer players after 80 to 160 ms, so on a slow machine the second one can land at the next table
  let A, B;
  const hubs = [];
  for (let i = 0; ; i++) {
    const [a, c, b, w] = [await from('DE', 'EU'), await from('FR', 'EU'), await from('TR', 'AS'), await from('TR', 'AS')];
    const [ha, hc, hb, hw] = [await hub(a), await hub(c), await hub(b), await hub(w)];
    hubs.push(ha, hc, hb, hw);
    const sa = ha.next(m => m.t === 'seated');
    ha.send({ t: 'quick', stake: 100 });
    A = await sa;
    const sb = hb.next(m => m.t === 'seated');
    hb.send({ t: 'quick', stake: 100 });
    B = await sb;
    assert.notStrictEqual(A.code, B.code, 'a Turkish player does not sit at a European table');
    assert(LEADS.eu.includes(A.code[0]) && LEADS.tr.includes(B.code[0]), 'a table code carries its region');
    const sc = hc.next(m => m.t === 'seated');
    hc.send({ t: 'quick', stake: 100 });
    if ((await sc).code === A.code) break;
    assert(i < 4, 'the same region still matches');
    console.log('regions: the second player was seated at another table, trying again');
  }
  console.log('regions: quick play stays inside the region');

  // the list and the next quick play follow a change of region
  for (let i = 0; ; i++) {
    const [x, y] = [await from('DE', 'EU'), await from('TR', 'AS')];
    level(4, x, y);
    const [hx, hy] = [await hub(x), await hub(y)];
    hubs.push(hx, hy);
    const sx = hx.next(m => m.t === 'seated');
    hx.send({ t: 'quick', stake: 500 });
    const X = await sx;
    await call('POST', '/api/region', y, { region: 'eu' });
    const sy = hy.next(m => m.t === 'seated');
    hy.send({ t: 'quick', stake: 500 });
    // a table that filled up in the meantime is not the one quick play finds
    if ((await sy).code === X.code) break;
    assert(i < 4, 'quick play follows the new region');
    console.log('regions: the table filled before the second player came, trying again');
  }
  console.log('regions: changing region moves the open lobby');

  // friends meet across regions: an invite, then a seat at the friend's table
  const rooms = [];
  for (let i = 0; ; i++) {
    const [f1, f2] = [await from('GB', 'EU'), await from('JP', 'AS')];
    await befriend(f1, f2);
    const [h1, h2] = [await hub(f1), await hub(f2)];
    const s1 = h1.next(m => m.t === 'seated');
    h1.send({ t: 'quick', stake: 100 });
    const F = await s1;
    const r1 = seated(F);
    rooms.push(r1);
    hubs.push(h1, h2);
    await r1.next(m => m.t === 'room');
    const inv = h2.next(m => m.t === 'invited');
    r1.send({ t: 'invite', to: f2.id });
    assert.strictEqual((await inv).code, F.code);
    const s2 = h2.next(m => m.t === 'seated' || m.t === 'error');
    h2.send({ t: 'sit', code: F.code });
    const got = await s2;
    if (got.code === F.code) break;
    assert(got.k === 'full' && i < 4, 'a friend from another region sits at the table: ' + JSON.stringify(got));
    console.log('regions: the table filled before the friend came, trying again');
  }
  console.log('regions: friends invite and join across regions');

  // a tournament form is per region: a player of another region starts alone, one of the same region joins
  const [t1, t2, t3] = [await from('DE', 'EU'), await from('TR', 'AS'), await from('NL', 'EU')];
  link(t1, t2, t3);
  const [g1, g2, g3] = [await hub(t1), await hub(t2), await hub(t3)];
  const one = g1.next(m => m.t === 'cup' && m.buy === 1000);
  g1.send({ t: 'cup', buy: 1000 });
  assert.strictEqual((await one).n, 1);
  const two = g2.next(m => m.t === 'cup' && m.buy === 1000);
  g2.send({ t: 'cup', buy: 1000 });
  assert.strictEqual((await two).n, 1, 'a European form does not take a Turkish player');
  const three = g3.next(m => m.t === 'cup' && m.buy === 1000);
  g3.send({ t: 'cup', buy: 1000 });
  assert((await three).n >= 2, 'a player of the same region joins the form');
  for (const g of [g1, g2, g3]) g.send({ t: 'cup', buy: 0 });
  await sleep(300);
  console.log('regions: tournament forms stay inside the region');
  for (const h of [...hubs, g1, g2, g3]) h.ws.close();
  for (const r of rooms) r.ws.close();
}

// two humans quick-play the same table at this stake; the personas fill the rest
async function seatTwo(stake) {
  const accA = await guest();
  const accB = await guest();
  if (stake > 100) level(4, accA, accB);
  const a = await hub(accA);
  const b = await hub(accB);
  const sa = a.next(m => m.t === 'seated');
  a.send({ t: 'quick', stake: stake });
  const A = await sa;
  const sb = b.next(m => m.t === 'seated');
  b.send({ t: 'quick', stake: stake });
  const B = await sb;
  assert.strictEqual(B.code, A.code, 'two quick players share a table');
  const t = { accA, accB, a, b, A, B, ra: seated(A), rb: seated(B) };
  t.offer = [t.ra, t.rb].map(c => c.next(m => m.t === 'state' && m.rm, 150000));
  for (const c of [t.ra, t.rb]) play(c, { finish: () => {} });
  return t;
}

const escrows = acc => sql("SELECT ref FROM chip_log WHERE player = '" + acc.id + "' AND reason = 'escrow'").map(x => x.ref);
const fees = acc => sql("SELECT delta FROM chip_log WHERE player = '" + acc.id + "' AND reason = 'fee'").map(x => x.delta);

// both humans press Rematch: the same room deals again and stakes are taken again under new refs
async function rematchBoth() {
  const t = await seatTwo(100);
  const [ma, mb] = await within(Promise.all(t.offer), 120000, 'match end');
  for (const m of [ma, mb]) {
    assert.strictEqual(m.phase, 'matchend');
    assert(m.rm.left > 0 && m.rm.left <= 15000);
    assert.strictEqual(m.rm.mine, false);
  }
  const line = t.rb.next(m => m.t === 'typed');
  t.ra.send({ t: 'text', x: 'good game' });
  assert.strictEqual((await line).x, 'good game');
  const next = [t.ra, t.rb].map(c => c.next(m => m.t === 'state' && m.phase !== 'matchend'));
  t.ra.send({ t: 'rematch' });
  t.rb.send({ t: 'rematch' });
  const [na, nb] = await within(Promise.all(next), 30000, 'new match');
  for (const m of [na, nb]) {
    assert.strictEqual(m.gameNo, 1);
    assert.strictEqual(m.lb, 0);
    assert.strictEqual(m.n, 4);
  }
  assert([t.accA, t.accB].every(acc => na.players.some(p => p.pid === acc.id)));
  for (const acc of [t.accA, t.accB]) {
    const refs = escrows(acc);
    assert.strictEqual(refs.length, 2);
    assert.notStrictEqual(refs[0], refs[1]);
    assert.deepStrictEqual(fees(acc), [-5, -5], 'a rematch charges the fee again');
  }
  const again = client('/ws/' + t.B.code);
  await again.ready;
  const old = [];
  again.handlers.push(m => { if (m.t === 'typed') old.push(m); });
  again.send({ t: 'join', token: t.B.token });
  await again.next(m => m.t === 'state');
  await sleep(400);
  assert.deepStrictEqual(old, [], 'a rematch starts with an empty chat log');
  again.ws.close();
  console.log('rematch: both pressed, the room dealt again with a new escrow each');
  for (const c of [t.ra, t.rb, t.a, t.b]) c.ws.close();
}

// one presses and the other cannot cover the stake: the second is sent back and the seat is looked for again
async function rematchOne() {
  const t = await seatTwo(100);
  // the window is short, so the chips go down while the match runs; the payout cannot bring them back to 1,000
  for (let i = 0; !t.rb.st; i++) {
    assert(i < 1200, 'rematch: the second player never got a state');
    await sleep(50);
  }
  sql("UPDATE players SET chips = 100 WHERE id = '" + t.accB.id + "'");
  await within(Promise.all(t.offer), 120000, 'match end');
  const poor = t.rb.next(m => m.t === 'error');
  t.rb.send({ t: 'rematch' });
  assert.strictEqual((await poor).k, 'poor');
  const closed = new Promise(res => t.rb.ws.on('close', res));
  const room = t.ra.next(m => m.t === 'room');
  const next = t.ra.next(m => m.t === 'state' && m.phase !== 'matchend');
  t.ra.send({ t: 'rematch' });
  assert.strictEqual(await within(closed, 5000, 'sent back'), 1000);
  const r = await within(room, 5000, 'room');
  const seed = (await call('GET', '/api/me', t.accB)).body.seed;
  assert(r.seats.includes(null) && r.finding > 0);
  assert(r.seats.every(x => !x || x.seed !== seed), 'the one who did not press is not seated');
  const st = await within(next, 30000, 'new match');
  assert.strictEqual(st.players.length, 4);
  assert(st.players.every(p => p.pid !== t.accB.id));
  assert(st.players.some(p => p.pid === t.accA.id));
  assert.strictEqual(escrows(t.accA).length, 2);
  assert.strictEqual(escrows(t.accB).length, 1);
  console.log('rematch: the poor player got poor and was sent back, the seat was refilled');
  for (const c of [t.ra, t.a, t.b]) c.ws.close();
}

// a player who pressed and then lost the connection is not charged for the next match
async function rematchAway() {
  const t = await seatTwo(100);
  await within(Promise.all(t.offer), 120000, 'match end');
  const next = t.ra.next(m => m.t === 'state' && m.phase !== 'matchend');
  t.rb.send({ t: 'rematch' });
  t.ra.send({ t: 'rematch' });
  t.rb.ws.close();
  const st = await within(next, 30000, 'new match');
  assert(st.players.every(p => p.pid !== t.accB.id));
  assert.strictEqual(escrows(t.accA).length, 2);
  assert.strictEqual(escrows(t.accB).length, 1);
  console.log('rematch: a player who dropped after pressing was not charged');
  for (const c of [t.ra, t.a, t.b]) c.ws.close();
}

// nobody presses: the window closes and the personas are free again
async function rematchNone() {
  const acc = level(4, await guest());
  const h = await hub(acc);
  const s = h.next(m => m.t === 'seated');
  h.send({ t: 'quick', stake: 500 });
  const sat = await s;
  const r = seated(sat);
  const offer = r.next(m => m.t === 'state' && m.rm);
  play(r, { finish: () => {} });
  await within(offer, 120000, 'match end');
  const over = r.next(m => m.t === 'state' && m.phase === 'matchend' && !m.rm);
  await within(over, 5000, 'window closing');
  const held = () => sql("SELECT count(*) AS n FROM personas WHERE busy = '" + sat.code + "'")[0].n;
  assert.strictEqual(held(), 0);
  console.log('rematch: nobody pressed, the personas are free again');
  r.ws.close();
  h.ws.close();
}

// a friend table takes the same path; with every seat kept the match starts at once
async function rematchFriends() {
  const accA = await guest();
  const accB = await guest();
  link(accA, accB);
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: 3, games: 3, stake: 100 });
  const ja = await a.next(m => m.t === 'joined');
  const b = client('/ws/' + ja.code);
  await b.ready;
  b.send({ t: 'join', auth: accB.auth });
  await b.next(m => m.t === 'joined');
  const offer = [a, b].map(c => c.next(m => m.t === 'state' && m.rm));
  for (const c of [a, b]) play(c, { finish: () => {} });
  a.send({ t: 'start' });
  await within(Promise.all(offer), 120000, 'match end');
  const next = [a, b].map(c => c.next(m => m.t === 'state' && m.phase !== 'matchend'));
  a.send({ t: 'rematch' });
  b.send({ t: 'rematch' });
  await within(Promise.all(next), 30000, 'new match');
  assert.strictEqual(escrows(accA).length, 2);
  assert.strictEqual(escrows(accB).length, 2);
  assert.deepStrictEqual([fees(accA), fees(accB)], [[-5, -5], [-5, -5]]);
  console.log('rematch: a friend table dealt again');
  a.ws.close();
  b.ws.close();
}

const cupIn = acc => sql("SELECT delta, ref FROM chip_log WHERE reason = 'cup' AND player = '" + acc.id + "' ORDER BY id");

// withdrawing, by message or by closing the app, costs nothing and frees the player
async function cupCancel() {
  const acc = level(10, link(await guest()));
  const h = await hub(acc);
  const counts = [];
  h.handlers.push(m => m.t === 'cup' && m.buy && counts.push(m.n));
  const first = h.next(m => m.t === 'cup' && m.buy === 5000);
  h.send({ t: 'cup', buy: 5000 });
  const f = await first;
  assert.strictEqual(f.n, 1);
  assert(f.left > 0 && f.left <= 20000 * 0.02 + 1);
  const no = h.next(m => m.t === 'error');
  h.send({ t: 'quick', stake: 100 });
  assert.strictEqual((await no).k, 'busy', 'a registered player is held');
  // cancel early: under the test pace the eight can be there within half a second, and a started tournament has no way out
  // counts already holds what came while the busy answer was awaited
  for (let i = 0; i < 400 && Math.max(...counts) < 3; i++) await sleep(50);
  assert(Math.max(...counts) >= 3, 'the form filled with computer players');
  const before = Math.max(...counts);
  const out = h.next(m => m.t === 'cup' && m.buy === 0);
  h.send({ t: 'cup', buy: 0 });
  await out;
  const again = h.next(m => m.t === 'cup' && m.buy === 5000);
  h.send({ t: 'cup', buy: 5000 });
  assert((await again).n >= before, 'signing straight back in finds the same count');
  h.ws.close();
  await sleep(800);
  const h2 = await hub(acc);
  const fresh = h2.next(m => m.t === 'cup' && m.buy === 5000);
  h2.send({ t: 'cup', buy: 5000 });
  assert.strictEqual((await fresh).n, 1, 'closing the app withdrew the player');
  h2.send({ t: 'cup', buy: 0 });
  await h2.next(m => m.t === 'cup' && m.buy === 0);
  assert.strictEqual(cupIn(acc).length, 0, 'nothing was taken');
  assert.strictEqual((await call('GET', '/api/me', acc)).body.chips, 5000);
  console.log('tournament: withdrawing costs nothing and frees the player');
  h2.ws.close();
}

// a hello tells a player who is in no tournament, so an app that missed the message can clear its state
async function cupHello() {
  const acc = await guest();
  const [c] = await within(hello({ auth: acc.auth }, m => m.t === 'cup' && m.buy === 0), 20000, 'a hello says there is no tournament');
  c.ws.close();
  console.log('tournament: a hello from an unregistered player gets buy 0');
}

// a failure while the buy-ins are taken leaves the form, and the repeat takes nobody's chips twice
async function cupRetry() {
  const [a, b] = await Promise.all([guest(), guest()]);
  link(a, b);
  sql("CREATE TRIGGER nopay BEFORE INSERT ON chip_log WHEN new.player = '" + b.id + "' AND new.ref LIKE '%:in' BEGIN SELECT RAISE(ABORT, 'down'); END");
  const ha = await hub(a);
  const hb = await hub(b);
  const msgs = [];
  for (const h of [ha, hb]) h.handlers.push(m => msgs.push(m));
  const ra = ha.next(m => m.t === 'cup' && m.buy === 1000);
  ha.send({ t: 'cup', buy: 1000 });
  await ra;
  const rb = hb.next(m => m.t === 'cup' && m.buy === 1000);
  hb.send({ t: 'cup', buy: 1000 });
  await rb;
  msgs.length = 0;
  for (let i = 0; i < 400 && !cupIn(a).length; i++) await sleep(50);
  assert.strictEqual(cupIn(a).length, 1, 'the first buy-in was taken before the failure');
  await sleep(300);
  assert(!msgs.some(m => m.t === 'seated' || m.t === 'cup' && m.buy === 0 || m.t === 'cup' && m.n > 8), 'the form waits');
  // the form is full and may have charged someone, so a withdraw is refused and the player is told the state again
  const back = ha.next(m => m.t === 'cup' && m.buy === 1000 && m.n === 8);
  ha.send({ t: 'cup', buy: 0 });
  await within(back, 3000, 'a refused withdraw gets the state back');
  const sa = ha.next(m => m.t === 'seated');
  const sb = hb.next(m => m.t === 'seated');
  sql('DROP TRIGGER nopay');
  assert.strictEqual((await within(sa, 10000, 'the retry seats the first')).cup, 'first');
  assert.strictEqual((await within(sb, 10000, 'the retry seats the second')).cup, 'first');
  assert.strictEqual(cupIn(a).length, 1, 'taken once');
  assert.strictEqual(cupIn(b).length, 1);
  assert.strictEqual((await call('GET', '/api/me', a)).body.chips, 4000);
  console.log('tournament: a failed start was retried without charging twice');
  ha.ws.close();
  hb.ws.close();
}

// a tournament whose humans all fail to pay at the start is dropped, not played by personas alone
async function cupGone() {
  const t0 = Date.now();
  const acc = link(await guest());
  // the account can register, but its chips never move, as if it were deleted before the start
  sql("CREATE TRIGGER frozen BEFORE UPDATE ON players WHEN old.id = '" + acc.id + "' AND new.chips < old.chips BEGIN SELECT RAISE(IGNORE); END");
  const h = await hub(acc);
  const poor = h.next(m => m.t === 'error' && m.k === 'poor');
  h.send({ t: 'cup', buy: 1000 });
  await within(poor, 10000, 'the start fails');
  await sleep(1500);
  sql('DROP TRIGGER frozen');
  assert.strictEqual(sql('SELECT count(*) AS n FROM personas WHERE busy IS NOT NULL AND busy_at >= ' + t0)[0].n, 0, 'no personas are left claimed');
  console.log('tournament: nobody paid, so nothing started');
  h.ws.close();
}

async function cupPoor() {
  const acc = level(10, link(await guest()));
  sql("UPDATE players SET chips = 999 WHERE id = '" + acc.id + "'");
  const h = await hub(acc);
  const seen = [];
  h.handlers.push(m => seen.push(m));
  const no = h.next(m => m.t === 'error');
  h.send({ t: 'cup', buy: 1000 });
  assert.strictEqual((await no).k, 'poor');
  const no2 = h.next(m => m.t === 'error');
  h.send({ t: 'cup', buy: 12 });
  h.send({ t: 'cup', buy: 5000 });
  assert.strictEqual((await no2).k, 'poor');
  await sleep(200);
  assert(!seen.some(m => m.t === 'cup' && m.buy), 'a poor player is not registered');
  assert.strictEqual(cupIn(acc).length, 0);
  console.log('tournament: a player who cannot cover the buy-in is refused');
  h.ws.close();
}

// Humans enter and personas fill the rest. Nothing moves at the first tables, and the final pays 50/25/15/10 of eight buy-ins.
// With six humans one leaves right after the start: it is let go at once, gets no prize, and its share stays unpaid.
async function cupRun(n, buy = 1000) {
  const sharp = buy === 1000 ? 1 : 2;
  const prizes = [4, 2, 1.2, 0.8].map(x => x * buy);
  const hs = [];
  const finals = new Set();
  const probes = [];
  let snap = null;
  for (const acc of await Promise.all(Array.from({ length: n }, async () => level(10, link(await guest()))))) {
    const h = await hub(acc);
    const x = { acc: acc, h: h, counts: [], msgs: [], rooms: [], round: null, leaver: n === 6 && hs.length === 5, late: n === 2 };
    x.end = new Promise(res => h.handlers.push(m => {
      x.msgs.push(m);
      if (m.t === 'cup' && m.buy) x.counts.push(m.n);
      if (m.t === 'cupout' || m.t === 'cupend') res(m);
      if (m.t !== 'seated' || !m.cup) return;
      assert.strictEqual(m.cup, x.round ? 'final' : 'first');
      assert(x.rooms.every(r => r.ws.readyState === 1), 'the first table is kept until the final opens');
      x.round = m.cup;
      // the leaver may have qualified and sit at the final as a stand-in; a join without a token must not take the seat back
      if (m.cup === 'final' && n === 6 && !x.leaver && !finals.has(m.code)) {
        finals.add(m.code);
        const lv = hs[5].acc;
        probes.push((async () => {
          const t = client('/ws/' + m.code);
          await t.ready;
          const got = t.next(z => z.t === 'error' || z.t === 'joined');
          t.send({ t: 'join', auth: lv.auth });
          const z = await got;
          t.ws.close();
          return z;
        })());
      }
      for (const r of x.rooms) r.ws.close();
      const r = seated(m);
      play(r, { finish: c => {
        if (!x.late || x.round !== 'final' || x.sent) return;
        x.sent = true;
        c.send({ t: 'leave' });
      } });
      x.rooms = [r];
      if (x.leaver) r.ready.then(() => sleep(300)).then(() => {
        r.send({ t: 'leave' });
        res({ t: 'left' });
        // the seat is a stand-in's now, and a join without its token is turned away
        x.again = sleep(400).then(async () => {
          const t = client('/ws/' + m.code);
          await t.ready;
          const got = t.next(z => z.t === 'error' || z.t === 'joined');
          t.send({ t: 'join', auth: acc.auth });
          const z = await got;
          t.ws.close();
          return z;
        });
      });
      // the personas of this tournament stay level so no match brings a bonus, and their chips are noted
      if (!snap) {
        const id = cupIn(acc)[0].ref.split(':')[0];
        sql("UPDATE personas SET level = 20, xp = 19000 WHERE busy = '" + id + "'");
        snap = { id: id, rows: sql("SELECT id, chips FROM personas WHERE busy = '" + id + "'") };
      }
    }));
    hs.push(x);
  }
  const a = hs[0];
  const t0 = Date.now();
  const first = a.h.next(m => m.t === 'cup');
  a.h.send({ t: 'cup', buy: buy });
  assert.strictEqual((await first).n, 1);
  for (const x of hs.slice(1)) {
    x.h.send({ t: 'cup', buy: buy });
    await sleep(20);
  }
  const held = a.h.next(m => m.t === 'error');
  a.h.send({ t: 'quick', stake: 100 });
  assert.strictEqual((await held).k, 'busy');
  for (let i = 0; i < 600 && !a.counts.includes(8); i++) await sleep(50);
  assert.deepStrictEqual(a.counts, [1, 2, 3, 4, 5, 6, 7, 8], 'the count climbs one at a time');
  console.log('tournament: the count climbed to 8 in ' + (Date.now() - t0) + 'ms');

  await within(Promise.all(hs.map(x => x.end)), 400000, 'tournament');
  const ids = () => snap.rows.map(r => "'" + r.id + "'").join(',');
  for (let i = 0; i < 480 && sql("SELECT count(*) AS n FROM personas WHERE busy = '" + snap.id + "'")[0].n; i++) await sleep(500);
  assert.strictEqual(sql("SELECT count(*) AS n FROM personas WHERE busy = '" + snap.id + "'")[0].n, 0, 'the personas are free again');
  await sleep(500);

  if (n === 6) {
    const got = await Promise.all(probes);
    assert(got.length && got.every(z => z.t === 'error'), 'the leaver cannot join a final table');
    console.log('tournament: the leaver was turned away from the final: ' + got.map(z => z.k).join(','));
  }
  let paid = 0;
  let flowRows = 0;
  for (const x of hs) {
    assert(!x.msgs.some(m => /bot|fake|persona/i.test(JSON.stringify(m))), 'no hub message says bot');
    const rows = cupIn(x.acc);
    assert.deepStrictEqual(rows[0], { delta: -buy, ref: snap.id + ':in' }, 'the buy-in is taken once');
    assert.strictEqual(new Set(rows.map(r => r.ref)).size, rows.length, 'refs are unique');
    const log = sql("SELECT reason, delta FROM chip_log WHERE player = '" + x.acc.id + "'");
    assert(!log.some(r => r.reason === 'escrow' || r.reason === 'match'), 'no chips moved at a table');
    const me = (await call('GET', '/api/me', x.acc)).body;
    assert.strictEqual(me.chips, log.reduce((n, r) => n + r.delta, 0), 'every chip change is logged');
    const end = x.msgs.find(m => m.t === 'cupend');
    if (x.leaver) {
      assert(!end && rows.length === 1 && !x.msgs.some(m => m.t === 'cupout'), 'the leaver got nothing');
      assert.strictEqual((await x.again).k, 'left', 'a left seat of a tournament table is not taken back');
      const sat = x.h.next(m => m.t === 'seated');
      x.h.send({ t: 'quick', stake: 100 });
      await within(sat, 5000, 'the leaver is free');
      console.log('tournament: a human who left was let go and paid only the buy-in');
      continue;
    }
    const week = sql("SELECT week_won AS n FROM players WHERE id = '" + x.acc.id + "'")[0].n;
    if (!end) {
      assert.strictEqual(rows.length, 1);
      assert(x.msgs.some(m => m.t === 'cupout'));
      assert.strictEqual(week, 0);
      const fl = sharpRows(x.acc);
      assert(fl.length === (n === 2 ? 1 : fl.length) && fl.length <= 1 && fl.every(r => r.kind === 'cup' && r.stake === buy && r.net === -buy && r.won === 0 && r.sharp === sharp), 'a human knocked out is logged at the buy-in');
      flowRows += fl.length;
      console.log('tournament: a human went out after the first round and paid only the buy-in');
      continue;
    }
    assert.strictEqual(x.round, 'final');
    assert.strictEqual(end.prize, prizes[end.place - 1], 'leaving after the final does not cost the prize');
    assert.deepStrictEqual(rows[1], { delta: end.prize, ref: snap.id + ':out' });
    const st = x.rooms[0].st;
    assert.strictEqual(st.cup.round, 'final');
    assert.strictEqual(st.cup.place, end.place);
    assert.strictEqual(st.stake, 0);
    assert.deepStrictEqual(st.cup.prizes, prizes);
    assert.strictEqual(week, Math.max(0, end.prize - buy));
    const fl = sharpRows(x.acc);
    assert(fl.length === (n === 2 ? 1 : fl.length) && fl.length <= 1 && fl.every(r => r.kind === 'cup' && r.stake === buy && r.net === end.prize - buy && r.won === (end.place === 1 ? 1 : 0) && r.sharp === sharp), 'a finalist is logged by place');
    flowRows += fl.length;
    paid += end.prize;
    console.log('tournament: a human placed ' + end.place + ' at the final and got ' + end.prize);
  }
  assert(flowRows >= (n === 2 ? 2 : 1), 'the tournament wrote its flow rows');
  const after = sql('SELECT sum(chips) AS n FROM personas WHERE id IN (' + ids() + ')')[0].n;
  paid += after - snap.rows.reduce((n, r) => n + r.chips, 0);
  const unpaid = 8 * buy - paid;
  assert(n === 6 ? [0, ...prizes].includes(unpaid) : unpaid === 0, 'the pool was paid out, less the share of a leaver: ' + unpaid);
  sql('UPDATE players SET chips = chips + 5000 WHERE id = ' + who(a.acc));
  const free = a.h.next(m => m.t === 'seated');
  a.h.send({ t: 'quick', stake: 100 });
  await within(free, 5000, 'free after the tournament');
  console.log('tournament: 8 x ' + buy + ' paid out by place, players held during and free after');
  for (const x of hs) {
    for (const r of x.rooms) r.ws.close();
    x.h.ws.close();
  }
}

// Plays APNs (8792 production, 8793 sandbox), FCM and Google's token endpoint (8794), and records what the worker sends.
// A rule per token picks the answer: { apns: [400, 'BadDeviceToken'], sandbox: [...], fcm: [404, 'UNREGISTERED', status, message] }.
function fakePush() {
  const f = { apns: [], sandbox: [], fcm: [], exchanges: [], rules: {}, dead: new Set(), revoke: false };
  f.clear = () => { f.apns.length = f.sandbox.length = f.fcm.length = 0; };
  const serve = (name, port, fn) => fake(name, port, (req, res) => new Promise((ok, no) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      try {
        const [status, o] = fn(req, b);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o || {}));
        ok();
      } catch (e) { no(e); }
    });
  }));
  const servers = [['apns', 'APNS', 8792], ['sandbox', 'SANDBOX', 8793]].map(([k, p, d]) => serve(k, port(p, d), (req, b) => {
    if (!/^\/3\/device\/[^/]+$/.test(req.url)) return [404, { reason: 'BadPath' }];
    const token = req.url.split('/').pop();
    f[k].push({ token: token, url: req.url, headers: req.headers, body: JSON.parse(b) });
    const rule = (f.rules[token] || {})[k] || [200];
    return [rule[0], rule[1] && { reason: rule[1] }];
  }));
  servers.push(serve('fcm', port('FCM', 8794), (req, b) => {
    if (req.url !== '/token' && !/^\/v1\/projects\/[^/]+\/messages:send$/.test(req.url)) return [404, {}];
    if (req.url === '/token') {
      const at = 'at-' + crypto.randomBytes(8).toString('hex');
      f.exchanges.push({ form: new URLSearchParams(b), at: at });
      return [200, { access_token: at, expires_in: 3600, token_type: 'Bearer' }];
    }
    const message = JSON.parse(b).message;
    const bearer = (req.headers.authorization || '').replace('Bearer ', '');
    f.fcm.push({ token: message.token, url: req.url, bearer: bearer, message: message });
    // the worker keeps its bearer between runs of this file, so any at- one is good until it is refused
    if (f.revoke || f.dead.has(bearer) || !bearer.startsWith('at-')) {
      f.revoke = false;
      f.dead.add(bearer);
      return [401, { error: { code: 401, status: 'UNAUTHENTICATED' } }];
    }
    const rule = (f.rules[message.token] || {}).fcm;
    if (!rule) return [200, { name: 'projects/x/messages/1' }];
    return [rule[0], { error: { code: rule[0], status: rule[2] || 'X', message: rule[3], details: rule[1] ? [{ errorCode: rule[1] }] : [] } }];
  }));
  f.ready = Promise.all(servers.map(s => s.listening$));
  f.close = () => servers.forEach(s => s.close());
  return f;
}

const DAY = 86400000;
const hexTok = () => crypto.randomBytes(32).toString('hex');
const fcmTok = () => 'fcm-' + crypto.randomBytes(40).toString('base64url');
const reg = (acc, kind, token, lang, tz) => call('POST', '/api/device', acc, { kind: kind, token: token, lang: lang || 'en', tz: tz || 0 });
const devs = acc => sql('SELECT token, kind, lang, tz, sandbox, created, seen FROM devices WHERE player = ' + who(acc));
// pushes go out after the answer, so a test waits for one it expects
const settle = async fn => {
  for (let i = 0; i < 50 && !fn(); i++) await sleep(100);
};
const tick = async time => {
  // the time can only be set through this route, not through /__scheduled
  const go = () => fetch(http + '/cdn-cgi/handler/scheduled?cron=0+*+*+*+*&time=' + time, { signal: AbortSignal.timeout(30000) });
  assert.strictEqual(await (await go().catch(go)).text(), 'ok');
};

// the tz, in minutes behind UTC, whose clock reads h:30 at this moment
// the tz of a device that reads half past noon now, so a test is never inside the quiet hours of invites and messages
const noonTz = () => tzAt(Date.now(), 12);
const tzAt = (now, h) => ((Math.floor(now % DAY / 60000) - h * 60 - 30 + 720) % 1440 + 1440) % 1440 - 720;

async function befriend(a, b) {
  await call('POST', '/api/friend', a, { id: b.id });
  await call('POST', '/api/friend', b, { id: a.id });
}

function jwtOk(jwt, key, alg, kind) {
  const [h, c, s] = jwt.split('.');
  const ok = crypto.verify('sha256', Buffer.from(h + '.' + c), kind === 'ec' ? { key: key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(s, 'base64url'));
  assert(ok, 'jwt signature');
  const head = JSON.parse(Buffer.from(h, 'base64url'));
  assert.strictEqual(head.alg, alg);
  return { head: head, claims: JSON.parse(Buffer.from(c, 'base64url')) };
}

async function metrics() {
  const a = await guest();
  const day = Math.floor(Date.now() / DAY);
  await hub(a);
  await sleep(300);
  assert.strictEqual(sql("SELECT count(*) AS n FROM active WHERE player = '" + a.id + "' AND day = " + day)[0].n, 1);
  await hello({ auth: 'nobody.nothing' }, m => m.t === 'error');
  assert.strictEqual(sql("SELECT count(*) AS n FROM active WHERE player = 'nobody'")[0].n, 0);
  sql("INSERT INTO active (player, day) VALUES ('old', " + (day - 100) + ")");
  // a match whose human was paid nothing writes an escrow row and no payout row, and still counts
  const played = "SELECT count(DISTINCT substr(ref, 1, length(ref) - 3)) AS n FROM chip_log WHERE reason = 'escrow' AND at >= " + day * DAY + ' AND at < ' + (day + 1) * DAY;
  sql("INSERT INTO chip_log (player, delta, reason, at, ref) VALUES ('" + a.id + "', -100, 'escrow', " + (day * DAY + 1000) + ", 'zeropay:in')");
  const before = sql(played)[0].n;
  assert(before >= 1);
  // the first run after midnight UTC writes the row for the day that just ended; a second one leaves it alone
  await tick((day + 1) * DAY + 5 * 60000);
  const [row] = sql('SELECT * FROM stats WHERE day = ' + day);
  assert(row && row.new >= 1 && row.dau >= 1, 'stats row ' + JSON.stringify(row));
  assert.strictEqual(row.matches, before);
  assert.strictEqual(sql("SELECT count(*) AS n FROM active WHERE player = 'old'")[0].n, 0);
  await tick((day + 2) * DAY - DAY + 3600000 + 5 * 60000);
  assert.deepStrictEqual(sql('SELECT * FROM stats WHERE day = ' + day), [row]);
  assert.strictEqual((await call('DELETE', '/api/me', a)).status, 200);
  assert.strictEqual(sql("SELECT count(*) AS n FROM active WHERE player = '" + a.id + "'")[0].n, 0);
}

// Plays RevenueCat's REST API on 8797: whatever a test puts in subs for a player id comes back as that player's purchases.
function fakeRc() {
  const f = { subs: {}, vip: {}, seen: [], down: false };
  f.server = fake('revenuecat', port('RC', 8797), (req, res) => {
    f.seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (f.down) {
      res.writeHead(500);
      return res.end('{}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const id = req.url.split('/').pop();
    res.end(JSON.stringify({ subscriber: { non_subscriptions: f.subs[id] || {}, subscriptions: f.vip[id] ? { [VIP]: f.vip[id] } : {} } }));
  });
  return f;
}

const PACK = n => 'com.aytutuna.amerikano.tokens.' + n;
const VIP = 'com.aytutuna.amerikano.vip.monthly';
const event = (type, acc, product, tx, more) => ({ api_version: '1.0', event: Object.assign({ type: type, app_user_id: acc.id, product_id: product, transaction_id: tx, environment: 'SANDBOX' }, more) });
const hook = (body, auth) => call('POST', '/api/rc', null, body, undefined, auth === null ? {} : { Authorization: auth === undefined ? 'test-hook-auth' : auth });
const shopOf = async acc => (await call('GET', '/api/shop', acc)).body;

async function shop(rc) {
  // the transaction ids below are fixed, so a rerun on the same local database starts without the last run's
  sql('DELETE FROM purchases');
  sql("DELETE FROM token_log WHERE ref LIKE 'rc:%' OR ref LIKE 'refund:%'");
  const a = await guest();
  const b = await guest();
  assert.strictEqual((await call('GET', '/api/shop')).status, 401);
  assert.deepStrictEqual(await shopOf(a), { tokens: 0, owned: [], worn: {}, vipUntil: 0, earned: 0, cap: 20, chips: true });
  assert.strictEqual((await call('POST', '/api/shop/buy', a, { item: 'frame-brass' })).status, 409, 'no tokens, no frame');
  assert.strictEqual((await call('POST', '/api/shop/buy', a, { item: 'frame-brass' })).body.error, 'broke');
  assert.strictEqual((await call('POST', '/api/shop/buy', a, { item: 'chips' })).status, 400);

  // the webhook
  const ev = event('NON_RENEWING_PURCHASE', a, PACK(500), 'tx-1');
  assert.strictEqual((await hook(ev, null)).status, 401, 'no header');
  assert.strictEqual((await hook(ev, 'wrong')).status, 401, 'wrong header');
  assert.strictEqual((await hook(ev, 'test-hook-auth2')).status, 401, 'close is not equal');
  assert.strictEqual((await shopOf(a)).tokens, 0);
  assert.strictEqual((await hook(ev)).status, 200);
  assert.strictEqual((await shopOf(a)).tokens, 500);
  assert.strictEqual((await hook(ev)).status, 200);
  assert.strictEqual((await shopOf(a)).tokens, 500, 'the same transaction is credited once');
  assert.strictEqual((await hook(event('INITIAL_PURCHASE', a, PACK(80), 'tx-2'))).status, 200);
  assert.strictEqual((await shopOf(a)).tokens, 580, 'INITIAL_PURCHASE counts too');
  const ignored = [event('NON_RENEWING_PURCHASE', a, PACK(81), 'tx-3'), event('NON_RENEWING_PURCHASE', a, 'com.aytutuna.amerikano.vip.monthly', 'tx-4'),
    event('RENEWAL', a, PACK(500), 'tx-5'), event('NON_RENEWING_PURCHASE', { id: '0'.repeat(32) }, PACK(500), 'tx-6'), event('NON_RENEWING_PURCHASE', { id: 'not-an-id' }, PACK(500), 'tx-7')];
  for (const bad of ignored) assert.strictEqual((await hook(bad)).status, 200, 'ignored events are still answered');
  assert.strictEqual((await shopOf(a)).tokens, 580, 'unknown products, other events and unknown players change nothing');
  assert.strictEqual((await call('POST', '/api/rc', null, { nothing: 1 }, undefined, { Authorization: 'test-hook-auth' })).status, 400);
  console.log('shop: webhook needs its header, credits a pack once, ignores the rest');

  // buying and wearing
  assert.strictEqual((await call('POST', '/api/shop/buy', a, { item: 'nothing' })).status, 400);
  let r = await call('POST', '/api/shop/buy', a, { item: 'frame-brass' });
  assert.deepStrictEqual([r.status, r.body.tokens, r.body.owned], [200, 330, ['frame-brass']]);
  r = await call('POST', '/api/shop/buy', a, { item: 'frame-brass' });
  assert.deepStrictEqual([r.status, r.body.error], [409, 'owned']);
  assert.strictEqual((await shopOf(a)).tokens, 330, 'an owned item is not charged again');
  const wear = (acc, slot, item) => call('POST', '/api/shop/wear', acc, { slot: slot, item: item });
  assert.strictEqual((await wear(a, 'frame', 'frame-laurel')).status, 403, 'not owned');
  assert.strictEqual((await wear(a, 'plate', 'frame-brass')).status, 400, 'wrong slot');
  assert.strictEqual((await wear(a, 'emote', 'emo-cafe')).status, 400, 'packs are not worn');
  assert.strictEqual((await wear(a, 'hat', null)).status, 400);
  assert.strictEqual((await wear(a, 'frame', undefined)).status, 400);
  assert.strictEqual((await wear(b, 'frame', 'frame-brass')).status, 403, 'nobody wears what another owns');
  assert.deepStrictEqual((await wear(a, 'frame', 'frame-brass')).body.worn, { frame: 'frame-brass' });
  assert.deepStrictEqual((await call('GET', '/api/me', a)).body.wear, { frame: 'frame-brass' });
  assert.deepStrictEqual((await wear(a, 'frame', null)).body.worn, {});
  await wear(a, 'frame', 'frame-brass');
  console.log('shop: buy charges once, wear needs the right slot and an owned item');

  // tokens are not chips
  assert.strictEqual((await call('GET', '/api/me', a)).body.chips, 5000, 'buying never touches chips');
  assert.strictEqual(sql('SELECT count(*) AS n FROM chip_log WHERE player = ' + who(a))[0].n, 1, 'only the start grant is in the chip log');
  assert.deepStrictEqual(sql('SELECT delta, reason FROM token_log WHERE player = ' + who(a) + ' ORDER BY id').map(x => [x.delta, x.reason]), [[500, 'purchase'], [80, 'purchase'], [-250, 'buy']]);
  assert.strictEqual((await call('POST', '/api/bailout', a)).status, 409);
  assert.strictEqual((await call('POST', '/api/shop/convert', a, { tokens: 10 })).status, 404, 'there is no way to change tokens into chips');

  // refunds
  const cancel = (acc, tx, why) => hook(event('CANCELLATION', acc, PACK(500), tx, { cancel_reason: why }));
  assert.strictEqual((await cancel(a, 'tx-1', 'UNSUBSCRIBE')).status, 200);
  assert.strictEqual((await shopOf(a)).tokens, 330, 'only a support refund takes tokens back');
  await cancel(a, 'tx-1', 'CUSTOMER_SUPPORT');
  assert.strictEqual((await shopOf(a)).tokens, 0, 'a refund takes what is left, not below zero');
  assert.strictEqual(sql("SELECT refunded FROM purchases WHERE tx = 'tx-1'")[0].refunded, 1);
  await cancel(a, 'tx-1', 'CUSTOMER_SUPPORT');
  await hook(ev);
  assert.strictEqual((await shopOf(a)).tokens, 0, 'a repeat refund and a repeat purchase change nothing');
  await cancel(a, 'tx-unknown', 'CUSTOMER_SUPPORT');
  assert.strictEqual((await call('POST', '/api/shop/buy', a, { item: 'frame-laurel' })).body.error, 'broke');
  assert(sql('SELECT min(tokens) AS n FROM players')[0].n >= 0);
  console.log('shop: refunds take tokens back down to zero, once');

  // the app's own sync against RevenueCat's REST API
  const c = await guest();
  rc.subs[c.id] = {
    [PACK(500)]: [{ id: 'rc-a', store_transaction_id: 'tx-sync-1', is_sandbox: true }, { id: 'rc-b', store_transaction_id: 'tx-sync-2', is_sandbox: false }],
    [PACK(81)]: [{ id: 'x', store_transaction_id: 'tx-sync-3' }],
    [PACK(80)]: [{ id: 'no-store-id' }],
    other: []
  };
  assert.strictEqual((await call('POST', '/api/shop/sync')).status, 401);
  rc.down = true;
  assert.strictEqual((await call('POST', '/api/shop/sync', c)).status, 502);
  assert.strictEqual((await call('POST', '/api/shop/sync', c)).status, 429, 'one sync at a time for a player');
  const again = () => sql('UPDATE players SET sync_at = 0 WHERE id = ' + who(c));
  again();
  assert.strictEqual((await shopOf(c)).tokens, 0);
  rc.down = false;
  again();
  r = await call('POST', '/api/shop/sync', c);
  assert.deepStrictEqual([r.status, r.body.tokens], [200, 1000], 'both transactions are credited, the unknown product and an entry without a store id are not');
  assert.deepStrictEqual(rc.seen[rc.seen.length - 1], { method: 'GET', url: '/v1/subscribers/' + c.id, auth: 'Bearer sk_test' });
  again();
  assert.strictEqual((await call('POST', '/api/shop/sync', c)).body.tokens, 1000, 'sync twice credits once');
  await hook(event('NON_RENEWING_PURCHASE', c, PACK(500), 'tx-sync-1'));
  assert.strictEqual((await shopOf(c)).tokens, 1000, 'the webhook after a sync credits nothing more');
  rc.subs[c.id][PACK(80)] = [{ id: 'rc-c', store_transaction_id: 'tx-sync-9' }];
  again();
  assert.strictEqual((await call('POST', '/api/shop/sync', c)).body.tokens, 1080, 'a new transaction is picked up');
  // a refund that comes first means the purchase is never credited
  await hook(event('CANCELLATION', c, PACK(500), 'tx-early', { cancel_reason: 'CUSTOMER_SUPPORT' }));
  await hook(event('NON_RENEWING_PURCHASE', c, PACK(500), 'tx-early'));
  assert.strictEqual((await shopOf(c)).tokens, 1080, 'a purchase refunded before it arrived credits nothing');
  assert.deepStrictEqual(sql("SELECT env FROM purchases WHERE tx IN ('tx-sync-1', 'tx-sync-2') ORDER BY tx").map(x => x.env), ['SANDBOX', 'PRODUCTION']);
  console.log('shop: sync credits transactions the webhook has not delivered, once');

  // emotes and what others see
  const [x, y] = [await guest(), await guest()];
  await hook(event('NON_RENEWING_PURCHASE', x, PACK(6500), 'tx-x'));
  for (const item of ['emo-cafe', 'frame-royal', 'back-sultan', 'felt-kilim', 'plate-gilt']) assert.strictEqual((await call('POST', '/api/shop/buy', x, { item: item })).status, 200, item);
  for (const [slot, item] of [['frame', 'frame-royal'], ['back', 'back-sultan'], ['felt', 'felt-kilim'], ['plate', 'plate-gilt']]) await wear(x, slot, item);
  const g = await pair(3, 3, [x, y]);
  const [sx, sy] = await begin(g);
  const seen = { a: [], b: [] };
  // the third seat is a computer player, who may answer with an emote of its own
  g.a.handlers.push(m => { if (m.t === 'said' && m.p !== 2) seen.a.push(m.k); });
  g.b.handlers.push(m => { if (m.t === 'said' && m.p !== 1) seen.b.push(m.k); });
  assert.deepStrictEqual(sx.players[0].wear, { frame: 'frame-royal', plate: 'plate-gilt', back: 'back-sultan' }, 'worn items travel in the seat, the felt stays private');
  assert.deepStrictEqual(sy.players[2].wear, sx.players[0].wear);
  assert.deepStrictEqual(sy.players[0].wear, {});
  assert.deepStrictEqual((await call('GET', '/api/player/' + x.id, y)).body.wear, { frame: 'frame-royal', plate: 'plate-gilt', back: 'back-sultan' }, 'and the profile card');
  g.b.send({ t: 'say', k: 'tea' });
  g.a.send({ t: 'say', k: 'smile' });
  await sleep(500);
  assert.deepStrictEqual([seen.a, seen.b], [['smile'], ['smile']], 'an emote from a pack nobody bought is dropped');
  g.a.send({ t: 'say', k: 'tea' });
  g.a.send({ t: 'say', k: 'lamp' });
  g.a.send({ t: 'say', k: 'eye' });
  await sleep(500);
  assert.deepStrictEqual([seen.a, seen.b], [['smile', 'tea', 'lamp'], ['smile', 'tea', 'lamp']], 'the owner can use the pack, and only that pack');
  g.a.ws.close();
  g.b.ws.close();
  console.log('shop: emotes need their pack, worn items reach other seats and the card');

  // deleting an account takes its shop records along
  assert.strictEqual((await call('DELETE', '/api/me', x)).status, 200);
  const gone = () => rc.seen.filter(s => s.method === 'DELETE' && s.url.endsWith(x.id));
  await settle(() => gone().length);
  assert.deepStrictEqual(gone(), [{ method: 'DELETE', url: '/v1/subscribers/' + x.id, auth: 'Bearer sk_test' }], 'RevenueCat is told to forget the player');
  for (const t of ['owned', 'token_log', 'purchases']) assert.strictEqual(sql('SELECT count(*) AS n FROM ' + t + ' WHERE player = ' + who(x))[0].n, 0, t);
  console.log('shop: account deletion removes owned items, token log and purchases');
}

// the VIP subscription through RevenueCat's webhook and the app's own sync
async function vip(rc) {
  sql('DELETE FROM purchases');
  sql("DELETE FROM token_log WHERE ref LIKE 'rc:%' OR ref LIKE 'refund:%' OR ref LIKE 'reversed:%'");
  const M = 30 * DAY;
  const now = Date.now();
  const sub = (type, acc, tx, until, more) => hook(event(type, acc, VIP, tx, Object.assign({ expiration_at_ms: until }, more)));
  const me = acc => call('GET', '/api/me', acc).then(r => r.body);
  const wear = (acc, slot, item) => call('POST', '/api/shop/wear', acc, { slot: slot, item: item });
  const a = await guest();
  const u1 = now + M;
  const u2 = now + 2 * M;
  assert.strictEqual((await me(a)).vipUntil, 0);

  // a first month: the end date and 500 tokens, once, whichever of the webhook and sync comes first
  assert.strictEqual((await sub('INITIAL_PURCHASE', a, 'vtx-1', u1)).status, 200);
  let s = await shopOf(a);
  assert.deepStrictEqual([s.tokens, s.vipUntil, (await me(a)).vipUntil], [500, u1, u1]);
  await sub('INITIAL_PURCHASE', a, 'vtx-1', u1);
  rc.vip[a.id] = { expires_date: new Date(u1).toISOString(), store_transaction_id: 'vtx-1', is_sandbox: true };
  assert.deepStrictEqual([(await call('POST', '/api/shop/sync', a)).body.tokens, (await shopOf(a)).vipUntil], [500, u1], 'the same month from sync and the webhook counts once');
  assert.strictEqual(sql('SELECT count(*) AS n FROM token_log WHERE player = ' + who(a))[0].n, 1);

  // sync first, the webhook after
  const b = await guest();
  rc.vip[b.id] = { expires_date: new Date(u1).toISOString(), store_transaction_id: 'vtx-b', is_sandbox: false };
  s = (await call('POST', '/api/shop/sync', b)).body;
  assert.deepStrictEqual([s.tokens, s.vipUntil], [500, u1]);
  await sub('INITIAL_PURCHASE', b, 'vtx-b', u1);
  assert.strictEqual((await shopOf(b)).tokens, 500);
  assert.strictEqual(sql("SELECT env FROM purchases WHERE tx = 'vtx-b'")[0].env, 'PRODUCTION');
  // a subscriber without a transaction id gets the date, and the tokens come with the webhook
  const n = await guest();
  rc.vip[n.id] = { expires_date: new Date(u1 + 1234).toISOString() };
  s = (await call('POST', '/api/shop/sync', n)).body;
  assert.deepStrictEqual([s.tokens, s.vipUntil], [0, u1 + 1234]);

  // a renewal extends and pays again; an older event that arrives late neither cuts nor repeats it
  await sub('RENEWAL', a, 'vtx-2', u2);
  s = await shopOf(a);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [1000, u2]);
  await sub('INITIAL_PURCHASE', a, 'vtx-1', u1);
  await sub('UNCANCELLATION', a, 'vtx-1', u1);
  await sub('PRODUCT_CHANGE', a, 'vtx-1', u1);
  s = await shopOf(a);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [1000, u2], 'late events do not shorten VIP');
  await sub('RENEWAL', a, 'vtx-0', now + 1000);
  s = await shopOf(a);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [1500, u2], 'a month paid earlier is paid once, without moving the end back');
  await sub('EXPIRATION', a, 'vtx-1', u1);
  assert.strictEqual((await shopOf(a)).vipUntil, u2, 'the expiry of a month that was renewed changes nothing');
  await sub('CANCELLATION', a, 'vtx-2', u2, { cancel_reason: 'UNSUBSCRIBE' });
  assert.deepStrictEqual([(await shopOf(a)).vipUntil, (await shopOf(a)).tokens], [u2, 1500], 'cancelling just lets it run out');
  await hook(event('RENEWAL', { id: '0'.repeat(32) }, VIP, 'vtx-x', { expiration_at_ms: u2 }));
  await hook(event('NON_RENEWING_PURCHASE', a, VIP, 'vtx-y', { expiration_at_ms: u2 + M }));
  assert.strictEqual((await shopOf(a)).vipUntil, u2, 'unknown players and other event types change nothing');
  console.log('vip: first month, renewal, late events, sync and webhook count once');

  // items for subscribers
  s = await shopOf(a);
  for (const id of ['frame-gold', 'plate-vip', 'back-vip']) assert(s.owned.includes(id), id + ' comes with VIP');
  assert.strictEqual((await call('POST', '/api/shop/buy', a, { item: 'frame-gold' })).body.error, 'vip', 'VIP items are not for sale');
  for (const [slot, item] of [['frame', 'frame-gold'], ['plate', 'plate-vip'], ['back', 'back-vip']]) assert.strictEqual((await wear(a, slot, item)).status, 200, item);
  const gold = { frame: 'frame-gold', plate: 'plate-vip', back: 'back-vip' };
  assert.deepStrictEqual((await me(a)).wear, gold);
  const plain = await guest();
  assert.strictEqual((await wear(plain, 'frame', 'frame-gold')).status, 403, 'nobody else wears them');
  assert.strictEqual((await wear(plain, 'frame', 'frame-gold')).body.error, 'vip');
  assert.deepStrictEqual((await shopOf(plain)).owned, []);

  // seats and the card say vip as a boolean for everybody
  const g = await pair(3, 3, [a, plain]);
  const [sa, sp] = await begin(g);
  assert.deepStrictEqual([sa.players[0].vip, sa.players[1].vip, sp.players[0].vip, sp.players[2].vip], [true, false, false, true]);
  assert.deepStrictEqual(sp.players[2].wear, gold, 'the others see the VIP items');
  const card = async (by, acc) => (await call('GET', '/api/player/' + acc.id, by)).body;
  assert.deepStrictEqual([(await card(plain, a)).vip, (await card(a, plain)).vip, (await card(a, a)).vip], [true, false, true]);
  // a closed socket keeps the seat, and a started table holds its players; leaving frees them for the next table
  const closed = [g.a, g.b].map(c => new Promise(res => c.ws.on('close', res)));
  g.a.send({ t: 'leave' });
  g.b.send({ t: 'leave' });
  await within(Promise.all(closed), 5000, 'the leavers closing');

  // when it runs out the items come off everywhere, and come back with a new month
  sql('UPDATE players SET vip_until = ' + (Date.now() - 1000) + ' WHERE id = ' + who(a));
  s = await shopOf(a);
  assert.deepStrictEqual([s.vipUntil, s.worn, s.owned], [0, {}, []]);
  const lapsed = await me(a);
  assert.deepStrictEqual([lapsed.vipUntil, lapsed.wear], [0, {}]);
  assert.strictEqual((await wear(a, 'back', 'back-vip')).status, 403);
  assert.strictEqual((await card(plain, a)).vip, false);
  assert.deepStrictEqual((await card(plain, a)).wear, {});
  const g2 = await pair(3, 3, [a, plain]);
  const [sl] = await begin(g2);
  assert.deepStrictEqual([sl.players[0].vip, sl.players[0].wear], [false, {}], 'a lapsed player sits down without them');
  g2.a.ws.close();
  g2.b.ws.close();
  await sub('RENEWAL', a, 'vtx-3', Date.now() + M);
  assert.deepStrictEqual((await me(a)).wear, gold, 'what they chose is back with the next month');
  console.log('vip: items belong to the subscription, badge travels as a boolean');

  // a refund ends VIP now and takes its month back; the refund of an older month leaves a later one alone
  const c = await guest();
  const [c1, c2] = [now + 10 * DAY, now + 40 * DAY];
  await sub('INITIAL_PURCHASE', c, 'vtx-c1', c1);
  await sub('RENEWAL', c, 'vtx-c2', c2);
  assert.deepStrictEqual([(await shopOf(c)).tokens, (await shopOf(c)).vipUntil], [1000, c2]);
  await sub('CANCELLATION', c, 'vtx-c1', c1, { cancel_reason: 'CUSTOMER_SUPPORT' });
  s = await shopOf(c);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [500, c2], 'an older month refunded leaves the current one');
  sql('UPDATE players SET tokens = 100 WHERE id = ' + who(c));
  const t0 = Date.now();
  await sub('CANCELLATION', c, 'vtx-c2', c2, { cancel_reason: 'CUSTOMER_SUPPORT' });
  s = await shopOf(c);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [0, 0], 'the latest month refunded ends VIP and tokens stop at zero');
  const ended = sql('SELECT vip_until FROM players WHERE id = ' + who(c))[0].vip_until;
  assert(ended >= t0 - 5000 && ended <= Date.now(), 'VIP ended now: ' + (ended - t0));
  await sub('RENEWAL', c, 'vtx-c2', c2);
  await sub('CANCELLATION', c, 'vtx-c2', c2, { cancel_reason: 'CUSTOMER_SUPPORT' });
  assert.deepStrictEqual([(await shopOf(c)).tokens, (await shopOf(c)).vipUntil], [0, 0], 'a refunded month is not granted again');
  // refund first, purchase after
  const d = await guest();
  await sub('CANCELLATION', d, 'vtx-d', now + M, { cancel_reason: 'CUSTOMER_SUPPORT' });
  await sub('INITIAL_PURCHASE', d, 'vtx-d', now + M);
  assert.deepStrictEqual([(await shopOf(d)).tokens, (await shopOf(d)).vipUntil], [0, 0]);
  console.log('vip: a refund ends VIP and takes the month back');

  // expiry, and the billing grace period
  const e = await guest();
  const past = now - 1000;
  await sub('INITIAL_PURCHASE', e, 'vtx-e', past);
  assert.strictEqual((await shopOf(e)).vipUntil, 0, 'a month that is over gives no VIP');
  await sub('BILLING_ISSUE', e, 'vtx-e', past, { grace_period_expiration_at_ms: now + 5 * DAY });
  assert.strictEqual((await shopOf(e)).vipUntil, now + 5 * DAY, 'the grace period keeps VIP');
  await sub('BILLING_ISSUE', e, 'vtx-e', past, { grace_period_expiration_at_ms: null });
  assert.strictEqual((await shopOf(e)).vipUntil, now + 5 * DAY);
  await sub('EXPIRATION', e, 'vtx-e', past, { expiration_reason: 'BILLING_ERROR' });
  s = await shopOf(e);
  assert.deepStrictEqual([s.vipUntil, s.tokens], [0, 500], 'expiration ends it, the paid month keeps its tokens');
  rc.vip[e.id] = { expires_date: new Date(past).toISOString(), grace_period_expires_date: new Date(now + 2 * DAY).toISOString(), store_transaction_id: 'vtx-e', is_sandbox: true };
  sql('UPDATE players SET sync_at = 0 WHERE id = ' + who(e));
  assert.strictEqual((await call('POST', '/api/shop/sync', e)).body.vipUntil, now + 2 * DAY, 'sync honours a grace period');
  console.log('vip: expiration and grace period');

  // a refund ends VIP whatever date it carries: the stored end of the month decides, not the refund's own time
  const sum = acc => sql('SELECT coalesce(sum(delta), 0) AS n FROM token_log WHERE player = ' + who(acc))[0].n;
  const ends = async (name, more) => {
    const x = await guest();
    await sub('INITIAL_PURCHASE', x, 'vtx-r-' + name, now + M);
    assert.strictEqual((await shopOf(x)).vipUntil, now + M, name);
    await sub('CANCELLATION', x, 'vtx-r-' + name, now + M, Object.assign({ cancel_reason: 'CUSTOMER_SUPPORT' }, more));
    s = await shopOf(x);
    assert.deepStrictEqual([s.vipUntil, s.tokens], [0, 0], name + ' ends VIP now and takes the tokens');
  };
  await ends('time', { expiration_at_ms: Date.now() });
  await ends('absent', { expiration_at_ms: undefined });
  await ends('later', { expiration_at_ms: now + 90 * DAY });
  const r1 = await guest();
  await sub('INITIAL_PURCHASE', r1, 'vtx-q1', now + 10 * DAY);
  await sub('RENEWAL', r1, 'vtx-q2', now + 40 * DAY);
  await sub('CANCELLATION', r1, 'vtx-q1', Date.now(), { cancel_reason: 'CUSTOMER_SUPPORT' });
  assert.strictEqual((await shopOf(r1)).vipUntil, now + 40 * DAY, 'an older month refunded at the refund time leaves the current one');
  // an id that is not ours leaves nothing behind, for a month and for a pack
  for (const id of ['0'.repeat(32), 'not-an-id']) {
    await hook(event('CANCELLATION', { id: id }, VIP, 'vtx-ghost-' + id.length, { cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: now + M }));
    await hook(event('CANCELLATION', { id: id }, PACK(500), 'ptx-ghost-' + id.length, { cancel_reason: 'CUSTOMER_SUPPORT' }));
  }
  assert.strictEqual(sql("SELECT count(*) AS n FROM purchases WHERE tx LIKE '%ghost%'")[0].n, 0, 'a refund for an unknown id is not written down');
  // a refund that cannot take the tokens back after three tries is flagged for the admin page
  const stuck = await guest();
  await sub('INITIAL_PURCHASE', stuck, 'vtx-stuck', now + M);
  sql('CREATE TRIGGER stuck BEFORE UPDATE OF tokens ON players WHEN NEW.tokens < OLD.tokens AND OLD.id = ' + who(stuck) + ' BEGIN SELECT RAISE(IGNORE); END');
  try {
    await sub('CANCELLATION', stuck, 'vtx-stuck', now + M, { cancel_reason: 'CUSTOMER_SUPPORT' });
  } finally {
    sql('DROP TRIGGER stuck');
  }
  assert.deepStrictEqual(sql("SELECT kind, a, b, x FROM flags WHERE kind = 'refund' AND a = " + who(stuck)), [{ kind: 'refund', a: stuck.id, b: 'vtx-stuck', x: 500 }]);
  assert.strictEqual(sql("SELECT refunded FROM purchases WHERE tx = 'vtx-stuck'")[0].refunded, 0, 'not marked as refunded while the tokens are still there');
  console.log('vip: a refund ends VIP by the stored end, ignores unknown ids and flags what it cannot take back');

  // a purchase and its refund at the same moment never leave tokens or VIP behind, whichever lands first
  for (let i = 0; i < 12; i++) {
    const x = await guest();
    const [t, pt] = ['vtx-race-' + i, 'ptx-race-' + i];
    await Promise.all([sub('INITIAL_PURCHASE', x, t, now + M), hook(event('NON_RENEWING_PURCHASE', x, PACK(500), pt))]);
    await Promise.all([sub('CANCELLATION', x, t, now + M, { cancel_reason: 'CUSTOMER_SUPPORT' }), hook(event('CANCELLATION', x, PACK(500), pt, { cancel_reason: 'CUSTOMER_SUPPORT' }))]);
    s = await shopOf(x);
    assert.deepStrictEqual([s.tokens, s.vipUntil, sum(x)], [0, 0, 0], 'a settled pair, round ' + i);
    const y = await guest();
    const [u, pu] = ['vtx-racing-' + i, 'ptx-racing-' + i];
    await Promise.all([sub('CANCELLATION', y, u, now + M, { cancel_reason: 'CUSTOMER_SUPPORT' }), sub('INITIAL_PURCHASE', y, u, now + M),
      hook(event('CANCELLATION', y, PACK(500), pu, { cancel_reason: 'CUSTOMER_SUPPORT' })), hook(event('NON_RENEWING_PURCHASE', y, PACK(500), pu))]);
    s = await shopOf(y);
    assert.deepStrictEqual([s.tokens, s.vipUntil, sum(y)], [0, 0, 0], 'the same at once, round ' + i);
    assert.deepStrictEqual(sql("SELECT refunded FROM purchases WHERE tx IN ('" + u + "', '" + pu + "')").map(r => r.refunded), [1, 1]);
  }
  console.log('vip: a purchase racing its refund leaves nothing behind');

  // the other events: an extension, a reversed refund, and what is only acknowledged
  const x1 = await guest();
  const e1 = now + 5 * DAY;
  await sub('INITIAL_PURCHASE', x1, 'vtx-x1', e1);
  await sub('SUBSCRIPTION_EXTENDED', x1, 'vtx-x1', e1 + 7 * DAY);
  assert.strictEqual((await shopOf(x1)).vipUntil, e1 + 7 * DAY, 'an extension moves the end');
  await sub('SUBSCRIPTION_EXTENDED', x1, 'vtx-x1', e1);
  assert.strictEqual((await shopOf(x1)).vipUntil, e1 + 7 * DAY, 'and never back');
  await sub('CANCELLATION', x1, 'vtx-x1', e1, { cancel_reason: 'CUSTOMER_SUPPORT' });
  await hook(event('NON_RENEWING_PURCHASE', x1, PACK(80), 'ptx-x1'));
  await hook(event('CANCELLATION', x1, PACK(80), 'ptx-x1', { cancel_reason: 'CUSTOMER_SUPPORT' }));
  s = await shopOf(x1);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [0, 0]);
  await sub('REFUND_REVERSED', x1, 'vtx-x1', e1);
  await hook(event('REFUND_REVERSED', x1, PACK(80), 'ptx-x1'));
  s = await shopOf(x1);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [580, e1 + 7 * DAY], 'a reversed refund gives the month and its tokens back, and the pack');
  await sub('REFUND_REVERSED', x1, 'vtx-x1', e1);
  await hook(event('REFUND_REVERSED', x1, PACK(80), 'ptx-x1'));
  assert.deepStrictEqual([(await shopOf(x1)).tokens, sum(x1)], [580, 580], 'twice changes nothing');
  assert.strictEqual(sql("SELECT refunded FROM purchases WHERE tx = 'vtx-x1'")[0].refunded, 0);
  // refund first, reversed, then the purchase arrives: it counts
  const x2 = await guest();
  await sub('CANCELLATION', x2, 'vtx-x2', e1, { cancel_reason: 'CUSTOMER_SUPPORT' });
  await sub('REFUND_REVERSED', x2, 'vtx-x2', e1);
  await sub('INITIAL_PURCHASE', x2, 'vtx-x2', e1);
  s = await shopOf(x2);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [500, e1]);
  for (const type of ['TEST', 'SUBSCRIPTION_PAUSED', 'INVOICE_ISSUANCE', 'TEMPORARY_ENTITLEMENT_GRANT']) assert.strictEqual((await sub(type, x2, 'vtx-x2', e1 + DAY)).status, 200, type + ' is acknowledged');
  assert.deepStrictEqual([(await shopOf(x2)).tokens, (await shopOf(x2)).vipUntil], [500, e1], 'and changes nothing');
  console.log('vip: extension, reversed refund and events that are only acknowledged');

  // a trial or an offer gives access and no tokens; the renewal that is paid gives them, once
  const t1 = await guest();
  const trial = { period_type: 'TRIAL', price: 0, environment: 'PRODUCTION' };
  await sub('INITIAL_PURCHASE', t1, 'vtx-t1', now + 7 * DAY, trial);
  s = await shopOf(t1);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [0, now + 7 * DAY], 'a trial is VIP without tokens');
  assert.deepStrictEqual(sql("SELECT tokens, env FROM purchases WHERE tx = 'vtx-t1'"), [{ tokens: 0, env: 'PRODUCTION' }], 'it still has its purchase row');
  const paidRenewal = { period_type: 'NORMAL', price: 4.99, environment: 'PRODUCTION' };
  await sub('RENEWAL', t1, 'vtx-t2', now + 7 * DAY + M, paidRenewal);
  await sub('RENEWAL', t1, 'vtx-t2', now + 7 * DAY + M, paidRenewal);
  s = await shopOf(t1);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [500, now + 7 * DAY + M], 'the first paid month pays 500, once');
  const t2 = await guest();
  await sub('INITIAL_PURCHASE', t2, 'vtx-t3', now + M, { period_type: 'NORMAL', price: 0, environment: 'PRODUCTION' });
  await sub('RENEWAL', t2, 'vtx-t4', now + 2 * M, { period_type: 'INTRO', price: 0.99, environment: 'PRODUCTION' });
  await sub('RENEWAL', t2, 'vtx-t5', now + 3 * M, { period_type: 'NORMAL', price: 4.99, is_family_share: true, environment: 'PRODUCTION' });
  s = await shopOf(t2);
  assert.deepStrictEqual([s.tokens, s.vipUntil], [0, now + 3 * M], 'a price of 0, an intro period and a family share give no tokens');
  await sub('RENEWAL', t2, 'vtx-t6', now + 4 * M, { period_type: 'NORMAL', price: 0, environment: 'SANDBOX' });
  assert.strictEqual((await shopOf(t2)).tokens, 500, 'a sandbox month is paid whatever its price');
  const t3 = await guest();
  rc.vip[t3.id] = { expires_date: new Date(now + M).toISOString(), store_transaction_id: 'vtx-t7', is_sandbox: false, period_type: 'trial' };
  s = (await call('POST', '/api/shop/sync', t3)).body;
  assert.deepStrictEqual([s.tokens, s.vipUntil], [0, now + M], 'a trial found by sync is the same');
  console.log('vip: only paid periods pay tokens');

  // Restore on a second account moves VIP and leaves the tokens where they were paid
  const [m1, m2] = [await guest(), await guest()];
  const mu = now + 11 * DAY;
  rc.vip[m1.id] = { expires_date: new Date(mu).toISOString(), store_transaction_id: 'vtx-m1', is_sandbox: false };
  assert.strictEqual((await call('POST', '/api/shop/sync', m1)).body.tokens, 500);
  assert.strictEqual((await wear(m1, 'frame', 'frame-gold')).status, 200);
  delete rc.vip[m1.id];
  rc.vip[m2.id] = { expires_date: new Date(mu).toISOString(), store_transaction_id: 'vtx-m1', is_sandbox: false };
  s = (await call('POST', '/api/shop/sync', m2)).body;
  assert.deepStrictEqual([s.tokens, s.vipUntil], [0, mu], 'the account that restored has VIP and no tokens');
  s = await shopOf(m1);
  assert.deepStrictEqual([s.tokens, s.vipUntil, s.worn, (await me(m1)).wear], [500, 0, {}, {}], 'the first account keeps the tokens and loses VIP and its items');
  assert.strictEqual(sql("SELECT player FROM purchases WHERE tx = 'vtx-m1'")[0].player, m2.id);
  assert.strictEqual(sum(m1) + sum(m2), 500, 'the month paid tokens once');
  await sub('RENEWAL', m2, 'vtx-m1', mu);
  assert.strictEqual(sum(m1) + sum(m2), 500, 'and the webhook for it adds nothing');
  // and back again
  delete rc.vip[m2.id];
  rc.vip[m1.id] = { expires_date: new Date(mu).toISOString(), store_transaction_id: 'vtx-m1', is_sandbox: false };
  sql('UPDATE players SET sync_at = 0 WHERE id = ' + who(m1));
  s = (await call('POST', '/api/shop/sync', m1)).body;
  assert.deepStrictEqual([s.tokens, s.vipUntil, (await shopOf(m2)).vipUntil, (await shopOf(m2)).tokens], [500, mu, 0, 0], 'a move back');
  // an account that holds a later paid month keeps VIP when an earlier one leaves
  const [n1, n2] = [await guest(), await guest()];
  await sub('INITIAL_PURCHASE', n1, 'vtx-n1', now + 20 * DAY);
  await sub('RENEWAL', n1, 'vtx-n2', now + 50 * DAY);
  rc.vip[n2.id] = { expires_date: new Date(now + 20 * DAY).toISOString(), store_transaction_id: 'vtx-n1', is_sandbox: false };
  await call('POST', '/api/shop/sync', n2);
  assert.deepStrictEqual([(await shopOf(n1)).vipUntil, (await shopOf(n2)).vipUntil], [now + 50 * DAY, now + 20 * DAY]);
  // a sync that has no transaction id finds the month by its end date
  const [k1, k2] = [await guest(), await guest()];
  await sub('INITIAL_PURCHASE', k1, 'vtx-k1', now + 21 * DAY);
  rc.vip[k2.id] = { expires_date: new Date(now + 21 * DAY).toISOString() };
  s = (await call('POST', '/api/shop/sync', k2)).body;
  assert.deepStrictEqual([s.vipUntil, (await shopOf(k1)).vipUntil, s.tokens, (await shopOf(k1)).tokens], [now + 21 * DAY, 0, 0, 500]);
  // the transfer webhook: the accounts it comes from lose VIP, the one it goes to gets the months
  const [f1, f2, f3] = [await guest(), await guest(), await guest()];
  await sub('INITIAL_PURCHASE', f1, 'vtx-f1', now + 22 * DAY);
  await sub('INITIAL_PURCHASE', f2, 'vtx-f2', now + 23 * DAY);
  const transfer = (from, to) => hook({ api_version: '1.0', event: { type: 'TRANSFER', transferred_from: from, transferred_to: to, environment: 'SANDBOX' } });
  assert.strictEqual((await transfer([f1.id, f2.id, 'not-ours'], [f3.id])).status, 200);
  assert.deepStrictEqual([(await shopOf(f1)).vipUntil, (await shopOf(f2)).vipUntil, (await shopOf(f3)).vipUntil], [0, 0, now + 23 * DAY]);
  assert.deepStrictEqual([sum(f1), sum(f2), sum(f3)], [500, 500, 0], 'tokens stay with who paid');
  const f4 = await guest();
  await transfer([f3.id], ['$RCAnonymousID:abc']);
  await transfer([f4.id], [f3.id]);
  assert.strictEqual((await shopOf(f3)).vipUntil, 0, 'a transfer to an id that is not ours still ends VIP on the account it left');
  console.log('vip: a restore moves VIP and leaves the tokens, a transfer ends it where it came from');

  // the store country is kept on the purchase
  const cc = await guest();
  await sub('INITIAL_PURCHASE', cc, 'vtx-cc', now + M, { country_code: 'TR' });
  await hook(event('NON_RENEWING_PURCHASE', cc, PACK(80), 'ptx-cc', { country_code: 'tr' }));
  assert.deepStrictEqual(sql("SELECT tx, country FROM purchases WHERE tx IN ('vtx-cc', 'ptx-cc') ORDER BY tx"), [{ tx: 'ptx-cc', country: null }, { tx: 'vtx-cc', country: 'TR' }]);

  // deleting an account says whether a subscription was running, for clients that did not warn first
  const dv = await guest();
  await sub('INITIAL_PURCHASE', dv, 'vtx-del', now + M);
  assert.deepStrictEqual((await call('DELETE', '/api/me', dv)).body, { ok: true, vip: true });
  assert.deepStrictEqual((await call('DELETE', '/api/me', await guest())).body, { ok: true, vip: false });
}

// sandbox purchases are marked, and a wipe takes back only what they gave
async function sandbox() {
  const M = 30 * DAY;
  const now = Date.now();
  const prod = { environment: 'PRODUCTION' };
  const tokens = async acc => (await shopOf(acc)).tokens;
  const wipe = (body, ip) => adm('POST', 'wipe', ADMIN, body, ip);
  const sub = (type, acc, tx, until, more) => hook(event(type, acc, VIP, tx, Object.assign({ expiration_at_ms: until }, more)));
  const a = await guest();
  await hook(event('NON_RENEWING_PURCHASE', a, PACK(500), 'sbx-a1'));
  await hook(event('NON_RENEWING_PURCHASE', a, PACK(80), 'sbx-a2', prod));
  assert.deepStrictEqual(sql('SELECT ref, env FROM token_log WHERE player = ' + who(a) + ' ORDER BY id'), [{ ref: 'rc:sbx-a1', env: 'SANDBOX' }, { ref: 'rc:sbx-a2', env: 'PRODUCTION' }], 'each grant is marked with where it came from');
  assert.strictEqual(await tokens(a), 580, 'a sandbox purchase still credits');
  const bare = await wipe({ id: a.id });
  assert.deepStrictEqual([bare.status, bare.body.error], [400, 'confirm'], 'a wipe needs the confirmation');
  assert.strictEqual((await wipe({ id: '0'.repeat(32), confirm: true })).status, 404);
  assert.strictEqual((await wipe({ id: a.id, confirm: true })).status, 200);
  assert.strictEqual(await tokens(a), 80, 'only the sandbox part goes');
  assert.strictEqual((await wipe({ id: a.id, confirm: true })).status, 200);
  assert.strictEqual(await tokens(a), 80, 'a second wipe changes nothing');
  assert.deepStrictEqual(sql('SELECT delta, reason, ref FROM token_log WHERE player = ' + who(a) + " AND reason = 'wipe'"), [{ delta: -500, reason: 'wipe', ref: 'wipe:rc:sbx-a1' }]);
  assert.strictEqual(sql("SELECT count(*) AS n FROM admin_log WHERE action = 'wipe' AND target = " + who(a))[0].n, 1, 'and only the first is logged');

  // what the account spent is gone: the wipe takes what is left, and the items stay
  const b = await guest();
  await hook(event('NON_RENEWING_PURCHASE', b, PACK(500), 'sbx-b1'));
  assert.strictEqual((await call('POST', '/api/shop/buy', b, { item: 'frame-brass' })).status, 200);
  await wipe({ id: b.id, confirm: true });
  const sb = await shopOf(b);
  assert.deepStrictEqual([sb.tokens, sb.owned], [0, ['frame-brass']]);

  // a refunded sandbox purchase is not taken back twice
  const r = await guest();
  await hook(event('NON_RENEWING_PURCHASE', r, PACK(500), 'sbx-r1'));
  await hook(event('NON_RENEWING_PURCHASE', r, PACK(80), 'sbx-r2'));
  await hook(event('CANCELLATION', r, PACK(500), 'sbx-r1', { cancel_reason: 'CUSTOMER_SUPPORT' }));
  assert.strictEqual(await tokens(r), 80);
  await wipe({ id: r.id, confirm: true });
  assert.strictEqual(await tokens(r), 0);

  // VIP that only sandbox paid for ends, VIP with a production month in it stays
  const [v1, v2, v3] = [await guest(), await guest(), await guest()];
  await sub('INITIAL_PURCHASE', v1, 'sbx-v1', now + M);
  await sub('INITIAL_PURCHASE', v2, 'sbx-v2', now + M);
  await sub('RENEWAL', v2, 'sbx-v3', now + 2 * M, prod);
  await sub('INITIAL_PURCHASE', v3, 'sbx-v4', now + M, prod);
  assert.deepStrictEqual([(await shopOf(v1)).vipUntil, (await shopOf(v2)).vipUntil, (await shopOf(v3)).vipUntil], [now + M, now + 2 * M, now + M]);
  for (const x of [v1, v2, v3]) await wipe({ id: x.id, confirm: true });
  assert.deepStrictEqual([(await shopOf(v1)).vipUntil, (await shopOf(v2)).vipUntil, (await shopOf(v3)).vipUntil], [0, now + 2 * M, now + M]);
  assert.deepStrictEqual([await tokens(v1), await tokens(v2), await tokens(v3)], [0, 500, 500], 'a sandbox month loses its tokens, a production one keeps them');
  assert.strictEqual(sql('SELECT count(*) AS n FROM purchases WHERE player = ' + who(v1))[0].n, 1, 'the purchase row stays, so the month is not credited again');
  console.log('sandbox: grants are marked, a wipe takes the sandbox part once and leaves items and production months');

  // every sandbox account at once, except the ones kept
  const [w1, w2] = [await guest(), await guest()];
  await hook(event('NON_RENEWING_PURCHASE', w1, PACK(500), 'sbx-w1'));
  await hook(event('NON_RENEWING_PURCHASE', w2, PACK(500), 'sbx-w2'));
  assert.strictEqual((await wipe({ all: true })).status, 400, 'every account needs the confirmation too');
  const all = await wipe({ all: true, keep: [w2.id], confirm: true }, '10.9.0.5');
  assert.strictEqual(all.status, 200);
  assert(all.body.tokens >= 500 && all.body.accounts >= 1);
  assert.deepStrictEqual([await tokens(w1), await tokens(w2)], [0, 500]);
  assert.strictEqual((await wipe({ all: true, confirm: true }, '10.9.0.5')).body.tokens, 500, 'the kept account goes when it is chosen');
  assert.strictEqual(await tokens(w2), 0);
  console.log('sandbox: the wipe of every account skips the ones kept');
}

// where the player is and where the store charged
async function country() {
  const a = await guest();
  const chips = async (acc, c) => (await call('GET', '/api/shop', acc, undefined, undefined, c ? { 'X-Country': c } : {})).body.chips;
  const set = list => adm('POST', 'settings', ADMIN, { key: 'chipsoff', value: list }, '10.9.0.6');
  assert.strictEqual(await chips(a), true, 'chip packs are open by default');
  assert.strictEqual(sql('SELECT country FROM players WHERE id = ' + who(a))[0].country, null);
  assert.strictEqual(await chips(a, 'TR'), true, 'and open in Turkey until the list says otherwise');
  assert.strictEqual(sql('SELECT country FROM players WHERE id = ' + who(a))[0].country, 'TR', 'the country is taken from the call');
  assert.strictEqual((await set('TR')).status, 200);
  assert.strictEqual(await chips(a), false, 'the next call sees the list, with no restart');
  const b = await guest();
  assert.strictEqual(await chips(b, 'DE'), true, 'other countries are not affected');
  assert.strictEqual((await set('TR,DE')).status, 200);
  assert.deepStrictEqual([await chips(a), await chips(b)], [false, false]);
  assert.strictEqual((await set('')).status, 200);
  assert.deepStrictEqual([await chips(a), await chips(b)], [true, true], 'removing it opens the packs again');
  // the player cannot move it
  assert.strictEqual((await call('POST', '/api/region', a, { region: 'am' })).status, 200);
  assert.strictEqual((await call('POST', '/api/region', a, { region: 'eu', country: 'US' })).status, 200);
  assert.strictEqual(sql('SELECT country FROM players WHERE id = ' + who(a))[0].country, 'TR', 'POST /api/region leaves the country alone');
  // a code that is not a country is ignored, /api/me refreshes it as well, and it follows the player on the road
  for (const x of ['XX', 'tr1', '']) await call('GET', '/api/me', a, undefined, undefined, { 'X-Country': x });
  assert.strictEqual(sql('SELECT country FROM players WHERE id = ' + who(a))[0].country, 'TR');
  await call('GET', '/api/me', a, undefined, undefined, { 'X-Country': 'CA' });
  assert.strictEqual(sql('SELECT country FROM players WHERE id = ' + who(a))[0].country, 'CA');
  // a purchase the store already took is never refused by the switch
  assert.strictEqual((await set('CA')).status, 200);
  assert.strictEqual((await hook(event('NON_RENEWING_PURCHASE', a, PACK(500), 'cty-1', { country_code: 'CA' }))).status, 200);
  assert.deepStrictEqual([(await shopOf(a)).tokens, sql("SELECT country FROM purchases WHERE tx = 'cty-1'")[0].country], [500, 'CA'], 'the switch only closes the offer, and the store country is kept on the purchase');
  await set('');
  console.log('country: the list closes chip packs per country at once, the country follows the call and not the player');
}

// the day's earnings stop at the cap, and a new UTC day starts again
async function cap() {
  const acc = link(await guest());
  const day = Math.floor(Date.now() / DAY);
  const match = async () => {
    const c = client('/ws/new');
    await c.ready;
    c.send({ t: 'create', auth: acc.auth, players: 3, games: 3, stake: 100 });
    const done = played(c);
    await c.next(m => m.t === 'joined');
    c.send({ t: 'start' });
    await within(done, 120000, 'match');
    await sleep(500);
    const end = c.st;
    c.ws.close();
    return end;
  };
  sql('UPDATE players SET earn_day = ' + day + ', earned = 20 WHERE id = ' + who(acc));
  let end = await match();
  assert.strictEqual((await shopOf(acc)).tokens, 0, 'nothing more after 20 a day');
  assert.strictEqual(end.res.tok, undefined);
  sql('UPDATE players SET earn_day = ' + (day - 1) + ', earned = 20 WHERE id = ' + who(acc));
  end = await match();
  const s = await shopOf(acc);
  assert.deepStrictEqual([s.tokens, s.earned, end.res.tok], [2, 2, 2], 'a new day starts from zero');
  assert.deepStrictEqual(sql('SELECT delta, reason FROM token_log WHERE player = ' + who(acc)), [{ delta: 2, reason: 'match' }]);
  console.log('shop: 2 tokens a finished match, 20 a day');
}

async function dms() {
  const [a, b, c] = [await guest(), await guest(), await guest()];
  const dm = (from, to, text) => call('POST', '/api/dm', from, { to: to.id, text: text });
  const thread = (me, other, q) => call('GET', '/api/dm/' + other.id + (q || ''), me);
  assert.strictEqual((await call('POST', '/api/dm', null, { to: b.id, text: 'hi' })).status, 401);
  await befriend(a, b);
  assert.strictEqual((await call('POST', '/api/dm', a, { to: 'x', text: 'hi' })).status, 400);
  assert.strictEqual((await dm(a, b, '  \n ')).status, 400);
  assert.strictEqual((await dm(a, c, 'hi')).status, 403, 'a stranger cannot be messaged');
  assert.strictEqual((await dm(a, a, 'hi')).status, 403);
  assert.strictEqual((await dm(c, a, 'hi')).status, 403);
  assert.strictEqual((await thread(c, a)).status, 403, 'nor read');
  assert.strictEqual((await thread(a, c)).status, 403);
  assert.strictEqual((await call('GET', '/api/dm/' + b.id)).status, 401);

  const hb = await hub(b);
  const live = hb.next(m => m.t === 'dm');
  let r = await dm(a, b, '  hello\x00 there  ');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.message.mine, r.body.message.text], [true, 'hello there']);
  const e = await live;
  assert.deepStrictEqual([e.from, e.m.text, e.m.id], [a.id, 'hello there', r.body.message.id], 'the open app gets it through the hub');
  assert.strictEqual(e.seed, sql('SELECT name_seed FROM players WHERE id = ' + who(a))[0].name_seed);
  hb.ws.close();
  const link = { to: b.id, text: 'you sh1t, www.example.com' };
  const ask = await call('POST', '/api/dm', a, link);
  assert.deepStrictEqual([ask.status, ask.body], [409, { error: 'contact' }], 'contact details need a yes first');
  assert.strictEqual(sql('SELECT count(*) AS n FROM messages WHERE sender = ' + who(a))[0].n, 1, 'and are not stored before it');
  const yes = await call('POST', '/api/dm', a, Object.assign({ ok: true }, link));
  assert.deepStrictEqual([yes.status, yes.body.message.text, yes.body.message.c], [200, 'you ****, www.example.com', true]);
  await dm(b, a, 'back at you');
  const waiting = async acc => (await call('GET', '/api/friends', acc)).body.friends.map(x => [x.id, x.unread]);
  assert.deepStrictEqual(await waiting(b), [[a.id, 2]], 'the friends list carries the unread count');
  assert.deepStrictEqual(await waiting(a), [[b.id, 1]]);
  r = await thread(b, a);
  assert.deepStrictEqual(r.body.messages.map(m => [m.mine, m.text]), [[true, 'back at you'], [false, 'you ****, www.example.com'], [false, 'hello there']], 'newest first');
  assert.deepStrictEqual(r.body.messages.map(m => m.c), [false, true, false], 'the flag comes with the history');
  assert.strictEqual(r.body.more, false);
  assert.deepStrictEqual(await waiting(b), [[a.id, 0]], 'reading marks the conversation read');
  assert.deepStrictEqual(await waiting(a), [[b.id, 1]], 'the other side still has theirs');
  for (const bad of ['abc', '1e400', '-5', '1.5', '']) assert.strictEqual((await thread(b, a, '?before=' + bad)).status, 400, 'before=' + bad);
  console.log('dm: friends only, cleaned and filtered, live through the hub, unread counts, read on open');

  // 5 in a burst, then one every 3 seconds
  const spam = [];
  for (let i = 0; i < 8; i++) spam.push((await dm(a, b, 'n' + i)).status);
  assert(spam.every(s => s === 200 || s === 429) && spam[7] === 429 && spam.filter(s => s === 200).length <= 2, 'flooding is cut off: ' + spam);

  // pages of 50, newest first, the older ones asked for by id
  sql("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120) INSERT INTO messages (sender, recipient, text, at) SELECT " + who(b) + ", " + who(a) + ", 'old ' || i, 1000 + i FROM n");
  r = await thread(a, b);
  assert.strictEqual(r.body.messages.length, 50);
  assert.strictEqual(r.body.more, true);
  const last = r.body.messages[r.body.messages.length - 1].id;
  const next = await thread(a, b, '?before=' + last);
  assert.strictEqual(next.body.messages.length, 50);
  assert(next.body.messages.every(m => m.id < last));
  const rest = await thread(a, b, '?before=' + next.body.messages[49].id);
  assert(rest.body.messages.length > 0 && rest.body.messages.length <= 50);
  console.log('dm: flooding cut off, history in pages');

  // an ended friendship and a block both close the conversation
  await call('DELETE', '/api/friend/' + b.id, a);
  assert.strictEqual((await dm(b, a, 'still there?')).status, 403);
  assert.strictEqual((await thread(a, b)).status, 403);
  await befriend(a, b);
  await sleep(3100);
  assert.strictEqual((await dm(a, b, 'back')).status, 200);
  await call('POST', '/api/block/' + b.id, a);
  await sleep(3100);
  assert.strictEqual((await dm(a, b, 'x')).status, 403, 'the blocker cannot send either');
  assert.strictEqual((await dm(b, a, 'x')).status, 403, 'the blocked player gets the same answer as a stranger');
  await call('DELETE', '/api/block/' + b.id, a);
  console.log('dm: refused after unfriending and across a block');

  // account deletion takes the messages with it
  const n = id => sql('SELECT count(*) AS n FROM messages WHERE sender = ' + who(id) + ' OR recipient = ' + who(id))[0].n;
  assert(n(a) > 0);
  assert.strictEqual((await call('DELETE', '/api/me', a)).status, 200);
  assert.strictEqual(n(a), 0, 'a deleted account leaves no messages, sent or received');
  console.log('dm: account deletion removes messages');
}

async function purge() {
  const T = Date.UTC(2031, 5, 20, 3, 5);
  const [a, b] = [await guest(), await guest()];
  const add = (at, text) => sql("INSERT INTO messages (sender, recipient, text, at) VALUES (" + who(a) + ", " + who(b) + ", '" + text + "', " + at + ")");
  add(T - 31 * DAY, 'old');
  add(T - 29 * DAY, 'recent');
  await tick(T + 3600000);
  assert.strictEqual(sql('SELECT count(*) AS n FROM messages WHERE sender = ' + who(a) + " AND text = 'old'")[0].n, 1, 'the cleanup only runs at 03:00 UTC');
  await tick(T);
  assert.deepStrictEqual(sql('SELECT text FROM messages WHERE sender = ' + who(a)).map(m => m.text), ['recent'], 'messages older than 30 days are deleted');
  console.log('dm: the cron deletes messages after 30 days');
}

// Chip-trade phrases are recorded, never blocked: the label, the table or dm and the player, not the words.
async function trade() {
  const g = await pair(3, 3);
  const [sa, sb] = await begin(g);
  const seatA = sb.players.findIndex(p => p.pid === g.accA.id);
  const seatB = sa.players.findIndex(p => p.pid === g.accB.id);
  sql("UPDATE players SET lang = 'tr' WHERE id = " + who(g.accA));
  sql("UPDATE players SET lang = 'en' WHERE id = " + who(g.accB));
  const hits = acc => sql('SELECT ctx, term FROM trade_hits WHERE player = ' + who(acc) + ' ORDER BY id');
  const said = async (from, to, seat, lines) => {
    const got = [];
    to.handlers.push(m => { if (m.t === 'typed' && m.p === seat) got.push(m.x); });
    for (const x of lines) from.send({ t: 'text', x: x });
    await within((async () => { while (got.length < lines.length) await sleep(50); })(), 5000, 'lines arriving');
    return got;
  };

  const lines = ['çip satılık 100 tl', 'iban ver', 'papara var mı'];
  assert.deepStrictEqual(await said(g.a, g.b, seatA, lines), lines, 'the lines arrive as typed');
  assert.deepStrictEqual(hits(g.accA), [{ ctx: g.code, term: 'chip-sale tl' }, { ctx: g.code, term: 'iban' }, { ctx: g.code, term: 'papara' }]);
  const plain = ['merhaba nasılsın', 'tl', 'kaç çip kaldı?'];
  assert.deepStrictEqual(await said(g.b, g.a, seatB, plain), plain);
  assert.deepStrictEqual(hits(g.accB), [], 'ordinary lines and a lone tl record nothing');
  await sleep(2100);
  assert.deepStrictEqual(await said(g.b, g.a, seatB, ['selling chips']), ['selling chips']);
  assert.deepStrictEqual(hits(g.accB), [{ ctx: g.code, term: 'chip-sale' }], 'an English account is recorded too');
  assert.strictEqual(sql('SELECT count(*) AS n FROM trade_hits')[0].n >= 4, true);
  console.log('trade: table lines are recorded by phrase and delivered unchanged');

  await befriend(g.accA, g.accB);
  const r = await call('POST', '/api/dm', g.accA, { to: g.accB.id, text: 'iban ver' });
  assert.deepStrictEqual([r.status, r.body.message.text], [200, 'iban ver']);
  await within((async () => { while (hits(g.accA).length < 4) await sleep(50); })(), 5000, 'dm hit');
  assert.deepStrictEqual(hits(g.accA)[3], { ctx: 'dm', term: 'iban' });
  assert.strictEqual((await call('POST', '/api/dm', g.accA, { to: g.accB.id, text: 'iyi geceler' })).status, 200);
  await sleep(300);
  assert.strictEqual(hits(g.accA).length, 4);
  console.log('trade: private messages are recorded too');

  const list = (await adm('GET', 'trades', ADMIN)).body.trades;
  assert.deepStrictEqual(list.slice(0, 2).map(x => [x.player, x.term, x.n]), [[g.accA.id, 'iban', 4], [g.accB.id, 'chip-sale', 1]], 'newest first with a count per player');
  assert(list.every(x => !('text' in x)));
  assert((await adm('GET', 'overview', ADMIN)).body.trades.length >= 5);
  assert.strictEqual((await adm('GET', 'trades')).status, 401);
  console.log('trade: the admin list');

  const T = Date.UTC(2031, 5, 20, 3, 5);
  const add = at => sql("INSERT INTO trade_hits (player, ctx, term, at) VALUES (" + who(g.accB) + ", 'ZZZZ', 'iban', " + at + ")");
  add(T - 91 * DAY);
  add(T - 89 * DAY);
  await tick(T);
  assert.deepStrictEqual(sql("SELECT at FROM trade_hits WHERE ctx = 'ZZZZ'").map(x => x.at), [T - 89 * DAY], 'hits older than 90 days are purged');
  assert.strictEqual((await call('DELETE', '/api/me', g.accA)).status, 200);
  assert.strictEqual(hits(g.accA).length, 0, 'deleting the account removes its hits');
  assert(hits(g.accB).length > 0);
  console.log('trade: purge after 90 days and removal with the account');
}

async function typedOff() {
  const g = await pair(3, 3);
  const [sa, sb] = await begin(g);
  const seatA = sb.players.findIndex(p => p.pid === g.accA.id);
  const seatB = sa.players.findIndex(p => p.pid === g.accB.id);
  await befriend(g.accA, g.accB);
  assert.strictEqual((await call('POST', '/api/typed', g.accB, { typed: 'no' })).status, 400);
  assert.strictEqual((await call('GET', '/api/me', g.accB)).body.typed, true, 'on by default');
  const r = await call('POST', '/api/typed', g.accB, { typed: false });
  assert.strictEqual(r.body.typed, false);
  assert.strictEqual((await call('GET', '/api/me', g.accB)).body.typed, false);

  const dm = (from, to) => call('POST', '/api/dm', from, { to: to.id, text: 'hi' });
  assert.strictEqual((await dm(g.accA, g.accB)).status, 403, 'nobody can message a player who has typed chat off');
  const no = await dm(g.accB, g.accA);
  assert.deepStrictEqual([no.status, no.body.error], [403, 'typedoff'], 'and they cannot send');

  const heard = [];
  g.b.handlers.push(m => { if (m.t === 'typed') heard.push(m); });
  const own = g.a.next(m => m.t === 'typed' && m.p === 0);
  g.a.send({ t: 'text', x: 'anyone there' });
  await own;
  const err = g.b.next(m => m.t === 'error');
  g.b.send({ t: 'text', x: 'me too' });
  assert.strictEqual((await err).k, 'typedoff');
  const said = g.b.next(m => m.t === 'said' && m.p === seatA);
  g.a.send({ t: 'say', k: 'hello' });
  await said;
  g.b.send({ t: 'say', k: 'hello' });
  assert.strictEqual((await g.a.next(m => m.t === 'said' && m.p === seatB)).k, 'hello', 'phrases and emotes still work');
  await sleep(300);
  assert.deepStrictEqual(heard, [], 'a player with typed chat off hears none');
  await call('POST', '/api/typed', g.accB, { typed: true });
  const back = g.b.next(m => m.t === 'typed' && m.p === seatA);
  await sleep(2100);
  g.a.send({ t: 'text', x: 'welcome back' });
  assert.strictEqual((await back).x, 'welcome back');
  assert.strictEqual((await dm(g.accA, g.accB)).status, 200);
  console.log('typed chat off: no messages either way, none heard at the table, phrases still work');
  g.a.ws.close();
  g.b.ws.close();
}

// a guest that is a day old and has finished that many matches
async function agedGuest(games = 10) {
  const x = await guest();
  sql('UPDATE players SET created = created - ' + 2 * DAY + ', games = ' + games + ' WHERE id = ' + who(x));
  return x;
}

// the same, with a seat in that table's match record at the given time
async function mate(match, code, games, at) {
  const x = await agedGuest(games);
  sql("INSERT INTO match_seat (match, code, kind, stake, player, fake, seat, at) VALUES ('" + match + "', '" + code + "', 'friend', 100, " + who(x) + ', 0, 4, ' + (at || Date.now()) + ')');
  return x;
}

async function reports() {
  // a long match, so the table is still there after the many slow sql calls below
  const g = await pair(5, 5);
  const [sa, sb] = await begin(g);
  const seatB = sa.players.findIndex(p => p.pid === g.accB.id);
  await befriend(g.accA, g.accB);
  const match = sql("SELECT match FROM match_seat WHERE code = '" + g.code + "' AND player = " + who(g.accB))[0].match;
  const seated = (games, at) => mate(match, g.code, games, at);
  const rep = (from, to, o) => call('POST', '/api/report', from, Object.assign({ pid: to.id, text: 'rude words', ctx: g.code }, o));
  const rows = who => sql('SELECT reporter, reported, text, ctx, match, counts FROM reports WHERE reported = ' + who);
  const muted = acc => sql('SELECT mute_until FROM players WHERE id = ' + who(acc))[0].mute_until > Date.now();
  const u1 = await agedGuest();
  assert.strictEqual((await call('POST', '/api/report', null, { pid: g.accB.id, ctx: 'dm' })).status, 401);
  assert.strictEqual((await rep(u1, u1)).status, 400, 'not oneself');
  assert.strictEqual((await rep(u1, g.accB, { pid: 'x' })).status, 400);
  assert.strictEqual((await rep(u1, g.accB, { ctx: 'nowhere' })).status, 400);
  assert.strictEqual((await rep(u1, { id: '0'.repeat(32) })).status, 404);
  assert.strictEqual((await rep(u1, g.accB, { ctx: 'dm' })).status, 404, 'a private message has to exist');

  // someone who was never at the table is stored and counts nothing
  assert.strictEqual((await rep(u1, g.accB)).status, 200);
  assert.deepStrictEqual(rows(who(g.accB)), [{ reporter: u1.id, reported: g.accB.id, text: 'rude words', ctx: g.code, match: null, counts: 0 }]);
  const [u2, u3] = [await agedGuest(), await agedGuest()];
  assert.strictEqual((await rep(u2, g.accB, { text: 'x'.repeat(500) })).status, 200);
  assert.strictEqual((await rep(u3, g.accB)).status, 200);
  assert.strictEqual(rows(who(g.accB)).find(r => r.reporter === u2.id).text.length, 300, 'the text is cut');
  assert(rows(who(g.accB)).every(r => r.counts === 0));
  assert.strictEqual(muted(g.accB), false, 'three reporters who were never there do not mute');
  // one who was there a week ago is not there now
  const stale = await seated(10, Date.now() - 8 * DAY);
  assert.strictEqual((await rep(stale, g.accB)).status, 200);
  assert.strictEqual(rows(who(g.accB)).find(r => r.reporter === stale.id).counts, 0);
  // a profile report is stored but never counts, from anyone
  for (const x of [await seated(10), await seated(10), await seated(10)]) assert.strictEqual((await rep(x, g.accB, { ctx: 'profile', text: undefined })).status, 200);
  assert.strictEqual(rows(who(g.accB)).filter(r => r.ctx === 'profile').length, 3);
  assert(rows(who(g.accB)).filter(r => r.ctx === 'profile').every(r => r.counts === 0));
  assert.strictEqual(muted(g.accB), false, 'three profile reports do not mute');
  console.log('reports: stored with their context; strangers, old seats and profile reports count nothing');

  // table-mates with 10 finished matches count: three of them mute for a day
  sql("INSERT INTO reports (reporter, reported, text, ctx, at, counts) VALUES ('" + 'f'.repeat(32) + "', " + who(g.accB) + ", 'old', 'dm', " + (Date.now() - 8 * DAY) + ', 1)');
  assert.strictEqual(muted(g.accB), false, 'a report from outside the week does not count');
  const [s1, s2, s3, s4] = [await seated(10), await seated(9), await seated(10), await seated(10)];
  assert.strictEqual((await rep(s1, g.accB)).status, 200);
  assert.strictEqual((await rep(s1, g.accB)).status, 200);
  assert.deepStrictEqual(rows(who(g.accB)).find(r => r.reporter === s1.id), { reporter: s1.id, reported: g.accB.id, text: 'rude words', ctx: g.code, match: match, counts: 1 });
  assert.strictEqual((await rep(s2, g.accB)).status, 200);
  assert.strictEqual(rows(who(g.accB)).find(r => r.reporter === s2.id).counts, 0, 'under 10 finished matches counts nothing');
  const typing = g.b.next(m => m.t === 'typed' && m.p === 0);
  g.b.send({ t: 'text', x: 'still fine' });
  await typing;
  assert.strictEqual((await rep(s3, g.accB)).status, 200);
  assert.strictEqual(muted(g.accB), false, 'one reporter many times, two reporters and one who has played too little are not enough');
  assert.strictEqual((await rep(s4, g.accB)).status, 200);
  assert.strictEqual(muted(g.accB), true, 'three reporters who were there mute for a day');
  const left = sql('SELECT mute_until FROM players WHERE id = ' + who(g.accB))[0].mute_until - Date.now();
  assert(left > 23 * 3600000 && left <= DAY, 'for 24 hours');
  assert.strictEqual(sql("SELECT count(*) AS n FROM admin_log WHERE who = 'auto' AND action = 'mute' AND target = " + who(g.accB))[0].n, 1, 'the automatic mute is logged once');

  await sleep(2100);
  const heard = [];
  g.a.handlers.push(m => { if (m.t === 'typed' && m.p === seatB) heard.push(m); });
  const err = g.b.next(m => m.t === 'error');
  g.b.send({ t: 'text', x: 'let me in' });
  assert.strictEqual((await err).k, 'mute');
  const said = g.a.next(m => m.t === 'said' && m.p === seatB);
  g.b.send({ t: 'say', k: 'sorry' });
  assert.strictEqual((await said).k, 'sorry', 'phrases and emotes still work');
  const dm = await call('POST', '/api/dm', g.accB, { to: g.accA.id, text: 'hello' });
  assert.deepStrictEqual([dm.status, dm.body], [403, { error: 'mute' }], 'the sender is told only that they cannot type');
  assert.strictEqual((await call('POST', '/api/dm', g.accA, { to: g.accB.id, text: 'hello' })).status, 200, 'they can still be written to');
  await sleep(300);
  assert.deepStrictEqual(heard, []);
  sql('UPDATE players SET mute_until = ' + (Date.now() - 1000) + ' WHERE id = ' + who(g.accB));
  const back = g.a.next(m => m.t === 'typed' && m.p === seatB);
  g.b.send({ t: 'text', x: 'thanks' });
  assert.strictEqual((await back).x, 'thanks', 'typing works again once the day is over');
  console.log('reports: three table-mates with 10 matches mute typed chat for a day, phrases and emotes still work');

  // a private message is read back from the conversation; it counts for a recipient with 10 matches
  sql('UPDATE players SET games = 10 WHERE id = ' + who(g.accA));
  const sent = await call('POST', '/api/dm', g.accB, { to: g.accA.id, text: 'nasty one' });
  const mid = sent.body.message.id;
  assert.strictEqual((await rep(g.accA, g.accB, { ctx: 'dm', mid: mid, text: 'made up' })).status, 200);
  const dmRow = rows(who(g.accB)).filter(r => r.ctx === 'dm' && r.reporter === g.accA.id)[0];
  assert.deepStrictEqual([dmRow.text, dmRow.counts, dmRow.match], ['nasty one', 1, null], 'the stored text is the real one');
  assert.strictEqual((await rep(u1, g.accB, { ctx: 'dm', mid: mid })).status, 404, 'only the recipient can report it');
  assert.strictEqual((await rep(g.accB, g.accA, { ctx: 'dm', mid: mid })).status, 404);
  sql('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) INSERT INTO reports (reporter, reported, text, ctx, at) SELECT ' + who(u1) + ", 'a', 'x', 'dm', " + Date.now() + ' FROM n');
  assert.strictEqual((await rep(u1, g.accA)).status, 429, 'at most 20 reports a day');
  console.log('reports: private messages read back from the conversation, 20 a day');

  // a computer player is reported like a person: same answer, stored, and nobody is muted
  const bot = sql("SELECT player FROM match_seat WHERE code = '" + g.code + "' AND fake = 1")[0].player;
  const [c1, c2, c3] = [await seated(10), await seated(10), await seated(10)];
  const human = await rep(c1, g.accB, { ctx: 'profile' });
  const comp = await rep(c2, { id: bot }, { ctx: 'profile' });
  assert.deepStrictEqual([comp.status, comp.body], [human.status, human.body], 'the same answer for a person and a computer player');
  assert.strictEqual((await rep(c1, { id: bot })).status, 200);
  assert.strictEqual((await rep(c2, { id: bot })).status, 200);
  assert.strictEqual((await rep(c3, { id: bot })).status, 200);
  assert.deepStrictEqual(sql("SELECT counts FROM reports WHERE reported = '" + bot + "'").map(r => r.counts), [0, 0, 0, 0], 'stored, counting nothing');
  assert.strictEqual(sql("SELECT count(*) AS n FROM admin_log WHERE action = 'mute' AND target = '" + bot + "'")[0].n, 0);
  console.log('reports: a computer player gets the same answer and is never muted');

  // new accounts do not count, and reports from before the last mute are spent
  for (const y of [await guest(), await guest(), await guest()]) {
    sql('UPDATE players SET games = 10 WHERE id = ' + who(y));
    sql("INSERT INTO match_seat (match, code, kind, stake, player, fake, seat, at) VALUES ('" + match + "', '" + g.code + "', 'friend', 100, " + who(y) + ', 0, 4, ' + Date.now() + ')');
    assert.strictEqual((await rep(y, g.accA)).status, 200);
  }
  assert.strictEqual(muted(g.accA), false, 'three accounts under a day old do not mute');
  assert.strictEqual((await rep(await seated(10), g.accB)).status, 200);
  assert.strictEqual(muted(g.accB), false, 'the reports before the last mute are not counted again');
  assert.strictEqual((await rep(await seated(10), g.accB)).status, 200);
  assert.strictEqual(muted(g.accB), false);
  assert.strictEqual((await rep(await seated(10), g.accB)).status, 200);
  assert.strictEqual(muted(g.accB), true, 'three new reporters after the mute ended mute again');
  console.log('reports: only accounts a day old count, and only reports since the last mute');

  // 180 days, and a deleted account takes the reports it made and the reports about it along
  const n = id => sql('SELECT count(*) AS n FROM reports WHERE reporter = ' + who(id))[0].n;
  const about = () => sql('SELECT count(*) AS n FROM reports WHERE reported = ' + who(g.accB))[0].n;
  const before = about();
  assert(n(s3) > 0);
  assert.strictEqual((await call('DELETE', '/api/me', s3)).status, 200);
  assert.strictEqual(n(s3), 0, 'a deleted account leaves no reports it made');
  assert.strictEqual(about(), before - 1, 'reports about someone else stay');
  const target = await agedGuest();
  assert.strictEqual((await rep(await agedGuest(), target, { ctx: 'profile' })).status, 200);
  assert.strictEqual(sql('SELECT count(*) AS n FROM reports WHERE reported = ' + who(target))[0].n, 1);
  assert.strictEqual((await call('DELETE', '/api/me', target)).status, 200);
  assert.strictEqual(sql('SELECT count(*) AS n FROM reports WHERE reported = ' + who(target))[0].n, 0, 'reports about a deleted account go with it');
  const T = Date.UTC(2031, 6, 20, 3, 5);
  sql("INSERT INTO reports (reporter, reported, text, ctx, at) VALUES ('p', 'q', 'ancient', 'dm', " + (T - 181 * DAY) + "), ('p', 'q', 'kept', 'dm', " + (T - 179 * DAY) + ')');
  await tick(T);
  assert.deepStrictEqual(sql("SELECT text FROM reports WHERE reporter = 'p'").map(r => r.text), ['kept'], 'reports are purged after 180 days');
  console.log('reports: purged after 180 days, removed with the reporter and the reported');
  g.a.ws.close();
  g.b.ws.close();
}

// the stand-in for Resend: it keeps what it is sent, and while down it hangs up
function fakeResend() {
  const f = { got: [], down: false };
  f.server = fake('resend', port('RESEND', 8798), (req, res) => new Promise(ok => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      if (f.down) req.socket.destroy();
      else {
        f.got.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(b) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"mail"}');
      }
      ok();
    });
  }));
  return f;
}

async function reportMail(rs) {
  const waitFor = async n => {
    for (let i = 0; i < 100 && rs.got.length < n; i++) await sleep(100);
    assert.strictEqual(rs.got.length, n, 'mails: ' + JSON.stringify(rs.got.map(x => x.body.subject)));
  };
  // nothing more arrives while the Worker would be sending
  const quiet = async n => {
    await sleep(800);
    assert.strictEqual(rs.got.length, n, 'no more mail: ' + JSON.stringify(rs.got.map(x => x.body.subject)));
  };
  const code = 'MAIL';
  sql('DELETE FROM mail_log');
  rs.got.length = 0;
  const [a, b] = [await agedGuest(), await guest()];
  const rep = (from, to, o) => call('POST', '/api/report', from, Object.assign({ pid: to.id, text: 'rude words', ctx: 'profile' }, o));

  // one report, one mail with what Aytu needs to find it
  assert.strictEqual((await rep(a, b)).status, 200);
  await waitFor(1);
  const id = sql('SELECT id FROM reports WHERE reporter = ' + who(a))[0].id;
  const m = rs.got[0];
  assert.deepStrictEqual([m.method, m.url, m.auth], ['POST', '/emails', 'Bearer test-resend-key']);
  assert.deepStrictEqual([m.body.from, m.body.to], ['Amerikano reports <reports@alazy.app>', ['support@alazy.app']]);
  for (const part of ['Report ' + id, 'Context profile', 'Reporter ' + a.id, 'Reported ' + b.id, 'Counted no', 'rude words', http + '/admin']) assert(m.body.text.includes(part), part + ' in ' + m.body.text);
  assert.strictEqual(sql('SELECT sent > 0 AS sent FROM mail_log')[0].sent, 1);
  assert.strictEqual(sql('SELECT body FROM mail_log')[0].body, '', 'a sent mail keeps no text');
  console.log('reportMail: a report sends one mail with its ids, context, text and the admin link');

  // the mute sends a second one
  const seats = ["('m-mail', '" + code + "', 'friend', 100, " + who(b) + ', 0, 0, ' + Date.now() + ')'];
  const mates = [];
  for (let i = 0; i < 3; i++) {
    const x = await agedGuest();
    mates.push(x);
    seats.push("('m-mail', '" + code + "', 'friend', 100, " + who(x) + ', 0, ' + (i + 1) + ', ' + Date.now() + ')');
  }
  sql('INSERT INTO match_seat (match, code, kind, stake, player, fake, seat, at) VALUES ' + seats.join(', '));
  for (const x of mates) assert.strictEqual((await rep(x, b, { ctx: code })).status, 200);
  await waitFor(1 + 3 + 1);
  const muteMail = rs.got.find(x => x.body.subject === 'Muted ' + b.id);
  assert(muteMail, rs.got.map(x => x.body.subject).join(' | '));
  assert(muteMail.body.text.includes('3 reports'));
  await quiet(5);
  console.log('reportMail: the automatic mute sends a second mail');

  // an unreachable Resend does not fail the report, and the mail waits for the digest
  rs.down = true;
  const c = await guest();
  assert.strictEqual((await rep(a, c, { text: 'while down' })).status, 200);
  await sleep(800);
  rs.down = false;
  assert.strictEqual(rs.got.length, 5, 'nothing got through');
  assert.strictEqual(sql('SELECT count(*) AS n FROM reports WHERE reported = ' + who(c))[0].n, 1, 'the report is stored');
  assert.strictEqual(sql('SELECT count(*) AS n FROM mail_log WHERE sent = 0')[0].n, 1, 'the mail is kept');

  // the 20th mail in an hour still goes, the 21st is held for the digest
  const inHour = () => sql('SELECT count(*) AS n FROM mail_log WHERE sent > ' + (Date.now() - 3600000))[0].n;
  const fill = 19 - inHour();
  sql('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ' + fill + ') INSERT INTO mail_log (at, kind, report, subject, body, sent) SELECT ' + Date.now() + ", 'report', 0, 'filler', '', " + Date.now() + ' FROM n');
  assert.strictEqual(inHour(), 19);
  const last = await guest();
  assert.strictEqual((await rep(a, last, { text: 'twentieth' })).status, 200);
  await waitFor(6);
  const d = await guest();
  assert.strictEqual((await rep(a, d, { text: 'over the limit' })).status, 200);
  await quiet(6);
  assert.strictEqual(sql('SELECT count(*) AS n FROM mail_log WHERE sent = 0')[0].n, 2, 'both are held');
  const T = Date.UTC(2031, 6, 20, 5, 0);
  await tick(T);
  await waitFor(7);
  const digest = rs.got[6].body;
  assert(/2 held report mails/.test(digest.subject), digest.subject);
  for (const part of ['while down', 'over the limit']) assert(digest.text.includes(part), part);
  assert.strictEqual(sql('SELECT count(*) AS n FROM mail_log WHERE sent = 0')[0].n, 0);
  assert.strictEqual(sql("SELECT count(*) AS n FROM mail_log WHERE body <> ''")[0].n, 0, 'sent mails keep no text');
  assert.strictEqual(sql('SELECT count(*) AS n FROM mail_log WHERE sent > ' + (T - 3600000))[0].n, 1, 'the digest counts as one mail');
  await tick(T + 3600000);
  await quiet(7);
  console.log('reportMail: an unreachable Resend does not fail the report, the 21st mail in an hour is held and goes out in the digest');

  // without a key nothing is sent or kept
  const { mail } = await import('../src/mail.js');
  const kept = sql('SELECT count(*) AS n FROM mail_log')[0].n;
  await mail({}, 'report', 1, 'no key', 'text');
  await quiet(7);
  assert.strictEqual(sql('SELECT count(*) AS n FROM mail_log')[0].n, kept);
  sql('DELETE FROM mail_log');
  console.log('reportMail: no key, no mail');
}

async function push() {
  const vars = Object.fromEntries(fs.readFileSync(process.env.DEV_VARS || __dirname + '/dev.vars', 'utf8').split(/\r?\n/).filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const apnsPub = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.from(vars.APNS_KEY, 'base64'), format: 'der', type: 'pkcs8' }));
  const sa = JSON.parse(vars.FCM_KEY.slice(1, -1));
  const fcmPub = crypto.createPublicKey(sa.private_key);
  const f = fakePush();
  await f.ready;
  sql('DELETE FROM devices');
  const name = (acc, lang) => Names.text(sql('SELECT name_seed FROM players WHERE id = ' + who(acc))[0].name_seed, lang);
  const to = (list, token) => list.filter(r => r.token === token);
  const seen = [];

  // registering, refreshing and removing a device
  const a = await guest();
  const b = await guest();
  assert.strictEqual((await call('POST', '/api/device', null, { kind: 'fcm', token: fcmTok(), lang: 'en', tz: 0 })).status, 401);
  for (const bad of [{ kind: 'web', token: fcmTok() }, { kind: 'apns', token: 'xyz' }, { kind: 'apns', token: fcmTok() }, { kind: 'fcm', token: 'a/b' + 'x'.repeat(30) },
    { kind: 'fcm', token: fcmTok(), tz: 900 }, { kind: 'fcm', token: fcmTok(), tz: 1.5 }, { kind: 'fcm', token: 5 }]) {
    assert.strictEqual((await call('POST', '/api/device', a, Object.assign({ tz: 0, lang: 'en' }, bad))).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual(devs(a).length, 0);
  const t1 = hexTok();
  let r = await reg(a, 'apns', t1.toUpperCase(), 'tr', 180);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.push, { on: true, invite: true, daily: true, friend: true, week: true, dm: true });
  let d = devs(a);
  assert.deepStrictEqual([d.length, d[0].token, d[0].kind, d[0].lang, d[0].tz, d[0].sandbox, d[0].created === d[0].seen], [1, t1, 'apns', 'tr', 180, 0, true], 'an APNs token is kept in lower case');
  await sleep(20);
  await reg(a, 'apns', t1, 'es', 0);
  assert.strictEqual(devs(a)[0].lang, 'es', 'a language with push texts is kept');
  await sleep(20);
  await reg(a, 'apns', t1, 'sv', -300);
  d = devs(a);
  assert.deepStrictEqual([d.length, d[0].lang, d[0].tz, d[0].seen > d[0].created], [1, 'en', -300, true], 'a refresh updates the row, an unknown language falls back to English');
  const t2 = fcmTok();
  await reg(a, 'fcm', t2, 'tr', 60);
  assert.strictEqual(devs(a).length, 2);
  await reg(b, 'fcm', t2, 'en', 0);
  assert.deepStrictEqual([devs(a).length, devs(b).length], [1, 1], 'a token that signs in as another account moves to it');
  await call('DELETE', '/api/device', a, { token: t2 });
  assert.strictEqual(devs(b).length, 1, 'only the owner can remove a token');
  assert.strictEqual((await call('DELETE', '/api/device', b, { token: t2 })).status, 200);
  assert.strictEqual(devs(b).length, 0);
  assert.strictEqual((await call('DELETE', '/api/device', a, { token: t1.toUpperCase() })).status, 200);
  assert.strictEqual(devs(a).length, 0);
  const many = await guest();
  for (let i = 0; i < 12; i++) await reg(many, 'fcm', fcmTok());
  assert.strictEqual(devs(many).length, 10, 'a player keeps at most 10 devices');
  console.log('push: devices registered, refreshed, moved, removed and capped');

  // preferences
  assert.strictEqual((await call('POST', '/api/push', a, {})).status, 400);
  assert.strictEqual((await call('POST', '/api/push', a, { invite: 'no' })).status, 400);
  r = await call('POST', '/api/push', a, { invite: false, week: false, other: true });
  assert.deepStrictEqual(r.body.push, { on: true, invite: false, daily: true, friend: true, week: false, dm: true });
  assert.deepStrictEqual((await call('GET', '/api/me', a)).body.push, r.body.push);
  r = await call('POST', '/api/push', a, { on: false, invite: true });
  assert.deepStrictEqual(r.body.push, { on: false, invite: true, daily: true, friend: true, week: false, dm: true });
  console.log('push: preferences read and updated');

  // an invite pushes only to a friend whose app is closed
  const g = await pair(3, 3);
  const [f1, f2, fo, fx, fb] = [await guest(), await guest(), await guest(), await guest(), await guest()];
  link(f1, f2, fo, fx, fb);
  for (const x of [f1, f2, fo, fb]) await befriend(g.accA, x);
  const k1 = hexTok();
  const k2 = fcmTok();
  await reg(f1, 'apns', k1, 'en', noonTz());
  await reg(f2, 'fcm', k2, 'tr', noonTz());
  await reg(fo, 'apns', hexTok(), 'en', noonTz());
  await reg(fx, 'apns', hexTok(), 'en', noonTz());
  await reg(fb, 'apns', hexTok(), 'en', noonTz());
  const invite = async x => {
    const ack = g.a.next(m => m.t === 'sent');
    g.a.send({ t: 'invite', to: x.id });
    return (await ack).ok;
  };
  const host = name(g.accA, 'en');
  const hostTr = name(g.accA, 'tr');
  f.clear();
  assert.strictEqual(await invite(f1), false, 'the answer for a friend with the app closed does not say whether a push went out');
  await settle(() => to(f.apns, k1).length);
  const q = to(f.apns, k1);
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].url, '/3/device/' + k1);
  assert.strictEqual(q[0].headers['apns-topic'], 'com.aytutuna.amerikano');
  assert.strictEqual(q[0].headers['apns-push-type'], 'alert');
  const jw = jwtOk(q[0].headers.authorization.replace('bearer ', ''), apnsPub, 'ES256', 'ec');
  assert.deepStrictEqual([jw.head.kid, jw.claims.iss], ['testkid', '8XT2U634Z4']);
  assert(Date.now() / 1000 - jw.claims.iat < 3100, 'the JWT is at most about 50 minutes old');
  assert.deepStrictEqual(q[0].body, { aps: { alert: { title: 'Table invite', body: host + ' invited you to a table.' }, sound: 'default' }, t: 'invite', code: g.code });
  const life = q[0].headers['apns-expiration'] - Date.now() / 1000;
  assert(life <= 600 && life > 500, 'an invite goes stale after 10 minutes');
  assert.strictEqual(await invite(f1), false);
  await sleep(400);
  assert.strictEqual(to(f.apns, k1).length, 1, 'the table does not ask again within its own gap');
  assert.strictEqual(await invite(f2), false);
  await settle(() => to(f.fcm, k2).length);
  const fm = to(f.fcm, k2);
  assert.strictEqual(fm.length, 1);
  assert.strictEqual(fm[0].url, '/v1/projects/amerikano-514707/messages:send');
  assert.deepStrictEqual(fm[0].message, { token: k2, notification: { title: 'Masa daveti', body: hostTr + ' seni bir masaya davet etti.' }, data: { t: 'invite', code: g.code }, android: { priority: 'HIGH', ttl: '600s' } });
  assert(/^at-/.test(fm[0].bearer), 'FCM got the bearer the token endpoint issued');
  seen.push(...f.apns, ...f.fcm);

  await sleep(5200);
  f.clear();
  assert.strictEqual(await invite(f1), false);
  await sleep(400);
  assert.strictEqual(f.apns.length, 0, 'the same pair gets one push in ten minutes');
  assert.strictEqual(sql("SELECT count(*) AS n FROM push_log WHERE kind = 'invite' AND sender = " + who(g.accA) + ' AND target = ' + who(f1))[0].n, 1, 'the gap is kept in the database');
  sql("UPDATE push_log SET at = at - 660000 WHERE kind = 'invite' AND target = " + who(f1));
  assert.strictEqual(await invite(f1), false);
  await settle(() => f.apns.length);
  assert.strictEqual(to(f.apns, k1).length, 1, 'ten minutes later the same pair is pushed again');
  f.clear();

  const ho = await hub(fo);
  const got = ho.next(m => m.t === 'invited');
  await sleep(2100);
  assert.strictEqual(await invite(fo), true);
  assert.strictEqual((await got).code, g.code);
  assert.strictEqual(f.apns.length, 0, 'an app that is open gets the socket message and no push');
  g.a.ws.close();
  g.b.ws.close();
  ho.ws.close();

  const g2 = await pair(3, 3);
  const [fp, fm2] = [await guest(), await guest()];
  for (const x of [fp, fm2, fb]) await befriend(g2.accA, x);
  await reg(fp, 'apns', hexTok(), 'en', noonTz());
  await reg(fm2, 'apns', hexTok(), 'en', noonTz());
  await call('POST', '/api/push', fp, { invite: false });
  await call('POST', '/api/push', fm2, { on: false });
  await call('POST', '/api/block/' + fb.id, g2.accA);
  f.clear();
  for (const x of [fp, fm2, fx]) {
    const ack = g2.a.next(m => m.t === 'sent');
    g2.a.send({ t: 'invite', to: x.id });
    assert.strictEqual((await ack).ok, false);
  }
  await sleep(4100);
  const ack = g2.a.next(m => m.t === 'sent');
  g2.a.send({ t: 'invite', to: fb.id });
  assert.strictEqual((await ack).ok, false);
  assert.strictEqual(f.apns.length, 0, 'a switched off kind, the master switch, a stranger and a blocked friend all get nothing');
  g2.a.ws.close();
  g2.b.ws.close();
  console.log('push: invites go to offline friends only, once per pair, in the device language');

  // friend requests and accepts
  const [x, y, z] = [await guest(), await guest(), await guest()];
  const ky = fcmTok();
  const kx = hexTok();
  await reg(y, 'fcm', ky, 'tr', 0);
  await reg(x, 'apns', kx, 'en', 0);
  f.clear();
  assert.strictEqual((await call('POST', '/api/friend', x, { id: y.id })).status, 200);
  await settle(() => to(f.fcm, ky).length);
  assert.deepStrictEqual(to(f.fcm, ky).map(m => [m.message.notification, m.message.data]), [[{ title: 'Arkadaşlık isteği', body: name(x, 'tr') + ' seninle arkadaş olmak istiyor.' }, { t: 'friend' }]]);
  await call('POST', '/api/friend', x, { id: y.id });
  await sleep(400);
  assert.strictEqual(f.fcm.length, 1, 'asking twice pushes once');
  await call('POST', '/api/friend', y, { id: x.id });
  await settle(() => to(f.apns, kx).length);
  assert.deepStrictEqual(to(f.apns, kx).map(m => m.body), [{ aps: { alert: { title: 'New friend', body: name(y, 'en') + ' accepted your friend request.' }, sound: 'default' }, t: 'friend' }]);
  await call('DELETE', '/api/friend/' + y.id, x);
  f.clear();
  await call('POST', '/api/friend', x, { id: y.id });
  await sleep(400);
  assert.strictEqual(f.fcm.length, 0, 'request, cancel and request again pushes once');
  sql("UPDATE push_log SET at = at - 3600000 WHERE kind = 'req' AND sender = " + who(x));
  await call('DELETE', '/api/friend/' + y.id, x);
  await call('POST', '/api/friend', x, { id: y.id });
  await sleep(400);
  assert.strictEqual(f.fcm.length, 0, 'an hour later is still the same day');
  sql("UPDATE push_log SET at = at - 90000000 WHERE kind = 'req' AND sender = " + who(x));
  await call('DELETE', '/api/friend/' + y.id, x);
  await call('POST', '/api/friend', x, { id: y.id });
  await settle(() => f.fcm.length);
  assert.strictEqual(f.fcm.length, 1, 'a day later the pair is pushed again');
  f.clear();
  await call('DELETE', '/api/friend/' + y.id, x);
  await call('POST', '/api/block/' + x.id, y);
  assert.strictEqual((await call('POST', '/api/friend', x, { id: y.id })).status, 200);
  await sleep(400);
  assert.strictEqual(f.fcm.length, 0, 'a blocked player cannot make the blocker\'s phone ring');
  await call('DELETE', '/api/block/' + x.id, y);
  const hz = await hub(z);
  await reg(z, 'apns', hexTok(), 'en', 0);
  await call('POST', '/api/friend', x, { id: z.id });
  await sleep(400);
  assert.strictEqual(f.apns.length, 0, 'a player with the app open is not pushed');
  hz.ws.close();
  await sleep(200);
  await call('POST', '/api/push', z, { friend: false });
  await call('POST', '/api/friend', await guest(), { id: z.id });
  await sleep(400);
  assert.strictEqual(f.apns.length, 0, 'the friend switch stops requests when the app is closed');
  console.log('push: friend requests and accepts, once a day per pair, blocks, open app, switch');

  // a message pushes to a friend whose app is closed, once per ten minutes
  const [m1, m2] = [await guest(), await guest()];
  await befriend(m1, m2);
  const km = fcmTok();
  await reg(m2, 'fcm', km, 'tr', noonTz());
  f.clear();
  assert.strictEqual((await call('POST', '/api/dm', m1, { to: m2.id, text: 'selam' })).status, 200);
  await settle(() => to(f.fcm, km).length);
  assert.deepStrictEqual(to(f.fcm, km).map(m => [m.message.notification, m.message.data]), [[{ title: 'Yeni mesaj', body: name(m1, 'tr') + ' sana bir mesaj gönderdi.' }, { t: 'dm' }]], 'the push never carries the text');
  await call('POST', '/api/dm', m1, { to: m2.id, text: 'again' });
  await sleep(400);
  assert.strictEqual(f.fcm.length, 1, 'one push per pair in ten minutes');
  sql("DELETE FROM push_log WHERE kind = 'dm'");
  await call('POST', '/api/push', m2, { dm: false });
  await call('POST', '/api/dm', m1, { to: m2.id, text: 'third' });
  await sleep(400);
  assert.strictEqual(f.fcm.length, 1, 'the messages switch stops it');
  await call('POST', '/api/push', m2, { dm: true });
  const hm = await hub(m2);
  await call('POST', '/api/dm', m1, { to: m2.id, text: 'fourth' });
  await sleep(400);
  assert.strictEqual(f.fcm.length, 1, 'an open app is not pushed');
  hm.ws.close();
  console.log('push: messages for a closed app only, no text, once per pair, switch');

  // a persona has no account, so nothing is ever sent for one, even with a device row forced in
  const pid = crypto.randomBytes(16).toString('hex');
  const now0 = Date.now();
  sql("INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy_at, created) VALUES ('" + pid + "', 101, '0,0,0,0', 3, 300, 10, 3, 5000, " + now0 + ", 0, " + now0 + ")");
  const kp = hexTok();
  sql("INSERT INTO devices (token, player, kind, lang, tz, session, created, seen) VALUES ('" + kp + "', '" + pid + "', 'apns', 'en', " + tzAt(now0, 18) + ", '', 0, 0)");
  f.clear();
  assert.strictEqual((await call('POST', '/api/friend', x, { id: pid })).status, 200);
  await sleep(400);
  await tick(now0);
  assert.strictEqual(to(f.apns, kp).length, 0, 'no request and no daily for a persona');

  // senders: sandbox fallback, dropped tokens, failures that change nothing
  const nudge = async acc => {
    await call('POST', '/api/friend', await guest(), { id: acc.id });
    await sleep(700);
  };
  const s = await guest();
  const ks = hexTok();
  await reg(s, 'apns', ks, 'en', 0);
  f.rules[ks] = { apns: [400, 'BadDeviceToken'] };
  f.clear();
  await nudge(s);
  assert.deepStrictEqual([to(f.apns, ks).length, to(f.sandbox, ks).length, devs(s)[0].sandbox], [1, 1, 1], 'production said bad token, sandbox took it and it is remembered');
  f.clear();
  await nudge(s);
  assert.deepStrictEqual([to(f.apns, ks).length, to(f.sandbox, ks).length], [0, 1], 'a remembered sandbox device goes straight there');
  const bad = await guest();
  const kb = hexTok();
  await reg(bad, 'apns', kb, 'en', 0);
  f.rules[kb] = { apns: [400, 'BadDeviceToken'], sandbox: [400, 'BadDeviceToken'] };
  f.clear();
  await nudge(bad);
  assert.deepStrictEqual([to(f.apns, kb).length, to(f.sandbox, kb).length, devs(bad).length], [1, 1, 0], 'a token neither side knows is dropped');
  const gone = await guest();
  const kg = hexTok();
  await reg(gone, 'apns', kg, 'en', 0);
  f.rules[kg] = { apns: [410, 'Unregistered'] };
  f.clear();
  await nudge(gone);
  assert.deepStrictEqual([to(f.apns, kg).length, to(f.sandbox, kg).length, devs(gone).length], [1, 0, 0], '410 drops the device');
  const keep = await guest();
  const ke = hexTok();
  await reg(keep, 'apns', ke, 'en', 0);
  f.rules[ke] = { apns: [500, 'InternalServerError'] };
  assert.strictEqual((await call('POST', '/api/friend', await guest(), { id: keep.id })).status, 200);
  await sleep(700);
  assert.strictEqual(devs(keep).length, 1, 'a server error keeps the device and fails nothing');
  const badToken = [400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token'];
  for (const [rule, label] of [[[404, 'UNREGISTERED'], 'UNREGISTERED'], [[400, 'UNREGISTERED'], 'UNREGISTERED on a 400'], [badToken, 'INVALID_ARGUMENT for the token'],
    [[403, 'SENDER_ID_MISMATCH', 'PERMISSION_DENIED'], 'SENDER_ID_MISMATCH']]) {
    const w = await guest();
    const kw = fcmTok();
    await reg(w, 'fcm', kw, 'en', 0);
    f.rules[kw] = { fcm: rule };
    await nudge(w);
    assert.strictEqual(devs(w).length, 0, 'FCM ' + label + ' drops the device');
  }
  for (const rule of [[500], [404], [400],[400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'Invalid JSON payload'], [403], [403, 'PERMISSION_DENIED', 'PERMISSION_DENIED']]) {
    const fk = await guest();
    const kk = fcmTok();
    await reg(fk, 'fcm', kk, 'en', 0);
    f.rules[kk] = { fcm: rule };
    await nudge(fk);
    assert.strictEqual(devs(fk).length, 1, 'an FCM error ' + JSON.stringify(rule) + ' keeps the device');
  }
  // only a refused provider token makes APNs sign a new one
  const jwts = list => new Set(list.filter(m => m.headers).map(m => m.headers.authorization)).size;
  assert.strictEqual(jwts(seen), 1, 'one APNs JWT serves every push');
  const via = async rule => {
    const acc = await guest();
    const k = hexTok();
    await reg(acc, 'apns', k, 'en', 0);
    if (rule) f.rules[k] = { apns: rule };
    await nudge(acc);
    return to(f.apns, k)[0].headers.authorization;
  };
  const j1 = await via(null);
  assert.strictEqual(await via([403, 'ExpiredProviderToken']), j1, 'the refused push still carried the cached JWT');
  const j2 = await via(null);
  assert.notStrictEqual(j2, j1, 'an expired provider token is signed again');
  assert.strictEqual(await via([403, 'Forbidden']), j2);
  assert.strictEqual(await via(null), j2, 'any other 403 keeps the JWT');
  const after = seen.length;
  console.log('push: sandbox fallback, 410 and UNREGISTERED drop the device, server errors change nothing');

  // the OAuth exchange: signed with the service account, reused until it expires or is refused
  const o1 = await guest();
  const ko1 = fcmTok();
  await reg(o1, 'fcm', ko1, 'en', 0);
  f.revoke = true;
  const before = f.exchanges.length;
  await nudge(o1);
  assert.strictEqual(devs(o1).length, 1, 'a refused bearer keeps the device');
  await nudge(o1);
  await nudge(o1);
  assert.strictEqual(f.exchanges.length, before + 1, 'the refused bearer was exchanged again, once, and then reused');
  const ex = f.exchanges[f.exchanges.length - 1];
  assert.strictEqual(ex.form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const gj = jwtOk(ex.form.get('assertion'), fcmPub, 'RS256');
  assert.deepStrictEqual([gj.claims.iss, gj.claims.scope, gj.claims.aud, gj.claims.exp - gj.claims.iat], [sa.client_email, 'https://www.googleapis.com/auth/firebase.messaging', 'http://localhost:' + port('FCM', 8794) + '/token', 3600]);
  assert.deepStrictEqual(to(f.fcm, ko1).slice(-2).map(m => m.bearer), [ex.at, ex.at]);
  console.log('push: FCM bearer exchanged with the signed service account JWT and cached');

  // the daily bonus at 18:00 local
  const now = Date.now();
  const day = Math.floor(now / DAY) * DAY;
  const mk = async (acc, list) => {
    acc.tokens = [];
    for (const [kind, tz, lang] of list) {
      const t = kind === 'apns' ? hexTok() : fcmTok();
      await reg(acc, kind, t, lang, tz);
      acc.tokens.push(t);
    }
  };
  const evening = tzAt(now, 18);
  const noon = tzAt(now, 12);
  sql('DELETE FROM devices');
  const [d1, d2, d3, n1, n2, n3, n4, d4, n5] = [await guest(), await guest(), await guest(), await guest(), await guest(), await guest(), await guest(), await guest(), await guest()];
  await mk(d4, [['apns', tzAt(now, 20), 'en']]);
  await mk(n5, [['apns', tzAt(now, 22), 'en']]);
  await mk(d1, [['apns', evening, 'tr']]);
  await mk(d2, [['fcm', evening, 'en']]);
  await mk(d3, [['apns', evening, 'en'], ['fcm', noon, 'en']]);
  await mk(n1, [['apns', evening, 'en']]);
  await mk(n2, [['apns', noon, 'en']]);
  await mk(n3, [['apns', evening, 'en']]);
  await mk(n4, [['apns', evening, 'en']]);
  sql('UPDATE players SET daily_at = ' + (day - DAY + 1000) + ', streak = 3 WHERE id = ' + who(d1));
  sql('UPDATE players SET daily_at = ' + now + ' WHERE id = ' + who(n1));
  sql('UPDATE players SET push_daily = 0 WHERE id = ' + who(n3));
  sql('UPDATE players SET push_on = 0 WHERE id = ' + who(n4));
  f.clear();
  await tick(now);
  const everyone = [d1, d2, d3, n1, n2, n3, n4, d4, n5].flatMap(p => p.tokens);
  const hit = () => [...f.apns, ...f.fcm].filter(m => everyone.includes(m.token)).map(m => m.token).sort();
  assert.deepStrictEqual(hit(), [d1.tokens[0], d2.tokens[0], d3.tokens[0], d4.tokens[0]].sort(), 'ready, evening until 22:00, switched on; only the device in its evening');
  assert.deepStrictEqual(to(f.apns, d1.tokens[0])[0].body, { aps: { alert: { title: 'Günlük bonus', body: '1.500 çiplik günlük bonusun hazır.' }, sound: 'default' }, t: 'daily' });
  assert.deepStrictEqual(to(f.fcm, d2.tokens[0])[0].message.notification, { title: 'Daily bonus', body: 'Your daily bonus of 750 chips is ready.' });
  assert.deepStrictEqual(to(f.fcm, d2.tokens[0])[0].message.data, { t: 'daily' });
  seen.push(...f.apns, ...f.fcm);
  await tick(now + 60000);
  assert.strictEqual(hit().length, 4, 'a second run in the same evening pushes nobody');
  console.log('push: daily bonus once, in the evening local, with the amount, per switch and device');

  // the weekly rank on Monday morning local time
  let T = Date.UTC(2031, 0, 6);
  while (new Date(T).getUTCDay() !== 1) T += DAY;
  const wk = t => Math.floor((t - 4 * DAY) / (7 * DAY));
  const lw = wk(T) - 1;
  // the far future week is only ours, but an earlier run of this file may have left players in it
  sql('UPDATE players SET week = 0, week_won = 0, prev_week = 0, prev_won = 0 WHERE week >= ' + (lw - 1) + ' OR prev_week >= ' + (lw - 1));
  sql('DELETE FROM devices');
  const ws = [];
  for (let i = 0; i < 9; i++) ws.push(await guest());
  const [w1, w2, w3, w4, w5, w6, w7, w8, w9] = ws;
  await mk(w1, [['apns', 0, 'en']]);
  await mk(w2, [['fcm', 0, 'tr']]);
  await mk(w3, [['apns', 0, 'en']]);
  await mk(w4, [['apns', 0, 'en']]);
  await mk(w5, [['apns', 0, 'en']]);
  await mk(w6, [['apns', -720, 'en']]);
  await mk(w7, [['apns', 0, 'en']]);
  await mk(w8, [['apns', -720, 'tr']]);
  await mk(w9, [['fcm', 0, 'en']]);
  const set = (acc, week, won, extra) => sql('UPDATE players SET week = ' + week + ', week_won = ' + won + (extra || '') + ' WHERE id = ' + who(acc));
  set(w1, lw, 500);
  set(w2, lw, 500);
  set(w3, lw, 900);
  set(w4, lw - 1, 800);
  set(w5, lw, 700, ', push_week = 0');
  set(w6, lw - 1, 600);
  set(w7, lw, 0);
  set(w8, lw, 450);
  // already won this week: last week is in the prev columns
  set(w9, lw + 1, 100, ', prev_week = ' + lw + ', prev_won = 400');
  // a pair held for a look gets no weekly push and is not counted ahead of anyone
  const [h1, h2] = [await guest(), await guest()];
  await mk(h1, [['apns', 0, 'en']]);
  await mk(h2, [['apns', 0, 'en']]);
  set(h1, lw, 1000);
  set(h2, lw, 950);
  sql("INSERT INTO flags (kind, a, b, x, y, at) VALUES ('pair', " + who(h1) + ', ' + who(h2) + ', 0, 0, ' + Date.now() + ')');
  // computer players are on the board: one ahead of most with last week's chips in the week columns, one with them in the prev columns
  sql('DELETE FROM personas WHERE created = 5');
  const bot = (i, extra) => sql("INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy_at, created, week, week_won, prev_week, prev_won) VALUES ('" + String(i).repeat(32) + "', " + (900 + i) + ", '1,1,1,0', 3, 300, 9, 3, 5000, 0, 0, 5, " + extra + ')');
  sql('UPDATE personas SET week = 0, week_won = 0, prev_week = 0, prev_won = 0 WHERE week >= ' + (lw - 1) + ' OR prev_week >= ' + (lw - 1));
  bot(1, lw + ', 800, 0, 0');
  bot(2, (lw + 1) + ', 20, ' + lw + ', 550');
  f.clear();
  await tick(T + 10 * 3600000 + 5 * 60000);
  const wm = acc => [...f.apns, ...f.fcm].filter(m => acc.tokens.includes(m.token));
  assert.deepStrictEqual(wm(w1)[0].body, { aps: { alert: { title: 'Weekly leaderboard', body: 'You won 500 chips last week and finished #5.' }, sound: 'default' }, t: 'week' });
  assert.deepStrictEqual(wm(w2)[0].message.notification, { title: 'Haftalık sıralama', body: 'Geçen hafta 500 çip kazandın ve sıralamada 5. oldun.' });
  assert.deepStrictEqual(wm(w3)[0].body.aps.alert.body, 'You won 900 chips last week and finished #1.');
  assert.strictEqual(wm(w9)[0].message.notification.body, 'You won 400 chips last week and finished #8.', 'a player who already won this week still gets last week\'s rank, with the computer players in it');
  assert.strictEqual(wm(h1).length + wm(h2).length, 0, 'a flagged pair gets no weekly push');
  for (const [acc, why] of [[w4, 'won nothing last week'], [w5, 'switched off'], [w7, 'no chips won']]) assert.strictEqual(wm(acc).length, 0, why);
  assert.strictEqual(wm(w6).length + wm(w8).length, 0, 'in a zone ahead the clock is not Monday morning, or the UTC week has not turned');
  seen.push(...f.apns, ...f.fcm);
  const n = f.apns.length + f.fcm.length;
  await tick(T + 10 * 3600000 + 5 * 60000);
  await tick(T + 11 * 3600000 + 5 * 60000);
  assert.strictEqual(f.apns.length + f.fcm.length, n, 'sent once');
  await tick(T + 5 * 60000);
  assert.strictEqual(wm(w8).length, 1, 'once UTC is in the new week the zone ahead gets its push, in its own hours');
  assert.strictEqual(wm(w8)[0].body.aps.alert.body, 'Geçen hafta 450 çip kazandın ve sıralamada 7. oldun.');
  sql('DELETE FROM personas WHERE created = 5');
  console.log('push: weekly rank on Monday morning local, last week only, once');

  // an account that is deleted takes its devices along
  const del = await guest();
  await reg(del, 'apns', hexTok(), 'en', 0);
  await reg(del, 'fcm', fcmTok(), 'en', 0);
  assert.strictEqual(devs(del).length, 2);
  assert.strictEqual((await call('DELETE', '/api/me', del)).status, 200);
  assert.strictEqual(devs(del).length, 0);
  const old = await guest();
  await reg(old, 'fcm', fcmTok(), 'en', 0);
  sql('UPDATE devices SET seen = 1 WHERE player = ' + who(old));
  await tick(Date.UTC(2031, 0, 8, 3, 5));
  assert.strictEqual(devs(old).length, 0, 'a device not seen for 90 days goes at 03:00 UTC');
  console.log('push: account deletion and old devices remove their rows');

  // a run makes a limited number of subrequests; a small budget shows the players it does not reach staying unmarked, and the
  // next ticks, ten minutes apart inside the evening window, serve the rest
  sql('DELETE FROM devices');
  sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('pushbudget', '40')");
  const T2 = Date.UTC(2031, 5, 10, 12, 0);
  const mine = acc => sql('SELECT daily_sent AS s FROM players WHERE id = ' + who(acc))[0].s;
  const crowd = [];
  for (let i = 0; i < 30; i++) {
    crowd.push(await guest());
    await mk(crowd[i], [['apns', tzAt(T2, 18), 'en']]);
  }
  f.clear();
  await tick(T2);
  const served = crowd.filter(c => mine(c) === T2).length;
  assert(served > 5 && served < 30, 'the budget served ' + served + ' of 30');
  assert.strictEqual(f.apns.length, served, 'a player is marked only when pushed');
  await tick(T2 + 3 * 60000);
  assert.strictEqual(f.apns.length, served + crowd.filter(c => mine(c) === T2 + 3 * 60000).length, 'a run minutes later pushes new players only');
  for (let i = 2; i <= 5; i++) await tick(T2 + i * 600000);
  assert.strictEqual(crowd.filter(c => mine(c) >= T2).length, 30, 'the ticks inside the window take the rest');
  assert.strictEqual(f.apns.length, 30, 'nobody twice');
  sql("DELETE FROM settings WHERE key = 'pushbudget'");
  // a player with ten devices costs up to 31, so the second one does not fit and is handed back
  sql('DELETE FROM devices');
  sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('pushbudget', '40')");
  const T3 = Date.UTC(2031, 5, 11, 12, 0);
  const [big1, big2] = [await guest(), await guest()];
  for (const b of [big1, big2]) await mk(b, Array.from({ length: 10 }, () => ['apns', tzAt(T3, 18), 'en']));
  f.clear();
  await tick(T3);
  assert.deepStrictEqual([big1, big2].map(b => mine(b) === T3).sort(), [false, true], 'one of two big players fits');
  assert.strictEqual(f.apns.length, 10);
  await tick(T3 + 600000);
  assert.strictEqual(f.apns.length, 20, 'the one left over is pushed on the next tick');
  sql("DELETE FROM settings WHERE key = 'pushbudget'");
  // the full budget serves a crowd in one run
  sql('DELETE FROM devices');
  const T5 = Date.UTC(2031, 5, 13, 12, 0);
  const wide = [];
  for (let i = 0; i < 30; i++) {
    wide.push(await guest());
    await mk(wide[i], [['apns', tzAt(T5, 18), 'en']]);
  }
  f.clear();
  await tick(T5);
  assert.strictEqual(wide.filter(c => mine(c) === T5).length, 30, 'with 900 subrequests nobody waits');
  console.log('push: a run stays inside its subrequest budget, the next ticks of the window take the rest');

  // invites and messages are held back at night on the device's own clock; the lists in the app still have them
  const [qa, qb, qc, qd] = [await guest(), await guest(), await guest(), await guest()];
  await befriend(qa, qb);
  await befriend(qa, qc);
  await befriend(qa, qd);
  const kq = { b: hexTok(), c: hexTok(), d: hexTok() };
  const clock = h => tzAt(Date.now(), h);
  await reg(qb, 'apns', kq.b, 'en', clock(23));
  await reg(qc, 'apns', kq.c, 'en', clock(3));
  await reg(qd, 'apns', kq.d, 'en', clock(7));
  f.clear();
  for (const x of [qb, qc, qd]) assert.strictEqual((await call('POST', '/api/dm', qa, { to: x.id, text: 'hej' })).status, 200);
  await sleep(600);
  assert.deepStrictEqual([kq.b, kq.c, kq.d].map(k => to(f.apns, k).length), [0, 0, 0], 'a message at 23:30, 03:30 or 07:30 on the device does not push');
  assert.strictEqual(sql('SELECT count(*) AS n FROM messages WHERE sender = ' + who(qa))[0].n, 3, 'it is still in the list');
  await reg(qb, 'apns', kq.b, 'en', clock(8));
  await reg(qc, 'apns', kq.c, 'en', clock(21));
  await call('POST', '/api/dm', qa, { to: qb.id, text: 'morning' });
  await call('POST', '/api/dm', qa, { to: qc.id, text: 'evening' });
  await settle(() => to(f.apns, kq.b).length && to(f.apns, kq.c).length);
  assert.deepStrictEqual([kq.b, kq.c].map(k => to(f.apns, k).length), [1, 1], 'at 08:30 and 21:30 it does, and the held message left no gap behind');
  const gq = await pair(3, 3, [qa, qd]);
  await reg(qd, 'apns', kq.d, 'en', clock(2));
  f.clear();
  gq.a.send({ t: 'invite', to: qd.id });
  await gq.a.next(m => m.t === 'sent');
  await sleep(400);
  assert.strictEqual(to(f.apns, kq.d).length, 0, 'an invite at 02:30 on the device does not push');
  gq.a.ws.close();
  gq.b.ws.close();
  console.log('push: invites and messages keep quiet from 22:00 to 08:00 on the device clock');

  // a token that signs in as a second account is the second account's alone
  const [ta, tb, tc] = [await guest(), await guest(), await guest()];
  const tk = hexTok();
  await reg(ta, 'apns', tk, 'en', noonTz());
  await reg(tb, 'apns', tk, 'en', noonTz());
  f.clear();
  await call('POST', '/api/friend', tc, { id: ta.id });
  await sleep(500);
  assert.strictEqual(to(f.apns, tk).length, 0, 'the first account no longer pushes to the token');
  await call('POST', '/api/friend', tc, { id: tb.id });
  await settle(() => to(f.apns, tk).length);
  assert.strictEqual(to(f.apns, tk).length, 1, 'the second does');
  console.log('push: a token taken by a second account stops pushing to the first');

  // one job failing does not stop the next
  const T4 = Date.UTC(2031, 5, 12, 3, 5);
  const late = await guest();
  await mk(late, [['apns', tzAt(T4, 18), 'en']]);
  sql('DROP TABLE push_log');
  f.clear();
  await tick(T4);
  assert.strictEqual(to(f.apns, late.tokens[0]).length, 1, 'the daily goes out although the cleanup before it failed');
  sql('CREATE TABLE push_log (kind TEXT NOT NULL, sender TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, sender, target))');
  console.log('push: the run survives a failing job');

  // no key, no request, no error
  const mod = await import('../src/push.js');
  const dv = [{ token: hexTok(), kind: 'apns', lang: 'en', sandbox: 0 }, { token: fcmTok(), kind: 'fcm', lang: 'tr', sandbox: 0 }];
  f.clear();
  const at = { PACE: '1', APNS_BASE: 'http://localhost:' + port('APNS', 8792), FCM_BASE: 'http://localhost:' + port('FCM', 8794), FCM_TOKEN_URL: 'http://localhost:' + port('FCM', 8794) + '/token' };
  for (const env of [{}, { APNS_KEY: vars.APNS_KEY, FCM_KEY: vars.FCM_KEY }, Object.assign({ APNS_KEY_ID: 'testkid', FCM_PROJECT: 'x' }, at)]) {
    assert.strictEqual(await mod.send(env, dv, 'invite', { seed: 1, code: 'ABCD' }), 0);
    await mod.cron(Object.assign({ DB: null }, env), Date.UTC(2031, 0, 6, 10, 30));
  }
  assert.strictEqual(f.apns.length + f.fcm.length, 0);
  console.log('push: a sender without its key is skipped quietly');

  // what went out says nothing about bots
  assert(seen.length > 6);
  assert(!seen.some(m => /bot|fake|persona/i.test(JSON.stringify(m.body || m.message))), 'no push mentions bots');
  assert.strictEqual(jwts(seen.slice(after)), 1, 'the new APNs JWT serves every push after it');
  f.close();
  console.log('push: nothing for personas, no hint of them in any text');
}
// plays the Realtime SFU on port 8796; REALTIME_APP_ID=testapp, REALTIME_APP_TOKEN=testtoken and RTC_BASE=http://localhost:8796 go in dev.vars
function fakeSfu() {
  const f = { log: [], sessions: {} };
  let n = 0;
  f.server = fake('sfu', port('SFU', 8796), (req, res) => new Promise((ok, no) => {
    res.on('close', ok);
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      try {
      const b = raw ? JSON.parse(raw) : {};
      f.log.push({ method: req.method, path: req.url, body: b, auth: req.headers.authorization });
      const send = (o, status) => {
        res.writeHead(status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const m = req.url.match(/^\/apps\/testapp\/sessions\/(new|(\w+)\/(tracks\/new|renegotiate|tracks\/close))$/);
      if (!m) return send({ errorCode: 'not_found' }, 404);
      if (m[1] === 'new') {
        const id = 's' + ++n;
        f.sessions[id] = {};
        return send({ sessionId: id });
      }
      const s = f.sessions[m[2]];
      if (!s) return send({ errorCode: 'session_error' }, 404);
      if (m[3] === 'renegotiate') return send({});
      if (m[3] === 'tracks/close') {
        for (const t of b.tracks) for (const k of Object.keys(s)) if (s[k] === t.mid) delete s[k];
        return send({ tracks: b.tracks });
      }
      const t = b.tracks[0];
      if (t.location === 'local') {
        s[t.trackName] = t.mid;
        return send({ sessionDescription: { type: 'answer', sdp: 'answer' }, tracks: [{ mid: t.mid, trackName: t.trackName }] });
      }
      const from = f.sessions[t.sessionId];
      if (!from || !(t.trackName in from)) return send({ tracks: [{ errorCode: 'not_found' }] });
      send({ requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'offer' }, tracks: [{ mid: String(10 + n++), trackName: t.trackName, sessionId: t.sessionId }] });
      ok();
      } catch (e) { no(e); }
    });
  }));
  f.pushed = () => f.log.filter(r => r.method === 'POST' && /tracks\/new$/.test(r.path) && r.body.tracks[0].location === 'local');
  f.pulled = () => f.log.filter(r => r.method === 'POST' && /tracks\/new$/.test(r.path) && r.body.tracks[0].location === 'remote');
  return f;
}

const SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n';

async function voice(f) {
  const vx = (acc, g, op, body) => call('POST', '/api/voice/' + op, acc, Object.assign({ scope: 'table', code: g.code }, body));
  const g = await pair(3, 3);
  const [sa] = await begin(g);
  const h = await pair(3, 3);
  await begin(h);
  const o = await guest();
  const heard = { a: [], b: [] };
  g.a.handlers.push(m => { if (m.t === 'voice') heard.a.push(m); });
  g.b.handlers.push(m => { if (m.t === 'voice') heard.b.push(m); });
  const A = g.accA.id;
  const B = g.accB.id;
  const bots = sa.players.filter(p => p.pid && p.pid !== A && p.pid !== B).map(p => p.pid);
  assert.strictEqual(bots.length, 1);

  assert.strictEqual((await call('POST', '/api/voice/who', null, { scope: 'table', code: g.code })).status, 401);
  assert.strictEqual((await call('GET', '/api/voice/who', g.accA)).status, 404);
  assert.strictEqual((await call('POST', '/api/voice/who', g.accA, { scope: 'nowhere' })).status, 400);
  assert.strictEqual((await call('POST', '/api/voice/nope', g.accA, { scope: 'table', code: g.code })).status, 404);
  assert.strictEqual((await vx(o, g, 'who')).status, 403, 'someone not seated here has no voice here');
  assert.strictEqual((await vx(o, g, 'mic', { sdp: SDP, mid: '0' })).status, 403);

  assert.strictEqual((await vx(g.accA, g, 'mic', { sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', mid: '0' })).status, 400, 'only audio');
  assert.strictEqual((await vx(g.accA, g, 'mic', { sdp: SDP + 'm=audio 9 RTP/AVP 0\r\n', mid: '0' })).status, 400, 'one track');
  assert.strictEqual((await vx(g.accA, g, 'mic', { sdp: SDP, mid: 'x' })).status, 400);
  assert.strictEqual(f.pushed().length, 0);
  const on = await vx(g.accA, g, 'mic', { sdp: SDP, mid: '0' });
  assert.deepStrictEqual([on.status, on.body], [200, { sdp: 'answer' }]);
  await sleep(200);
  assert.deepStrictEqual(heard.b, [{ t: 'voice', pid: A, on: true }], 'the table is told, the speaker is not');
  assert.deepStrictEqual(heard.a, []);
  const pub = f.pushed()[0];
  const name = pub.body.tracks[0].trackName;
  assert.strictEqual(pub.auth, 'Bearer testtoken');
  assert(/^[0-9a-f]{32}$/.test(name), 'the track name is made by the server');
  assert(!JSON.stringify(on.body).includes(name), 'and never sent to the client');

  assert.deepStrictEqual((await vx(g.accB, g, 'who')).body, { pids: [A] });
  assert.deepStrictEqual((await vx(g.accA, g, 'who')).body, { pids: [] });
  assert.strictEqual((await vx(o, g, 'pull', { pid: A })).status, 403, 'an outsider cannot pull a table track');
  assert.strictEqual((await vx(g.accA, g, 'pull', { pid: A })).status, 404, 'nor can anyone pull their own');
  assert.strictEqual((await vx(g.accB, g, 'pull', { pid: bots[0], fresh: true })).status, 404, 'a bot has no track');
  assert.strictEqual((await vx(g.accB, g, 'pull', { pid: 'zz' })).status, 404);
  assert.strictEqual(f.pulled().length, 0);
  const pull = await vx(g.accB, g, 'pull', { pid: A, fresh: true });
  assert.deepStrictEqual([pull.status, pull.body.sdp, pull.body.pid], [200, 'offer', A]);
  const got = f.pulled()[0];
  assert.deepStrictEqual([got.body.tracks[0].sessionId, got.body.tracks[0].trackName], [pub.path.split('/')[4], name], 'the pull names what was published');
  assert.notStrictEqual(got.path.split('/')[4], pub.path.split('/')[4], 'through a session of its own');
  assert.strictEqual((await vx(g.accB, g, 'answer', { sdp: 'x' })).status, 200);
  assert(f.log.some(r => r.method === 'PUT' && /renegotiate$/.test(r.path) && r.body.sessionDescription.type === 'answer'));
  assert.strictEqual((await vx(g.accA, g, 'answer', { sdp: 'x' })).status, 400, 'no listening session to answer for');

  // another table has its own tracks
  const A2 = h.accA.id;
  assert.strictEqual((await vx(h.accA, h, 'mic', { sdp: SDP, mid: '0' })).status, 200);
  assert.strictEqual(new Set(f.pushed().map(r => r.body.tracks[0].trackName)).size, 2, 'every track has its own name');
  assert.strictEqual((await vx(g.accB, h, 'pull', { pid: A2 })).status, 403, 'a player of one table cannot pull at another');
  assert.strictEqual((await vx(g.accB, g, 'pull', { pid: A2 })).status, 404, 'nor reach it by asking for the player here');
  assert.strictEqual((await vx(h.accB, h, 'pull', { pid: A })).status, 404);
  assert.deepStrictEqual((await vx(h.accB, h, 'who')).body, { pids: [A2] });

  // voice off, both ways
  assert.strictEqual((await call('POST', '/api/voice', g.accB, { voice: 'no' })).status, 400);
  assert.strictEqual((await call('POST', '/api/voice', g.accB, { voice: false })).body.voice, false);
  assert.strictEqual((await call('GET', '/api/me', g.accA)).body.voice, true, 'on by default');
  assert.strictEqual((await vx(g.accB, g, 'who')).status, 403, 'a player with voice off cannot listen');
  assert.strictEqual((await vx(g.accB, g, 'pull', { pid: A })).status, 403);
  assert.strictEqual((await vx(g.accB, g, 'mic', { sdp: SDP, mid: '0' })).status, 403, 'or talk');
  await call('POST', '/api/voice', g.accA, { voice: false });
  await call('POST', '/api/voice', g.accB, { voice: true });
  assert.strictEqual((await vx(g.accB, g, 'pull', { pid: A })).status, 404, 'and nobody hears them');
  assert.deepStrictEqual((await vx(g.accB, g, 'who')).body, { pids: [] });
  await call('POST', '/api/voice', g.accA, { voice: true });
  assert.strictEqual((await vx(g.accB, g, 'pull', { pid: A })).status, 200);

  // blocked, either way round
  assert.strictEqual((await vx(g.accB, g, 'mic', { sdp: SDP, mid: '0' })).status, 200);
  await sleep(200);
  assert.deepStrictEqual(heard.a.pop(), { t: 'voice', pid: B, on: true });
  await call('POST', '/api/block/' + B, g.accA);
  assert.strictEqual((await vx(g.accA, g, 'pull', { pid: B })).status, 404, 'a player does not hear one they blocked');
  assert.strictEqual((await vx(g.accB, g, 'pull', { pid: A })).status, 404, 'nor one who blocked them');
  assert.deepStrictEqual([(await vx(g.accA, g, 'who')).body, (await vx(g.accB, g, 'who')).body], [{ pids: [] }, { pids: [] }]);
  await vx(g.accB, g, 'stop');
  await vx(g.accB, g, 'mic', { sdp: SDP, mid: '0' });
  await sleep(200);
  assert.deepStrictEqual(heard.a, [], 'and is not told when they talk');
  await call('DELETE', '/api/block/' + B, g.accA);
  assert.strictEqual((await vx(g.accA, g, 'pull', { pid: B })).status, 200);

  // the proxy is rate limited per player
  const codes = [];
  for (let i = 0; i < 40; i++) codes.push((await vx(h.accA, h, 'who')).status);
  assert(codes.includes(429), 'a flood of requests is refused');
  assert.strictEqual(codes[0], 200);
  assert.deepStrictEqual((await vx(h.accB, h, 'who')).body, { pids: [A2] }, 'one player flooding does not touch another');

  // leaving the table ends the voice
  const before = f.log.length;
  g.a.ws.close();
  await sleep(300);
  assert.deepStrictEqual(heard.b.pop(), { t: 'voice', pid: A, on: false });
  assert(f.log.slice(before).some(r => /tracks\/close$/.test(r.path) && r.body.force === true), 'the track is closed at the SFU');
  assert.deepStrictEqual((await vx(g.accB, g, 'who')).body, { pids: [] });
  console.log('voice: tablemates only, names made by the server, blocked and voice-off kept apart, rate limited');

  // the hub says voice is available; without an app id it is off and silent
  const [hi, hm] = await hello({ auth: o.auth }, m => m.t === 'hub');
  assert.strictEqual(hm.voice, true);
  hi.ws.close();
  const { on: live, voice: api } = await import('../src/voice.js');
  assert.strictEqual(live({ REALTIME_APP_ID: '' }), false);
  assert.strictEqual(live({}), false);
  const off = await api(new Request('http://x/api/voice/who', { method: 'POST', body: '{}' }), { REALTIME_APP_ID: '' });
  assert.strictEqual(off.status, 404);
  console.log('voice: off without an app id');
  g.b.ws.close();
  h.a.ws.close();
  h.b.ws.close();
}

async function calls(f) {
  const [a, b, c, e, d] = [await guest(), await guest(), await guest(), await guest(), await guest()];
  await befriend(a, b);
  await befriend(a, e);
  await befriend(b, e);
  await befriend(a, d);
  const [ha, hb, hc, he] = [await hub(a), await hub(b), await hub(c), await hub(e)];
  const ring = (x, from) => x.next(m => m.t === 'ring' && m.from.pid === from.id);
  const dial = (x, to) => x.send({ t: 'call', to: to.id });
  const ended = (x, why) => x.next(m => m.t === 'call' && m.st === 'end' && m.why === why);
  const line = (me, other) => call('GET', '/api/dm/' + other.id, me).then(r => r.body.messages.filter(m => m.k).map(m => [m.k, m.mine]));
  const gap = () => sleep(150);
  const vc = (acc, id, op, body) => call('POST', '/api/voice/' + op, acc, Object.assign({ scope: 'call', id: id }, body));
  const refuse = async (x, to, why) => {
    const n = ended(x, why);
    dial(x, to);
    await n;
    await gap();
  };

  // only a friend who is online, with voice on on both sides, can be rung
  await refuse(ha, c, 'no');
  await refuse(ha, d, 'away');
  await call('POST', '/api/voice', b, { voice: false });
  await refuse(ha, b, 'no');
  await call('POST', '/api/voice', b, { voice: true });
  await call('POST', '/api/voice', a, { voice: false });
  await refuse(ha, b, 'no');
  await call('POST', '/api/voice', a, { voice: true });

  // ringing, busy, decline
  let r = ring(hb, a);
  const mine = ha.next(m => m.t === 'call' && m.st === 'ring');
  dial(ha, b);
  const rb = await r;
  assert.strictEqual(rb.id, (await mine).id);
  assert.deepStrictEqual(Object.keys(rb.from).sort(), ['av', 'level', 'pid', 'seed', 'vip', 'wear']);
  await refuse(he, b, 'busy');
  await refuse(ha, e, 'busy');
  const dd = Promise.all([ended(ha, 'declined'), ended(hb, 'declined')]);
  hb.send({ t: 'hang', id: rb.id });
  await dd;
  assert.deepStrictEqual(await line(a, b), [['declined', true]], 'a declined call leaves a line');

  // accepted, then talk through the SFU
  await gap();
  r = ring(hb, a);
  dial(ha, b);
  const id = (await r).id;
  const on = Promise.all([ha.next(m => m.t === 'call' && m.st === 'on'), hb.next(m => m.t === 'call' && m.st === 'on')]);
  hc.send({ t: 'accept', id: id });
  he.send({ t: 'accept', id: id });
  ha.send({ t: 'accept', id: id });
  await sleep(100);
  hb.send({ t: 'accept', id: id });
  const [oa, ob] = await on;
  assert.deepStrictEqual([oa.with, ob.with, oa.id], [b.id, a.id, id], 'only the one rung can answer');
  const hear = hb.next(m => m.t === 'voice');
  assert.strictEqual((await vc(a, id, 'mic', { sdp: SDP, mid: '0' })).status, 200);
  assert.deepStrictEqual(await hear, { t: 'voice', id: id, pid: a.id, on: true });
  assert.strictEqual((await vc(c, id, 'who')).status, 403, 'a stranger cannot reach the call');
  assert.strictEqual((await vc(e, id, 'pull', { pid: a.id })).status, 403, 'nor a friend of both');
  assert.deepStrictEqual((await vc(b, id, 'who')).body, { pids: [a.id] });
  assert.strictEqual((await vc(b, id, 'pull', { pid: a.id, fresh: true })).status, 200);
  assert.strictEqual((await vc(b, id, 'answer', { sdp: 'x' })).status, 200);
  assert.strictEqual((await vc(b, id, 'pull', { pid: c.id })).status, 404);
  assert.strictEqual((await call('POST', '/api/voice/who', a, { scope: 'call', id: 'nope' })).status, 403);
  assert.strictEqual((await vc(b, id, 'mic', { sdp: SDP, mid: '0' })).status, 200);
  await call('POST', '/api/voice', b, { voice: false });
  assert.strictEqual((await vc(a, id, 'pull', { pid: b.id })).status, 404, 'a friend with voice off is not heard in a call either');
  await call('POST', '/api/voice', b, { voice: true });
  const codes = [];
  for (let i = 0; i < 40; i++) codes.push((await vc(a, id, 'who')).status);
  assert(codes.includes(429), 'the proxy is rate limited in a call too');
  const bye = Promise.all([ended(ha, 'ended'), ended(hb, 'ended')]);
  const closes = f.log.length;
  ha.send({ t: 'hang', id: id });
  await bye;
  await sleep(100);
  assert(f.log.slice(closes).some(x => /tracks\/close$/.test(x.path)), 'the tracks are closed at the SFU');
  assert.strictEqual((await vc(b, id, 'who')).status, 403, 'nothing after hanging up');
  assert.deepStrictEqual(await line(a, b), [['declined', true]], 'a call that happened leaves no line');

  // nobody answers
  await gap();
  const miss = Promise.all([ended(ha, 'missed'), ended(hb, 'missed')]);
  dial(ha, b);
  await miss;
  assert.strictEqual((await call('GET', '/api/friends', b)).body.friends.find(x => x.id === a.id).unread, 1, 'a missed call counts as unread');
  assert.deepStrictEqual(await line(b, a), [['missed', false], ['declined', false]]);

  // the caller gives up while it rings, and cannot ring again at once
  await gap();
  r = ring(hb, a);
  dial(ha, b);
  const quick = ended(ha, 'slow');
  dial(ha, b);
  const rid = (await r).id;
  await quick;
  const gave = Promise.all([ended(ha, 'missed'), ended(hb, 'missed')]);
  ha.send({ t: 'hang', id: rid });
  await gave;

  // a dropped connection ends it after a short grace
  await gap();
  r = ring(hb, a);
  dial(ha, b);
  const did = (await r).id;
  const up = hb.next(m => m.t === 'call' && m.st === 'on');
  hb.send({ t: 'accept', id: did });
  await up;
  const lost = ended(ha, 'dropped');
  hb.ws.close();
  await lost;
  console.log('calls: friends only, busy, decline, missed, accept, SFU proxy, hang up, dropped');
  for (const x of [ha, hc, he]) x.ws.close();
}
const seatsOf = code => sql("SELECT * FROM match_seat WHERE code = '" + code + "' ORDER BY seat");
const moved = (acc, match) => sql("SELECT coalesce(sum(delta), 0) AS n FROM chip_log WHERE player = " + who(acc) + " AND ref LIKE '" + match + ":%'")[0].n;

// every seat of every match is written down, computer players too, with the result and who left
async function matchlog() {
  const [accA, accB, accE] = [await guest(), await guest(), await guest()];
  link(accA, accB, accE);
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: 3, games: 3, stake: 100 });
  const ja = await a.next(m => m.t === 'joined');
  const b = client('/ws/' + ja.code);
  await b.ready;
  b.send({ t: 'join', auth: accB.auth });
  await b.next(m => m.t === 'joined');
  const e = client('/ws/' + ja.code);
  await e.ready;
  e.send({ t: 'join', auth: accE.auth });
  await e.next(m => m.t === 'joined');
  const fin = [a, b, e].map(c => played(c));
  a.send({ t: 'start' });
  await within(Promise.all(fin), 120000, 'match end');
  await sleep(800);
  let rows = seatsOf(ja.code);
  assert.deepStrictEqual(rows.map(x => [x.player, x.kind, x.stake, x.fake, x.seat, x.gone]), [[accA.id, 'friend', 100, 0, 0, 0], [accB.id, 'friend', 100, 0, 1, 0], [accE.id, 'friend', 100, 0, 2, 0]]);
  assert.strictEqual(rows[0].match, rows[1].match);
  for (const [i, acc] of [accA, accB, accE].entries()) {
    assert(rows[i].net !== null && rows[i].at > 0);
    assert.strictEqual(rows[i].net, moved(acc, rows[0].match), 'net is what the chip log moved');
  }
  console.log('matchlog: a friend table writes one row per seat, net equals the chip log');
  a.ws.close();
  b.ws.close();
  e.ws.close();

  // a leave in a started match sets gone; the other seat does not
  const [accC, accD] = [await guest(), await guest()];
  link(accC, accD);
  const c = client('/ws/new');
  await c.ready;
  c.send({ t: 'create', auth: accC.auth, players: 3, games: 3, stake: 100 });
  const jc = await c.next(m => m.t === 'joined');
  const d = client('/ws/' + jc.code);
  await d.ready;
  d.send({ t: 'join', auth: accD.auth });
  await d.next(m => m.t === 'joined');
  const end = played(Object.assign(c, { seat: jc.seat }));
  c.send({ t: 'start' });
  await d.next(m => m.t === 'state');
  d.send({ t: 'leave' });
  await within(end, 120000, 'match end');
  await sleep(800);
  rows = seatsOf(jc.code).filter(x => !x.fake);
  assert.deepStrictEqual(rows.map(x => [x.player, x.gone, x.gone_at > 0]), [[accC.id, 0, false], [accD.id, 1, true]]);
  assert.strictEqual(rows[1].net, moved(accD, rows[0].match), 'a leaver net is what the chip log moved, the real result');
  console.log('matchlog: a leave sets gone and the net is settled with the match');
  c.ws.close();

  // a public table: the three computer players are rows too, flagged
  const h = await hub(accA);
  const s = h.next(m => m.t === 'seated');
  h.send({ t: 'quick', stake: 100 });
  const sat = await s;
  const r = seated(sat);
  await within(played(r), 120000, 'match end');
  await sleep(800);
  rows = seatsOf(sat.code);
  assert.deepStrictEqual(rows.map(x => [x.kind, x.fake]), [['pub', 0], ['pub', 1], ['pub', 1], ['pub', 1]]);
  assert.strictEqual(rows[0].player, accA.id);
  assert(rows.every(x => x.net !== null), 'computer players settle too');
  assert.strictEqual(rows[0].net, moved(accA, rows[0].match));
  assert.strictEqual(sql('SELECT count(*) AS n FROM chip_log WHERE player IN (' + rows.slice(1).map(x => "'" + x.player + "'").join(',') + ')')[0].n, 0);
  r.ws.close();
  h.ws.close();
  console.log('matchlog: a public table writes the computer players too');

  // the nightly cleanup keeps 35 days
  const T = Date.UTC(2031, 5, 20, 3, 5);
  const old = (m, at) => sql("INSERT INTO match_seat (match, code, kind, stake, player, fake, seat, at) VALUES ('" + m + "', 'ZZZZ', 'pub', 100, " + who(accB) + ", 0, 0, " + at + ")");
  old('old', T - 36 * DAY);
  old('new', T - 34 * DAY);
  await tick(T);
  assert.deepStrictEqual(sql("SELECT match FROM match_seat WHERE code = 'ZZZZ'").map(x => x.match), ['new']);
  console.log('matchlog: rows older than 35 days are purged');

  assert.strictEqual((await call('DELETE', '/api/me', accA)).status, 200);
  assert.strictEqual(sql('SELECT count(*) AS n FROM match_seat WHERE player = ' + who(accA))[0].n, 0, 'deleting the account deletes its rows');
  console.log('matchlog: account deletion removes the rows');
}

const ADMIN = process.env.ADMIN_KEY;
const adm = (method, path, key, body, ip) => call(method, '/admin/api/' + path, null, body, null, Object.assign({ 'CF-Connecting-IP': ip || '10.9.0.1' }, key ? { Authorization: 'Bearer ' + key } : {}));

async function admin() {
  const { admin: handler } = await import('../src/admin.js');
  for (const p of ['/admin', '/admin/api/log']) assert.strictEqual((await handler(new Request('http://x' + p), {})).status, 503, 'no ADMIN_KEY, no page');
  assert(ADMIN, 'the runner sets ADMIN_KEY');

  const page = await fetch(http + '/admin');
  assert.strictEqual(page.status, 200);
  assert(/text\/html/.test(page.headers.get('content-type')) && /<title>Admin<\/title>/.test(await page.text()));
  assert.strictEqual((await adm('GET', 'log')).status, 401);
  assert.strictEqual((await adm('GET', 'log', 'wrong')).status, 401);
  assert.strictEqual((await adm('GET', 'log', ADMIN)).status, 200);
  assert.strictEqual((await call('GET', '/admin/api/log', null, null, 'https://evil.example', { Authorization: 'Bearer ' + ADMIN })).status, 403, 'only its own origin');
  assert.strictEqual((await call('GET', '/admin/api/log', null, null, http, { Authorization: 'Bearer ' + ADMIN, 'CF-Connecting-IP': '10.9.0.1' })).status, 200);
  console.log('admin: 503 without a key, 401 with a wrong one, its own origin only');

  const got = async () => (await adm('GET', 'settings', ADMIN)).body.settings;
  assert.deepStrictEqual(JSON.parse((await got()).strong), { 100: 0, 500: 1, 2500: 2, 10000: 9, 50000: 9, cup1000: 1, cup5000: 2, cup25000: 9 });
  assert.strictEqual((await got()).chipsoff, '');
  for (const [key, value] of [['chipsoff', 'tr'], ['chipsoff', 'TR,'], ['strong', '{}'], ['strong', 'x'], ['nope', 'TR'], ['chipsoff', 5]]) {
    assert.strictEqual((await adm('POST', 'settings', ADMIN, { key, value })).status, 400, key + ' ' + value);
  }
  assert.strictEqual((await adm('POST', 'settings', ADMIN, { key: 'chipsoff', value: 'TR,CA' })).status, 200);
  assert.strictEqual((await got()).chipsoff, 'TR,CA');
  assert.strictEqual(sql("SELECT value FROM settings WHERE key = 'chipsoff'")[0].value, 'TR,CA', 'the next request reads what was saved');
  assert.strictEqual((await adm('POST', 'settings', ADMIN, { key: 'chipsoff', value: '' })).status, 200);
  const log = (await adm('GET', 'log', ADMIN)).body.log;
  assert.deepStrictEqual(log.slice(0, 2).map(x => [x.who, x.action, x.target, JSON.parse(x.detail).to]), [['admin', 'setting', 'chipsoff', ''], ['admin', 'setting', 'chipsoff', 'TR,CA']]);
  console.log('admin: settings saved, read back and logged');

  const codes = await Promise.all(Array.from({ length: 45 }, () => adm('GET', 'log', 'guess', null, '10.9.0.2')));
  assert(codes.some(x => x.status === 429), 'tries are limited per address');
  assert.strictEqual((await adm('GET', 'log', ADMIN)).status, 200, 'another address is not affected');
  console.log('admin: repeated tries are refused');
  await adminActions();
}

// mute, ban, balance and the rest of what the admin page does to an account; each part has its own address, as the page's tries are limited
async function adminActions() {
  const act = (path, body, ip, key) => adm('POST', path, key === undefined ? ADMIN : key, body, ip);
  const rows = (action, target) => sql("SELECT who, detail FROM admin_log WHERE action = '" + action + "' AND target = '" + target + "' ORDER BY id");

  // mute and unmute
  const ip1 = '10.9.1.1';
  const a = await guest();
  const b = await guest();
  assert.strictEqual((await act('mute', { id: a.id }, ip1, 'wrong')).status, 401);
  assert.strictEqual((await act('mute', { id: 'x' }, ip1)).status, 404);
  assert.strictEqual((await act('mute', { id: '0'.repeat(32) }, ip1)).status, 404);
  assert.strictEqual((await act('mute', { id: a.id, hours: 0 }, ip1)).status, 400);
  assert.strictEqual((await act('mute', { id: a.id }, ip1)).status, 200);
  const left = sql('SELECT mute_until FROM players WHERE id = ' + who(a))[0].mute_until - Date.now();
  assert(left > 23 * 3600000 && left <= DAY, 'a day by default');
  const dm = await call('POST', '/api/dm', a, { to: b.id, text: 'hi' });
  assert.deepStrictEqual([dm.status, dm.body.error], [403, 'mute'], 'the muted player cannot type');
  assert.strictEqual((await act('unmute', { id: a.id }, ip1)).status, 200);
  assert.strictEqual(sql('SELECT mute_until FROM players WHERE id = ' + who(a))[0].mute_until, 0);
  assert.strictEqual((await call('POST', '/api/dm', a, { to: b.id, text: 'hi' })).body.error, 'nodm', 'the mute is over');
  assert.deepStrictEqual([rows('mute', a.id).length, rows('unmute', a.id).length, rows('mute', a.id)[0].who], [1, 1, 'admin']);
  console.log('admin: mute and unmute, logged');

  // a balance correction goes through the chip function
  const ip2 = '10.9.1.2';
  const chips = acc => sql('SELECT chips FROM players WHERE id = ' + who(acc))[0].chips;
  assert.strictEqual((await act('balance', { id: b.id, delta: 0, ref: 'r0' }, ip2)).status, 400);
  assert.strictEqual((await act('balance', { id: b.id, delta: 1.5, ref: 'r0' }, ip2)).status, 400);
  assert.strictEqual((await act('balance', { id: b.id, delta: 5, ref: 'no good' }, ip2)).status, 400, 'a reference is required');
  assert.strictEqual((await act('balance', { id: b.id, delta: 700, ref: 'r1' }, ip2)).status, 200);
  assert.strictEqual(chips(b), 5700);
  assert.deepStrictEqual(sql("SELECT delta, reason, ref FROM chip_log WHERE player = " + who(b) + " AND reason = 'admin'"), [{ delta: 700, reason: 'admin', ref: 'admin:r1' }]);
  assert.strictEqual((await act('balance', { id: b.id, delta: 700, ref: 'r1' }, ip2)).status, 200);
  assert.strictEqual(chips(b), 5700, 'the same reference changes nothing the second time');
  const below = await act('balance', { id: b.id, delta: -6000, ref: 'r2' }, ip2);
  assert.deepStrictEqual([below.status, below.body.error, chips(b)], [409, 'below', 5700], 'not below zero');
  assert.strictEqual((await act('balance', { id: b.id, delta: -700, ref: 'r3' }, ip2)).status, 200);
  assert.strictEqual(chips(b), 5000);
  assert.strictEqual(sql("SELECT count(*) AS n FROM chip_log WHERE player = " + who(b) + " AND reason = 'admin'")[0].n, 2, 'one chip_log row per correction');
  assert.deepStrictEqual(rows('balance', b.id).map(x => JSON.parse(x.detail).delta), [700, -700], 'logged once each');
  console.log('admin: balance corrections write one chip_log row each, a repeat is a no-op, below zero is refused');

  // a message can be deleted by its id
  const ip3 = '10.9.1.3';
  await befriend(a, b);
  const sent = await call('POST', '/api/dm', a, { to: b.id, text: 'nasty' });
  assert.strictEqual(sent.status, 200);
  assert.strictEqual((await call('GET', '/api/dm/' + a.id, b)).body.messages.length, 1);
  assert.strictEqual((await act('unsay', { id: 'x' }, ip3)).status, 400);
  assert.strictEqual((await act('unsay', { id: sent.body.message.id }, ip3)).status, 200);
  assert.strictEqual((await call('GET', '/api/dm/' + a.id, b)).body.messages.length, 0);
  assert.strictEqual((await act('unsay', { id: sent.body.message.id }, ip3)).status, 404);
  assert.strictEqual(rows('unsay', String(sent.body.message.id)).length, 1);
  console.log('admin: a message is deleted by its id');

  // the report list says whether each counted, what the reporter has played and which reported seat is a computer player
  const ip4 = '10.9.1.4';
  const reporter = await agedGuest(12);
  const bot = sql('SELECT id FROM personas LIMIT 1')[0];
  assert.strictEqual((await call('POST', '/api/report', reporter, { pid: b.id, ctx: 'profile', text: 'one' })).status, 200);
  if (bot) assert.strictEqual((await call('POST', '/api/report', reporter, { pid: bot.id, ctx: 'profile', text: 'two' })).status, 200);
  const list = (await adm('GET', 'reports', ADMIN, null, ip4)).body.reports;
  const mine = list.filter(x => x.reporter === reporter.id);
  assert.deepStrictEqual(mine.map(x => [x.text, x.games, x.counts, x.fake]), bot ? [['two', 12, 0, 1], ['one', 12, 0, 0]] : [['one', 12, 0, 0]], 'newest first');
  assert.strictEqual((await adm('GET', 'reports', null, null, ip4)).status, 401);
  console.log('admin: the report list');

  // a ban shuts the account out of everything, takes its seat at a public table without a leave and can be undone
  const ip5 = '10.9.1.5';
  const stamp = Date.now();
  sql('DELETE FROM personas WHERE created = 1');
  sql('UPDATE personas SET chips = 100, topup = ' + stamp + ', busy = NULL');
  sql('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 29) INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy, busy_at, created) ' +
    "SELECT lower(hex(randomblob(16))), i, '1,1,1,0', 1, 0, 0, 0, 10000000, " + stamp + ', NULL, 0, 1 FROM n');
  const c = await guest();
  const h = await hub(c);
  const sat = h.next(m => m.t === 'seated' || m.t === 'error');
  h.send({ t: 'quick', stake: 100 });
  const s = await sat;
  assert.strictEqual(s.t, 'seated', 'quick: ' + s.k);
  const r = seated(s);
  await r.next(m => m.t === 'state');
  const before = chips(c);
  assert.strictEqual((await act('ban', { id: c.id, why: 'test ban' }, ip5)).status, 200);
  await gone(h, 5000);
  await gone(r, 5000);
  const row = sql('SELECT banned, banned_why, banned_at FROM players WHERE id = ' + who(c))[0];
  assert.deepStrictEqual([row.banned, row.banned_why, row.banned_at > Date.now() - 60000], [1, 'test ban', true]);
  assert.strictEqual(sql('SELECT count(*) AS n FROM sessions WHERE player = ' + who(c))[0].n, 0, 'the sessions are gone');
  for (const [method, path] of [['GET', '/api/me'], ['POST', '/api/daily'], ['GET', '/api/friends'], ['GET', '/api/shop'], ['POST', '/api/report']]) assert.strictEqual((await call(method, path, c, method === 'POST' ? {} : undefined)).status, 401, path);
  const [h2, e] = await hello({ auth: c.auth }, m => m.t === 'error');
  assert.strictEqual(e.k, 'auth', 'the hub refuses it');
  h2.ws.close();
  const n = client('/ws/new');
  await n.ready;
  const refusal = n.next(m => m.t === 'error');
  n.send({ t: 'create', auth: c.auth, players: 3, games: 3 });
  assert.strictEqual((await refusal).k, 'auth', 'so does a room');
  n.ws.close();
  assert.strictEqual(sql('SELECT count(*) AS n FROM leaves WHERE player = ' + who(c))[0].n, 0, 'no leave penalty');
  assert.strictEqual(sql('SELECT gone FROM match_seat WHERE player = ' + who(c))[0].gone, 1, 'the seat is marked left');
  assert.strictEqual(sql("SELECT count(*) AS n FROM chip_log WHERE player = " + who(c) + " AND reason = 'leave'")[0].n, 0);
  assert(chips(c) <= before, 'nothing was paid back to the banned account early');
  assert.strictEqual(rows('ban', c.id).length, 1);
  assert.strictEqual((await act('ban', { id: c.id }, ip5)).status, 200, 'banning twice is fine');
  assert.strictEqual(rows('ban', c.id).length, 1);
  assert.strictEqual((await act('unban', { id: c.id }, ip5)).status, 200);
  assert.strictEqual(sql('SELECT banned FROM players WHERE id = ' + who(c))[0].banned, 0);
  // signing in again makes a session; Apple's case is in the apple section
  sql("INSERT INTO sessions (player, secret_hash, created) VALUES (" + who(c) + ", '" + crypto.createHash('sha256').update(c.secret).digest('hex') + "', " + Date.now() + ')');
  assert.strictEqual((await call('GET', '/api/me', c)).status, 200, 'unbanned');
  assert.strictEqual(rows('unban', c.id).length, 1);
  console.log('admin: a ban closes every way in, frees the seat without a leave and can be undone');

  // a started match settles a banned player's seat by its real result, as for a leaver
  const ip6 = '10.9.1.6';
  const accA = level(4, link(await guest()));
  const accB = level(4, link(await guest()));
  const x = client('/ws/new');
  await x.ready;
  x.send({ t: 'create', auth: accA.auth, players: 3, games: 3, stake: 500 });
  const jx = await x.next(m => m.t === 'joined');
  const y = client('/ws/' + jx.code);
  await y.ready;
  y.send({ t: 'join', auth: accB.auth });
  await y.next(m => m.t === 'joined');
  const fin = played(Object.assign(x, { seat: jx.seat }));
  x.send({ t: 'start' });
  await y.next(m => m.t === 'state');
  const kept = sql('SELECT xp, tokens, games, wins, week_won FROM players WHERE id = ' + who(accB))[0];
  assert.strictEqual((await act('ban', { id: accB.id }, ip6)).status, 200);
  await gone(y, 5000);
  await within(fin, 120000, 'match end');
  await sleep(800);
  const seatB = x.st.players.find(p => p.pid === accB.id);
  const back = payout(500, 3, seatB.chips);
  assert.strictEqual(chips(accB), 5000 - 1100 - 25 + back, 'the banned seat gets its real payout');
  assert.deepStrictEqual(sql('SELECT xp, tokens, games, wins, week_won FROM players WHERE id = ' + who(accB))[0], kept, 'and no xp, tokens or wins');
  const seat = seatsOf(jx.code).find(z => z.player === accB.id);
  assert.deepStrictEqual([seat.gone, seat.net], [1, back - 1125]);
  assert.strictEqual(sql('SELECT count(*) AS n FROM leaves WHERE player = ' + who(accB))[0].n, 0);
  console.log('admin: a banned player in a running match is replaced and settled by the real result');
  x.ws.close();

  // a ban while the table waits for its start: the deal takes the seat out and charges nothing
  const accC = level(4, link(await guest()));
  const accD = level(4, link(await guest()));
  const p = client('/ws/new');
  await p.ready;
  p.send({ t: 'create', auth: accC.auth, players: 3, games: 3, stake: 500 });
  const jp = await p.next(m => m.t === 'joined');
  const q = client('/ws/' + jp.code);
  await q.ready;
  q.send({ t: 'join', auth: accD.auth });
  await q.next(m => m.t === 'joined');
  const bankD = chips(accD);
  assert.strictEqual((await act('ban', { id: accD.id }, ip6)).status, 200);
  assert.strictEqual(sql("SELECT count(*) AS n FROM match_seat WHERE code = '" + jp.code + "'")[0].n, 0, 'nothing is recorded before the deal');
  p.send({ t: 'start' });
  await gone(q, 5000);
  await p.next(m => m.t === 'state');
  assert.strictEqual(chips(accD), bankD, 'no stake was taken');
  assert.strictEqual(sql("SELECT count(*) AS n FROM match_seat WHERE code = '" + jp.code + "' AND player = " + who(accD))[0].n, 0, 'and it never counted as seated');
  p.ws.close();
  console.log('admin: a ban before the deal keeps the player out of the match and its stake');
}

// the source scan: nothing but the one function sets chips or tokens
function chipfn() {
  const dir = __dirname + '/../src/';
  const hits = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const text = fs.readFileSync(dir + f, 'utf8');
    for (const m of text.matchAll(/UPDATE\s+(\w+)\s+SET\s[^;`'"]*?\b(chips|tokens)\s*=|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\([^)]*\b(chips|tokens)\b/gi)) if ((m[1] || m[3]) === 'players') hits.push(f + ' ' + (m[2] || m[4]) + (m[1] ? '' : ' column'));
  }
  // the new account row is made with 0 chips and the start grant follows in the same batch
  assert.deepStrictEqual(hits.sort(), ['account.js chips', 'account.js chips column', 'account.js tokens', 'account.js tokens']);
  const persona = fs.readFileSync(dir + 'persona.js', 'utf8');
  assert(/outside the chip function/.test(persona), 'the computer players banks are marked as separate');
  console.log('chipfn: chips and tokens are set by account.js only, the computer players banks aside');
}

// each test picks its own address, so a minute's budget is never shared; only the dev server reads X-Addr
const addr = () => '10.' + Array.from(crypto.randomBytes(3)).join('.');
// the HTTP status a connection was refused with, or 0
const refused = async c => {
  try {
    await c.ready;
    return 0;
  } catch (e) {
    return +/http (\d+)/.exec(e.message)[1];
  }
};
const gone = async (c, ms) => {
  for (let t = 0; c.ws.readyState === 1; t += 100) {
    assert(t < ms, 'the socket is still open after ' + ms + ' ms');
    await sleep(100);
  }
};
const devvars = () => Object.fromEntries(fs.readFileSync(process.env.DEV_VARS || __dirname + '/dev.vars', 'utf8').split(/\r?\n/).filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const unknownCode = () => 'Z' + Array.from({ length: 3 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[crypto.randomInt(23)]).join('');

async function limits() {
  const { net } = await import('../src/peer.js');
  assert.strictEqual(net('1.2.3.4'), '1.2.3.4');
  assert.strictEqual(net('2001:db8:1:2:aaaa::1'), net('2001:DB8:1:2:0:0:0:ffff'));
  assert.notStrictEqual(net('2001:db8:1:2::1'), net('2001:db8:1:3::1'));
  assert.strictEqual(net('::ffff:9.8.7.6'), '9.8.7.6');
  assert.strictEqual(net('::1'), '0:0:0:0');
  assert.strictEqual(net(''), '');

  // 20 sockets that say nothing per address, counted by the /64 for IPv6
  const hold = ip => ({ 'X-Addr': ip, 'X-Hello': '30000' });
  const held = [];
  const A = addr();
  for (let i = 0; i < 20; i++) {
    const c = client('/ws/hub', null, hold(A));
    await c.ready;
    held.push(c);
  }
  assert.strictEqual(await refused(client('/ws/hub', null, hold(A))), 429, 'the 21st silent socket from one address is refused');
  const other = client('/ws/hub', null, hold(addr()));
  await other.ready;
  held.push(other);
  for (const c of held) c.ws.close();
  const p = crypto.randomBytes(4).toString('hex');
  const six = n => hold('2001:db8:' + p.slice(0, 4) + ':' + p.slice(4) + ':' + n + '::1');
  const sixHeld = [];
  for (let i = 1; i <= 20; i++) {
    const c = client('/ws/hub', null, six(i));
    await c.ready;
    sixHeld.push(c);
  }
  assert.strictEqual(await refused(client('/ws/hub', null, six(99))), 429, 'addresses of one /64 count together');
  const next = client('/ws/hub', null, hold('2001:db8:' + p.slice(0, 4) + ':ffff::1'));
  await next.ready;
  sixHeld.push(next);
  for (const c of sixHeld) c.ws.close();
  console.log('limits: 20 silent sockets per address, an IPv6 /64 as one');

  // silent sockets are closed within a second at test pace
  const quiet = client('/ws/hub', null, { 'X-Addr': addr() });
  await quiet.ready;
  await gone(quiet, 1500);
  console.log('limits: a socket that never says hello is closed');

  // a hub full of silent sockets still lets a signed-in player in: the oldest silent one goes
  const cap = +devvars().HUB_SILENT;
  assert(cap > 1 && cap <= 200, 'the dev server lowers the cap on silent sockets (HUB_SILENT)');
  const silent = [];
  for (let i = 0; i < cap; i++) {
    const c = client('/ws/hub', null, hold(addr()));
    await c.ready;
    silent.push(c);
  }
  const acc = await guest();
  const [c, m] = await hello({ auth: acc.auth }, m => m.t === 'hub');
  assert.strictEqual(m.t, 'hub');
  await gone(silent[0], 3000);
  assert.strictEqual(silent[1].ws.readyState, 1, 'only the oldest was let go');
  for (const s of silent) s.ws.close();
  c.ws.close();
  console.log('limits: a hub full of silent sockets still takes a signed-in hello');

  // the whole hub at its cap: a signed-in hello still gets in, as the oldest silent socket goes
  await sleep(1500);
  const old = client('/ws/hub', null, hold(addr()));
  await old.ready;
  const young = client('/ws/hub', null, hold(addr()));
  await young.ready;
  const full = client('/ws/hub', null, Object.assign(hold(addr()), { 'X-Max': '1' }));
  await full.ready;
  await gone(old, 3000);
  assert.strictEqual(young.ws.readyState, 1, 'only the oldest silent socket was let go');
  for (const x of [young, full]) x.ws.close();
  console.log('limits: a hub at its cap lets the oldest silent socket go');

  // signed-in sockets per address: a sixth account from one address is turned away (HUB_KNOWN is 5 here)
  const K = addr();
  const known = [];
  for (let i = 0; i < +devvars().HUB_KNOWN; i++) {
    const a = await guest();
    const c = client('/ws/hub', null, { 'X-Addr': K });
    await c.ready;
    const w = c.next(m => m.t === 'hub');
    c.send({ t: 'hello', auth: a.auth });
    await w;
    known.push(c);
  }
  const extra = await guest();
  const over = client('/ws/hub', null, { 'X-Addr': K });
  await over.ready;
  const err = over.next(m => m.t === 'error');
  over.send({ t: 'hello', auth: extra.auth });
  assert.strictEqual((await err).k, 'slow', 'one address holds at most 5 signed-in accounts here');
  for (const c of known) c.ws.close();
  console.log('limits: signed-in sockets per address are capped');

  // at a table: a socket that never joins is closed, even where no table exists; a room takes 8 of them
  const lost = client('/ws/' + unknownCode(), null, { 'X-Addr': addr() });
  await lost.ready;
  await gone(lost, 4000);
  const code = unknownCode();
  const strays = [];
  for (let i = 0; i < 8; i++) {
    const s = client('/ws/' + code, null, hold(addr()));
    await s.ready;
    strays.push(s);
  }
  assert.strictEqual(await refused(client('/ws/' + code, null, hold(addr()))), 503, 'the 9th unseated socket is refused');
  for (const s of strays) s.ws.close();
  await sleep(300);
  const again = client('/ws/' + code, null, { 'X-Addr': addr() });
  await again.ready;
  again.ws.close();
  console.log('limits: a Room closes sockets that never join and takes 8 of them');

  // three create or join tries, the fourth closes the socket
  const t = client('/ws/new', null, { 'X-Addr': addr() });
  await t.ready;
  for (let i = 0; i < 3; i++) {
    const e = t.next(m => m.t === 'error');
    t.send({ t: 'create', auth: acc.auth, players: 9, games: 9 });
    assert.strictEqual((await e).k, 'opts');
  }
  const end = new Promise(res => t.ws.on('close', (code, why) => res([code, String(why)])));
  t.send({ t: 'create', auth: acc.auth, players: 9, games: 9 });
  assert.deepStrictEqual(await within(end, 3000, 'the 4th try closes the socket'), [1008, 'tries']);
  console.log('limits: the 4th join or create try closes the socket');

  // the limiter counts in windows aligned to the clock minute, so the tries must not straddle a boundary
  while (Date.now() % 60000 > 30000) await sleep(500);
  // /ws/new is the dearest path: 10 a minute per address
  const N = addr();
  for (let i = 0; i < 10; i++) {
    const c2 = client('/ws/new', null, { 'X-Addr': N });
    await c2.ready;
    c2.ws.close();
  }
  assert.strictEqual(await refused(client('/ws/new', null, { 'X-Addr': N })), 429, 'the 11th /ws/new in a minute is refused');
  const fresh = client('/ws/new', null, { 'X-Addr': addr() });
  await fresh.ready;
  fresh.ws.close();
  // and every socket is held to 30 a minute
  const S = addr();
  for (let i = 0; i < 30; i++) {
    const c2 = client('/ws/hub', null, { 'X-Addr': S });
    await c2.ready;
    c2.ws.close();
  }
  assert.strictEqual(await refused(client('/ws/hub', null, { 'X-Addr': S })), 429, 'the 31st socket in a minute is refused');
  console.log('limits: 10 new tables and 30 sockets a minute per address');
}

async function probe() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  // a join that goes nowhere answers the same, whether the code is unknown, full or started
  const tryJoin = async (acc, code, extra) => {
    const c = client('/ws/' + code, null, extra);
    await c.ready;
    const e = c.next(m => m.t === 'error' || m.t === 'joined');
    c.send({ t: 'join', auth: acc.auth });
    const m = await e;
    return [m.k || m.t, c];
  };
  const [host, p1, p2, s1, s2, s3] = [await guest(), await guest(), await guest(), await guest(), await guest(), await guest()];
  const made = async (acc, n) => {
    const a = client('/ws/new');
    await a.ready;
    a.send({ t: 'create', auth: acc.auth, players: n, games: n });
    const j = await a.next(m => m.t === 'joined');
    return [a, j.code];
  };
  const [a, code] = await made(host, 3);
  const [jb, cb] = await tryJoin(p1, code);
  assert.strictEqual(jb, 'joined');
  const [jb2, cb2] = await tryJoin(p2, code);
  assert.strictEqual(jb2, 'joined');
  assert.strictEqual((await tryJoin(s1, code))[0], 'nocode', 'a full table');
  const st = a.next(m => m.t === 'state');
  a.send({ t: 'start' });
  await st;
  assert.strictEqual((await tryJoin(s2, code))[0], 'nocode', 'a started table');
  assert.strictEqual((await tryJoin(s3, unknownCode()))[0], 'nocode', 'a code nobody made');
  a.ws.close();
  cb.ws.close();
  cb2.ws.close();
  console.log('probe: unknown, full and started codes answer alike');

  // an account's failed joins are counted: after 10 in 10 minutes even a good code is refused, another account is not affected
  const flood = await guest();
  for (let i = 0; i < 15; i++) assert.strictEqual((await tryJoin(flood, unknownCode()))[0], 'nocode');
  const [h2, c2] = await made(await guest(), 5);
  assert.strictEqual((await tryJoin(flood, c2))[0], 'nocode', 'past the budget a good code is refused as well');
  const [r, jc] = await tryJoin(await guest(), c2);
  assert.strictEqual(r, 'joined', 'a second account is unaffected');
  jc.ws.close();
  console.log('probe: 15 joins to random codes from one account are cut off');

  // the address has a budget of its own: 5 failed joins a minute
  const X = { 'X-Addr': addr() };
  for (let i = 0; i < 8; i++) assert.strictEqual((await tryJoin(await guest(), unknownCode(), X))[0], 'nocode');
  assert.strictEqual((await tryJoin(await guest(), c2, X))[0], 'nocode', 'an address past its budget gets nothing');
  const [ok, jd] = await tryJoin(await guest(), c2, { 'X-Addr': addr() });
  assert.strictEqual(ok, 'joined', 'another address is fine');
  jd.ws.close();
  h2.ws.close();
  console.log('probe: an address past 5 failed joins a minute is refused');

  // a table can only be made at a code /ws/new handed out
  const acc = await guest();
  const fake = client('/ws/' + unknownCode());
  await fake.ready;
  const e = fake.next(m => m.t === 'error');
  fake.send({ t: 'create', auth: acc.auth, players: 3, games: 3 });
  assert.strictEqual((await e).k, 'nocode');
  const forged = client('/ws/' + unknownCode(), null, { 'X-Amk-New': '1' });
  await forged.ready;
  const e2 = forged.next(m => m.t === 'error');
  forged.send({ t: 'create', auth: acc.auth, players: 3, games: 3 });
  assert.strictEqual((await e2).k, 'nocode', 'a client cannot claim to have been handed the code');
  console.log('probe: create at a made-up code is refused');

  // codes keep their alphabet and length
  const lead = new Set();
  for (let i = 0; i < 6; i++) {
    const [t, code2] = await made(await guest(), 3);
    assert(/^[A-HJKMNP-Z]{4}$/.test(code2), code2);
    assert(code2.split('').every(x => letters.includes(x)));
    lead.add(code2[0]);
    t.ws.close();
  }
  assert(lead.size > 1, 'the codes are not all alike');
  console.log('probe: the code alphabet and length are unchanged');
}

const breakDeal = h => sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('faildeal', '" + JSON.stringify(h) + "')");
const mendDeal = () => sql("DELETE FROM settings WHERE key = 'faildeal'");

// a table that cannot deal tries again, then gives every stake back
async function dealfail() {
  const rows = (acc, tail) => sql('SELECT delta FROM chip_log WHERE player = ' + who(acc) + " AND ref LIKE '%" + tail + "' ORDER BY id").map(x => x.delta);
  const chips = async acc => (await call('GET', '/api/me', acc)).body.chips;
  const state = m => m.t === 'state';

  // a third human fills the table, so it is not opened to computer players and does not start over by itself
  const full = async g => {
    const acc = link(await guest());
    const x = client('/ws/' + g.code);
    await x.ready;
    x.send({ t: 'join', auth: acc.auth });
    await x.next(m => m.t === 'joined');
    g.x = x;
    return g;
  };

  // one failure, then the retry deals, and nobody is charged twice
  let g = await full(await pair(3, 3));
  breakDeal({ kind: 'friend', n: 1, seat: 0 });
  const dealt = Promise.all([g.a.next(state), g.b.next(state)]);
  g.a.send({ t: 'start' });
  await within(dealt, 20000, 'the retry deals');
  assert.deepStrictEqual([rows(g.accA, ':in'), rows(g.accB, ':in')], [[-220], [-220]]);
  assert.strictEqual(JSON.parse(sql("SELECT value FROM settings WHERE key = 'faildeal'")[0].value).n, 0, 'the hook fired once');
  mendDeal();
  g.a.ws.close();
  g.b.ws.close();
  g.x.ws.close();
  console.log('dealfail: a failure is retried and deals');

  // a failure that stays, after the first seat was taken: both get the error, everything is returned, the table can start again
  g = await full(await pair(3, 3));
  breakDeal({ kind: 'friend', n: 99, seat: 1 });
  const off = [g.a, g.b].map(c => c.next(m => m.t === 'error' && m.k === 'dealfail'));
  g.a.send({ t: 'start' });
  await within(Promise.all(off), 20000, 'both are told the deal failed');
  assert.deepStrictEqual([rows(g.accA, ':in'), rows(g.accA, ':back'), rows(g.accB, ':in'), rows(g.accB, ':back')], [[-220], [220], [], []]);
  assert.deepStrictEqual([rows(g.accA, ':fee'), rows(g.accA, ':feeback')], [[-5], [5]], 'the fee goes back with it');
  assert.deepStrictEqual([await chips(g.accA), await chips(g.accB)], [5000, 5000]);
  mendDeal();
  const again = Promise.all([g.a.next(state), g.b.next(state)]);
  g.a.send({ t: 'start' });
  await within(again, 20000, 'the table starts again');
  assert.deepStrictEqual([rows(g.accA, ':in').length, rows(g.accA, ':back').length], [2, 1], 'the second match has its own refs');
  g.a.ws.close();
  g.b.ws.close();
  g.x.ws.close();
  console.log('dealfail: a deal that never works returns every stake and leaves the table usable');

  // a public table with computer players: the human is refunded, the computer players' banks come back, the table is gone
  const t0 = Date.now();
  const mine = Array.from({ length: 15 }, (x, i) => ({ id: 'dealfail' + crypto.randomBytes(12).toString('hex'), seed: 101 + i }));
  sql('INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy_at, created) VALUES ' +
    mine.map(x => "('" + x.id + "', " + x.seed + ", '0,0,0,0', 2, 100, 3, 1, 123450, " + t0 + ', 0, ' + t0 + ')').join(', '));
  sql("UPDATE personas SET busy = 'hold', busy_at = " + t0 + " WHERE busy IS NULL AND id NOT LIKE 'dealfail%'");
  breakDeal({ kind: 'pub', n: 99, seat: 2 });
  const acc = await guest();
  const h = await hub(acc);
  const sat = h.next(m => m.t === 'seated');
  h.send({ t: 'quick', stake: 100 });
  const r = seated(await sat);
  await within(r.next(m => m.t === 'error' && m.k === 'dealfail'), 30000, 'the public table gives up');
  await sleep(500);
  assert.deepStrictEqual([rows(acc, ':in'), rows(acc, ':back'), await chips(acc)], [[-260], [260], 5000]);
  const left = sql("SELECT chips, busy FROM personas WHERE id LIKE 'dealfail%'");
  assert(left.every(x => x.chips === 123450 && x.busy === null), 'banks are back and no computer player is held: ' + JSON.stringify(left.filter(x => x.chips !== 123450 || x.busy !== null)));
  assert(sql("SELECT count(*) AS n FROM personas WHERE id LIKE 'dealfail%' AND busy_at >= " + t0)[0].n >= 2, 'computer players were at the table');
  mendDeal();
  r.ws.close();
  h.ws.close();
  console.log('dealfail: a public table refunds the human and the computer players and is wiped');

  // a tournament table that cannot deal cancels the tournament: the buy-in comes back, the computer players' too
  breakDeal({ kind: 'cup', n: 99, seat: 0 });
  const cacc = link(await guest());
  const ch = await hub(cacc);
  const cupoff = ch.next(m => m.t === 'error' && m.k === 'cupoff');
  ch.send({ t: 'cup', buy: 1000 });
  await within(cupoff, 60000, 'the tournament is cancelled');
  assert.deepStrictEqual([rows(cacc, ':in'), rows(cacc, ':back'), await chips(cacc)], [[-1000], [1000], 5000]);
  const spent = sql("SELECT chips FROM personas WHERE id LIKE 'dealfail%'").filter(x => x.chips !== 123450);
  assert.strictEqual(spent.length, 0, 'the computer players got their buy-ins back');
  mendDeal();
  ch.ws.close();
  sql("DELETE FROM personas WHERE id LIKE 'dealfail%'");
  sql("UPDATE personas SET busy = NULL WHERE busy = 'hold'");
  console.log('dealfail: a tournament table that cannot deal refunds the tournament');
}

// Friend tables with a stake are for accounts with 10 finished public matches, whichever way they come in.
async function friendLimits() {
  const mk = async (games, lv = 1) => {
    const x = link(level(lv, await guest()));
    sql('UPDATE players SET pub_games = ' + games + ', chips = 50000000 WHERE id = ' + who(x));
    return x;
  };
  const made = async (acc, stake, players = 3) => {
    const c = client('/ws/new');
    await c.ready;
    const r = c.next(m => m.t === 'joined' || m.t === 'error');
    c.send({ t: 'create', auth: acc.auth, players: players, games: players, stake: stake });
    return [await r, c];
  };
  const ask = async (acc, o) => {
    const h = await hub(acc);
    const r = h.next(m => m.t === 'error' || m.t === 'seated');
    h.send(o);
    const m = await r;
    h.ws.close();
    return m;
  };

  // create and join
  const [no, nc] = await made(await mk(9), 100);
  assert.deepStrictEqual([no.k, no.need], ['games', 10], '9 public matches cannot host a table with a stake');
  nc.ws.close();
  const [free, fc] = await made(await mk(0), 0);
  assert.strictEqual(free.t, 'joined', 'a table for nothing is open to anyone');
  fc.ws.close();
  const [ok, host] = await made(await mk(10), 100);
  assert.strictEqual(ok.t, 'joined', '10 can');
  const join = async acc => {
    const j = client('/ws/' + ok.code);
    await j.ready;
    j.send({ t: 'join', auth: acc.auth });
    const m = await j.next(m => m.t === 'error' || m.t === 'joined');
    j.ws.close();
    return m;
  };
  const [j9, j0] = [await join(await mk(9)), await join(await mk(0))];
  assert.deepStrictEqual([j9.k, j9.need, j0.k], ['games', 10, 'games'], 'nor can they sit at one');
  assert.strictEqual((await join(await mk(10))).t, 'joined');
  const [gno, gc] = await made(await guest(), 100);
  assert.strictEqual(gno.k, 'guest', 'a guest has no such table');
  gc.ws.close();
  host.ws.close();
  console.log('friendLimits: create and join need 10 public matches');

  // an opened room: sit by code and quick play meet the same rule, a computer player does not
  // the accounts first: the table fills with computer players a few seconds after it opens
  const [young, vet, hostAcc] = [await mk(9, 4), await mk(10, 4), await mk(10, 4)];
  const [op, oc] = await made(hostAcc, 500);
  const opened = oc.next(m => m.t === 'room' && m.finding === 2);
  oc.send({ t: 'start' });
  await opened;
  const sit = await ask(young, { t: 'sit', code: op.code });
  assert.deepStrictEqual([sit.k, sit.need], ['games', 10], 'sit by code');
  const quick = await ask(young, { t: 'quick', stake: 500 });
  assert.strictEqual(quick.t, 'seated');
  assert.notStrictEqual(quick.code, op.code, 'quick play finds the young account a public table, not the friend room');
  const old = await ask(vet, { t: 'sit', code: op.code });
  assert.strictEqual(old.t, 'seated', 'ten can sit there');
  oc.ws.close();
  console.log('friendLimits: an opened room and quick play meet the same rule');

  // only a finished public match counts: not a friend table, not a seat that was left
  const [a, b] = [await mk(0), await mk(0)];
  const full = await quickAt(a, 100);
  const early = await quickAt(b, 100);
  await Promise.all([early.first, full.first]);
  early.r.send({ t: 'leave' });
  await within(full.done, 120000, 'match end');
  await sleep(1500);
  const games = acc => sql('SELECT pub_games AS n FROM players WHERE id = ' + who(acc))[0].n;
  assert.strictEqual(games(a), 1, 'a finished public match counts');
  assert.strictEqual(games(b), 0, 'a left one does not');
  sql('UPDATE players SET pub_games = 10 WHERE id = ' + who(a));
  const fr = await friendAt(a, 3, 100);
  await within(fr.done, 120000, 'friend match end');
  await sleep(1500);
  assert.strictEqual(games(a), 10, 'a friend table does not');
  console.log('friendLimits: public matches are counted when finished');
}

// Above 100,000 a day, friend-table winnings wait on the admin page: released to the winner or returned to those who lost them.
async function heldWins() {
  const mk = async () => {
    const x = link(level(30, await guest()));
    sql('UPDATE players SET pub_games = 10, chips = 100000000 WHERE id = ' + who(x));
    return x;
  };
  const [a, b, c] = [await mk(), await mk(), await mk()];
  const day = Math.floor(Date.now() / DAY);
  // a already took 150,000 today
  sql('INSERT INTO friend_day (player, day, match, net) VALUES (' + who(a) + ', ' + day + ", 'earlier', 150000)");
  const g = await pair(3, 3, [a, b], 2000000);
  const x = client('/ws/' + g.code);
  await x.ready;
  x.send({ t: 'join', auth: c.auth });
  await x.next(m => m.t === 'joined');
  const fins = [played(Object.assign(g.a, { seat: g.ja.seat })), played(g.b), played(x)];
  g.a.send({ t: 'start' });
  await within(Promise.all(fins), 180000, 'match end');
  await sleep(1500);
  const rows = seatsOf(g.code);
  const match = rows[0].match;
  assert(rows.some(r => r.net > 100000), 'somebody won more than the cap');
  const prev = { [a.id]: 150000, [b.id]: 0, [c.id]: 0 };
  const rowOf = acc => sql('SELECT * FROM held WHERE player = ' + who(acc) + " AND match = '" + match + "'");
  let first;
  for (const acc of [a, b, c]) {
    const net = rows.find(r => r.player === acc.id).net;
    const over = Math.max(0, Math.min(net, prev[acc.id] + net - 100000));
    const h = rowOf(acc);
    assert.deepStrictEqual(h.map(r => [r.amount, r.state]), over ? [[over, 'held']] : [], 'held for ' + net + ' after ' + prev[acc.id]);
    assert.strictEqual(moved(acc, match), net - over, 'the balance got the rest');
    assert.strictEqual(sql('SELECT sum(net) AS n FROM friend_day WHERE player = ' + who(acc) + ' AND day = ' + day)[0].n, prev[acc.id] + net, 'the day tally counts all of it');
    if (over && !first) first = Object.assign({ acc: acc }, h[0]);
  }
  console.log('heldWins: what a win takes above 100,000 a day is held, the rest paid');

  // the admin page lists it and releases it once
  const chips = acc => sql('SELECT chips FROM players WHERE id = ' + who(acc))[0].chips;
  const listed = (await adm('GET', 'flags', ADMIN, null, '10.9.7.1')).body.held;
  assert(listed.some(h => h.id === first.id && h.amount === first.amount), 'the page lists it');
  const before = chips(first.acc);
  assert.strictEqual((await adm('POST', 'release', ADMIN, { id: first.id }, '10.9.7.2')).status, 200);
  assert.strictEqual(chips(first.acc), before + first.amount);
  assert.deepStrictEqual(sql("SELECT delta, reason FROM chip_log WHERE ref = 'held:" + first.id + "'"), [{ delta: first.amount, reason: 'release' }]);
  assert.strictEqual(sql('SELECT state FROM held WHERE id = ' + first.id)[0].state, 'released');
  assert.strictEqual((await adm('POST', 'release', ADMIN, { id: first.id }, '10.9.7.3')).status, 409, 'a second click pays nothing');
  assert.strictEqual((await adm('POST', 'return', ADMIN, { id: first.id }, '10.9.7.4')).status, 409, 'and neither does a return after it');
  assert.strictEqual(chips(first.acc), before + first.amount);
  assert.strictEqual(sql("SELECT count(*) AS n FROM admin_log WHERE action = 'release' AND target = " + who(first.acc))[0].n, 1);
  console.log('heldWins: release pays the winner once');

  // return: split by what each seat lost, never more than that, and a computer player's share goes to its bank
  const [w, l1, l2] = [await mk(), await mk(), await mk()];
  const bot = 'f'.repeat(32);
  sql("DELETE FROM personas WHERE id = '" + bot + "'");
  sql("INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy, busy_at, created) VALUES ('" + bot + "', 7, '1,1,1,0', 1, 0, 0, 0, 1000, 0, NULL, 0, 7)");
  const seat = (p, net, fake, i) => "('mx', 'MXMX', 'friend', 100, '" + p + "', " + fake + ', ' + i + ', ' + Date.now() + ', ' + net + ')';
  sql('INSERT INTO match_seat (match, code, kind, stake, player, fake, seat, at, net) VALUES ' + [seat(w.id, 395, 0, 0), seat(l1.id, -105, 0, 1), seat(l2.id, -305, 0, 2), seat(bot, -205, 1, 3)].join(', '));
  sql('INSERT INTO held (player, amount, match, at) VALUES (' + who(w) + ", 350, 'mx', " + Date.now() + ')');
  const hid = sql("SELECT id FROM held WHERE match = 'mx'")[0].id;
  const bank = () => sql("SELECT chips FROM personas WHERE id = '" + bot + "'")[0].chips;
  const [c1, c2, wc] = [chips(l1), chips(l2), chips(w)];
  assert.strictEqual((await adm('POST', 'return', ADMIN, { id: hid }, '10.9.7.5')).status, 200);
  assert.deepStrictEqual([chips(l1) - c1, chips(l2) - c2, bank() - 1000], [58, 176, 116], 'shares of 350 by losses of 100, 300 and 200, the odd chip to the largest');
  assert.strictEqual(chips(w), wc, 'the winner gets nothing');
  assert.deepStrictEqual(sql("SELECT reason FROM chip_log WHERE ref LIKE 'held:" + hid + ":%'").map(r => r.reason), ['return', 'return']);
  assert.strictEqual(sql('SELECT state FROM held WHERE id = ' + hid)[0].state, 'returned');
  assert.strictEqual((await adm('POST', 'return', ADMIN, { id: hid }, '10.9.7.6')).status, 409);
  assert.strictEqual((await adm('POST', 'release', ADMIN, { id: hid }, '10.9.7.7')).status, 409);
  assert.deepStrictEqual([chips(l1) - c1, chips(l2) - c2, bank() - 1000, chips(w) - wc], [58, 176, 116, 0], 'a second click changes nothing');
  assert.strictEqual((await adm('POST', 'release', ADMIN, { id: 999999 }, '10.9.7.8')).status, 409);
  sql("DELETE FROM personas WHERE id = '" + bot + "'");
  sql("DELETE FROM match_seat WHERE match = 'mx'");
  console.log('heldWins: return splits by losses, capped, computer player to its bank, once');

  // an account takes its tally and held chips with it
  assert.strictEqual((await call('DELETE', '/api/me', first.acc)).status, 200);
  const left = t => sql('SELECT count(*) AS n FROM ' + t + ' WHERE player = ' + who(first.acc))[0].n;
  assert.deepStrictEqual([left('held'), left('friend_day')], [0, 0]);
  console.log('heldWins: deleting the account removes them');
}

// A pair that moves chips one way is flagged and held out of the rankings until the admin clears it.
async function pairs() {
  const hex = () => crypto.randomBytes(16).toString('hex');
  const NOW = Date.now();
  let n = 0;
  const seed = (kind, stake, rows, at) => {
    const m = 'pr' + ++n + '-' + NOW;
    sql('INSERT INTO match_seat (match, code, kind, stake, player, fake, seat, at, net) VALUES ' + rows.map(([p, net, fake], i) => "('" + m + "', '" + m + "', '" + kind + "', " + stake + ", '" + p + "', " + (fake ? 1 : 0) + ', ' + i + ', ' + at + ', ' + net + ')').join(', '));
  };
  const ago = i => NOW - i * 1000;
  // a loss of 10,000 at the 10,000 table is -10,700 with the fee
  const pass = (from, to, times, extra = []) => {
    for (let i = 0; i < times; i++) seed('friend', 10000, [[from, -10700], [to, 10000], ...extra], ago(i));
  };
  const [x1, y1] = [await guest(), await guest()];
  const [x2, y2, x3, y3, x4, f4, x5, y5, z5, x6, y6] = Array.from({ length: 11 }, hex);
  pass(x1.id, y1.id, 5);
  pass(x2, y2, 5);
  pass(y2, x2, 2);
  pass(x3, y3, 4);
  seed('friend', 10000, [[x3, -10700], [y3, 10000]], NOW - 8 * DAY);
  for (let i = 0; i < 10; i++) seed('friend', 10000, [[x4, -10700], [f4, 10000, 1]], ago(i));
  for (let i = 0; i < 6; i++) seed('friend', 10000, [[x5, -10700], [y5, 5000], [z5, 5000]], ago(i));
  pass(x6, y6, 5);
  // the other way of looking: most of the last 20 matches with one partner, lost to
  const run = (r, s, times, others, kind, at0 = 0) => {
    for (let i = 0; i < times; i++) seed(kind, 100, [[r, -105], [s, 100]], ago(at0 + i));
    for (let i = 0; i < others; i++) seed('pub', 100, [[r, -105], [hex(), 100]], ago(at0 + times + i));
  };
  const [r1, s1, r2, s2, r3, s3, r4, f5] = Array.from({ length: 8 }, hex);
  run(r1, s1, 16, 4, 'pub');
  run(r2, s2, 15, 5, 'pub');
  // sixteen friend matches that are older than 84 public ones are not among the last 20
  run(r3, s3, 16, 0, 'friend', 84);
  for (let i = 0; i < 84; i++) seed('pub', 100, [[r3, -105], [hex(), 100]], ago(i));
  for (let i = 0; i < 20; i++) seed('pub', 100, [[r4, -105], [f5, 100, 1]], ago(i));

  const big = 8e15;
  const me = await guest();
  sql('UPDATE players SET week = ' + WEEK() + ', week_won = ' + (big + 100) + ' WHERE id = ' + who(me));
  sql('UPDATE players SET week = ' + WEEK() + ', week_won = ' + (big + 200) + ', xp = 1e13, level = 200000 WHERE id = ' + who(x1));
  sql('UPDATE players SET week = ' + WEEK() + ', week_won = ' + (big + 150) + ', xp = 9e12, level = 190000 WHERE id = ' + who(y1));
  let top = (await call('GET', '/api/top', me)).body;
  assert.deepStrictEqual(top.week.slice(0, 2).map(r => r.id), [x1.id, y1.id]);
  assert.strictEqual(top.you.rank, 3);

  const hour = Math.floor(NOW / 3600000) * 3600000;
  await tick(hour);
  const open = sql("SELECT id, a, b, x, y FROM flags WHERE kind = 'pair' AND cleared IS NULL AND (a IN ('" + [x1.id, x2, x3, x4, x5, y5, z5, x6, r1, r2, r3, r4].join("', '") + "') OR b IN ('" + [y1.id, s1, s2, s3, y2, y3, f4, f5, y6].join("', '") + "')) ORDER BY id");
  assert.deepStrictEqual(open.map(o => o.a + ' ' + o.b).sort(), [x1.id + ' ' + y1.id, x6 + ' ' + y6, r1 + ' ' + s1].sort(), 'only the one-way pairs and the one-partner run are flagged');
  assert.deepStrictEqual(open.filter(o => o.a === x1.id).map(o => [o.x, o.y]), [[50000, 0]]);
  assert.deepStrictEqual(open.filter(o => o.a === r1).map(o => [o.x, o.y]), [[0, 16]]);
  assert.strictEqual(sql("SELECT count(*) AS n FROM admin_log WHERE who = 'auto' AND action = 'pair' AND target = " + who(x1))[0].n, 1);
  await tick(hour);
  assert.strictEqual(sql("SELECT count(*) AS n FROM flags WHERE kind = 'pair' AND a = " + who(x1))[0].n, 1, 'a second run flags nothing again');
  console.log('pairs: one-way flows and runs of lost matches are flagged, balanced pairs, computer players and mixed partners are not');

  // held out of the rankings
  top = (await call('GET', '/api/top', me)).body;
  assert(!top.week.some(r => r.id === x1.id || r.id === y1.id), 'neither is on the weekly board');
  assert(!top.level.some(r => r.id === x1.id || r.id === y1.id), 'nor on the level board');
  assert.strictEqual(top.you.rank, 1, 'and nobody counts them ahead');
  assert.deepStrictEqual((await call('GET', '/api/top', x1)).body.you, { won: 0, rank: null });
  const listed = (await adm('GET', 'flags', ADMIN, null, '10.9.8.1')).body.flags;
  assert(listed.some(f => f.a === x1.id && f.b === y1.id));

  // clearing brings them back and blocks a new flag for 30 days
  const fid = open.find(o => o.a === x1.id).id;
  assert.strictEqual((await adm('POST', 'clear', ADMIN, { id: fid }, '10.9.8.2')).status, 200);
  assert.strictEqual((await adm('POST', 'clear', ADMIN, { id: fid }, '10.9.8.3')).status, 404);
  top = (await call('GET', '/api/top', me)).body;
  assert.deepStrictEqual(top.week.slice(0, 2).map(r => r.id), [x1.id, y1.id], 'cleared, they are back');
  await tick(hour);
  assert.strictEqual(sql("SELECT count(*) AS n FROM flags WHERE kind = 'pair' AND cleared IS NULL AND a = " + who(x1))[0].n, 0, 'not flagged again soon');
  sql('UPDATE flags SET cleared = cleared - ' + 31 * DAY + ' WHERE id = ' + fid);
  await tick(hour);
  assert.strictEqual(sql("SELECT count(*) AS n FROM flags WHERE kind = 'pair' AND cleared IS NULL AND a = " + who(x1))[0].n, 1, 'after 30 days it can be');
  console.log('pairs: held out of the boards, cleared on the admin page, quiet for 30 days');
  sql("UPDATE players SET week_won = 0, xp = 0, level = 1 WHERE id IN ('" + [me.id, x1.id, y1.id].join("', '") + "')");
}

let section = 'start';
// names on the command line run alone, in the normal order
const only = process.argv.slice(2);
const names = new Set();
// what a seat paid at the deal, from the chip log
const paid = (acc, match) => sql("SELECT reason, delta, ref FROM chip_log WHERE player = " + who(acc) + " AND ref LIKE '" + match + ":%' ORDER BY id");

// the table fee is its own row at the deal, outside what is held, and only a table with a stake has one
async function fee() {
  // a table that is still running holds its players, so every table gets its own
  const mk = async () => level(4, link(await guest()));
  let [a, b, c] = [await mk(), await mk(), await mk()];
  const now = Date.now();
  sql('DELETE FROM personas WHERE created = 1');
  sql('UPDATE personas SET chips = 100, topup = ' + now + ', busy = NULL');
  sql('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 19) INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy, busy_at, created) ' +
    "SELECT lower(hex(randomblob(16))), i, '1,1,1,0', 1, 0, 0, 0, 100000, " + now + ', NULL, 0, 1 FROM n');
  const sit = async (code, acc) => {
    const x = client('/ws/' + code);
    await x.ready;
    x.send({ t: 'join', auth: acc.auth });
    await x.next(m => m.t === 'joined');
    return x;
  };
  const open = async (acc, o) => {
    const x = client('/ws/new');
    await x.ready;
    x.send(Object.assign({ t: 'create', auth: acc.auth, players: 3, games: 3 }, o));
    const j = await x.next(m => m.t === 'joined');
    return [x, j];
  };
  const matchOf = code => sql("SELECT match FROM match_seat WHERE code = '" + code + "' LIMIT 1")[0].match;

  // a friend table: each human pays what is held and the fee, the computer player's bank drops by both
  const [ha, ja] = await open(a, { stake: 100 });
  const hb = await sit(ja.code, b);
  const fins = [played(Object.assign(ha, { seat: ja.seat })), played(hb)];
  const sa = ha.next(m => m.t === 'state');
  ha.send({ t: 'start' });
  const first = await sa;
  assert.deepStrictEqual([first.stake, first.fee, first.hold], [100, 5, 220]);
  const match = matchOf(ja.code);
  for (const acc of [a, b]) {
    assert.deepStrictEqual(paid(acc, match).map(x => [x.reason, x.delta, x.ref]), [['escrow', -220, match + ':in'], ['fee', -5, match + ':fee']]);
  }
  const bots = first.players.filter(p => personaIds([p.pid]) === 1);
  assert.deepStrictEqual(bots.map(p => p.bank), [100000 - 225], 'the computer player pays the same');
  // chips spent mid-match (gifts, say) do not matter: what was held pays the loss, so the payout lands in full
  sql('UPDATE players SET chips = 0 WHERE id = ' + who(a));
  await within(Promise.all(fins), 120000, 'match end');
  await sleep(800);
  const rows = seatsOf(ja.code);
  assert.strictEqual(rows.reduce((n, x) => n + x.net, 0), -15, 'the seats together lose only the fees');
  for (const x of rows.filter(x => !x.fake)) assert.strictEqual(x.net, moved({ id: x.player }, match));
  assert.strictEqual(sql('SELECT chips FROM players WHERE id = ' + who(a))[0].chips, payout(100, 3, ha.st.players[0].chips), 'an empty balance still settles in full');
  console.log('fee: a friend table takes the held amount and the fee, the nets add up to minus the fees');
  ha.ws.close();
  hb.ws.close();

  // a table under 100 pays 5 % of the stake rounded down: nothing at 10, 1 at 20, and none at a stake of 0
  for (const [stake, want] of [[10, 0], [20, 1], [0, 0]]) {
    [a, b] = [await mk(), await mk()];
    const [x, j] = await open(a, { stake: stake });
    const y = await sit(j.code, b);
    const st = x.next(m => m.t === 'state');
    x.send({ t: 'start' });
    const f = await st;
    assert.strictEqual(f.fee, want);
    const fees = sql("SELECT delta FROM chip_log WHERE player = " + who(a) + " AND reason = 'fee' AND ref LIKE '" + matchOf(j.code) + ":%'");
    assert.deepStrictEqual(fees.map(r => r.delta), want ? [-want] : [], 'stake ' + stake);
    x.ws.close();
    y.ws.close();
  }
  console.log('fee: 5 % of a stake under 100, rounded down, and nothing at 0');

  // one who cannot cover what is held and the fee is replaced and pays nothing; one who covers it exactly pays it
  [a, b, c] = [await mk(), await mk(), await mk()];
  const [xa, xj] = await open(a, { stake: 500 });
  const xb = await sit(xj.code, b);
  const xc = await sit(xj.code, c);
  sql('UPDATE players SET chips = 1124 WHERE id = ' + who(b));
  sql('UPDATE players SET chips = 1125 WHERE id = ' + who(c));
  const err = xb.next(m => m.t === 'error');
  const sx = xa.next(m => m.t === 'state');
  xa.send({ t: 'start' });
  assert.strictEqual((await err).k, 'poor', 'one short of 1,125 is replaced');
  await sx;
  const m2 = matchOf(xj.code);
  assert.deepStrictEqual(paid(b, m2), [], 'and pays nothing');
  assert.strictEqual(sql('SELECT chips FROM players WHERE id = ' + who(b))[0].chips, 1124);
  assert.deepStrictEqual(paid(c, m2).map(x => x.delta), [-1100, -25]);
  assert.strictEqual(sql('SELECT chips FROM players WHERE id = ' + who(c))[0].chips, 0);
  assert.deepStrictEqual(seatsOf(xj.code).filter(x => !x.fake).map(x => x.player).sort(), [a.id, c.id].sort(), 'no match row for the replaced seat');
  console.log('fee: a seat that cannot cover held and fee is replaced and pays nothing; exact cover pays');
  for (const x of [xa, xb, xc]) x.ws.close();

  // a public table: the fee of the stake, from the human and from all three computer players
  sql('UPDATE personas SET chips = 100000 WHERE created = 1');
  const hh = await hub(level(4, link(await guest())));
  const ss = hh.next(m => m.t === 'seated');
  hh.send({ t: 'quick', stake: 500 });
  const sat = await ss;
  const r = seated(sat);
  const pub = await r.next(m => m.t === 'state');
  assert.deepStrictEqual([pub.fee, pub.hold], [25, 1300]);
  assert.deepStrictEqual(pub.players.slice(1).map(p => p.bank), [100000 - 1325, 100000 - 1325, 100000 - 1325]);
  r.ws.close();
  hh.ws.close();
  console.log('fee: a public 500 table takes 25 from every seat');
}

// leaving a started public match counts, costs chips from the third in a week and cools the table down
// withdrawing a quick play before the match starts costs nothing and leaves no trace; one that starts on the sit is no leave either
async function quickCancel() {
  const rows = (acc, q) => sql('SELECT count(*) AS n FROM ' + q + ' WHERE player = ' + who(acc))[0].n;
  const acc = await guest();
  const before = sql('SELECT chips FROM players WHERE id = ' + who(acc))[0].chips;
  for (let i = 0; i < 2; i++) {
    const h = await hub(acc);
    const sat = h.next(m => m.t === 'seated' || m.t === 'error');
    h.send({ t: 'quick', stake: 100 });
    const s = await sat;
    assert.strictEqual(s.t, 'seated', 'quick again after a withdrawal: ' + s.k);
    const r = seated(s);
    const room = await r.next(m => m.t === 'room');
    assert(room.seats.some(x => !x), 'the table is still waiting');
    r.send({ t: 'leave' });
    await sleep(400);
    r.ws.close();
    h.ws.close();
  }
  assert.strictEqual(sql('SELECT chips FROM players WHERE id = ' + who(acc))[0].chips, before, 'no stake was taken');
  assert.strictEqual(sql('SELECT count(*) AS n FROM chip_log WHERE player = ' + who(acc) + " AND reason IN ('escrow', 'fee', 'match', 'leave')")[0].n, 0, 'nothing was logged');
  assert.strictEqual(rows(acc, 'leaves') + rows(acc, 'match_seat'), 0, 'no leave and no match');
  console.log('quickCancel: two quick plays withdrawn before the start left nothing behind');

  // the fourth person fills the last seat, so the match starts on the sit and nobody has left
  const four = [];
  for (let i = 0; i < 4; i++) four.push(await guest());
  const socks = [];
  const states = [];
  for (const a of four) {
    const h = await hub(a);
    const sat = h.next(m => m.t === 'seated');
    h.send({ t: 'quick', stake: 100 });
    const r = seated(await sat);
    states.push(r.next(m => m.t === 'state'));
    socks.push(h, r);
  }
  await Promise.all(states);
  for (const a of four) {
    assert.strictEqual(rows(a, 'leaves'), 0, 'no leave row');
    assert.strictEqual(rows(a, 'match_seat'), 1, 'one match');
  }
  for (const c of socks) c.ws.close();
  console.log('quickCancel: a quick play that started on the sit leaves no leave row');
}

async function leaves() {
  const stamp = Date.now();
  sql('DELETE FROM personas WHERE created = 1');
  sql('UPDATE personas SET chips = 100, topup = ' + stamp + ', busy = NULL');
  sql('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 29) INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy, busy_at, created) ' +
    "SELECT lower(hex(randomblob(16))), i, '1,1,1,0', 1, 0, 0, 0, 10000000, " + stamp + ', NULL, 0, 1 FROM n');
  const mk = async (lv, chips) => {
    const acc = level(lv, link(await guest()));
    sql('UPDATE players SET chips = ' + chips + ' WHERE id = ' + who(acc));
    return acc;
  };
  const count = acc => sql('SELECT count(*) AS n FROM leaves WHERE player = ' + who(acc))[0].n;
  const row = acc => sql('SELECT chips, cool_until, cool_stake FROM players WHERE id = ' + who(acc))[0];
  const old = (acc, n, ago) => {
    for (let i = 0; i < n; i++) sql('INSERT INTO leaves (player, match, at, code, stake, kind) VALUES (' + who(acc) + ", 'seed-" + crypto.randomUUID() + "', " + (Date.now() - ago) + ", 'ZZZZ', 500, 'pub')");
  };
  const matchOf = (acc, code) => sql('SELECT match FROM match_seat WHERE player = ' + who(acc) + " AND code = '" + code + "'")[0].match;
  // sits at a public table, waits for the deal and presses Leave
  const quit = async (acc, stake) => {
    const h = await hub(acc);
    const sat = h.next(m => m.t === 'seated' || m.t === 'error');
    h.send({ t: 'quick', stake: stake });
    const s = await sat;
    assert.strictEqual(s.t, 'seated', 'quick at ' + stake + ': ' + s.k);
    const r = seated(s);
    const st = await r.next(m => m.t === 'state');
    r.send({ t: 'leave' });
    await sleep(700);
    r.ws.close();
    h.ws.close();
    return Object.assign({ code: s.code }, st);
  };
  const refusal = async (acc, stake) => {
    const h = await hub(acc);
    const e = h.next(m => m.t === 'seated' || m.t === 'error');
    h.send({ t: 'quick', stake: stake });
    const m = await e;
    h.ws.close();
    return m;
  };
  const penalties = acc => sql('SELECT delta, ref FROM chip_log WHERE player = ' + who(acc) + " AND reason = 'leave'");

  // the first two leaves cost nothing
  const a = await mk(10, 100000);
  await quit(a, 500);
  await quit(a, 500);
  assert.strictEqual(count(a), 2);
  assert.deepStrictEqual(penalties(a), []);
  assert.strictEqual(row(a).cool_until, 0);
  assert.strictEqual(sql("SELECT count(*) AS n FROM flags WHERE kind = 'leave' AND a = " + who(a))[0].n, 0);
  console.log('leaves: the first two cost nothing');

  // the third costs one more stake, flags the account and cools 500 and above for 15 minutes
  sql('UPDATE players SET chips = 100000 WHERE id = ' + who(a));
  const t3 = Date.now();
  const third = await quit(a, 500);
  const match = matchOf(a, third.code);
  assert.strictEqual(count(a), 3);
  assert.deepStrictEqual(penalties(a), [{ delta: -500, ref: match + ':leave' }], 'one more stake, once');
  assert.deepStrictEqual(sql("SELECT x, y FROM flags WHERE kind = 'leave' AND a = " + who(a)), [{ x: 3, y: 500 }]);
  assert.strictEqual(sql("SELECT count(*) AS n FROM admin_log WHERE who = 'auto' AND action = 'leave' AND target = " + who(a))[0].n, 1);
  const c = row(a);
  assert(c.cool_until > t3 + 14 * 60000 && c.cool_until < Date.now() + 16 * 60000, 'cooling for 15 minutes');
  assert.strictEqual(c.cool_stake, 500);
  assert.strictEqual((await call('GET', '/api/me', a)).body.cool.stake, 500);
  for (const stake of [500, 2500]) {
    sql('UPDATE players SET chips = 100000 WHERE id = ' + who(a));
    const e = await refusal(a, stake);
    assert.strictEqual(e.k, 'cool', 'sit at ' + stake);
    assert(e.left > 14 * 60000 - 5000 && e.left <= 15 * 60000, 'the time left comes with it');
  }
  assert.strictEqual((await refusal(a, 100)).t, 'seated', 'a smaller table is open');
  assert.strictEqual((await adm('GET', 'leavers', ADMIN)).body.leavers.find(x => x.id === a.id).n, 3);
  console.log('leaves: the third pays one stake, is flagged, and 500 and above cool for 15 minutes');

  // a table of friends is not covered
  const f = await pair(3, 3, [await mk(10, 100000), await mk(10, 100000)], 500);
  const going = f.a.next(m => m.t === 'state');
  f.a.send({ t: 'start' });
  await going;
  f.b.send({ t: 'leave' });
  await sleep(600);
  assert.strictEqual(count(f.accB), 0, 'friend table leaves count nothing');
  f.a.ws.close();
  f.b.ws.close();

  // the sixth in a week cools for an hour
  const b = await mk(10, 100000);
  old(b, 5, 3600000);
  const t6 = Date.now();
  await quit(b, 500);
  assert.strictEqual(count(b), 6);
  const cb = row(b);
  assert(cb.cool_until > t6 + 59 * 60000 && cb.cool_until < Date.now() + 61 * 60000, 'an hour');
  assert.deepStrictEqual(penalties(b).map(x => x.delta), [-500]);
  console.log('leaves: the sixth cools for an hour');

  // a week old leave does not count
  const d = await mk(10, 100000);
  old(d, 4, 8 * 86400000);
  old(d, 1, 3600000);
  await quit(d, 500);
  assert.deepStrictEqual(penalties(d), [], 'two leaves in the week, so nothing to pay');
  assert.strictEqual(row(d).cool_until, 0);

  // the penalty is at most 2,500, and at most what the player has
  const g = await mk(30, 700000);
  old(g, 2, 3600000);
  await quit(g, 50000);
  assert.deepStrictEqual(penalties(g).map(x => x.delta), [-2500], 'the 50,000 table charges 2,500');
  console.log('leaves: older ones do not count, the penalty is capped at 2,500');

  // a seat gone for the window counts, once; one that is back in time counts nothing
  const h1 = await mk(4, 100000);
  const hh = await hub(h1);
  const sa = hh.next(m => m.t === 'seated');
  hh.send({ t: 'quick', stake: 100 });
  const seat1 = await sa;
  let r1 = seated(seat1);
  const s1 = await r1.next(m => m.t === 'state');
  assert(s1.pub, 'the table says it is a public one');
  r1.ws.close();
  await sleep(300);
  r1 = client('/ws/' + seat1.code);
  await r1.ready;
  r1.send({ t: 'join', token: seat1.token });
  await r1.next(m => m.t === 'joined');
  await sleep(6500);
  assert.strictEqual(count(h1), 0, 'back in time, so nothing counted');
  r1.ws.close();
  for (let i = 0; i < 60 && !count(h1); i++) await sleep(300);
  assert.strictEqual(count(h1), 1, 'gone past the window counts');
  await sleep(3000);
  assert.strictEqual(count(h1), 1, 'and only once');
  assert.strictEqual(sql('SELECT gone FROM match_seat WHERE player = ' + who(h1) + " AND code = '" + seat1.code + "'")[0].gone, 1);
  hh.ws.close();
  console.log('leaves: a seat gone for the window counts once, a quick return counts nothing');

  // the same match counted again, as when a lapsed seat comes back and presses Leave: nothing moves
  const k1 = await mk(4, 100000);
  old(k1, 2, 3600000);
  const kh = await hub(k1);
  const ks = kh.next(m => m.t === 'seated');
  kh.send({ t: 'quick', stake: 100 });
  const kseat = await ks;
  let kr = seated(kseat);
  await kr.next(m => m.t === 'state');
  kr.ws.close();
  for (let i = 0; i < 60 && !penalties(k1).length; i++) await sleep(300);
  assert.strictEqual(count(k1), 3);
  const first = row(k1);
  assert(first.cool_until > 0, 'cooling after the lapse');
  kr = client('/ws/' + kseat.code);
  await kr.ready;
  kr.send({ t: 'join', token: kseat.token });
  await kr.next(m => m.t === 'joined');
  await kr.next(m => m.t === 'state');
  kr.send({ t: 'leave' });
  await sleep(1200);
  assert.strictEqual(count(k1), 3, 'one row per match');
  assert.deepStrictEqual(penalties(k1).length, 1, 'charged once');
  assert.strictEqual(row(k1).cool_until, first.cool_until, 'the cooldown does not move');
  assert.strictEqual(sql("SELECT count(*) AS n FROM flags WHERE kind = 'leave' AND a = " + who(k1))[0].n, 1);
  assert.strictEqual(sql("SELECT count(*) AS n FROM admin_log WHERE action = 'leave' AND target = " + who(k1))[0].n, 1);
  kr.ws.close();
  kh.ws.close();
  console.log('leaves: counting the same match twice changes nothing');

  // the nightly cleanup keeps 35 days, and deleting the account takes its rows
  const T = Date.UTC(2031, 5, 21, 3, 5);
  const seed = (m, at) => sql('INSERT INTO leaves (player, match, at, code, stake, kind) VALUES (' + who(d) + ", '" + m + "', " + at + ", 'PURG', 500, 'pub')");
  seed('old', T - 36 * DAY);
  seed('new', T - 34 * DAY);
  await tick(T);
  assert.deepStrictEqual(sql("SELECT match FROM leaves WHERE code = 'PURG'").map(x => x.match), ['new']);
  assert.strictEqual((await call('DELETE', '/api/me', d)).status, 200);
  assert.strictEqual(count(d), 0, 'deleting the account deletes its leaves');
  console.log('leaves: purged after 35 days, removed with the account');
}

// a seat that lapsed but came back plays the rematch as anyone does: xp for it, and it can lapse again
async function lapseRematch() {
  const t = await seatTwo(100);
  const xp = () => sql('SELECT xp FROM players WHERE id = ' + who(t.accA))[0].xp;
  await t.ra.ready;
  await t.rb.next(m => m.t === 'state');
  const before = xp();
  t.ra.ws.close();
  for (let i = 0; i < 60 && !sql('SELECT count(*) AS n FROM leaves WHERE player = ' + who(t.accA))[0].n; i++) await sleep(300);
  assert.strictEqual(sql('SELECT count(*) AS n FROM leaves WHERE player = ' + who(t.accA))[0].n, 1, 'the lapse counted');
  const back = client('/ws/' + t.A.code);
  await back.ready;
  play(back, { finish: () => {} });
  back.send({ t: 'join', token: t.A.token });
  await within(back.next(m => m.t === 'state' && m.rm, 150000), 160000, 'match end');
  const next = [back, t.rb].map(c => c.next(m => m.t === 'state' && m.phase !== 'matchend'));
  back.send({ t: 'rematch' });
  t.rb.send({ t: 'rematch' });
  await within(Promise.all(next), 30000, 'new match');
  await within(back.next(m => m.t === 'state' && m.rm, 150000), 160000, 'second match end');
  for (let i = 0; i < 30 && xp() === before; i++) await sleep(300);
  assert(xp() > before, 'the rematch gave xp');
  console.log('lapseRematch: a seat that lapsed earns in the rematch');
  for (const c of [back, t.rb, t.a, t.b]) c.ws.close();
}

// a seat that lapsed is a counted leave: from then on it plays like one that pressed Leave, not with the safe moves of a missed turn
async function lapseStandIn() {
  const t = await seatTwo(100);
  await t.rb.next(m => m.t === 'state');
  t.ra.ws.close();
  const lapses = () => sql('SELECT count(*) AS n FROM leaves WHERE player = ' + who(t.accA))[0].n;
  for (let i = 0; i < 100 && !lapses(); i++) await sleep(300);
  assert.strictEqual(lapses(), 1, 'the lapse counted');
  const mark = t.rb.log.length;
  await within(t.offer[1], 150000, 'match end');
  const i = t.rb.st.players.findIndex(p => p.pid === t.accA.id);
  const kinds = new Set(t.rb.log.slice(mark).filter(e => e.p === i && MOVES.includes(e.k)).map(e => e.k));
  assert(['open', 'lay', 'take', 'claim'].some(k => kinds.has(k)), 'the lapsed seat plays on like a leaver, not only draws and discards: ' + [...kinds]);
  console.log('lapseStandIn: a seat that lapsed plays on as a relaxed stand-in');
  for (const c of [t.ra, t.rb, t.a, t.b]) c.ws.close();
}

// no leave from a friend table or a tournament was counted anywhere in the run
function leaveKinds() {
  const n = sql("SELECT count(*) AS n FROM leaves l JOIN match_seat m ON m.match = l.match WHERE m.kind <> 'pub'")[0].n;
  assert.strictEqual(n, 0, 'only public tables count leaves');
  console.log('leaves: none counted from friend tables or cups');
}

// a seat is kept for a player who is slow to open the table's socket, as a phone on a poor connection or a loaded browser is
async function slowJoin() {
  const acc = await guest();
  const h = await hub(acc);
  const s = h.next(m => m.t === 'seated');
  h.send({ t: 'quick', stake: 100 });
  const sat = await s;
  await sleep(600);
  const r = seated(sat);
  await within(r.next(m => m.t === 'room' || m.t === 'state'), 10000, 'the seat is still there after a slow connect');
  console.log('slowJoin: a player who connects to the table late keeps the seat');
  r.ws.close();
  h.ws.close();
}

// who may sit where: level gates on every way into a table, and what a guest may do
async function gates() {
  const need = { 100: 1, 500: 4, 2500: 10, 10000: 20, 50000: 30 };
  const acct = async (lv, signed = true) => {
    const x = await guest();
    if (signed) link(x);
    sql('UPDATE players SET level = ' + lv + ', chips = 100000000 WHERE id = ' + who(x));
    return x;
  };
  const ask = async (acc, o) => {
    const h = await hub(acc);
    const r = h.next(m => m.t === 'error' || m.t === 'seated' || m.t === 'cup' && m.buy);
    h.send(o);
    const m = await r;
    h.ws.close();
    return m;
  };
  const [h0, hello0] = await hello({ auth: (await acct(1)).auth }, m => m.t === 'hub');
  assert.deepStrictEqual([hello0.gate, hello0.cupGate, hello0.fee], [need, { 1000: 1, 5000: 10, 25000: 20 }, { 100: 5, 500: 25, 2500: 125, 10000: 700, 50000: 4000 }]);
  h0.ws.close();

  // quick play: one level short is refused with the level needed, the level itself sits
  for (const stake of [500, 2500, 10000, 50000]) {
    const no = await ask(await acct(need[stake] - 1), { t: 'quick', stake: stake });
    assert.deepStrictEqual([no.k, no.need], ['level', need[stake]], 'quick at ' + stake);
    assert.strictEqual((await ask(await acct(need[stake]), { t: 'quick', stake: stake })).t, 'seated', 'level ' + need[stake] + ' sits at ' + stake);
  }
  assert.strictEqual((await ask(await acct(1), { t: 'quick', stake: 100 })).t, 'seated');
  console.log('gates: 500 needs level 4, 2,500 level 10, 10,000 level 20, 50,000 level 30');

  // cups: 1,000 any level, 5,000 level 10, 25,000 level 20
  for (const [buy, lv] of [[1000, 1], [5000, 10], [25000, 20]]) {
    if (lv > 1) {
      const no = await ask(await acct(lv - 1), { t: 'cup', buy: buy });
      assert.deepStrictEqual([no.k, no.need], ['level', lv], 'cup ' + buy);
    }
    const h = await hub(await acct(lv));
    const ok = h.next(m => m.t === 'cup' && m.buy === buy);
    h.send({ t: 'cup', buy: buy });
    await ok;
    h.send({ t: 'cup', buy: 0 });
    h.ws.close();
  }
  console.log('gates: the 5,000 cup needs level 10, the 25,000 cup level 20');

  // a friend table takes the gate of the highest public stake at or below its own
  const made = async (acc, stake) => {
    const c = client('/ws/new');
    await c.ready;
    const r = c.next(m => m.t === 'joined' || m.t === 'error');
    c.send({ t: 'create', auth: acc.auth, players: 3, games: 3, stake: stake });
    return [await r, c];
  };
  const [no, nc] = await made(await acct(9), 3000);
  assert.deepStrictEqual([no.k, no.need], ['level', 10], 'a 3,000 table uses the 2,500 gate');
  nc.ws.close();
  const [ok, host] = await made(await acct(10), 3000);
  assert.strictEqual(ok.t, 'joined');
  const nine = await acct(9);
  const j = client('/ws/' + ok.code);
  await j.ready;
  j.send({ t: 'join', auth: nine.auth });
  const jn = await j.next(m => m.t === 'error' || m.t === 'joined');
  assert.deepStrictEqual([jn.k, jn.need], ['level', 10], 'and so does a join');
  const [low, lc] = await made(await acct(1), 90);
  assert.strictEqual(low.t, 'joined', 'under 100 any level');
  lc.ws.close();
  j.ws.close();
  host.ws.close();

  // an opened friend table: sitting by its code meets the same gate, while the computer players are still arriving
  const [hl, hk] = [await hub(await acct(3)), await hub(await acct(4))];
  const [op, oc] = await made(await acct(4), 500);
  const opened = oc.next(m => m.t === 'room' && m.finding === 2);
  oc.send({ t: 'start' });
  await opened;
  const sitNo = hl.next(m => m.t === 'error');
  const sitOk = hk.next(m => m.t === 'seated' || m.t === 'error');
  hl.send({ t: 'sit', code: op.code });
  hk.send({ t: 'sit', code: op.code });
  const no2 = await sitNo;
  assert.deepStrictEqual([no2.k, no2.need], ['level', 4], 'sit by code');
  assert.strictEqual((await sitOk).t, 'seated');
  for (const x of [oc, hl, hk]) x.ws.close();
  console.log('gates: friend tables and opened rooms use the gate of their stake');

  // guests: the two smallest tables, nothing above, no cups, no gifts
  const gst = () => acct(30, false);
  assert.strictEqual((await ask(await gst(), { t: 'quick', stake: 100 })).t, 'seated');
  assert.strictEqual((await ask(await gst(), { t: 'quick', stake: 500 })).t, 'seated');
  for (const stake of [2500, 10000, 50000]) assert.strictEqual((await ask(await gst(), { t: 'quick', stake: stake })).k, 'guest', 'guest at ' + stake);
  assert.strictEqual((await ask(await gst(), { t: 'cup', buy: 1000 })).k, 'guest', 'guest at a cup');
  const [gf, gc] = await made(await gst(), 100);
  assert.strictEqual(gf.k, 'guest', 'guest at a friend table with a stake');
  gc.ws.close();
  const g = await pair(3, 3, [await acct(1, false), await acct(1, false)], 0);
  await begin(g);
  const err = g.a.next(m => m.t === 'error');
  g.a.send({ t: 'gift', to: 1, k: 'tea' });
  assert.strictEqual((await err).k, 'guest', 'a guest cannot send a gift');
  assert.strictEqual(sql("SELECT count(*) AS n FROM chip_log WHERE reason = 'gift' AND player = " + who(g.accA))[0].n, 0);
  g.a.ws.close();
  g.b.ws.close();
  console.log('gates: guests sit at 100 and 500 only, no cups, no gifts');
}

// follows a table socket: every state with its time, the log kept as play() keeps it (unless play() has the socket), and the seat counts of the waiting view
function track(c, log = true) {
  c.states = [];
  c.rooms = [];
  c.handlers.push(m => {
    if (m.t === 'room') c.rooms.push([Date.now(), m.seats.filter(Boolean).length]);
    if (m.t !== 'state') return;
    if (log) {
      if (m.lb === 0) c.log = [];
      c.log = c.log.concat(m.log);
    }
    c.st = m;
    c.states.push([Date.now(), m]);
  });
  return c;
}

// three humans at a friend table without chips: the host and two others, none of them playing yet
async function trio() {
  const g = await pair(3, 3, undefined, 0);
  const accX = await guest();
  const x = client('/ws/' + g.code);
  await x.ready;
  x.send({ t: 'join', auth: accX.auth });
  g.jx = await x.next(m => m.t === 'joined');
  return Object.assign(g, { x, accX });
}

const MOVES = ['task', 'draw', 'take', 'claim', 'open', 'lay', 'add', 'finish', 'discard'];
// what the seat of a viewer (0) did, from its log
const byMe = c => c.log.filter(e => e.p === 0 && MOVES.includes(e.k)).map(e => e.k);
const discards = c => c.log.filter(e => e.k === 'discard' && e.p === 0).length;

// a missed clock is a missed turn: the stand-in plays it with safe moves and the player keeps control; the second one in a
// row sets the seat away until the player says back
async function missedClock() {
  let g = await trio();
  const a = track(g.a);
  const fins = [played(g.b), played(g.x)];
  const first = a.next(m => m.t === 'state' && discards(a) === 1);
  a.send({ t: 'start' });
  await within(first, 30000, 'the first clock runs out');
  assert.deepStrictEqual(byMe(a), ['task', 'draw', 'discard'], 'the stand-in chose, drew from the stock and discarded');
  assert.strictEqual(a.st.auto, false, 'one missed turn does not set the seat away');
  assert(a.st.players.every(p => !p.away) && g.b.st.players.every(p => !p.away), 'and nobody sees it away');
  assert.strictEqual(a.st.turn, 1, 'the turn has passed');
  const fresh = a.next(m => m.t === 'state' && m.clock && m.clock.p === 0);
  const away = g.b.next(m => m.t === 'state' && m.players.some(p => p.away));
  const clock = (await within(fresh, 30000, 'the next clock of the seat')).clock;
  assert(clock.left > 0.8 * clock.span, 'the next turn has a full clock: ' + clock.left + ' of ' + clock.span);

  // the second missed turn in a row: away for the others, and the player's own state says so
  await within(a.next(m => m.t === 'state' && m.auto), 60000, 'the second missed turn');
  const seen = (await within(away, 60000, 'the others see it away')).players.filter(p => p.away);
  assert.deepStrictEqual(seen.map(p => p.pid), [g.accA.id]);

  // back: the seat is the player's again, and the count starts over
  const before = discards(a);
  const back = a.next(m => m.t === 'state' && !m.auto);
  const rearmed = a.next(m => m.t === 'state' && !m.auto && m.clock && m.clock.p === 0);
  a.send({ t: 'back' });
  await within(back, 5000, 'back clears away');
  const again = (await within(rearmed, 60000, 'the clock of the seat runs again')).clock;
  assert(again.left > 0.8 * again.span, 'back gives a full clock: ' + again.left + ' of ' + again.span);
  await within(a.next(m => m.t === 'state' && discards(a) > before), 60000, 'the stand-in discards again');
  assert.strictEqual(a.st.auto, false, 'after back one missed turn is not away');
  await within(a.next(m => m.t === 'state' && m.auto), 60000, 'away again after two more');
  console.log('missedClock: a missed turn is played safely, the second in a row sets the seat away, back hands it over');

  // the whole match with the player idle: nothing is claimed, taken, opened or laid for them
  const end = a.next(m => m.t === 'state' && m.phase === 'matchend');
  await within(Promise.all([...fins, end]), 180000, 'the match ends');
  assert(a.states.every(([, m]) => m.players[0].claims === 0), 'claims stay 0');
  assert(byMe(a).every(k => ['task', 'draw', 'discard'].includes(k)), 'only tasks, draws and discards: ' + [...new Set(byMe(a))]);
  for (const c of [g.a, g.b, g.x]) c.ws.close();
  console.log('missedClock: a whole match with the player idle leaves no claim, take or meld');

  // a legal act between two missed turns resets the count
  g = await trio();
  const idle = track(g.a);
  const fins2 = [played(g.b), played(g.x)];
  let own = 0;
  let key = '';
  let sent = '';
  idle.handlers.push(m => {
    if (m.t !== 'state' || m.turn !== 0 || m.phase === 'claim' || m.phase === 'gameend' || m.phase === 'matchend') return;
    const k = m.gameNo + ':' + m.turns;
    if (k !== key) {
      key = k;
      own++;
    }
    if (own !== 2 || sent === k + m.phase) return;
    sent = k + m.phase;
    if (m.phase === 'choose') idle.send({ t: 'act', a: 'choose', id: m.tasksLeft[0] });
    else if (m.phase === 'draw') idle.send({ t: 'act', a: 'draw' });
    else idle.send({ t: 'act', a: 'discard', id: m.players[0].hand[0] });
  });
  const third = idle.next(m => m.t === 'state' && discards(idle) === 3);
  idle.send({ t: 'start' });
  await within(third, 90000, 'three discards');
  assert.strictEqual(idle.st.auto, false, 'a missed turn after a turn of its own is only the first');
  await within(idle.next(m => m.t === 'state' && m.auto), 90000, 'the next missed turn');
  assert.strictEqual(discards(idle), 3, 'the one after it is the second in a row');
  for (const c of [g.a, g.b, g.x]) c.ws.close();
  await Promise.all(fins2.map(p => p.catch(() => {})));
  console.log('missedClock: a legal act resets the count of missed turns');

  // a lost connection: back before any move nothing shows; later the stand-in plays and the seat is away until back
  g = await trio();
  const host = track(g.a);
  const fin3 = played(g.b);
  const started = g.x.next(m => m.t === 'state');
  host.send({ t: 'start' });
  await within(started, 20000, 'the match starts');
  g.x.ws.close();
  const x2 = track(client('/ws/' + g.code));
  await x2.ready;
  const calm = host.next(m => m.t === 'state' && m.players.every(p => !p.away));
  const joined = x2.next(m => m.t === 'state');
  x2.send({ t: 'join', token: g.jx.token });
  assert.strictEqual((await within(joined, 10000, 'the seat comes back')).auto, false, 'a quick return before any move is silent');
  await within(calm, 10000, 'and the others see nobody away');
  assert(!host.log.some(e => e.p === 2 && MOVES.includes(e.k)), 'nothing was played for the seat');
  const drawn = host.next(m => m.t === 'state' && host.log.some(e => e.k === 'draw' && e.p === 2));
  x2.ws.close();
  await within(drawn, 60000, 'the stand-in plays for the seat that is gone');
  const x3 = track(client('/ws/' + g.code));
  await x3.ready;
  const found = x3.next(m => m.t === 'state');
  x3.send({ t: 'join', token: g.jx.token });
  assert.strictEqual((await within(found, 10000, 'the seat comes back again')).auto, true, 'after a move of the stand-in the player finds the seat away');
  const cleared = x3.next(m => m.t === 'state' && !m.auto);
  x3.send({ t: 'back' });
  await within(cleared, 5000, 'back clears it');
  for (const c of [g.a, g.b, x3]) c.ws.close();
  await fin3.catch(() => {});
  console.log('missedClock: a lost connection becomes away only after a stand-in move, and back clears it');
}

// A public table fills inside one window that ends 4 to 8 seconds after the first sit and starts then; somebody of the region looking
// at the lobby stretches it, up to 15 seconds. The tables are made with a window 25 times longer, so a few hundred ms of delay is small.
async function startWindow() {
  const K = 0.02 * 25;
  // a region nobody else uses, so no sleeping lobby socket of another section stretches the window
  const player = () => from('JP', 'AS');
  const sit = async acc => {
    const h = await hub(acc);
    const s = h.next(m => m.t === 'seated');
    h.send({ t: 'quick', stake: 100, scale: 25 });
    const m = await s;
    hubs.push(h);
    return { h, m, at: Date.now() };
  };
  const done = [];
  const hubs = [];
  const join = s => {
    const r = track(seated(s.m), false);
    done.push(played(r));
    return r;
  };
  // the first state of a table, which may have come already
  const to = async r => {
    if (!r.states.length) await within(r.next(m => m.t === 'state'), 30000, 'the table starts');
    return r.states[0][1];
  };

  // alone: a persona every 1 to 2 s, never in the last seat, and the match starts when the window ends
  const A = await sit(await player());
  const ra = join(A);
  await to(ra);
  const at = n => ra.rooms.find(x => x[1] === n);
  assert.deepStrictEqual(ra.rooms.map(x => x[1]).filter((n, i, all) => !i || n !== all[i - 1]), [1, 2, 3, 4], 'one seat at a time: ' + JSON.stringify(ra.rooms.map(x => [x[0] - A.at, x[1]])));
  for (const n of [2, 3]) {
    const gap = at(n)[0] - (n === 2 ? A.at : at(2)[0]);
    assert(gap >= 1000 * K - 150 && gap <= 2000 * K + 600, 'persona ' + (n - 1) + ' comes 1 to 2 s on: ' + gap + ' ms');
  }
  const end = at(4)[0] - A.at;
  assert(end >= 4000 * K - 400 && end <= 8000 * K + 600, 'the last seat is filled when the window ends, 4 to 8 s: ' + end + ' ms');
  assert(ra.states[0][0] >= at(4)[0], 'and the match starts after it');
  console.log('startWindow: a lone player starts 4 to 8 s after sitting, the last seat filled at the end');

  // a second person inside the window sits at the same table, with no retry
  const B1 = await sit(await player());
  const rb1 = join(B1);
  const B2 = await sit(await player());
  assert.strictEqual(B2.m.code, B1.m.code, 'the second player gets the same table');
  const rb2 = join(B2);
  const st = await to(rb1);
  assert.strictEqual(st.players.filter(p => p.pid && personaIds([p.pid]) === 0).length, 2, 'two people');
  assert.strictEqual(st.players.filter(p => p.pid && personaIds([p.pid]) === 1).length, 2, 'and two computer players');
  await to(rb2);
  console.log('startWindow: a second player inside the window gets the same table');

  // somebody looking at the lobby: the start waits up to 15 s
  const L = await hub(await player());
  hubs.push(L);
  const C = await sit(await player());
  const rc = join(C);
  await to(rc);
  const late = rc.states[0][0] - C.at;
  assert(late >= 15000 * K - 600 && late <= 15000 * K + 3500, 'the window is stretched to 15 s: ' + late + ' ms');
  console.log('startWindow: a player in the lobby stretches the window up to 15 s');

  // and that player may take the last seat while it waits: the table starts at once
  const L2 = await player();
  const hl = await hub(L2);
  hubs.push(hl);
  const D = await sit(await player());
  const rd = join(D);
  await sleep(8000 * K + 700);
  assert.strictEqual(rd.states.length, 0, 'still waiting after the longest plain window');
  assert.strictEqual(rd.rooms[rd.rooms.length - 1][1], 3, 'with the last seat open');
  const t1 = Date.now();
  const ss = hl.next(m => m.t === 'seated');
  hl.send({ t: 'quick', stake: 100, scale: 25 });
  const M = await ss;
  assert.strictEqual(M.code, D.m.code, 'the player of the lobby takes the open seat');
  const r2 = join({ m: M });
  await to(rd);
  assert(rd.states[0][0] - t1 < 2500, 'and the table starts when it is full: ' + (rd.states[0][0] - t1) + ' ms');
  assert(rd.states[0][0] - D.at < 15000 * K - 500, 'before the 15 s');
  await to(r2);
  console.log('startWindow: the last seat stays open for a person until the window ends');
  await within(Promise.all(done), 240000, 'the matches end');
  for (const h of hubs) h.ws.close();
  await sleep(500);
}

// a tournament that is cancelled gives each buy-in back once, to everyone who paid it, knocked out or not; the humans only sit and
// miss their clocks, so some are knocked out in the first round
async function cupAbort() {
  const t0 = Date.now();
  const buy = 1000;
  // one withdraws before the start and so never pays
  const w = link(await guest());
  const hw = await hub(w);
  const reg = hw.next(m => m.t === 'cup' && m.buy === buy);
  hw.send({ t: 'cup', buy: buy });
  await reg;
  const out = hw.next(m => m.t === 'cup' && m.buy === 0);
  hw.send({ t: 'cup', buy: 0 });
  await out;
  const hs = [];
  for (let i = 0; i < 4; i++) {
    const acc = link(await guest());
    const h = await hub(acc);
    const x = { acc, h, msgs: [], rooms: [] };
    x.off = h.next(m => m.t === 'error' && m.k === 'cupoff');
    h.handlers.push(m => {
      x.msgs.push(m);
      if (m.t !== 'seated' || !m.cup) return;
      for (const r of x.rooms) r.ws.close();
      x.rooms = [seated(m)];
    });
    hs.push(x);
  }
  for (const x of hs) {
    x.h.send({ t: 'cup', buy: buy });
    await sleep(20);
  }
  // both first-round tables deal, then every table that tries to deal fails: the final cannot be seated
  for (let i = 0; i < 400 && sql("SELECT count(*) AS n FROM match_seat WHERE kind = 'cup' AND at >= " + t0)[0].n < 8; i++) await sleep(50);
  assert.strictEqual(sql("SELECT count(*) AS n FROM match_seat WHERE kind = 'cup' AND at >= " + t0)[0].n, 8, 'the first round is dealt: ' + JSON.stringify(hs.map(x => x.msgs.map(m => m.t + (m.k || '') + (m.n || '')))) + ' personas ' + JSON.stringify(sql('SELECT busy IS NULL AS free, count(*) AS n FROM personas GROUP BY 1')));
  // the first abort fails on every refund, as when the database is down, and is tried again until it works
  sql("CREATE TRIGGER no_back BEFORE INSERT ON chip_log WHEN NEW.ref LIKE '%:back' BEGIN SELECT RAISE(ABORT, 'down'); END");
  breakDeal({ kind: 'cup', n: 99, seat: 0 });
  await sleep(3000);
  assert(hs.every(x => !cupIn(x.acc).some(r => r.ref.endsWith(':back')) && !x.msgs.some(m => m.t === 'error' && m.k === 'cupoff')), 'nothing is refunded while the abort fails');
  sql('DROP TRIGGER no_back');
  await within(Promise.all(hs.map(x => x.off)), 400000, 'the tournament is cancelled');
  mendDeal();
  await sleep(1500);
  const id = cupIn(hs[0].acc)[0].ref.split(':')[0];
  let knocked = 0;
  for (const x of hs) {
    const rows = cupIn(x.acc);
    assert.deepStrictEqual(rows.map(r => [r.delta, r.ref]), [[-buy, id + ':in'], [buy, id + ':back']], 'one buy-in and one refund');
    assert.strictEqual((await call('GET', '/api/me', x.acc)).body.chips, 5000);
    if (x.msgs.some(m => m.t === 'cupout')) knocked++;
  }
  assert(knocked > 0, 'a human who was knocked out is among those refunded');
  assert.strictEqual(cupIn(w).length, 0, 'the player who withdrew paid and got nothing');
  assert.strictEqual(sql("SELECT count(*) AS n FROM chip_log WHERE ref = '" + id + ":back'")[0].n, 4, 'nobody was refunded twice');
  for (let i = 0; i < 100 && sql("SELECT count(*) AS n FROM personas WHERE busy = '" + id + "'")[0].n; i++) await sleep(100);
  assert.strictEqual(sql("SELECT count(*) AS n FROM personas WHERE busy = '" + id + "'")[0].n, 0, 'the computer players are free');
  console.log('cupAbort: all four buy-ins came back once after repeated aborts (' + knocked + ' of them from players who were out), nothing for the one who withdrew');
  for (const x of hs) {
    for (const r of x.rooms) r.ws.close();
    x.h.ws.close();
  }
  hw.ws.close();
}

const sec = async (name, fn) => {
  names.add(name);
  if (only.length && !only.includes(name)) return;
  section = name;
  return fn();
};
// one limit for the whole run, so a stuck wait names the section it was in
setTimeout(() => {
  console.error('watchdog: the run is still in "' + section + '" after ' + WATCHDOG / 60000 + ' minutes');
  process.exit(1);
}, WATCHDOG);
process.on('unhandledRejection', e => {
  console.error('in "' + section + '":', e);
  process.exit(1);
});
(async () => {
  ({ payout, hold, feeFor, maxLoss, barred, cupBarred, strongFor } = await import('../src/account.js'));
  await sec('schema', () => schema());
  await sec('math', () => math());
  await sec('accounts', () => accounts());
  await sec('apple', () => apple());
  await sec('races', () => races());
  await sec('solo', () => solo());
  await sec('lobby', () => lobby());
  await sec('friends', () => friends());
  await sec('silent', () => silent());
  await sec('limits', () => limits());
  await sec('probe', () => probe());
  await sec('tables', () => tables());
  await sec('busy', () => busy());
  await sec('lone', () => lone());
  await sec('forfeit', () => forfeit());
  await sec('friendRules', () => friendRules());
  await sec('words', () => words());
  await sec('chat', () => chat());
  await sec('talk', () => talk());
  await sec('tongues', () => tongues());
  await sec('gifts', () => gifts());
  await sec('invites', () => invites());
  await sec('push', () => push());
  await sec('dms', () => dms());
  const sfu = fakeSfu();
  await sfu.server.listening$;
  await sec('voice', () => voice(sfu));
  await sec('calls', () => calls(sfu));
  sfu.server.close();
  await sec('purge', () => purge());
  await sec('matchlog', () => matchlog());
  const rs = fakeResend();
  await rs.server.listening$;
  await sec('admin', () => admin());
  await sec('chipfn', () => chipfn());
  await sec('dealfail', () => dealfail());
  await sec('typedOff', () => typedOff());
  await sec('trade', () => trade());
  await sec('reports', () => reports());
  await sec('reportMail', () => reportMail(rs));
  await sec('personas', () => personas());
  await sec('pool', () => pool());
  await sec('strong', () => strong());
  await sec('flow', () => flow());
  await sec('slowJoin', () => slowJoin());
  await sec('fee', () => fee());
  await sec('gates', () => gates());
  await sec('leaves', () => leaves());
  await sec('quickCancel', () => quickCancel());
  await sec('lapseRematch', () => lapseRematch());
  await sec('lapseStandIn', () => lapseStandIn());
  await sec('missedClock', () => missedClock());
  await sec('startWindow', () => startWindow());
  await sec('openRoom', () => openRoom());
  await sec('whereabouts', () => whereabouts());
  await sec('boards', () => boards());
  await sec('rematchPersona', () => rematchPersona());
  await sec('computerFriends', () => computerFriends());
  await sec('board', () => board());
  await sec('fixes', () => fixes());
  await sec('held', () => held());
  await sec('pace', () => pace());
  await sec('friendTables', () => friendTables());
  await sec('noRetake', () => noRetake());
  await sec('regions', () => regions());
  await sec('rematchBoth', () => rematchBoth());
  await sec('rematchOne', () => rematchOne());
  await sec('rematchAway', () => rematchAway());
  await sec('rematchNone', () => rematchNone());
  await sec('rematchFriends', () => rematchFriends());
  await sec('cupCancel', () => cupCancel());
  await sec('cupPoor', () => cupPoor());
  await sec('cupGone', () => cupGone());
  await sec('cupHello', () => cupHello());
  await sec('cupRetry', () => cupRetry());
  await sec('cupRun', () => cupRun(2));
  await sec('cupRun', () => cupRun(6));
  await sec('cupRun', () => cupRun(2, 5000));
  await sec('cupAbort', () => cupAbort());
  await sec('leaveKinds', () => leaveKinds());
  await sec('friendLimits', () => friendLimits());
  await sec('heldWins', () => heldWins());
  await sec('pairs', () => pairs());
  await sec('metrics', () => metrics());
  const rc = fakeRc();
  await rc.server.listening$;
  await sec('shop', () => shop(rc));
  await sec('vip', () => vip(rc));
  await sec('sandbox', () => sandbox());
  await sec('country', () => country());
  await sec('cap', () => cap());
  rc.server.close();
  rs.server.close();
  const bad = only.filter(x => !names.has(x));
  if (bad.length) throw new Error('no such section: ' + bad.join(', ') + ' (have ' + [...names].join(' ') + ')');
  console.log('ok');
  reached = true;
  process.exit(0);
})().catch(e => {
  console.error('in "' + section + '":', e);
  process.exit(1);
});
