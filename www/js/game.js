var Game = (function () {
  const SUITS = ['c', 'd', 'h', 's'];
  const SI = { c: 0, d: 1, h: 2, s: 3 };
  const SYM = { c: '♣', d: '♦', h: '♥', s: '♠' };
  const BOT_NAMES = ['Ece', 'Can', 'Deniz', 'Aylin', 'Bot'];
  const CARDS = [];
  (function () {
    let id = 0;
    for (let d = 0; d < 2; d++)
      for (const s of SUITS)
        for (let r = 1; r <= 13; r++) CARDS.push({ id: id++, r: r, s: s });
    for (let j = 0; j < 4; j++) CARDS.push({ id: id++, r: 0, s: '' });
  })();

  const S = n => ({ t: 'set', n: n });
  const R = n => ({ t: 'run', n: n });
  const TASKS = [
    { id: 's3r3', tr: 'Bir üçlü küt + bir üçlü seri', en: 'one set of 3 + one run of 3', gl: 'bir üçlü küt + bir üçlü seri', reqs: [S(3), R(3)] },
    { id: 's4r3', tr: 'Bir dörtlü küt + bir üçlü seri', en: 'one set of 4 + one run of 3', gl: 'bir dörtlü küt + bir üçlü seri', reqs: [S(4), R(3)] },
    { id: 'r4s3', tr: 'Bir dörtlü seri + bir üçlü küt', en: 'one run of 4 + one set of 3', gl: 'bir dörtlü seri + bir üçlü küt', reqs: [R(4), S(3)] },
    { id: 's3s3', tr: 'İki üçlü küt', en: 'two sets of 3', gl: 'iki üçlü küt', reqs: [S(3), S(3)] },
    { id: 'r3r3', tr: 'İki üçlü seri', en: 'two runs of 3', gl: 'iki üçlü seri', reqs: [R(3), R(3)] },
    { id: 's4', tr: 'Bir dörtlü küt', en: 'one set of 4', gl: 'bir dörtlü küt', reqs: [S(4)] },
    { id: 'r4', tr: 'Bir dörtlü seri', en: 'one run of 4', gl: 'bir dörtlü seri', reqs: [R(4)] },
    { id: 's4r4', tr: 'Bir dörtlü küt + bir dörtlü seri', en: 'one set of 4 + one run of 4', gl: 'bir dörtlü küt + bir dörtlü seri', reqs: [S(4), R(4)] },
    { id: 's4s4', tr: 'İki dörtlü küt', en: 'two sets of 4', gl: 'iki dörtlü küt', reqs: [S(4), S(4)] },
    { id: 'r4r4', tr: 'İki dörtlü seri', en: 'two runs of 4', gl: 'iki dörtlü seri', reqs: [R(4), R(4)] },
    { id: 'r3x3', tr: 'Üç üçlü seri', en: 'three runs of 3', gl: 'üç üçlü seri', reqs: [R(3), R(3), R(3)] },
    { id: 's3x3', tr: 'Üç üçlü küt', en: 'three sets of 3', gl: 'üç üçlü küt', reqs: [S(3), S(3), S(3)] },
    { id: 'r6', tr: 'Altılama', en: 'one run of 6', gl: 'altı kartlık seri', reqs: [R(6)] },
    { id: 'cazip', tr: 'Cazip', en: 'two runs of 3 + two sets of 3', gl: 'iki üçlü seri + iki üçlü küt', reqs: [R(3), R(3), S(3), S(3)] },
    { id: 'cift', tr: 'Çift', en: 'four pairs', gl: 'dört çift', reqs: [S(2), S(2), S(2), S(2)] },
    { id: 'ara', tr: 'Arabitiş', en: 'go out from hand', gl: 'elden bitiş', reqs: [] }
  ];

  function pts(c) {
    return c.r === 0 ? 20 : c.r === 1 ? 11 : c.r >= 10 ? 10 : c.r;
  }

  function handPts(hand) {
    let t = 0;
    for (const c of hand) t += pts(c);
    return t;
  }

  function cardName(c) {
    if (!c.r) return 'Joker';
    return (c.r === 1 ? 'A' : c.r === 11 ? 'J' : c.r === 12 ? 'Q' : c.r === 13 ? 'K' : c.r) + SYM[c.s];
  }

  function validSet(cards, min) {
    if (cards.length < min) return false;
    let rank = 0;
    for (const c of cards) {
      if (!c.r) continue;
      if (rank && c.r !== rank) return false;
      rank = c.r;
    }
    return rank > 0;
  }

  // lowest start position (1..14, ace is 1 or 14) a run can have, 0 if none
  function runStart(cards) {
    const n = cards.length;
    if (n > 14) return 0;
    const seen = [];
    let suit = '';
    for (const c of cards) {
      if (!c.r) continue;
      if (suit && c.s !== suit) return 0;
      suit = c.s;
      seen[c.r] = (seen[c.r] || 0) + 1;
      if (seen[c.r] > (c.r === 1 && n === 14 ? 2 : 1)) return 0;
    }
    if (!suit) return 0;
    for (let st = 1; st + n - 1 <= 14; st++) {
      let ok = true;
      for (let r = 1; r <= 13 && ok; r++) {
        if (!seen[r]) continue;
        if (r === 1) ok = st === 1 || st + n - 1 === 14;
        else ok = r >= st && r <= st + n - 1;
      }
      if (ok) return st;
    }
    return 0;
  }

  function validRun(cards, min) {
    return cards.length >= min && runStart(cards) > 0;
  }

  function validMeld(cards, t, min) {
    return t === 'set' ? validSet(cards, min) : validRun(cards, min);
  }

  function runLayout(cards) {
    const st = runStart(cards);
    if (!st) return cards.slice();
    const nat = cards.filter(c => c.r);
    const jokers = cards.filter(c => !c.r);
    const out = [];
    const used = [];
    for (let p = st; p < st + cards.length; p++) {
      const k = nat.findIndex((c, i) => !used[i] && (c.r === p || (c.r === 1 && p === 14)));
      if (k >= 0) { used[k] = true; out.push(nat[k]); }
      else out.push(jokers.pop());
    }
    return out;
  }

  function newCounts() {
    return [0, 1, 2, 3].map(() => new Array(16).fill(0));
  }

  // value of a card for runs: neighbours in the same suit
  function near(cnt, s, r) {
    return (r > 1 ? cnt[s][r - 1] : 0) + (r < 13 ? cnt[s][r + 1] : 0) +
      (r > 2 ? cnt[s][r - 2] : 0) * 0.5 + (r < 12 ? cnt[s][r + 2] : 0) * 0.5;
  }

  // Best way to build the required melds from a hand. missing is the number of
  // cards still needed after spending every joker; melds only when missing is 0.
  function plan(hand, reqs) {
    const cnt = newCounts();
    let jk = 0;
    for (const c of hand) {
      if (c.r) cnt[SI[c.s]][c.r]++;
      else jk++;
    }
    const list = reqs.slice().sort((a, b) => b.n - a.n || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    let bestMiss = Infinity;
    let bestPick = null;
    const pick = [];

    function cands(rq, minKey) {
      const out = [];
      if (rq.t === 'set') {
        for (let r = Math.max(1, minKey); r <= 13; r++) {
          const tot = cnt[0][r] + cnt[1][r] + cnt[2][r] + cnt[3][r];
          if (tot) out.push({ key: r, need: rq.n - Math.min(tot, rq.n) });
        }
      } else {
        for (let s = 0; s < 4; s++) {
          for (let st = 1; st + rq.n - 1 <= 14; st++) {
            const key = s * 16 + st;
            if (key < minKey) continue;
            let used = 0;
            for (let p = st; p < st + rq.n; p++) if (cnt[s][p > 13 ? 1 : p]) used++;
            if (used) out.push({ key: key, need: rq.n - used });
          }
        }
      }
      out.sort((a, b) => a.need - b.need || a.key - b.key);
      return out.length > 8 ? out.slice(0, 8) : out;
    }

    function takes(rq, c) {
      const out = [];
      if (rq.t === 'set') {
        const all = [];
        for (let s = 0; s < 4; s++)
          for (let i = 0; i < cnt[s][c.key]; i++) all.push([s, c.key, near(cnt, s, c.key)]);
        all.sort((a, b) => a[2] - b[2]);
        for (let i = 0; i < rq.n - c.need; i++) out.push([all[i][0], all[i][1]]);
      } else {
        const s = c.key >> 4;
        const st = c.key & 15;
        for (let p = st; p < st + rq.n; p++) {
          const r = p > 13 ? 1 : p;
          if (cnt[s][r]) out.push([s, r]);
        }
      }
      return out;
    }

    function go(d, acc, prevKey) {
      if (bestMiss === 0) return;
      if (d === list.length) {
        const miss = Math.max(0, acc - jk);
        if (miss < bestMiss) {
          bestMiss = miss;
          bestPick = pick.slice();
        }
        return;
      }
      const rq = list[d];
      const same = d > 0 && list[d - 1].t === rq.t && list[d - 1].n === rq.n;
      for (const c of cands(rq, same ? prevKey : 0)) {
        if (Math.max(0, acc + c.need - jk) >= bestMiss) break;
        const tk = takes(rq, c);
        for (const x of tk) cnt[x[0]][x[1]]--;
        pick.push({ rq: rq, takes: tk, need: c.need });
        go(d + 1, acc + c.need, c.key);
        pick.pop();
        for (const x of tk) cnt[x[0]][x[1]]++;
      }
    }

    go(0, 0, 0);
    if (bestMiss !== 0) return { missing: bestMiss, melds: null };

    const pools = [0, 1, 2, 3].map(() => []);
    const jokers = [];
    for (const c of hand) {
      if (!c.r) { jokers.push(c); continue; }
      const p = pools[SI[c.s]];
      (p[c.r] = p[c.r] || []).push(c);
    }
    const melds = [];
    for (const pk of bestPick) {
      let cards = pk.takes.map(x => pools[x[0]][x[1]].pop());
      for (let i = 0; i < pk.need; i++) cards.push(jokers.pop());
      if (pk.rq.t === 'run') cards = runLayout(cards);
      melds.push({ t: pk.rq.t, cards: cards });
    }
    return { missing: 0, melds: melds };
  }

  // Exact version of plan(): tries every split of suits, copies and jokers, and
  // remembers states that failed. Returns the melds or null.
  function openSearch(hand, reqs) {
    const cnt = newCounts();
    const pools = [0, 1, 2, 3].map(() => []);
    const jokers = [];
    for (const c of hand) {
      if (!c.r) { jokers.push(c); continue; }
      cnt[SI[c.s]][c.r]++;
      const p = pools[SI[c.s]];
      (p[c.r] = p[c.r] || []).push(c);
    }
    const list = reqs.slice().sort((a, b) => (a.t === b.t ? 0 : a.t === 'run' ? -1 : 1) || b.n - a.n);
    const total = list.reduce((a, r) => a + r.n, 0);
    if (hand.length < total) return null;
    const dead = new Set();
    const pick = [];

    function go(d, jk) {
      if (d === list.length) return true;
      const key = d + ',' + jk + ',' + cnt.map(a => a.join('')).join();
      if (dead.has(key)) return false;
      const rq = list[d];
      if (rq.t === 'set' ? trySets(d, jk, rq) : tryRuns(d, jk, rq)) return true;
      dead.add(key);
      return false;
    }

    function trySets(d, jk, rq) {
      for (let r = 1; r <= 13; r++) {
        const a = [cnt[0][r], cnt[1][r], cnt[2][r], cnt[3][r]];
        const tot = a[0] + a[1] + a[2] + a[3];
        for (let k = Math.min(tot, rq.n); k >= 1 && rq.n - k <= jk; k--) {
          const v = [0, 0, 0, 0];
          const spread = (s, left) => {
            if (s === 4) {
              if (left) return false;
              for (let i = 0; i < 4; i++) cnt[i][r] -= v[i];
              pick.push({ t: 'set', r: r, v: v.slice(), j: rq.n - k });
              if (go(d + 1, jk - (rq.n - k))) return true;
              pick.pop();
              for (let i = 0; i < 4; i++) cnt[i][r] += v[i];
              return false;
            }
            for (let x = Math.min(a[s], left); x >= 0; x--) {
              v[s] = x;
              if (spread(s + 1, left - x)) return true;
            }
            v[s] = 0;
            return false;
          };
          if (spread(0, k)) return true;
        }
      }
      return false;
    }

    function tryRuns(d, jk, rq) {
      for (let s = 0; s < 4; s++) {
        for (let a = 1; a + rq.n - 1 <= 14; a++) {
          const have = [];
          for (let p = a; p < a + rq.n; p++) if (cnt[s][p > 13 ? 1 : p]) have.push(p);
          if (!have.length || rq.n - have.length > jk) continue;
          // a joker may stand in for a natural that another meld needs as its anchor
          for (let mask = (1 << have.length) - 1; mask > 0; mask--) {
            const use = have.filter((p, i) => mask >> i & 1);
            const j = rq.n - use.length;
            if (j > jk) continue;
            for (const p of use) cnt[s][p > 13 ? 1 : p]--;
            pick.push({ t: 'run', s: s, use: use, j: j });
            if (go(d + 1, jk - j)) return true;
            pick.pop();
            for (const p of use) cnt[s][p > 13 ? 1 : p]++;
          }
        }
      }
      return false;
    }

    if (!go(0, jokers.length)) return null;
    return pick.map(pk => {
      let cards = [];
      if (pk.t === 'set') pk.v.forEach((x, s) => { for (let i = 0; i < x; i++) cards.push(pools[s][pk.r].pop()); });
      else for (const p of pk.use) cards.push(pools[pk.s][p > 13 ? 1 : p].pop());
      for (let i = 0; i < pk.j; i++) cards.push(jokers.pop());
      if (pk.t === 'run') cards = runLayout(cards);
      return { t: pk.t, cards: cards };
    });
  }

  function openMelds(hand, reqs) {
    const r = plan(hand, reqs);
    return r.missing === 0 ? r.melds : openSearch(hand, reqs);
  }

  function meldTypes(cards) {
    const out = [];
    if (validSet(cards, 3)) out.push('set');
    if (validRun(cards, 3)) out.push('run');
    return out;
  }

  // Cover as much of the hand as possible with disjoint melds of 3+.
  // Returns the melds and the cards left over.
  function partition(hand, budget) {
    budget = budget || 5000;
    const pools = [0, 1, 2, 3].map(() => {
      const a = [];
      for (let r = 0; r <= 15; r++) a.push([]);
      return a;
    });
    const jokers = [];
    for (const c of hand) {
      if (c.r) pools[SI[c.s]][c.r].push(c);
      else jokers.push(c);
    }
    const melds = [];
    const skipped = [];
    let best = null;
    let nodes = 0;

    function count(s, r) {
      return r < 1 ? 0 : pools[s][r].length;
    }

    function finish() {
      const ms = melds.map(m => ({ t: m.t, cards: m.cards.slice() }));
      const rest = skipped.slice();
      for (const j of jokers) {
        const m = ms.find(x => validMeld(x.cards.concat(j), x.t, 3));
        if (m) m.cards.push(j);
        else rest.push(j);
      }
      if (!best || rest.length < best.left) {
        for (const m of ms) if (m.t === 'run') m.cards = runLayout(m.cards);
        best = { left: rest.length, melds: ms, rest: rest };
      }
    }

    function rec() {
      if (best && best.left === 0) return;
      if (nodes++ > budget) return;
      if (best && skipped.length >= best.left) return;
      let s = 0;
      let r = 0;
      for (s = 0; s < 4; s++) {
        for (r = 1; r <= 13; r++) if (pools[s][r].length) break;
        if (r <= 13) break;
      }
      if (s === 4) { finish(); return; }

      const all = [];
      for (let s2 = 0; s2 < 4; s2++)
        for (const c of pools[s2][r]) all.push({ c: c, v: s2 === s ? -100 : near2(s2, r) });
      all.sort((a, b) => a.v - b.v);
      const ks = [];
      if (all.length >= 3) { ks.push([all.length, 0]); if (all.length > 3) ks.push([3, 0]); }
      if (all.length >= 2 && jokers.length >= 1) ks.push([2, 1]);
      if (all.length >= 1 && jokers.length >= 2) ks.push([1, 2]);
      for (const kj of ks) {
        const cards = all.slice(0, kj[0]).map(x => x.c);
        for (const c of cards) pools[SI[c.s]][c.r].splice(pools[SI[c.s]][c.r].indexOf(c), 1);
        const js = jokers.splice(jokers.length - kj[1], kj[1]);
        melds.push({ t: 'set', cards: cards.concat(js) });
        rec();
        melds.pop();
        for (const j of js) jokers.push(j);
        for (const c of cards) pools[SI[c.s]][c.r].push(c);
      }

      // runs from the lowest card of this suit upward, longest first
      const seq = [];
      const opts = [];
      let jn = 0;
      for (let p = r; p <= 14; p++) {
        const rr = p > 13 ? 1 : p;
        const nat = p === r || count(s, rr) > (rr === r ? 1 : 0);
        if (!nat) {
          if (jn >= jokers.length) break;
          jn++;
        }
        seq.push(nat);
        if (seq.length >= 3 && nat) opts.push({ len: seq.length, jn: jn });
      }
      for (let i = opts.length - 1; i >= 0; i--) {
        const o = opts[i];
        const cards = [];
        for (let p = r; p < r + o.len; p++) {
          const rr = p > 13 ? 1 : p;
          if (pools[s][rr].length) cards.push(pools[s][rr].pop());
        }
        const js = jokers.splice(jokers.length - o.jn, o.jn);
        melds.push({ t: 'run', cards: cards.concat(js) });
        rec();
        melds.pop();
        for (const j of js) jokers.push(j);
        for (let k = cards.length - 1; k >= 0; k--) pools[SI[cards[k].s]][cards[k].r].push(cards[k]);
      }

      const f = pools[s][r].pop();
      skipped.push(f);
      rec();
      skipped.pop();
      pools[s][r].push(f);
    }

    function near2(s, r) {
      return count(s, r - 1) + count(s, r + 1) + (count(s, r - 2) + count(s, r + 2)) * 0.5;
    }

    rec();
    return best;
  }

  // Exact check for Arabitis, where partition missing a hand would leave the
  // player stuck. Longer melds split into ones of 3 to 5, so those sizes are enough.
  function finishPlan(hand) {
    const nat0 = hand.filter(c => c.r).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.r - b.r));
    const jokers = hand.filter(c => !c.r);
    const melds = [];
    const dead = new Set();

    function rec(nat, jn, lf) {
      if (!nat.length) return melds.length > 0 || jn <= lf;
      const key = nat.map(x => x.s + x.r).join() + '|' + jn + '|' + lf;
      if (dead.has(key)) return false;
      const c = nat[0];

      const tryMeld = (t, cards, j) => {
        melds.push({ t: t, cards: cards, j: j });
        if (rec(nat.filter(x => !cards.includes(x)), jn - j, lf)) return true;
        melds.pop();
        return false;
      };

      const same = nat.filter(x => x !== c && x.r === c.r);
      const seen = new Set();
      for (let mask = 0; mask < 1 << same.length; mask++) {
        const pick = same.filter((x, i) => mask >> i & 1);
        const k = pick.map(x => x.s).join('');
        if (pick.length > 4 || seen.has(k)) continue;
        seen.add(k);
        const j = Math.max(0, 2 - pick.length);
        if (j <= jn && tryMeld('set', [c].concat(pick), j)) return true;
      }

      const fill = (q, b, p, cards, j) => {
        if (q > b) return tryMeld('run', cards, j);
        if (q === p) return fill(q + 1, b, p, cards, j);
        const rr = q === 14 ? 1 : q;
        const n = nat.find(x => x !== c && x.s === c.s && x.r === rr);
        if (n && fill(q + 1, b, p, cards.concat(n), j)) return true;
        return j < jn && fill(q + 1, b, p, cards, j + 1);
      };
      for (const p of c.r === 1 ? [1, 14] : [c.r]) {
        for (let a = Math.max(1, p - 4); a <= p; a++) {
          for (let b = Math.max(p, a + 2); b <= Math.min(14, a + 4); b++) {
            if (fill(a, b, p, [c], 0)) return true;
          }
        }
      }

      if (lf > 0 && rec(nat.slice(1), jn, lf - 1)) return true;
      dead.add(key);
      return false;
    }

    for (let lf = 0; lf <= 1; lf++) {
      if (!rec(nat0, jokers.length, lf)) continue;
      const js = jokers.slice();
      const out = melds.map(m => ({ t: m.t, cards: m.cards.concat(js.splice(0, m.j)) }));
      for (const j of js) {
        const m = out.find(x => validMeld(x.cards.concat(j), x.t, 3));
        if (m) m.cards.push(j);
      }
      return out;
    }
    return null;
  }

  const memo = new Map();

  function sig(hand) {
    return hand.map(c => (c.r ? c.s + c.r : 'J')).sort().join(',');
  }

  function deficit(hand, task) {
    const key = task.id + '|' + sig(hand);
    let v = memo.get(key);
    if (v === undefined) {
      v = task.id === 'ara' ? partition(hand, 1500).left : plan(hand, task.reqs).missing;
      if (memo.size > 30000) memo.clear();
      memo.set(key, v);
    }
    return v;
  }

  // deficit before and after taking a card, comparable across tasks
  function gain(st, p, card) {
    const task = st.task;
    const after = p.hand.concat(card);
    if (task.id === 'ara') {
      return [deficit(p.hand, task), Math.max(0, deficit(after, task) - 1)];
    }
    return [deficit(p.hand, task), deficit(after, task)];
  }

  function neighbours(hand, c) {
    let n = 0;
    for (const o of hand) {
      if (o === c || !o.r) continue;
      if (o.r === c.r) n += 1;
      else if (o.s === c.s) {
        const d = Math.abs(o.r - c.r);
        if (d === 1 || d === 12) n += 1;
        else if (d === 2) n += 0.5;
      }
    }
    return n;
  }

  // cards still missing for the task, 0 when the hand can open
  function away(hand, task) {
    if (task.id === 'ara') return finishPlan(hand) ? 0 : Math.max(1, partition(hand, 1500).left - 1);
    const m = plan(hand, task.reqs).missing;
    return m && openSearch(hand, task.reqs) ? 0 : m;
  }

  function need(st, i) {
    const p = st.players[i];
    return !st.task || p.opened ? 0 : away(p.hand, st.task);
  }

  function fits(st, cards) {
    if (!cards.length) return [];
    return st.melds.filter(m => validMeld(m.cards.concat(cards), m.t, 2)).map(m => m.id);
  }

  function no(err, data) {
    return Object.assign({ ok: false, err: err }, data);
  }

  const yes = { ok: true };

  function say(st, k, data) {
    st.log.push(Object.assign({ k: k }, data));
  }

  function fx(st, name) {
    if (st.fx) st.fx.push(name);
  }

  function cur(st) {
    return st.players[st.turn];
  }

  function ids(cards) {
    return cards.map(c => c.id);
  }

  function meldIds(melds) {
    return melds.map(m => ({ t: m.t, ids: ids(m.cards) }));
  }

  function shuffle(a, rnd) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function newMatch(o) {
    const n = o.players;
    const st = {
      n: n,
      games: o.games,
      gameNo: 0,
      level: o.level === 'relaxed' ? 'relaxed' : 'sharp',
      pot: 10 * n,
      tasksLeft: TASKS.filter(t => t.id !== 'ara'),
      players: [],
      log: [],
      fx: o.fx ? [] : null,
      rnd: o.rnd || Math.random,
      phase: '',
      melds: [],
      mid: 0,
      stock: [],
      discard: [],
      stats: []
    };
    for (let i = 0; i < n; i++) {
      const human = !o.allBots && i === 0;
      st.players.push({
        name: human ? (o.name || 'You') : BOT_NAMES[o.allBots ? i : i - 1],
        bot: !human, hand: [], opened: false, claims: 0, chips: -10, score: 0
      });
    }
    say(st, 'pot', { n: 10 });
    startGame(st);
    return st;
  }

  function startGame(st) {
    memo.clear();
    st.gameNo++;
    st.cutter = (st.gameNo - 1) % st.n;
    st.turn = st.cutter;
    st.melds = [];
    st.discard = [];
    st.claim = null;
    st.played = false;
    st.justOpened = false;
    st.result = null;
    st.turns = 0;
    for (const p of st.players) { p.hand = []; p.opened = false; p.claims = 0; }
    const deck = shuffle(CARDS.slice(), st.rnd);
    const cutter = st.players[st.cutter];
    const cut = deck[Math.floor(st.rnd() * deck.length)];
    say(st, 'game', { n: st.gameNo, p: st.cutter });
    say(st, 'cut', { p: st.cutter, card: cut.id });
    let want = 13;
    if (!cut.r) {
      deck.splice(deck.indexOf(cut), 1);
      cutter.hand.push(cut);
      want = 12;
      say(st, 'keep', { p: st.cutter });
    }
    for (let k = 0; k < st.n; k++) {
      const p = st.players[(st.cutter + k) % st.n];
      const need = p === cutter ? want : 13;
      for (let i = 0; i < need; i++) p.hand.push(deck.pop());
    }
    fx(st, 'deal');
    st.discard.push(deck.pop());
    st.stock = deck;
    fx(st, 'flip');
    say(st, 'top', { card: st.discard[0].id });
    if (st.gameNo === st.games) {
      st.task = TASKS[TASKS.length - 1];
      st.chooser = -1;
      st.phase = 'draw';
      say(st, 'last', { p: st.cutter });
    } else {
      st.task = null;
      st.chooser = st.cutter;
      st.phase = 'choose';
    }
  }

  function chooseTask(st, id) {
    if (st.phase !== 'choose') return no('phase');
    const t = st.tasksLeft.find(x => x.id === id);
    if (!t) return no('task');
    st.task = t;
    st.tasksLeft = st.tasksLeft.filter(x => x !== t);
    st.phase = 'draw';
    say(st, 'task', { p: st.turn, task: t.id });
    return yes;
  }

  function nextTurn(st) {
    st.turn = (st.turn + 1) % st.n;
    st.phase = 'draw';
    st.played = false;
    st.justOpened = false;
    st.turns++;
    if (!st.stock.length) endGame(st, -1);
  }

  function drawStock(st) {
    if (st.phase !== 'draw') return no('phase');
    if (!st.stock.length) { endGame(st, -1); return yes; }
    const p = cur(st);
    p.hand.push(st.stock.pop());
    fx(st, 'flip');
    say(st, 'draw', { p: st.turn });
    openClaim(st);
    return yes;
  }

  function openClaim(st) {
    const queue = [];
    if (st.discard.length && st.stock.length) {
      for (let k = 1; k < st.n; k++) {
        const q = (st.turn + k) % st.n;
        if (st.players[q].claims < 4) queue.push(q);
      }
    }
    if (!queue.length) { st.phase = 'play'; return; }
    st.claim = { card: st.discard[st.discard.length - 1], queue: queue, i: 0 };
    st.phase = 'claim';
  }

  function claimer(st) {
    return st.claim ? st.claim.queue[st.claim.i] : -1;
  }

  function claimTake(st) {
    if (st.phase !== 'claim') return no('phase');
    const q = claimer(st);
    const p = st.players[q];
    p.hand.push(st.discard.pop());
    p.hand.push(st.stock.pop());
    p.claims++;
    p.chips--;
    st.pot++;
    fx(st, 'flip');
    say(st, 'claim', { p: q, card: st.claim.card.id });
    st.claim = null;
    st.phase = 'play';
    return yes;
  }

  function claimPass(st) {
    if (st.phase !== 'claim') return no('phase');
    st.claim.i++;
    if (st.claim.i >= st.claim.queue.length) {
      st.claim = null;
      st.phase = 'play';
    }
    return yes;
  }

  function takeDiscard(st) {
    if (st.phase !== 'draw') return no('phase');
    if (!st.discard.length) return no('empty');
    const p = cur(st);
    const c = st.discard.pop();
    p.hand.push(c);
    fx(st, 'flip');
    say(st, 'take', { p: st.turn, card: c.id });
    st.phase = 'play';
    return yes;
  }

  function inHand(p, cards) {
    const seen = new Set();
    for (const c of cards) {
      if (seen.has(c.id) || !p.hand.includes(c)) return false;
      seen.add(c.id);
    }
    return true;
  }

  function removeCards(p, cards) {
    const gone = new Set(ids(cards));
    p.hand = p.hand.filter(c => !gone.has(c.id));
  }

  function putMeld(st, t, cards) {
    st.melds.push({ id: st.mid++, t: t, cards: t === 'run' ? runLayout(cards) : cards.slice(), owner: st.turn });
    fx(st, 'place');
  }

  function checkOut(st) {
    if (!cur(st).hand.length) endGame(st, st.turn);
  }

  function open(st, melds) {
    const p = cur(st);
    if (st.phase !== 'play') return no('phase');
    if (st.task.id === 'ara') return no('ara');
    if (p.opened) return no('opened');
    const all = [].concat(...melds.map(m => m.cards));
    if (!inHand(p, all)) return no('hand');
    const left = melds.slice();
    for (const rq of st.task.reqs) {
      const k = left.findIndex(m => m.t === rq.t && m.cards.length === rq.n && validMeld(m.cards, m.t, rq.n));
      if (k < 0) return no('match');
      left.splice(k, 1);
    }
    if (left.length) return no('match');
    removeCards(p, all);
    for (const m of melds) putMeld(st, m.t, m.cards);
    p.opened = true;
    st.justOpened = true;
    say(st, 'open', { p: st.turn, melds: meldIds(melds) });
    checkOut(st);
    return yes;
  }

  function layMeld(st, cards, t) {
    const p = cur(st);
    if (st.phase !== 'play') return no('phase');
    if (!p.opened) return no('closed', { ara: st.task.id === 'ara' });
    if (st.justOpened) return no('wait');
    if (!inHand(p, cards)) return no('hand');
    if (cards.length < 3) return no('short');
    if (t && t !== 'set' && t !== 'run') return no('type');
    const type = t || meldTypes(cards)[0];
    if (!type || !validMeld(cards, type, 3)) return no('shape', { t: type || null });
    removeCards(p, cards);
    putMeld(st, type, cards);
    say(st, 'lay', { p: st.turn, t: type, ids: ids(cards) });
    checkOut(st);
    return yes;
  }

  function addToMeld(st, mid, cards) {
    const p = cur(st);
    if (st.phase !== 'play') return no('phase');
    if (!p.opened) return no('closed', { ara: st.task.id === 'ara' });
    if (st.justOpened) return no('wait');
    const m = st.melds.find(x => x.id === mid);
    if (!m) return no('meld');
    if (!cards.length) return no('pick');
    if (!inHand(p, cards)) return no('hand');
    const next = m.cards.concat(cards);
    if (!validMeld(next, m.t, 2)) return no('fit', { t: m.t });
    removeCards(p, cards);
    m.cards = m.t === 'run' ? runLayout(next) : next;
    fx(st, 'place');
    say(st, 'add', { p: st.turn, mid: mid, ids: ids(cards) });
    checkOut(st);
    return yes;
  }

  // Arabitis: melds must use the whole hand, leaving at most one card to discard
  function finishHand(st, melds) {
    const p = cur(st);
    if (st.phase !== 'play') return no('phase');
    if (st.task.id !== 'ara') return no('notara');
    const all = [].concat(...melds.map(m => m.cards));
    if (!inHand(p, all)) return no('hand');
    if (!melds.every(m => validMeld(m.cards, m.t, 3))) return no('shape');
    if (p.hand.length - all.length > 1) return no('whole');
    removeCards(p, all);
    for (const m of melds) putMeld(st, m.t, m.cards);
    p.opened = true;
    say(st, 'finish', { p: st.turn, melds: meldIds(melds) });
    if (p.hand.length) {
      st.discard.push(p.hand.pop());
      say(st, 'discard', { p: st.turn, card: st.discard[st.discard.length - 1].id });
    }
    endGame(st, st.turn);
    return yes;
  }

  function discard(st, card) {
    const p = cur(st);
    if (st.phase !== 'play') return no('phase');
    if (!p.hand.includes(card)) return no('hand');
    removeCards(p, [card]);
    st.discard.push(card);
    fx(st, 'place');
    say(st, 'discard', { p: st.turn, card: card.id });
    if (!p.hand.length) endGame(st, st.turn);
    else nextTurn(st);
    return yes;
  }

  // what Open would lay with the current selection (or the whole hand)
  function openPlan(st, sel) {
    const p = cur(st);
    if (st.phase !== 'play' || p.opened) return null;
    if (st.task.id === 'ara') return finishPlan(p.hand);
    return openMelds(sel && sel.length ? sel : p.hand, st.task.reqs);
  }

  function endGame(st, fin) {
    const ch = st.chooser;
    if (fin >= 0) {
      const g = Math.min(5, st.pot);
      st.pot -= g;
      st.players[fin].chips += g;
    }
    const rows = st.players.map((p, i) => {
      const hp = handPts(p.hand);
      let adj = 0;
      if (i === ch) {
        if (i === fin) adj = -50;
        else if (!p.opened) adj = 50;
      }
      p.score += hp + adj;
      return { cards: p.hand.length, pts: hp, adj: adj, game: hp + adj, total: p.score, chips: p.chips };
    });
    st.result = { rows: rows, finisher: fin };
    st.stats.push({ fin: fin, turns: st.turns, task: st.task.id });
    st.lastFin = fin;
    st.phase = 'gameend';
    st.claim = null;
    if (fin >= 0) say(st, 'out', { p: fin });
    else say(st, 'stockout');
  }

  function nextGame(st) {
    if (st.phase !== 'gameend') return no('phase');
    if (st.gameNo >= st.games) endMatch(st);
    else startGame(st);
    return yes;
  }

  function endMatch(st) {
    const order = st.players.map((p, i) => i);
    const last = st.result.rows;
    order.sort((a, b) => st.players[a].score - st.players[b].score || last[a].game - last[b].game || a - b);
    const low = order[0];
    const fin = st.lastFin;
    const pay = st.players.map(() => 0);
    if (fin < 0 || fin === low) pay[low] = st.pot;
    else {
      pay[fin] = Math.floor(st.pot / 3);
      pay[low] = st.pot - pay[fin];
    }
    for (let i = 0; i < st.n; i++) st.players[i].chips += pay[i];
    st.final = { order: order, low: low, finisher: fin, pay: pay, pot: st.pot };
    say(st, 'win', { p: low });
    st.pot = 0;
    st.phase = 'matchend';
  }

  // Cards go out as ids and come back as the shared card objects, so the
  // identity checks in the rules keep working after a reload.
  function dump(st) {
    const d = JSON.parse(JSON.stringify(st, (k, v) => {
      if (v && typeof v === 'object') {
        if (CARDS[v.id] === v) return { $c: v.id };
        if (TASKS.includes(v)) return { $t: v.id };
      }
      return v;
    }));
    d.v = 1;
    return d;
  }

  function load(json, o) {
    let st;
    try {
      st = JSON.parse(typeof json === 'string' ? json : JSON.stringify(json), (k, v) => {
        if (v && typeof v === 'object') {
          if ('$c' in v) return CARDS[v.$c];
          if ('$t' in v) return TASKS.find(t => t.id === v.$t);
        }
        return v;
      });
    } catch (e) {
      return null;
    }
    if (!st || st.v !== 1 || !st.players) return null;
    delete st.v;
    st.rnd = (o && o.rnd) || Math.random;
    if (st.fx) st.fx = [];
    return st;
  }

  // Relaxed bots slip with these chances; sharp bots never touch st.rnd.
  const SLIP = { noClaim: 0.8, passDiscard: 0.5, badDiscard: 0.5, missAdd: 0.5, late: 0.45 };

  function slip(st, k) {
    return st.level === 'relaxed' && st.rnd() < SLIP[k];
  }

  function botChoose(st, p) {
    let best = null;
    let bd = Infinity;
    for (const t of st.tasksLeft) {
      const d = plan(p.hand, t.reqs).missing;
      if (d < bd) { bd = d; best = t; }
    }
    chooseTask(st, best.id);
  }

  function botDraw(st, p) {
    const top = st.discard[st.discard.length - 1];
    let take = false;
    if (top) {
      if (!p.opened) {
        const g = gain(st, p, top);
        take = g[1] < g[0];
      } else {
        take = st.melds.some(m => validMeld(m.cards.concat(top), m.t, 2));
        if (!take) {
          const a = partition(p.hand, 800).left;
          const b = partition(p.hand.concat(top), 800).left;
          take = b <= a;
        }
      }
    }
    if (take && !slip(st, 'passDiscard')) takeDiscard(st);
    else drawStock(st);
  }

  function botClaim(st, p) {
    if (p.opened || p.claims >= 4) return false;
    const g = gain(st, p, st.claim.card);
    return g[1] < g[0] && g[1] <= 2 && !slip(st, 'noClaim');
  }

  function addAll(st, p) {
    let moved = true;
    while (moved && p.hand.length) {
      moved = false;
      for (const c of p.hand.slice()) {
        if (!c.r) continue;
        const m = st.melds.find(x => validMeld(x.cards.concat(c), x.t, 2));
        if (!m || slip(st, 'missAdd')) continue;
        addToMeld(st, m.id, [c]);
        if (st.phase !== 'play') return;
        moved = true;
      }
    }
  }

  function layAll(st, p, melds) {
    for (const m of melds) {
      layMeld(st, m.cards, m.t);
      if (st.phase !== 'play') return;
    }
  }

  function botPlay(st, p) {
    if (st.task.id === 'ara') {
      const melds = finishPlan(p.hand);
      if (melds && !slip(st, 'late')) finishHand(st, melds);
      return;
    }
    if (!p.opened) {
      const melds = openMelds(p.hand, st.task.reqs);
      if (melds && !slip(st, 'late')) open(st, melds);
      return;
    }
    addAll(st, p);
    if (st.phase !== 'play') return;
    const full = partition(p.hand);
    if (full.left <= 1) {
      layAll(st, p, full.melds);
      return;
    }
    const nat = partition(p.hand.filter(c => c.r));
    layAll(st, p, nat.melds);
    if (st.phase !== 'play') return;
    addAll(st, p);
    if (st.phase !== 'play') return;
    // jokers only go down when that leaves at most one card to discard
    if (p.hand.filter(c => c.r).length <= 1) {
      for (const j of p.hand.filter(c => !c.r)) {
        const m = st.melds.find(x => validMeld(x.cards.concat(j), x.t, 2));
        if (m) addToMeld(st, m.id, [j]);
        if (st.phase !== 'play') return;
      }
    }
  }

  function botDiscard(st, p) {
    const nat = p.hand.filter(c => c.r);
    const pool = nat.length ? nat : p.hand;
    const seen = new Set();
    let best = null;
    let bs = null;
    for (const c of pool) {
      const key = c.s + c.r;
      if (seen.has(key)) continue;
      seen.add(key);
      const rest = p.hand.filter(x => x !== c);
      let d;
      if (st.task.id === 'ara') d = partition(rest, 800).left;
      else if (!p.opened) d = deficit(rest, st.task);
      else d = partition(rest, 400).left;
      const v = pts(c) - 7 * neighbours(p.hand, c);
      if (best === null || d < bs[0] || (d === bs[0] && v > bs[1])) { best = c; bs = [d, v]; }
    }
    if (slip(st, 'badDiscard')) best = pool[Math.floor(st.rnd() * pool.length)];
    discard(st, best);
  }

  // One visible bot action. False when a human has to act or nothing is running.
  function botStep(st) {
    if (st.phase === 'choose') {
      const p = cur(st);
      if (!p.bot) return false;
      botChoose(st, p);
      return true;
    }
    if (st.phase === 'draw') {
      const p = cur(st);
      if (!p.bot) return false;
      botDraw(st, p);
      return true;
    }
    if (st.phase === 'claim') {
      const q = st.players[claimer(st)];
      if (!q.bot) return false;
      if (botClaim(st, q)) claimTake(st);
      else claimPass(st);
      return true;
    }
    if (st.phase === 'play') {
      const p = cur(st);
      if (!p.bot) return false;
      if (!st.played) {
        st.played = true;
        botPlay(st, p);
      } else botDiscard(st, p);
      return true;
    }
    return false;
  }

  return {
    TASKS: TASKS, CARDS: CARDS, BOT_NAMES: BOT_NAMES,
    pts: pts, handPts: handPts, cardName: cardName,
    validMeld: validMeld, meldTypes: meldTypes, runLayout: runLayout, runStart: runStart,
    plan: plan, openSearch: openSearch, partition: partition, finishPlan: finishPlan,
    away: away, need: need, fits: fits,
    newMatch: newMatch, startGame: startGame, chooseTask: chooseTask,
    drawStock: drawStock, takeDiscard: takeDiscard, claimTake: claimTake, claimPass: claimPass, claimer: claimer,
    open: open, openPlan: openPlan, layMeld: layMeld, addToMeld: addToMeld, finishHand: finishHand,
    discard: discard, nextGame: nextGame, botStep: botStep, cur: cur,
    dump: dump, load: load
  };
})();

if (typeof module !== 'undefined') module.exports = Game;
