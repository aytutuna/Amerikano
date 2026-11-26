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
let payout;

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
const TOP = new Set(['t', 'lb', 'n', 'stake', 'fast', 'res', 'games', 'gameNo', 'level', 'pot', 'phase', 'task', 'tasksLeft', 'turn', 'cutter',
  'chooser', 'clock', 'rm', 'cup', 'turns', 'justOpened', 'stock', 'discard', 'melds', 'claim', 'players', 'result', 'stats', 'lastFin', 'final', 'log']);
const RM = new Set(['left', 'want', 'mine']);
const CUP = new Set(['round', 'buy', 'prizes', 'place', 'through']);
const SEAT = new Set(['name', 'pid', 'seed', 'av', 'level', 'bank', 'away', 'n', 'opened', 'claims', 'chips', 'score', 'hand', 'wear', 'vip']);

let ips = 0;

async function call(method, path, acc, body, origin, extra) {
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

function client(path, origin) {
  const c = { handlers: [], log: [], errors: [], seen: 0, recent: [] };
  c.ws = new WebSocket(base + path, { headers: origin ? { Origin: origin } : {} });
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
  sql("UPDATE players SET xp = 95 WHERE id = '" + accA.id + "'");
  const a = client('/ws/new', 'https://amerikano.pages.dev');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: 5, games: 5, level: 'sharp' });
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
    const back = payout(100, view.players[0].chips);
    const bonus = acc === accA ? 2000 : 0;
    assert.strictEqual(p.chips, 5000 - 100 + back + bonus, who + ' chips after escrow and payout');
    assert.strictEqual(view.res.net, back - 100, who + ' result in the view');
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
  ({ payout } = await import('../src/account.js'));
  assert.strictEqual(payout(100, 0), 100);
  assert.strictEqual(payout(100, 25), 350);
  assert.strictEqual(payout(500, -10), 0);
  assert.strictEqual(payout(500, -14), -200);
  assert.strictEqual(payout(2500, 40), 12500);
  assert.strictEqual(payout(50000, -3), 35000);
  console.log('payout: stake back plus chips at stake/10, a loss past the stake is charged');
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
  const poor = await guest();
  sql("UPDATE players SET chips = 4999 WHERE id = '" + poor.id + "'");
  const p = await hub(poor);
  const no = p.next(m => m.t === 'error');
  p.send({ t: 'quick', stake: 500 });
  assert.strictEqual((await no).k, 'poor');
  p.ws.close();

  const a = await hub(accA);
  const b = await hub(accB);
  b.send({ t: 'watch', stake: 100 });
  const sa = a.next(m => m.t === 'seated');
  const seen = b.next(m => m.t === 'tables' && m.tables.some(x => x.seats.filter(Boolean).length === 1));
  a.send({ t: 'quick', stake: 100 });
  const A = await sa;
  const listed = await seen;
  assert(listed.tables.some(x => x.code === A.code), 'the new table is listed for watchers');
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
    const back = payout(100, c.st.players[0].chips);
    const me = (await call('GET', '/api/me', acc)).body;
    assert.strictEqual(me.chips, 5000 - 100 + back, who + ' chips');
    assert.strictEqual(c.st.res.net, back - 100);
    const rows = sql("SELECT reason, delta FROM chip_log WHERE player = '" + acc.id + "' AND reason IN ('escrow', 'match') ORDER BY id");
    assert.deepStrictEqual(rows.map(x => x.reason), back ? ['escrow', 'match'] : ['escrow']);
    assert.strictEqual(rows[0].delta, -100);
    console.log(who, 'stake 100, payout', back, 'chips', me.chips, 'xp', me.xp);
  }
  const keys = sql("SELECT ref FROM chip_log WHERE player = '" + accA.id + "' AND reason = 'escrow'");
  assert.throws(() => sql("INSERT INTO chip_log (player, delta, reason, at, ref) VALUES ('" + accA.id + "', -100, 'escrow', 0, '" + keys[0].ref + "')"));
  console.log('a second escrow with the same ref is refused');
  const after = b.next(m => m.t === 'tables');
  b.send({ t: 'watch', stake: 100 });
  assert(!(await after).tables.some(x => x.code === A.code), 'a finished match is not listed');
  ra.ws.close();
  rb.ws.close();
  a.ws.close();
  b.ws.close();
}

