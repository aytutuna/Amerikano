var Shop = (function () {
  const node = Cards.node;
  // RevenueCat's public SDK keys; Android has none until its Play app exists
  const KEYS = { ios: 'appl_cEUnkcNStTBVeCTrDPvqTfHWOEs', android: '' };
  const fmt = n => n.toLocaleString(I18n.loc());
  const who = seed => Names.text(seed, I18n.lang());
  const TABS = ['tokens', 'frame', 'plate', 'back', 'felt', 'emote'];
  let state = null;
  let prices = null;
  let rc = Promise.resolve('');
  let tab = 'tokens';
  let ask = '';
  let busy = false;
  let msg = '';

  const platform = () => (window.Capacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : 'web');
  const plug = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases;
  const live = () => !!plug() && !!KEYS[platform()];
  const has = id => !!state && state.owned.includes(id);
  const cancelled = e => !!e && (e.userCancelled || (e.data && e.data.userCancelled));

  // RevenueCat knows the player by the account id; a new account logs in over the old one
  function link() {
    const id = Account.id();
    if (!live() || !id) return Promise.resolve(false);
    rc = rc.then(async cur => {
      if (cur === id) return cur;
      try {
        if (cur) await plug().logIn({ appUserID: id });
        else await plug().configure({ apiKey: KEYS[platform()], appUserID: id });
        return id;
      } catch (e) {
        return cur;
      }
    });
    return rc.then(cur => cur === id);
  }

  async function load() {
    state = await Account.call('GET', '/api/shop');
    return state;
  }

  async function packs() {
    if (prices) return prices;
    if (!await link()) throw new Error('rc');
    const r = await plug().getProducts({ productIdentifiers: Catalog.PACKS.map(Catalog.product), type: 'NON_SUBSCRIPTION' });
    prices = Object.fromEntries(r.products.map(p => [p.identifier, p]));
    return prices;
  }

  function start() {
    if (!Account.has()) return;
    // whatever the last account had is gone
    state = null;
    ask = '';
    load().catch(() => {});
    link();
  }

  function preview(item, i) {
    const pv = node('span', 'ipv');
    pv.setAttribute('aria-hidden', 'true');
    const me = Account.me();
    if (item === 'pack') {
      const g = node('span', 'pvt');
      for (let k = 0; k < 1 + Math.min(3, Math.floor((i + 1) / 2)); k++) g.appendChild(Cards.icon('i-token', 'tkg'));
      pv.appendChild(g);
    } else if (item.slot === 'frame') pv.appendChild(Avatar.sized(me.avatar, 44, item.id));
    else if (item.slot === 'plate') {
      const p = node('span', 'pvp', who(me.seed));
      p.dataset.plate = item.id;
      pv.appendChild(p);
    } else if (item.slot === 'back') {
      const b = node('span', 'pvb');
      b.dataset.back = item.id;
      b.appendChild(Cards.backEl());
      pv.appendChild(b);
    } else if (item.slot === 'felt') {
      const o = node('span', 'oval');
      o.dataset.felt = item.id;
      pv.appendChild(o);
    } else {
      const row = node('span', 'pve');
      for (const k of item.emotes) row.appendChild(Cards.icon('e-' + k, 'em'));
      pv.appendChild(row);
    }
    return pv;
  }

  function price(n) {
    const p = node('span', 'price');
    p.appendChild(Cards.icon('i-token', 'chip'));
    p.appendChild(node('b', '', fmt(n)));
    return p;
  }

  function button(kind, label, fn) {
    const b = node('button', 'btn ' + kind, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  // every change comes back as the shop as the server has it; the lobby's purse and the table follow
  async function change(path, body) {
    msg = '';
    try {
      state = await Account.call('POST', path, body);
      await Account.refresh();
    } catch (e) {
      // an item that is already owned needs no message, only the state as it is
      msg = e.message === 'owned' ? '' : t(e.message === 'broke' ? 'shop.broke' : 'shop.failed');
      await load().catch(() => {});
    }
  }

  function itemTile(item, draw) {
    const e = node('div', 'itile');
    e.appendChild(preview(item));
    const name = t('shop.item.' + item.id);
    e.appendChild(node('b', 'inm', name));
    const bt = node('div', 'ibt');
    const done = () => { ask = ''; UI.redraw(); draw(); };
    if (!has(item.id)) {
      const tokens = state.tokens;
      if (ask === item.id) {
        bt.appendChild(node('span', 'ask', t('shop.ask', { n: t('shop.count', { n: item.price }) })));
        bt.appendChild(button('primary', t('shop.yes'), () => change('/api/shop/buy', { item: item.id }).then(() => { if (!msg) Live.say(t('shop.bought', { name: name })); done(); })));
        bt.appendChild(button('quiet', t('shop.no'), done));
      } else {
        const b = button('primary', '', () => { ask = item.id; draw(); });
        b.appendChild(price(item.price));
        b.setAttribute('aria-label', t('shop.buyFor', { name: name, n: t('shop.count', { n: item.price }) }));
        b.disabled = tokens < item.price;
        bt.appendChild(b);
      }
    } else if (item.slot === 'emote') bt.appendChild(node('span', 'tag', t('shop.owned')));
    else if (state.worn[item.slot] === item.id) {
      e.classList.add('worn');
      bt.appendChild(node('span', 'tag', t('shop.worn')));
      bt.appendChild(button('quiet', t('shop.off'), () => change('/api/shop/wear', { slot: item.slot, item: null }).then(done)));
    } else bt.appendChild(button('plain', t('shop.wear'), () => change('/api/shop/wear', { slot: item.slot, item: item.id }).then(done)));
    e.appendChild(bt);
    return e;
  }

  // how many more tokens a unit of money buys than in the smallest pack, from the store's amounts when it gave all of them
  function bonus(n) {
    const store = prices && Catalog.PACKS.every(k => prices[Catalog.product(k)] && prices[Catalog.product(k)].price > 0);
    const cost = k => (store ? prices[Catalog.product(k)].price : Catalog.USD[k]);
    return Math.round(n / cost(n) / (80 / cost(80)) * 100 - 100);
  }

  // the card shows the price the store gives, in the player's own currency
  function packTile(n, i, draw) {
    const e = node('div', 'itile' + (live() ? '' : ' off'));
    e.appendChild(preview('pack', i));
    if (n > Catalog.PACKS[0]) e.appendChild(node('span', 'bon', t('shop.bonus', { n: bonus(n) })));
    const rib = n === 1200 ? 'popular' : n === 14000 ? 'best' : '';
    if (rib) e.appendChild(node('span', 'rbn', t('shop.' + rib)));
    e.appendChild(node('b', 'inm', t('shop.count', { n: n })));
    const bt = node('div', 'ibt');
    const p = prices && prices[Catalog.product(n)];
    const b = button('primary', p ? p.priceString : '...', () => buyPack(n, draw));
    b.disabled = !live() || !p || busy;
    if (p) b.setAttribute('aria-label', t('shop.buyFor', { name: t('shop.count', { n: n }), n: p.priceString }));
    bt.appendChild(b);
    e.appendChild(bt);
    return e;
  }

  async function buyPack(n, draw) {
    busy = true;
    msg = '';
    draw();
    // never buy under a RevenueCat user that is not this account
    if (!await link()) {
      busy = false;
      msg = t('shop.failed');
      return draw();
    }
    try {
      await plug().purchaseStoreProduct({ product: prices[Catalog.product(n)] });
    } catch (e) {
      busy = false;
      // Ask to Buy: the parent has to approve, and the webhook credits the tokens then
      if (String(e && (e.code || (e.data && e.data.code))) === '20') msg = t('shop.pending');
      else if (!cancelled(e)) msg = t('shop.failed');
      return draw();
    }
    // the tokens are asked for now so they do not wait for the webhook; if that fails they arrive on their own
    try {
      try {
        state = await Account.call('POST', '/api/shop/sync');
      } catch (e) {
        // the open sheet may have just asked: one sync at a time, so try again after the gap
        if (e.status !== 429) throw e;
        await new Promise(r => setTimeout(r, 10500));
        state = await Account.call('POST', '/api/shop/sync');
      }
      await Account.refresh();
      Live.say(t('shop.added', { n: n }));
    } catch (e) {
      msg = t('shop.late');
    }
    busy = false;
    UI.redraw();
    draw();
  }

  function note(text) {
    return node('p', 'note', text);
  }

  function open(done) {
    const body = node('div', 'shop');
    ask = '';
    msg = '';
    const h = Sheet.open({ kind: 'bottom', tall: true, title: t('shop.title'), body: body, onClose: done, actions: [{ label: t('close'), kind: 'primary' }] });
    const me = Account.me();

    function draw() {
      if (!document.contains(body)) return;
      const focus = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.k : null;
      body.textContent = '';
      const top = node('div', 'shop-top');
      const bal = node('span', 'shop-bal');
      bal.appendChild(Cards.icon('i-token', 'chip'));
      bal.appendChild(node('b', '', t('shop.count', { n: state ? state.tokens : me.tokens || 0 })));
      top.appendChild(bal);
      const list = node('div', 'tabs sub');
      list.setAttribute('role', 'tablist');
      for (const k of TABS) {
        const b = node('button', 'tab', t('shop.tab.' + k));
        b.type = 'button';
        b.dataset.k = 'tab' + k;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', tab === k);
        b.addEventListener('click', () => { tab = k; ask = ''; msg = ''; draw(); });
        list.appendChild(b);
      }
      top.appendChild(list);
      body.appendChild(top);
      if (msg) {
        const m = note(msg);
        m.setAttribute('role', 'alert');
        body.appendChild(m);
      }
      if (!state) return body.appendChild(note(t('shop.loading')));
      const grid = node('div', 'sgrid');
      if (tab === 'tokens') {
        Catalog.PACKS.forEach((n, i) => grid.appendChild(packTile(n, i, draw)));
        body.appendChild(grid);
        if (!live()) body.appendChild(note(t(platform() === 'android' ? 'shop.android' : 'shop.web')));
        else if (!me.apple) body.appendChild(note(t('shop.guest')));
        body.appendChild(note(t('shop.earn', { n: Catalog.MATCH, cap: Catalog.DAILY, got: state.earned })));
        body.appendChild(note(t('shop.rule')));
      } else {
        for (const item of Catalog.ITEMS) if (item.slot === tab) grid.appendChild(itemTile(item, draw));
        body.appendChild(grid);
        if (tab === 'emote') body.appendChild(note(t('shop.emoNote')));
      }
      if (focus) {
        const f = body.querySelector('[data-k="' + focus + '"]');
        if (f) f.focus({ preventScroll: true });
      }
    }

    draw();
    load().then(draw, () => {
      msg = t('shop.failed');
      draw();
    });
    if (live()) {
      packs().then(draw, () => {});
      // purchases made earlier that never reached the server are picked up here
      Account.call('POST', '/api/shop/sync').then(s => {
        if (state && s.tokens === state.tokens) return;
        state = s;
        Account.refresh().then(() => { UI.redraw(); draw(); }, () => {});
      }, () => {});
    }
    return h;
  }

  // the extra emotes the player may use at a table
  const emotes = () => Catalog.ITEMS.filter(i => i.emotes && has(i.id)).flatMap(i => i.emotes);

  return { open: open, start: start, emotes: emotes, load: load };
})();
