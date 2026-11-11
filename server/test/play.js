// Plays whole matches through the socket API against a running `wrangler dev --var PACE:0.02`.
const assert = require('assert');
const WebSocket = require('ws');
const Game = require('../../www/js/game.js');

const base = process.env.URL || 'ws://localhost:8787';
const TOP = new Set(['t', 'lb', 'n', 'games', 'gameNo', 'level', 'pot', 'phase', 'task', 'tasksLeft', 'turn', 'cutter',
  'chooser', 'turns', 'justOpened', 'stock', 'discard', 'melds', 'claim', 'players', 'result', 'stats', 'lastFin', 'final', 'log']);
const SEAT = new Set(['name', 'bot', 'away', 'n', 'opened', 'claims', 'chips', 'score', 'hand']);

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

  const a = client('/ws/new', 'https://amerikano.pages.dev');
  await a.ready;
  a.send({ t: 'create', name: '  Ay\u0007‮tu  with a very long name indeed ', players: 5, games: 5, level: 'sharp' });
  const ja = await a.next(m => m.t === 'joined');
  const code = ja.code;
  assert(/^[A-HJKMNP-Z]{4}$/.test(code), 'code ' + code);
  const room = await a.next(m => m.t === 'room');
  console.log('room', code, 'host name:', JSON.stringify(room.seats[0].name));
  assert.strictEqual(room.seats[0].name.length <= 16 && !/[\u0007‮]/.test(room.seats[0].name), true);

  const b = client('/ws/' + code, 'capacitor://localhost');
  await b.ready;
  b.send({ t: 'join', name: 'Bea' });
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
  nope.send({ t: 'join', name: 'x' });
  assert.strictEqual((await nope.next(m => m.t === 'error')).k, 'nocode');

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
  assert.strictEqual(a.st.players[(bs.seat - a.seat + 5) % 5].name, 'Bea');
  assert.strictEqual(bs.st.players[0].name, 'Bea');
  console.log('players seen by host (rotated, seat 0 = host):', names.join(', '));
  console.log('final pay for host view:', JSON.stringify(a.st.final.pay), 'low:', a.st.final.low);
  console.log('errors seen: host', a.errors.join() || '-', 'guest', bs.errors.join() || '-');
  a.ws.close();
  bs.ws.close();
}

async function quick() {
  const a = client('/ws/quick');
  const b = client('/ws/quick');
  await Promise.all([a.ready, b.ready]);
  a.send({ t: 'quick' });
  b.send({ t: 'quick' });
  const [ma, mb] = await Promise.all([a.next(m => m.t === 'matched'), b.next(m => m.t === 'matched')]);
  assert.strictEqual(ma.code, mb.code);
  assert.notStrictEqual(ma.seat, mb.seat);
  const r = client('/ws/' + ma.code);
  await r.ready;
  r.send({ t: 'join', token: ma.token });
  const s = await r.next(m => m.t === 'state');
  leakCheck(s);
  const names = s.players.map(p => p.name);
  assert.strictEqual(new Set(names).size, 4);
  console.log('quick match: room', ma.code, 'seat', ma.seat, 'names', names.join(', '), 'bots', s.players.filter(p => p.bot).length);
  r.ws.close();
}

async function lobby() {
  const a = client('/ws/new');
  await a.ready;
  a.send({ t: 'create', name: { toString: 1 }, players: 3, games: 3 });
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

(async () => {
  await lobby();
  await friends();
  await quick();
  console.log('ok');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