async function lone() {
  const acc = await guest();
  const h = await hub(acc);
  const s = h.next(m => m.t === 'seated');
  h.send({ t: 'quick', stake: 500 });
  const sat = await s;
  const r = seated(sat);
  const st = await r.next(m => m.t === 'state');
  leakCheck(st);
  assert.strictEqual(st.players.filter(p => p.pid && personaIds([p.pid]) === 1).length, 3);
  assert.strictEqual(st.stake, 500);
  await new Promise(x => setTimeout(x, 300));
  assert.strictEqual((await call('GET', '/api/me', acc)).body.chips, 4500);
  console.log('lone player: bots fill the table after the wait, stake 500 taken');
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
  const acc = await guest();
  const poor = await guest();
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
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: 2, games: 2, level: 'relaxed', stake: 500 });
  const ja = await a.next(m => m.t === 'joined');
  const b = client('/ws/' + ja.code);
  await b.ready;
  b.send({ t: 'join', auth: accB.auth });
  await b.next(m => m.t === 'joined');
  const poor = await guest();
  sql("UPDATE players SET chips = 4999 WHERE id = '" + poor.id + "'");
  const c = client('/ws/' + ja.code);
  await c.ready;
  c.send({ t: 'join', auth: poor.auth });
  assert.strictEqual((await c.next(m => m.t === 'error')).k, 'poor');
  const fin = played(Object.assign(a, { seat: ja.seat }));
  a.send({ t: 'start' });
  await b.next(m => m.t === 'state');
  b.send({ t: 'leave' });
  await within(fin, 120000, 'match end');
  await new Promise(r => setTimeout(r, 600));
  assert.strictEqual((await call('GET', '/api/me', accB)).body.chips, 4500, 'the leaver loses the escrow');
  assert.deepStrictEqual(sql("SELECT reason FROM chip_log WHERE player = '" + accB.id + "' AND reason <> 'start'").map(x => x.reason), ['escrow']);
  const back = payout(500, a.st.players[0].chips);
  assert.strictEqual((await call('GET', '/api/me', accA)).body.chips, 4500 + back);
  console.log('forfeit: the leaver lost the 500 escrow, the other got', back);
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
  const acc = await guest();
  const c = client('/ws/new');
  await c.ready;
  c.send({ t: 'create', auth: acc.auth, players: 2, games: 2, level: 'relaxed' });
  await c.next(m => m.t === 'joined');
  const rooms = [];
  c.handlers.push(m => { if (m.t === 'room') rooms.push(m); });
  c.send({ t: 'start' });
  await c.next(m => m.t === 'state' && m.phase === 'matchend');
  await new Promise(r => setTimeout(r, 500));
  const p = (await call('GET', '/api/me', acc)).body;
  assert.strictEqual(p.games + p.xp + p.tokens, 0, 'a player who never moved earns nothing');
  assert.strictEqual(sql("SELECT week_won AS n FROM players WHERE id = '" + acc.id + "'")[0].n, 0, 'nor weekly chips');
  assert(rooms.some(m => m.finding === 1), 'the waiting view says one seat is being filled');
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

  const burst = await Promise.all([1, 2, 3, 4].map(async i => post('/api/apple', null, await cred({ sub: racer }, null, 'r' + i))));
  const racer = 'race.' + t.sub;
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
async function pair(n, games, accs) {
  const accA = accs ? accs[0] : await guest();
  const accB = accs ? accs[1] : await guest();
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: n, games: games, level: 'relaxed' });
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
  assert.strictEqual(await chips(g.accA), 4900);
  const seen = g.a.next(m => m.t === 'gifted');
  const bank = g.a.next(m => m.t === 'state' && m.players[0].bank === 4850);
  g.a.send({ t: 'gift', to: 1, k: 'tea' });
  const e = await seen;
  assert.deepStrictEqual([e.from, e.to, e.k], [0, 1, 'tea']);
  await bank;
  await sleep(100);
  // B sits after A, so B counts A as the last seat and itself as 0
  assert.deepStrictEqual([sent[0].from, sent[0].to], [2, 0], 'the target sees the gift as sent to them');
  assert.strictEqual(await chips(g.accA), 4850);
  assert.strictEqual(await chips(g.accB), 4900, 'nobody receives the chips');
  assert.deepStrictEqual(sql('SELECT delta, reason FROM chip_log WHERE player = ' + who(g.accA) + " AND reason = 'gift'"), [{ delta: -50, reason: 'gift' }]);
  console.log('gift: 50 chips charged once, shown to both, not paid to the target');

  g.a.send({ t: 'gift', to: 0, k: 'tea' });
  g.a.send({ t: 'gift', to: 3, k: 'tea' });
  g.a.send({ t: 'gift', to: 1, k: 'gold' });
  await sleep(300);
  assert.strictEqual(sent.length, 1, 'self, out of range and unknown gifts are dropped');
  assert.strictEqual(await chips(g.accA), 4850);
  const bot = g.a.next(m => m.t === 'gifted' && m.to === 2);
  g.a.send({ t: 'gift', to: 2, k: 'tea' });
  await bot;
  assert.strictEqual(await chips(g.accA), 4800, 'a bot seat is charged too');

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
  const f = await guest();
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
  const acc = await guest();
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
  assert.deepStrictEqual(steps.filter((n, i) => i === 0 || n !== steps[i - 1]), [1, 2, 3], 'seats fill one at a time before the table starts');
  const two = counts.find(x => x[1] === 2)[0];
  assert(two - t0 >= 60, 'the first fill waits a while: ' + (two - t0) + 'ms');
  const st = r.st;
  assert.strictEqual(st.players.length, 4);
  const others = st.players.slice(1);
  assert.strictEqual(personaIds(others.map(p => p.pid)), 3);
  for (const p of others) {
    const row = sql("SELECT vip, wear FROM personas WHERE id = '" + p.pid + "'")[0];
    assert([0, 1].includes(row.vip), 'a persona is decided as VIP or not once: ' + row.vip);
    assert.strictEqual(p.vip, row.vip === 1, 'the seat shows what the persona is');
    assert.strictEqual((await call('GET', '/api/player/' + p.pid, acc)).body.vip, p.vip, 'and so does the card');
    assert(row.vip === 1 || !Object.values(JSON.parse(row.wear)).some(id => Catalog.item(id).vip), 'only a VIP persona wears VIP items');
  }
  for (const p of others) {
    assert(p.level >= 1 && p.level <= 4, 'level near the human: ' + p.level);
    assert(p.bank >= 500 * 9, 'plausible chips: ' + p.bank);
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
  const said = all.filter(m => m.t === 'said');
  for (const m of said) assert(m.p >= 1 && m.p < 4 && (Chat.SAY.includes(m.k) || Chat.EMO.includes(m.k) || Catalog.pack(m.k)));
  assert(said.length <= 4, 'chat is capped per match');
  await sleep(600);
  const me = (await call('GET', '/api/me', acc)).body;
  assert.strictEqual(me.chips, 5000 - 500 + payout(500, st.players[0].chips));
  assert.strictEqual(sql("SELECT count(*) AS n FROM chip_log WHERE player IN (SELECT id FROM personas)")[0].n, 0, 'personas never touch the chip log');
  assert.strictEqual(sql("SELECT count(*) AS n FROM players WHERE id IN (SELECT id FROM personas)")[0].n, 0);
  assert(me.xp >= 40 && me.games === 1, 'a match against personas counts: xp ' + me.xp);
  assert.strictEqual(me.xp, 40 + (st.final.low === 0 ? 30 : 0) + 5 * st.stats.filter(x => x.fin === 0).length);
  const board = (await call('GET', '/api/player/' + acc.id, acc)).body;
  assert.strictEqual(board.won, st.res.net > 0 ? st.res.net : 0, 'and so does the weekly board');
  console.log('personas: a lone human got a full table, ' + said.length + ' chat, ' + gaps.length + ' paced moves, settled');

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
  const top = (await call('GET', '/api/top', acc)).body;
  assert(![...top.week, ...top.level].some(x => x.id === pid), 'personas are not ranked');
  assert.strictEqual((await call('DELETE', '/api/friend/' + pid, acc)).status, 200);
  assert.strictEqual((await call('GET', '/api/player/' + pid, acc)).body.rel, 'none');
  assert.strictEqual((await call('GET', '/api/friends', acc)).body.outgoing.length, 0);
  console.log('persona profile: same shape, friend request stays pending and can be cancelled');
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
  const host = client('/ws/new');
  await host.ready;
  host.send({ t: 'create', auth: a.auth, players: 3, games: 3, level: 'relaxed', stake: 500 });
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

  // two humans: the winner's net is counted, and a player from an earlier week starts again
  const g = await pair(2, 2);
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
    assert.strictEqual(p.won, net > 0 ? net : 0, 'weekly chips ' + p.won + ' for net ' + net);
    assert.strictEqual(sql('SELECT week AS n FROM players WHERE id = ' + who(acc))[0].n, net > 0 ? w : w - 1);
    const pv = sql('SELECT prev_week, prev_won FROM players WHERE id = ' + who(acc))[0];
    assert.deepStrictEqual([pv.prev_week, pv.prev_won], net > 0 ? [w - 1, 999] : [0, 0], 'a new week keeps the old one for the weekly push');
    console.log('two humans: net', net, 'counted', p.won);
  }
  g.a.ws.close();
  g.b.ws.close();
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
}

