// Make the env file first (it is gitignored):
//   node -e "const c=require('crypto');console.log('PACE=0.02\nAPPLE_BASE=http://localhost:8791\nAPPLE_KEY='+c.generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))" > test/dev.vars
// Plays whole matches through the socket API against a running
// `wrangler dev --port 8787 --env-file test/dev.vars`, which sets PACE, a throwaway APPLE_KEY and APPLE_BASE.
// The Apple tests play Apple's servers on port 8791.
const assert = require('assert');
const WebSocket = require('ws');
const Game = require('../../www/js/game.js');
const Chat = require('../../www/js/chat.js');

const { execSync } = require('child_process');
const crypto = require('crypto');
const httpServer = require('http');
let payout;

const base = process.env.URL || 'ws://localhost:8787';
const http = base.replace(/^ws/, 'http');
const TOP = new Set(['t', 'lb', 'n', 'stake', 'fast', 'res', 'games', 'gameNo', 'level', 'pot', 'phase', 'task', 'tasksLeft', 'turn', 'cutter',
  'chooser', 'clock', 'rm', 'cup', 'turns', 'justOpened', 'stock', 'discard', 'melds', 'claim', 'players', 'result', 'stats', 'lastFin', 'final', 'log']);
const RM = new Set(['left', 'want', 'mine']);
const CUP = new Set(['round', 'buy', 'prizes', 'place', 'through']);
const SEAT = new Set(['name', 'pid', 'seed', 'av', 'level', 'bank', 'away', 'n', 'opened', 'claims', 'chips', 'score', 'hand']);

let ips = 0;

