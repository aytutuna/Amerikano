// Plays whole matches through the socket API against a running `wrangler dev --var PACE:0.02`.
const assert = require('assert');
const WebSocket = require('ws');
const Game = require('../../www/js/game.js');

const { execSync } = require('child_process');
let payout;

const base = process.env.URL || 'ws://localhost:8787';
const http = base.replace(/^ws/, 'http');
const TOP = new Set(['t', 'lb', 'n', 'stake', 'res', 'games', 'gameNo', 'level', 'pot', 'phase', 'task', 'tasksLeft', 'turn', 'cutter',
  'chooser', 'turns', 'justOpened', 'stock', 'discard', 'melds', 'claim', 'players', 'result', 'stats', 'lastFin', 'final', 'log']);
const SEAT = new Set(['name', 'seed', 'av', 'level', 'bot', 'away', 'n', 'opened', 'claims', 'chips', 'score', 'hand']);

let ips = 0;

async function call(method, path, acc, body, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (acc) headers.Authorization = 'Bearer ' + acc.id + '.' + acc.secret;
  if (origin) headers.Origin = origin;
  // guests are rate limited per address
  if (path === '/api/guest') headers['CF-Connecting-IP'] = '10.0.0.' + (++ips % 250);
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
        const gone = c.log.slice(from).filter(e => e.p === 0 && e.k === 'draw');
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
      const covered = b2.log.slice(dropLen).filter(e => e.p === 0 && e.k === 'draw');
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
  assert(room.left > 0 && room.left <= 400, 'countdown ' + room.left);
  play(ra, o);
  play(rb, o);
  await Promise.race([finished, new Promise((r, j) => setTimeout(() => j(new Error('timeout')), 120000))]);
  assert.strictEqual(ra.st.stake, 100);
  assert.strictEqual(ra.st.players.filter(x => !x.bot).length, 2);
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
  const r = seated(await s);
  const st = await r.next(m => m.t === 'state');
  assert.strictEqual(st.players.filter(p => p.bot).length, 3);
  assert.strictEqual(st.stake, 500);
  await new Promise(x => setTimeout(x, 300));
  assert.strictEqual((await call('GET', '/api/me', acc)).body.chips, 4500);
  console.log('lone player: bots fill the table after the wait, stake 500 taken');
  r.ws.close();
  h.ws.close();
  // with nobody connected the bots still finish the match and the stake is settled
  const rows = () => sql("SELECT reason FROM chip_log WHERE player = '" + acc.id + "' AND reason = 'match'");
  for (let i = 0; i < 60 && !rows().length; i++) await new Promise(x => setTimeout(x, 500));
  assert.strictEqual(rows().length, 1, 'an abandoned match settles');
  console.log('abandoned match: the bots played it out and the stake was settled');
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
  c.send({ t: 'start' });
  await c.next(m => m.t === 'state' && m.phase === 'matchend');
  await new Promise(r => setTimeout(r, 500));
  const p = (await call('GET', '/api/me', acc)).body;
  assert.strictEqual(p.games + p.xp, 0, 'a room with one human pays no xp');
  c.ws.close();
  console.log('solo room against bots earns nothing');
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
}

(async () => {
  await math();
  await accounts();
  await races();
  await solo();
  await lobby();
  await friends();
  await tables();
  await busy();
  await lone();
  await forfeit();
  console.log('ok');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