// personas are shared by id: busy at one table, chips and stats settled, only the ones who can cover the stake
async function pool() {
  const day = 86400000;
  const now = Date.now();
  sql('DELETE FROM personas WHERE created = 1');
  sql('UPDATE personas SET chips = 100, topup = ' + now + ', busy = NULL');
  sql('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 19) INSERT INTO personas (id, name_seed, avatar, level, xp, games, wins, chips, topup, busy, busy_at, created) ' +
    "SELECT lower(hex(randomblob(16))), i, '1,1,1,0', 1, 0, 0, 0, 100000, " + (now - 3 * day) + ', NULL, 0, 1 FROM n');
  const rich = sql('SELECT id FROM personas WHERE created = 1').map(x => x.id);
  assert.strictEqual(rich.length, 20);

  const stakes = [100, 500, 2500];
  const accs = [await guest(), await guest(), await guest()];
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
      assert.strictEqual(p.bank, 100000 + 3 * 750 - runs[n].stake, 'the days since the last top-up are paid before the stake is taken');
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
      assert.strictEqual(row.chips, Math.max(firsts[n].players[k].bank + payout(x.stake, p.chips), 0), 'chips settled like a player');
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
}

// a private room whose host starts with empty seats is found by quick play, and the match counts for both humans
async function openRoom() {
  const [host, x] = [await guest(), await guest()];
  const c = client('/ws/new');
  await c.ready;
  c.send({ t: 'create', auth: host.auth, players: 4, games: 4, level: 'relaxed', stake: 500 });
  const ja = await c.next(m => m.t === 'joined');
  const rooms = [];
  c.handlers.push(m => { if (m.t === 'room') rooms.push(m); });
  await sleep(400);
  assert(rooms.every(m => m.finding === 0 && m.seats.filter(Boolean).length === 1), 'nobody comes before the host starts');
  const hx = await hub(x);
  hx.send({ t: 'watch', stake: 500 });
  const listed = hx.next(m => m.t === 'tables' && m.tables.some(t => t.code === ja.code));
  const open = c.next(m => m.t === 'room' && m.finding === 3);
  c.send({ t: 'start' });
  await open;
  assert((await listed).tables.find(t => t.code === ja.code).seats.filter(Boolean).length >= 1, 'listed once opened');
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
  const host = client('/ws/new');
  await host.ready;
  host.send({ t: 'create', auth: b.auth, players: 4, games: 4, level: 'relaxed', stake: 100 });
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
  const host = client('/ws/new');
  await host.ready;
  host.send({ t: 'create', auth: b.auth, players: 4, games: 4, level: 'relaxed', stake: 100 });
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
  const g = await pair(2, 2);
  await begin(g);
  const hx = await hub(g.accB);
  const busy = hx.next(m => m.t === 'error');
  hx.send({ t: 'quick', stake: 100 });
  assert.strictEqual((await busy).k, 'busy');
  console.log('start refused with held and the socket kept, a started private room counts as a seat');
  for (const c of [g.a, g.b, hx]) c.ws.close();
}