async function call(method, path, acc, body, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (acc) headers.Authorization = 'Bearer ' + acc.id + '.' + acc.secret;
  if (origin) headers.Origin = origin;
  // guests are rate limited per address
  if (path === '/api/guest' || path === '/api/apple') headers['CF-Connecting-IP'] = '10.0.0.' + (++ips % 250);
  const go = () => fetch(http + path, { method: method, headers: headers, body: body && JSON.stringify(body) });
  // the dev server drops idle connections while sql() runs
  const r = await go().catch(go);
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

async function guest() {
  const r = await call('POST', '/api/guest');
  assert.strictEqual(r.status, 200, 'guest ' + r.status);
  return Object.assign(r.body, { auth: r.body.id + '.' + r.body.secret });
}

// the dev server and this script share the local database
function sql(q) {
  const run = () => execSync('npx wrangler d1 execute amerikano --local --json --command "' + q.replace(/"/g, '\\"') + '"', { cwd: __dirname + '/..', stdio: ['ignore', 'pipe', 'ignore'] });
  // wrangler occasionally dies on a busy machine; a real sql error fails the same way each time
  let out;
  for (let i = 0; ; i++) {
    try { out = run(); break; } catch (e) { if (i === 2) throw e; }
  }
  return JSON.parse(out)[0].results;
}

function client(path, origin) {
  const c = { handlers: [], log: [], errors: [], seen: 0 };
  c.ws = new WebSocket(base + path, { headers: origin ? { Origin: origin } : {} });
  c.ready = new Promise((res, rej) => {
    c.ws.on('open', res);
    c.ws.on('unexpected-response', (q, r) => rej(new Error('http ' + r.statusCode)));
    c.ws.on('error', rej);
  });
  c.ws.on('message', d => {
    const m = JSON.parse(d);
    c.seen++;
    for (const h of c.handlers.slice()) h(m);
  });
  c.send = o => c.ws.send(JSON.stringify(o));
  c.next = pred => new Promise(res => {
    const h = m => {
      if (!pred(m)) return;
      c.handlers.splice(c.handlers.indexOf(h), 1);
      res(m);
    };
    c.handlers.push(h);
  });
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
  c.handlers.push(m => {
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
  });

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

async function hub(acc) {
  const c = client('/ws/hub');
  await c.ready;
  const hi = c.next(m => m.t === 'hub');
  c.send({ t: 'hello', auth: acc.auth });
  assert.deepStrictEqual((await hi).stakes, [100, 500, 2500, 10000, 50000]);
  return c;
}

function seated(m) {
  const c = client('/ws/' + m.code);
  c.ready.then(() => c.send({ t: 'join', token: m.token }));
  return c;
}

async function tables() {
  const bad = client('/ws/hub');
  await bad.ready;
  bad.send({ t: 'hello', auth: '0'.repeat(32) + '.' + '0'.repeat(64) });
  assert.strictEqual((await bad.next(m => m.t === 'error')).k, 'auth');

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
  const fin = new Promise(res => play(Object.assign(a, { seat: ja.seat }), { finish: res }));
  a.send({ t: 'start' });
  await b.next(m => m.t === 'state');
  b.send({ t: 'leave' });
  await fin;
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
  assert.strictEqual(p.games + p.xp, 0, 'a player who never moved earns nothing');
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
  const pre = await fetch(http + '/api/me', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'GET' } });
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

  // a guest the old worker made between migration 0005 and the deploy has no session row
  const old = { id: crypto.randomBytes(16).toString('hex'), secret: crypto.randomBytes(32).toString('hex') };
  const oh = crypto.createHash('sha256').update(old.secret).digest('hex');
  sql("INSERT INTO players (id, secret_hash, name_seed, avatar, chips, created) VALUES ('" + old.id + "', '" + oh + "', 1, '0,0,0,0', 5000, 0)");
  assert.strictEqual((await call('GET', '/api/me', old)).status, 200);
  assert.strictEqual(sql("SELECT count(*) AS n FROM sessions WHERE player = '" + old.id + "'")[0].n, 1);
  assert.strictEqual((await call('GET', '/api/me', { id: old.id, secret: '0'.repeat(64) })).status, 401);
  console.log('a guest from before the sessions table gets its session on first use');
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
  const stub = httpServer.createServer(async (q, r) => {
    if (q.url === '/auth/keys') return r.end(JSON.stringify({ keys: [jwk] }));
    const f = await form(q);
    if (f.client_secret.split('.').length !== 3) r.statusCode = 400;
    else if (q.url === '/auth/revoke') revoked.push({ token: f.token, client: f.client_id });
    else if (spent.has(f.code) || f.code.startsWith('bad') || (f.client_id === 'com.aytutuna.amerikano.web') !== (f.redirect_uri === 'https://amerikano.pages.dev/')) r.statusCode = 400;
    else {
      spent.add(f.code);
      return r.end(JSON.stringify({ refresh_token: 'rt.' + f.code }));
    }
    r.end('{}');
  });
  await new Promise(res => stub.listen(8791, res));
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

  const racer = 'race.' + t.sub;
  const burst = await Promise.all([1, 2, 3, 4].map(async i => post('/api/apple', null, await cred({ sub: racer }, null, 'r' + i))));
  assert.strictEqual(new Set(burst.map(x => x.body.id)).size, 1);
  assert.ok(row(burst[0].body.id).apple_refresh);
  assert.strictEqual(sessions(burst[0].body.id), 4);
  for (let i = 0; i < 12; i++) await post('/api/apple', null, await cred({ sub: racer }, null, 'm' + i));
  assert.strictEqual(sessions(burst[0].body.id), 10);
  console.log('parallel first sign-ins keep the token, a player keeps at most 10 devices');

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
async function pair(n, games) {
  const accA = await guest();
  const accB = await guest();
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', auth: accA.auth, players: n, games: games, level: 'relaxed' });
  const ja = await a.next(m => m.t === 'joined');
  const b = client('/ws/' + ja.code);
  await b.ready;
  b.send({ t: 'join', auth: accB.auth });
  await b.next(m => m.t === 'joined');
  return { accA, accB, a, b, ja, code: ja.code };
}

async function begin(g) {
  const sa = g.a.next(m => m.t === 'state');
  const sb = g.b.next(m => m.t === 'state');
  g.a.send({ t: 'start' });
  return [await sa, await sb];
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
  const fin = new Promise(res => play(r, { finish: res }));
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
  assert(gaps.length > 8 && Math.min(...gaps) >= 15, 'bot moves are paced: ' + Math.min(...gaps));
  const said = all.filter(m => m.t === 'said');
  for (const m of said) assert(m.p >= 1 && m.p < 4 && (Chat.SAY.includes(m.k) || Chat.EMO.includes(m.k)));
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
  assert.strictEqual(await gone, 4000);
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
  host.send({ t: 'start' });
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
    run.done = new Promise(res => play(r, { finish: res }));
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
  await Promise.all(runs.map(x => x.done));
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
  const h = client('/ws/hub');
  await h.ready;
  const hi = h.next(m => m.t === 'hub');
  h.send({ t: 'hello', auth: a.auth, at: 'training' });
  await hi;
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

const within = (p, ms, what) => Promise.race([p, new Promise((r, j) => setTimeout(() => j(new Error('timeout: ' + what)), ms))]);

// two humans quick-play the same table at this stake; the personas fill the rest
async function seatTwo(stake) {
  const accA = await guest();
  const accB = await guest();
  const a = await hub(accA);
  const b = await hub(accB);
  const sa = a.next(m => m.t === 'seated');
  a.send({ t: 'quick', stake: stake });
  const A = await sa;
  const sb = b.next(m => m.t === 'seated');
  b.send({ t: 'quick', stake: stake });
  const B = await sb;
  assert.strictEqual(B.code, A.code);
  const t = { accA, accB, a, b, A, ra: seated(A), rb: seated(B) };
  t.offer = [t.ra, t.rb].map(c => c.next(m => m.t === 'state' && m.rm));
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
  console.log('rematch: both pressed, the room dealt again with a new escrow each');
  for (const c of [t.ra, t.rb, t.a, t.b]) c.ws.close();
}

// one presses and the other cannot cover the stake: the second is sent back and the seat is looked for again
async function rematchOne() {
  const t = await seatTwo(100);
  // the window is short, so the chips go down while the match runs; the payout cannot bring them back to 1,000
  while (!t.rb.st) await sleep(50);
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
  const c = client('/ws/hub');
  await c.ready;
  const none = c.next(m => m.t === 'cup' && m.buy === 0);
  c.send({ t: 'hello', auth: acc.auth });
  await within(none, 5000, 'a hello says there is no tournament');
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

(async () => {
  schema();
  await math();
  await accounts();
  await apple();
  await races();
  await solo();
  await lobby();
  await friends();
  await silent();
  await tables();
  await busy();
  await lone();
  await forfeit();
  await friendRules();
  await chat();
  await gifts();
  await invites();
  await personas();
  await pool();
  await openRoom();
  await whereabouts();
  await board();
  await fixes();
  await held();
  await fast();
  await rematchBoth();
  await rematchOne();
  await rematchAway();
  await rematchNone();
  await rematchFriends();
  await cupCancel();
  await cupPoor();
  await cupGone();
  await cupHello();
  await cupRetry();
  await cupRun(2);
  await cupRun(6);
  console.log('ok');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
