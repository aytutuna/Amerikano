var UI = (function () {
  const node = Cards.node;
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const FAN = [23, 37, 104, 51, 12];
  let launched = false;

  function button(label, kind, fn) {
    const b = node('button', 'btn ' + kind, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function kilim() {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'hm-kilim');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('width', '1200');
    r.setAttribute('height', '120');
    r.setAttribute('fill', 'url(#kilim)');
    r.setAttribute('transform', 'scale(3)');
    s.appendChild(r);
    return s;
  }

  // whole kilim rows (36px each) so the band never ends on a cut motif
  function kilimRows() {
    const land = matchMedia('(orientation: landscape) and (max-height: 520px)').matches;
    const rows = land ? 2 : Math.max(4, Math.min(7, Math.floor(innerHeight * 0.27 / 36)));
    document.documentElement.style.setProperty('--kh', rows * 36 + 'px');
  }

  // The one orchestrated moment: the fan opens once per launch, later visits show it open.
  function fan(go) {
    const f = node('div', 'fan' + (go ? ' go' : ''));
    f.setAttribute('role', 'img');
    f.setAttribute('aria-label', t('start.fan'));
    FAN.forEach((id, i) => {
      const c = Cards.el(Game.CARDS[id]);
      c.style.setProperty('--a', (i - 2) * 15 + 'deg');
      c.style.setProperty('--i', i);
      f.appendChild(c);
    });
    return f;
  }

  function start(quiet) {
    const home = $('home');
    const keep = quiet && home.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const go = !launched && !quiet;
    launched = true;
    home.hidden = false;
    home.textContent = '';

    kilimRows();
    const top = node('div', 'hm-top');
    top.setAttribute('aria-hidden', 'true');
    top.appendChild(kilim());
    top.appendChild(node('div', 'fringe'));
    home.appendChild(top);

    const main = node('main', 'hm-main');
    const brand = node('div', 'hm-brand');
    const h1 = node('h1', '', t('start.title'));
    brand.appendChild(h1);
    brand.appendChild(fan(go));
    main.appendChild(brand);

    const nav = node('div', 'hm-btns');
    const saved = App.saved();
    if (saved) {
      const c = button('', 'primary big', () => App.resume());
      c.appendChild(node('b', '', t('start.cont')));
      c.appendChild(node('span', '', t('start.saved', saved)));
      c.dataset.k = 'cont';
      nav.appendChild(c);
    }
    const n = button(t('start.go'), saved ? 'plain' : 'primary big', setup);
    n.dataset.k = 'go';
    nav.appendChild(n);
    const row = node('div', 'hm-row');
    const h = button(t('start.how'), 'quiet', howTo);
    h.dataset.k = 'how';
    const s = button(t('start.settings'), 'quiet', settings);
    s.dataset.k = 'set';
    row.appendChild(h);
    row.appendChild(s);
    nav.appendChild(row);
    main.appendChild(nav);
    home.appendChild(main);
    // Large system text sizes scale the title past the screen width.
    document.fonts.ready.then(() => {
      const room = getComputedStyle(main).display === 'grid' ? brand.clientWidth : main.clientWidth - 40;
      if (h1.offsetWidth > room) h1.style.setProperty('--fit', room / h1.offsetWidth);
    });

    if (keep) {
      const e = home.querySelector('[data-k="' + keep + '"]');
      if (e) e.focus({ preventScroll: true });
    }
  }

  // Radio group drawn as pills or rows; the native input stays for keyboard and screen readers.
  function choice(name, legend, opts, cur, fn, cls) {
    const fs = node('fieldset', 'fld ' + (cls || ''));
    fs.appendChild(node('legend', '', legend));
    const wrap = node('div', 'opts');
    for (const o of opts) {
      const lab = node('label', 'opt');
      const inp = node('input');
      inp.type = 'radio';
      inp.name = name;
      inp.value = o.v;
      inp.checked = o.v === cur;
      inp.dataset.f = name + ':' + o.v;
      inp.addEventListener('change', () => fn(o.v));
      lab.appendChild(inp);
      const face = node('span', 'face');
      face.appendChild(node('b', '', o.label));
      if (o.note) face.appendChild(node('small', '', o.note));
      lab.appendChild(face);
      wrap.appendChild(lab);
    }
    fs.appendChild(wrap);
    return fs;
  }

  function gameOptions(n) {
    const out = [];
    for (let g = n; g <= 16; g += n) out.push(g);
    return out;
  }

  function setup() {
    let n = Settings.get('players');
    if (![3, 4, 5].includes(n)) n = 4;
    let g = Settings.get('games');
    let lv = Settings.get('level') === 'sharp' ? 'sharp' : 'relaxed';
    const form = node('div', 'form');
    const saved = App.saved();

    function fill() {
      const opts = gameOptions(n);
      if (!opts.includes(g)) g = opts.reduce((a, b) => Math.abs(b - g) < Math.abs(a - g) ? b : a);
      form.textContent = '';
      form.appendChild(choice('players', t('setup.players'), [3, 4, 5].map(v => ({ v: v, label: String(v) })), n, v => {
        n = v;
        fill();
        focusOn('players:' + v);
      }, 'seg'));
      form.appendChild(choice('games', t('setup.games'), opts.map(v => ({ v: v, label: String(v) })), g, v => { g = v; }, 'seg'));
      form.appendChild(node('p', 'note', t('setup.gamesNote')));
      form.appendChild(choice('level', t('setup.level'), [
        { v: 'relaxed', label: t('setup.relaxed'), note: t('setup.relaxedNote') },
        { v: 'sharp', label: t('setup.sharp'), note: t('setup.sharpNote') }
      ], lv, v => { lv = v; }, 'rows'));
      if (saved) form.appendChild(node('p', 'note', t('setup.replace')));
    }

    function focusOn(key) {
      const e = form.querySelector('[data-f="' + key + '"]');
      if (e) e.focus({ preventScroll: true });
    }

    fill();

    Sheet.open({
      kind: 'bottom', tall: true, title: t('setup.title'), body: form,
      actions: [
        {
          label: t('setup.go'), kind: 'primary', fn: () => {
            Settings.set('players', n, true);
            Settings.set('games', g, true);
            Settings.set('level', lv, true);
            App.newMatch({ players: n, games: g, level: lv });
          }
        },
        { label: t('cancel'), kind: 'quiet' }
      ]
    });
  }

  function toggle(key, label, note, extra) {
    const row = node('label', 'row');
    const id = 'tg-' + key;
    const tx = node('span', 'tx');
    const b = node('b', '', label);
    b.id = id;
    tx.appendChild(b);
    if (note) {
      const s = node('small', '', note);
      s.id = id + '-n';
      tx.appendChild(s);
    }
    if (extra) tx.appendChild(extra);
    row.appendChild(tx);
    const st = node('span', 'onoff', t(Settings.get(key) ? 'on' : 'off'));
    st.setAttribute('aria-hidden', 'true');
    row.appendChild(st);
    const inp = node('input', 'swt');
    inp.type = 'checkbox';
    inp.setAttribute('role', 'switch');
    inp.checked = !!Settings.get(key);
    inp.dataset.f = key;
    inp.setAttribute('aria-labelledby', id);
    if (note) inp.setAttribute('aria-describedby', id + '-n');
    inp.addEventListener('change', () => {
      st.textContent = t(inp.checked ? 'on' : 'off');
      Settings.set(key, inp.checked);
    });
    row.appendChild(inp);
    row.appendChild(node('span', 'track'));
    return row;
  }

  function settings() {
    const form = node('div', 'form');
    let h = null;

    function fill() {
      const was = document.activeElement && form.contains(document.activeElement) ? document.activeElement.dataset.f : null;
      form.textContent = '';
      form.appendChild(choice('lang', t('set.lang'), [
        { v: 'auto', label: t('set.auto') },
        { v: 'en', label: t('set.en') },
        { v: 'tr', label: t('set.tr') }
      ], Settings.get('lang'), v => { Settings.set('lang', v); fill(); if (h) h.set(t('set.title'), done()); }, 'seg'));
      form.appendChild(toggle('sound', t('set.sound')));
      form.appendChild(toggle('haptics', t('set.haptics')));
      const sw = node('span', 'suits');
      sw.setAttribute('aria-hidden', 'true');
      for (const s of ['s', 'h', 'd', 'c']) sw.appendChild(Cards.icon('su-' + s, 'su sx-' + s));
      form.appendChild(toggle('fourc', t('set.fourc'), t('set.fourcNote'), sw));
      form.appendChild(choice('speed', t('set.speed'), ['slow', 'normal', 'fast'].map(v => ({ v: v, label: t('set.' + v) })), Settings.get('speed'), v => Settings.set('speed', v), 'seg'));
      if (was) {
        const e = form.querySelector('[data-f="' + was + '"]');
        if (e) e.focus({ preventScroll: true });
      }
    }

    const done = () => [{ label: t('done'), kind: 'primary' }];
    fill();
    h = Sheet.open({ kind: 'bottom', tall: true, title: t('set.title'), body: form, actions: done() });
  }

  const cid = (s, r) => ({ c: 0, d: 13, h: 26, s: 39 })[s] + r - 1;

  function demo() {
    const d = node('div', 'demo');
    for (const [key, ids] of [['set', [cid('h', 7), cid('s', 7), cid('d', 7)]], ['run', [cid('h', 4), cid('h', 5), cid('h', 6)]]]) {
      const fig = node('figure', 'fig');
      const row = node('div', 'crow');
      row.setAttribute('role', 'img');
      row.setAttribute('aria-label', I18n.cap(ids.map(i => Cards.label(Game.CARDS[i])).join(', ')));
      for (const i of ids) row.appendChild(Cards.el(Game.CARDS[i]));
      fig.appendChild(row);
      fig.appendChild(node('figcaption', '', t('how.' + key)));
      d.appendChild(fig);
    }
    return d;
  }

  function howTo() {
    const body = node('div', 'how');
    body.appendChild(node('p', 'lead', t('how.intro')));
    for (const s of t('how.secs')) {
      const sec = node('section', 'hsec');
      sec.appendChild(node('h3', '', s.h));
      if (s.demo) sec.appendChild(demo());
      for (const x of s.p) {
        const p = node('p');
        if (x[1]) {
          p.appendChild(node('span', 'tag', t('how.house')));
          p.appendChild(document.createTextNode(' '));
        }
        p.appendChild(document.createTextNode(x[0]));
        sec.appendChild(p);
      }
      body.appendChild(sec);
    }
    Sheet.open({ kind: 'bottom', tall: true, title: t('how.title'), body: body, actions: [{ label: t('close'), kind: 'primary' }] });
  }

  function pause() {
    const body = node('div', 'menu');
    const h = Sheet.open({ kind: 'bottom', title: t('pause.title'), body: body });
    const item = (label, kind, fn) => {
      body.appendChild(button(label, kind, () => { h.close(); fn(); }));
    };
    item(t('pause.resume'), 'primary', () => {});
    item(t('pause.how'), 'plain', howTo);
    item(t('pause.settings'), 'plain', settings);
    item(t('pause.leave'), 'plain', () => App.leave(false));
    body.appendChild(node('p', 'note', t('pause.note')));
  }

  window.addEventListener('resize', () => { if (!$('home').hidden) kilimRows(); });

  return { start: start, pause: pause, settings: settings, howTo: howTo };
})();