// fast tables are their own pool with a shorter turn clock; a friend table takes the switch too
async function fast() {
  const [a, b, c] = [await guest(), await guest(), await guest()];
  const span = async (acc, fastOn) => {
    const h = await hub(acc);
    const s = h.next(m => m.t === 'seated');
    h.send({ t: 'quick', stake: 100, fast: fastOn });
    const sat = await s;
    const r = seated(sat);
    const room = await r.next(m => m.t === 'room');
    assert.strictEqual(room.fast, fastOn);
    const st = await r.next(m => m.t === 'state' && m.clock);
    leakCheck(st);
    assert.strictEqual(st.fast, fastOn);
    return { code: sat.code, span: st.clock.span, close: () => { r.ws.close(); h.ws.close(); } };
  };
  const f = await span(a, true);
  const n = await span(b, false);
  assert.notStrictEqual(f.code, n.code, 'a normal quick play does not sit at a fast table');
  const k = n.span / 30000;
  assert.strictEqual(f.span, 15000 * k);
  const f2 = await span(c, true);
  assert.notStrictEqual(f2.code, n.code);
  const host = client('/ws/new');
  await host.ready;
  host.send({ t: 'create', auth: a.auth, players: 3, games: 3, level: 'relaxed', stake: 100, fast: true });
  assert.strictEqual((await host.next(m => m.t === 'room')).fast, true);
  console.log('fast: own pool, clock span ' + f.span + ' against ' + n.span + ', friend table fast');
  for (const x of [f, n, f2]) x.close();
  host.ws.close();
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
  const [a, c, b, w] = [await from('DE', 'EU'), await from('FR', 'EU'), await from('TR', 'AS'), await from('TR', 'AS')];
  const [ha, hc, hb, hw] = [await hub(a), await hub(c), await hub(b), await hub(w)];
  const lists = [new Set(), new Set()];
  for (const [h, set] of [[hc, lists[0]], [hw, lists[1]]]) {
    h.handlers.push(m => m.t === 'tables' && m.tables.forEach(x => set.add(x.code)));
    h.send({ t: 'watch', stake: 100 });
  }
  const sa = ha.next(m => m.t === 'seated');
  ha.send({ t: 'quick', stake: 100 });
  const A = await sa;
  const sb = hb.next(m => m.t === 'seated');
  hb.send({ t: 'quick', stake: 100 });
  const B = await sb;
  assert.notStrictEqual(A.code, B.code, 'a Turkish player does not sit at a European table');
  assert(LEADS.eu.includes(A.code[0]) && LEADS.tr.includes(B.code[0]), 'a table code carries its region');
  const sc = hc.next(m => m.t === 'seated');
  hc.send({ t: 'quick', stake: 100 });
  assert.strictEqual((await sc).code, A.code, 'the same region still matches');
  await sleep(300);
  assert(lists[0].has(A.code) && !lists[0].has(B.code), 'a European watcher sees European tables only');
  assert(lists[1].has(B.code) && !lists[1].has(A.code), 'a Turkish watcher sees Turkish tables only');
  console.log('regions: quick play and public lists stay inside the region');

  // the list and the next quick play follow a change of region
  const [x, y] = [await from('DE', 'EU'), await from('TR', 'AS')];
  const [hx, hy] = [await hub(x), await hub(y)];
  const sx = hx.next(m => m.t === 'seated');
  hx.send({ t: 'quick', stake: 500 });
  const X = await sx;
  const empty = hy.next(m => m.t === 'tables');
  hy.send({ t: 'watch', stake: 500 });
  assert.strictEqual((await empty).tables.length, 0, 'the other region has no table');
  const shown = hy.next(m => m.t === 'tables' && m.tables.some(t => t.code === X.code));
  await call('POST', '/api/region', y, { region: 'eu' });
  await shown;
  const sy = hy.next(m => m.t === 'seated');
  hy.send({ t: 'quick', stake: 500 });
  assert.strictEqual((await sy).code, X.code, 'quick play follows the new region');
  console.log('regions: changing region moves the open lobby');

  // friends meet across regions: an invite, then a seat at the friend's table
  const [f1, f2] = [await from('GB', 'EU'), await from('JP', 'AS')];
  await befriend(f1, f2);
  const [h1, h2] = [await hub(f1), await hub(f2)];
  const s1 = h1.next(m => m.t === 'seated');
  h1.send({ t: 'quick', stake: 100 });
  const F = await s1;
  const r1 = seated(F);
  await r1.next(m => m.t === 'room');
  const inv = h2.next(m => m.t === 'invited');
  r1.send({ t: 'invite', to: f2.id });
  assert.strictEqual((await inv).code, F.code);
  const s2 = h2.next(m => m.t === 'seated');
  h2.send({ t: 'sit', code: F.code });
  assert.strictEqual((await s2).code, F.code, 'a friend from another region sits at the table');
  console.log('regions: friends invite and join across regions');

  // a tournament form is per region: a player of another region starts alone, one of the same region joins
  const [t1, t2, t3] = [await from('DE', 'EU'), await from('TR', 'AS'), await from('NL', 'EU')];
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
  for (const h of [ha, hb, hc, hw, hx, hy, h1, h2, g1, g2, g3]) h.ws.close();
  r1.ws.close();
}

// two humans quick-play the same table at this stake; the personas fill the rest
async function seatTwo(stake) {
  let accA, accB, a, b, A, B;
  // the table fills with computer players after 80 to 160 ms, so on a slow machine the second one can land at the next table
  for (let i = 0; ; i++) {
    accA = await guest();
    accB = await guest();
    a = await hub(accA);
    b = await hub(accB);
    const sa = a.next(m => m.t === 'seated');
    a.send({ t: 'quick', stake: stake });
    A = await sa;
    const sb = b.next(m => m.t === 'seated');
    b.send({ t: 'quick', stake: stake });
    B = await sb;
    if (B.code === A.code) break;
    assert(i < 4, 'two quick players share a table: ' + A.code + ' ' + B.code);
    console.log('seatTwo: the second player was seated at another table, trying again');
    a.ws.close();
    b.ws.close();
  }
  const t = { accA, accB, a, b, A, B, ra: seated(A), rb: seated(B) };
  t.offer = [t.ra, t.rb].map(c => c.next(m => m.t === 'state' && m.rm, 150000));
  for (const c of [t.ra, t.rb]) play(c, { finish: () => {} });
  return t;
}

const escrows = acc => sql("SELECT ref FROM chip_log WHERE player = '" + acc.id + "' AND reason = 'escrow'").map(x => x.ref);

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
  const acc = await guest();
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
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: 2, games: 2, level: 'relaxed', stake: 100 });
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
  console.log('rematch: a friend table dealt again');
  a.ws.close();
  b.ws.close();
}

const cupIn = acc => sql("SELECT delta, ref FROM chip_log WHERE reason = 'cup' AND player = '" + acc.id + "' ORDER BY id");

// withdrawing, by message or by closing the app, costs nothing and frees the player
async function cupCancel() {
  const acc = await guest();
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
  await h.next(m => m.t === 'cup' && m.n >= 3);
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
  const acc = await guest();
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
  const acc = await guest();
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
async function cupRun(n) {
  const buy = 1000;
  const prizes = [4000, 2000, 1200, 800];
  const hs = [];
  let snap = null;
  for (const acc of await Promise.all(Array.from({ length: n }, guest))) {
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

  let paid = 0;
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
    paid += end.prize;
    console.log('tournament: a human placed ' + end.place + ' at the final and got ' + end.prize);
  }
  const after = sql('SELECT sum(chips) AS n FROM personas WHERE id IN (' + ids() + ')')[0].n;
  paid += after - snap.rows.reduce((n, r) => n + r.chips, 0);
  const unpaid = 8 * buy - paid;
  assert(n === 6 ? [0, ...prizes].includes(unpaid) : unpaid === 0, 'the pool was paid out, less the share of a leaver: ' + unpaid);
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
const tzAt = (now, h) => ((Math.floor(now % DAY / 60000) - h * 60 - 30 + 720) % 1440 + 1440) % 1440 - 720;
// the tz of a device that reads half past noon now, so a test is never inside the quiet hours of invites and messages
const noonTz = () => tzAt(Date.now(), 12);

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
  assert.deepStrictEqual(await shopOf(a), { tokens: 0, owned: [], worn: {}, vipUntil: 0, earned: 0, cap: 20 });
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
  const g = await pair(2, 2, [x, y]);
  const [sx, sy] = await begin(g);
  const seen = { a: [], b: [] };
  g.a.handlers.push(m => { if (m.t === 'said') seen.a.push(m.k); });
  g.b.handlers.push(m => { if (m.t === 'said') seen.b.push(m.k); });
  assert.deepStrictEqual(sx.players[0].wear, { frame: 'frame-royal', plate: 'plate-gilt', back: 'back-sultan' }, 'worn items travel in the seat, the felt stays private');
  assert.deepStrictEqual(sy.players[1].wear, sx.players[0].wear);
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
  sql("DELETE FROM token_log WHERE ref LIKE 'rc:%' OR ref LIKE 'refund:%'");
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
  rc.vip[n.id] = { expires_date: new Date(u1).toISOString() };
  s = (await call('POST', '/api/shop/sync', n)).body;
  assert.deepStrictEqual([s.tokens, s.vipUntil], [0, u1]);

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
  const g = await pair(2, 2, [a, plain]);
  const [sa, sp] = await begin(g);
  assert.deepStrictEqual([sa.players[0].vip, sa.players[1].vip, sp.players[0].vip, sp.players[1].vip], [true, false, false, true]);
  assert.deepStrictEqual(sp.players[1].wear, gold, 'the others see the VIP items');
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
  const g2 = await pair(2, 2, [a, plain]);
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
}

// the day's earnings stop at the cap, and a new UTC day starts again
async function cap() {
  const acc = await guest();
  const day = Math.floor(Date.now() / DAY);
  const match = async () => {
    const c = client('/ws/new');
    await c.ready;
    c.send({ t: 'create', auth: acc.auth, players: 2, games: 2, level: 'relaxed' });
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

async function reports() {
  const g = await pair(3, 3);
  const [sa, sb] = await begin(g);
  const seatB = sa.players.findIndex(p => p.pid === g.accB.id);
  const seatA = sb.players.findIndex(p => p.pid === g.accA.id);
  await befriend(g.accA, g.accB);
  // only accounts at least a day old count as reporters
  const aged = async () => {
    const x = await guest();
    sql('UPDATE players SET created = created - ' + 2 * DAY + ' WHERE id = ' + who(x));
    return x;
  };
  const [r1, r2, r3] = [await aged(), await aged(), await aged()];
  const rep = (from, to, o) => call('POST', '/api/report', from, Object.assign({ pid: to.id, text: 'rude words', ctx: g.code }, o));
  const rows = who => sql('SELECT reporter, reported, text, ctx FROM reports WHERE reported = ' + who);
  const muted = acc => sql('SELECT mute_until FROM players WHERE id = ' + who(acc))[0].mute_until > Date.now();
  assert.strictEqual((await call('POST', '/api/report', null, { pid: g.accB.id, ctx: 'dm' })).status, 401);
  assert.strictEqual((await rep(r1, r1)).status, 400, 'not oneself');
  assert.strictEqual((await rep(r1, g.accB, { pid: 'x' })).status, 400);
  assert.strictEqual((await rep(r1, g.accB, { ctx: 'nowhere' })).status, 400);
  assert.strictEqual((await rep(r1, { id: '0'.repeat(32) })).status, 404);
  assert.strictEqual((await rep(r1, g.accB, { ctx: 'dm' })).status, 404, 'a private message has to exist');
  assert.strictEqual((await rep(r1, g.accB)).status, 200);
  assert.deepStrictEqual(rows(who(g.accB)), [{ reporter: r1.id, reported: g.accB.id, text: 'rude words', ctx: g.code }]);
  assert.strictEqual((await rep(r1, g.accB, { ctx: 'profile', text: undefined })).status, 200);
  assert.strictEqual((await rep(r1, g.accB)).status, 200);
  assert.strictEqual((await rep(r2, g.accB, { text: 'x'.repeat(500) })).status, 200);
  assert.strictEqual(rows(who(g.accB)).find(r => r.reporter === r2.id).text.length, 300, 'the text is cut');
  assert.strictEqual(muted(g.accB), false, 'one reporter many times, and two reporters, are not enough');
  // a report from outside the week does not count
  sql("INSERT INTO reports (reporter, reported, text, ctx, at) VALUES ('" + 'f'.repeat(32) + "', " + who(g.accB) + ", 'old', 'dm', " + (Date.now() - 8 * DAY) + ')');
  assert.strictEqual(muted(g.accB), false);
  const typing = g.b.next(m => m.t === 'typed' && m.p === 0);
  g.b.send({ t: 'text', x: 'still fine' });
  await typing;
  assert.strictEqual((await rep(r3, g.accB)).status, 200);
  assert.strictEqual(muted(g.accB), true, 'three reporters within a week mute for a day');
  const left = sql('SELECT mute_until FROM players WHERE id = ' + who(g.accB))[0].mute_until - Date.now();
  assert(left > 23 * 3600000 && left <= DAY, 'for 24 hours');

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
  console.log('reports: stored with their context, three reporters in a week mute typed chat for a day, phrases and emotes still work');

  // a private message is read back from the conversation
  const sent = await call('POST', '/api/dm', g.accB, { to: g.accA.id, text: 'nasty one' });
  const mid = sent.body.message.id;
  assert.strictEqual((await rep(g.accA, g.accB, { ctx: 'dm', mid: mid, text: 'made up' })).status, 200);
  assert.strictEqual(rows(who(g.accB)).filter(r => r.ctx === 'dm' && r.reporter === g.accA.id)[0].text, 'nasty one', 'the stored text is the real one');
  assert.strictEqual((await rep(r1, g.accB, { ctx: 'dm', mid: mid })).status, 404, 'only the recipient can report it');
  assert.strictEqual((await rep(g.accB, g.accA, { ctx: 'dm', mid: mid })).status, 404);
  sql('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) INSERT INTO reports (reporter, reported, text, ctx, at) SELECT ' + who(r1) + ", 'a', 'x', 'dm', " + Date.now() + ' FROM n');
  assert.strictEqual((await rep(r1, g.accA)).status, 429, 'at most 20 reports a day');
  console.log('reports: private messages read back from the conversation, 20 a day');

  // new accounts do not count, and reports from before the last mute are spent
  for (const y of [await guest(), await guest(), await guest()]) assert.strictEqual((await rep(y, g.accA)).status, 200);
  assert.strictEqual(muted(g.accA), false, 'three accounts under a day old do not mute');
  assert.strictEqual((await rep(await aged(), g.accB)).status, 200);
  assert.strictEqual(muted(g.accB), false, 'the three reports before the last mute are not counted again');
  assert.strictEqual((await rep(await aged(), g.accB)).status, 200);
  assert.strictEqual(muted(g.accB), false);
  assert.strictEqual((await rep(await aged(), g.accB)).status, 200);
  assert.strictEqual(muted(g.accB), true, 'three new reporters after the mute ended mute again');
  console.log('reports: only accounts a day old count, and only reports since the last mute');

  // 180 days, and a deleted reporter takes their reports along
  const n = id => sql('SELECT count(*) AS n FROM reports WHERE reporter = ' + who(id))[0].n;
  const about = () => sql('SELECT count(*) AS n FROM reports WHERE reported = ' + who(g.accB))[0].n;
  const before = about();
  assert(n(r2) > 0);
  assert.strictEqual((await call('DELETE', '/api/me', r2)).status, 200);
  assert.strictEqual(n(r2), 0, 'a deleted account leaves no reports it made');
  assert.strictEqual(about(), before - 1, 'reports about someone else stay');
  const T = Date.UTC(2031, 6, 20, 3, 5);
  sql("INSERT INTO reports (reporter, reported, text, ctx, at) VALUES ('p', 'q', 'ancient', 'dm', " + (T - 181 * DAY) + "), ('p', 'q', 'kept', 'dm', " + (T - 179 * DAY) + ')');
  await tick(T);
  assert.deepStrictEqual(sql("SELECT text FROM reports WHERE reporter = 'p'").map(r => r.text), ['kept'], 'reports are purged after 180 days');
  console.log('reports: purged after 180 days, removed with the reporter');
  g.a.ws.close();
  g.b.ws.close();
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
  assert.deepStrictEqual(to(f.apns, d1.tokens[0])[0].body, { aps: { alert: { title: 'Günlük ödül', body: '1.500 çiplik günlük ödülün hazır.' }, sound: 'default' }, t: 'daily' });
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
  f.clear();
  await tick(T + 10 * 3600000 + 5 * 60000);
  const wm = acc => [...f.apns, ...f.fcm].filter(m => acc.tokens.includes(m.token));
  assert.deepStrictEqual(wm(w1)[0].body, { aps: { alert: { title: 'Weekly leaderboard', body: 'You won 500 chips last week and finished #3.' }, sound: 'default' }, t: 'week' });
  assert.deepStrictEqual(wm(w2)[0].message.notification, { title: 'Haftalık sıralama', body: 'Geçen hafta 500 çip kazandın ve sıralamada 3. oldun.' });
  assert.deepStrictEqual(wm(w3)[0].body.aps.alert.body, 'You won 900 chips last week and finished #1.');
  assert.strictEqual(wm(w9)[0].message.notification.body, 'You won 400 chips last week and finished #6.', 'a player who already won this week still gets last week\'s rank');
  for (const [acc, why] of [[w4, 'won nothing last week'], [w5, 'switched off'], [w7, 'no chips won']]) assert.strictEqual(wm(acc).length, 0, why);
  assert.strictEqual(wm(w6).length + wm(w8).length, 0, 'in a zone ahead the clock is not Monday morning, or the UTC week has not turned');
  seen.push(...f.apns, ...f.fcm);
  const n = f.apns.length + f.fcm.length;
  await tick(T + 10 * 3600000 + 5 * 60000);
  await tick(T + 11 * 3600000 + 5 * 60000);
  assert.strictEqual(f.apns.length + f.fcm.length, n, 'sent once');
  await tick(T + 5 * 60000);
  assert.strictEqual(wm(w8).length, 1, 'once UTC is in the new week the zone ahead gets its push, in its own hours');
  assert.strictEqual(wm(w8)[0].body.aps.alert.body, 'Geçen hafta 450 çip kazandın ve sıralamada 5. oldun.');
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
  const T2 = Date.UTC(2031, 5, 10, 12, 0);
  sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('pushbudget', '40')");
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
  // a player with ten devices costs up to 31, so the second one does not fit and is handed back
  sql("DELETE FROM settings WHERE key = 'pushbudget'");
  sql('DELETE FROM devices');
  const T3 = Date.UTC(2031, 5, 11, 12, 0);
  sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('pushbudget', '40')");
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
  const [accA, accB] = [await guest(), await guest()];
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: 2, games: 2, level: 'relaxed', stake: 100 });
  const ja = await a.next(m => m.t === 'joined');
  const b = client('/ws/' + ja.code);
  await b.ready;
  b.send({ t: 'join', auth: accB.auth });
  await b.next(m => m.t === 'joined');
  const fin = [a, b].map(c => played(c));
  a.send({ t: 'start' });
  await within(Promise.all(fin), 120000, 'match end');
  await sleep(800);
  let rows = seatsOf(ja.code);
  assert.deepStrictEqual(rows.map(x => [x.player, x.kind, x.stake, x.fake, x.seat, x.gone]), [[accA.id, 'friend', 100, 0, 0, 0], [accB.id, 'friend', 100, 0, 1, 0]]);
  assert.strictEqual(rows[0].match, rows[1].match);
  for (const [i, acc] of [accA, accB].entries()) {
    assert(rows[i].net !== null && rows[i].at > 0);
    assert.strictEqual(rows[i].net, moved(acc, rows[0].match), 'net is what the chip log moved');
  }
  console.log('matchlog: a friend table writes one row per seat, net equals the chip log');
  a.ws.close();
  b.ws.close();

  // a leave in a started match sets gone; the other seat does not
  const [accC, accD] = [await guest(), await guest()];
  const c = client('/ws/new');
  await c.ready;
  c.send({ t: 'create', auth: accC.auth, players: 2, games: 2, level: 'relaxed', stake: 100 });
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
  rows = seatsOf(jc.code);
  assert.deepStrictEqual(rows.map(x => [x.player, x.gone, x.gone_at > 0]), [[accC.id, 0, false], [accD.id, 1, true]]);
  assert.strictEqual(rows[1].net, -100);
  assert.strictEqual(rows[1].net, moved(accD, rows[0].match), 'a leaver net is what the chip log moved');
  console.log('matchlog: a leave sets gone and the lost stake');
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

let section = 'start';
// names on the command line run alone, in the normal order
const only = process.argv.slice(2);
const names = new Set();
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
  ({ payout } = await import('../src/account.js'));
  await sec('schema', () => schema());
  await sec('math', () => math());
  await sec('accounts', () => accounts());
  await sec('apple', () => apple());
  await sec('races', () => races());
  await sec('solo', () => solo());
  await sec('lobby', () => lobby());
  await sec('friends', () => friends());
  await sec('silent', () => silent());
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
  await sec('admin', () => admin());
  await sec('chipfn', () => chipfn());
  await sec('typedOff', () => typedOff());
  await sec('reports', () => reports());
  await sec('personas', () => personas());
  await sec('pool', () => pool());
  await sec('openRoom', () => openRoom());
  await sec('whereabouts', () => whereabouts());
  await sec('board', () => board());
  await sec('fixes', () => fixes());
  await sec('held', () => held());
  await sec('fast', () => fast());
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
  await sec('metrics', () => metrics());
  const rc = fakeRc();
  await rc.server.listening$;
  await sec('shop', () => shop(rc));
  await sec('vip', () => vip(rc));
  await sec('cap', () => cap());
  rc.server.close();
  const bad = only.filter(x => !names.has(x));
  if (bad.length) throw new Error('no such section: ' + bad.join(', ') + ' (have ' + [...names].join(' ') + ')');
  console.log('ok');
  reached = true;
  process.exit(0);
})().catch(e => {
  console.error('in "' + section + '":', e);
  process.exit(1);
});
