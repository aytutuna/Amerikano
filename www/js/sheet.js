var Sheet = (function () {
  const root = document.getElementById('sheets');
  const stack = [];
  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  let uid = 0;
  let down = 0;

  document.addEventListener('pointerdown', e => { down = e.timeStamp; }, true);

  function bg() {
    return [document.getElementById('game'), document.getElementById('home')];
  }

  function syncInert() {
    const top = stack[stack.length - 1];
    const modal = stack.some(s => s.o.modal !== false);
    for (const e of bg()) e.inert = modal;
    // a non-modal sheet covers these, so keep focus off them; the rack stays live
    for (const id of ['seats', 'melds', 'piles']) document.getElementById(id).inert = !modal && stack.length > 0;
    for (const s of stack) s.wrap.inert = s !== top && modal;
    if (S.changed) S.changed();
  }

  function acts(h) {
    const o = h.o;
    h.acts.textContent = '';
    h.acts.hidden = !(o.actions && o.actions.length);
    for (const x of o.actions || []) {
      const b = Cards.node('button', 'btn ' + (x.kind || 'plain'), x.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        h.close();
        if (x.fn) x.fn();
      });
      h.acts.appendChild(b);
    }
  }

  // when the opener is gone, land on something a keyboard or screen reader user can act on
  function park() {
    if (stack.length || (document.activeElement && document.activeElement !== document.body)) return;
    for (const q of ['#game:not([hidden]) #stock', '#game:not([hidden]) #hand .card', '#game:not([hidden]) #menu', '#home:not([hidden]) button']) {
      const c = document.querySelector(q);
      if (c) c.focus({ preventScroll: true });
      if (document.activeElement === c) return;
    }
  }

  function open(o) {
    const id = 'sh' + (++uid);
    const wrap = Cards.node('div', 'sw ' + (o.kind || 'bottom'));
    const born = performance.now();
    if (o.modal !== false) {
      const scrim = Cards.node('div', 'scrim');
      // the click that ends a long press lands on the sheet that press just opened
      scrim.addEventListener('click', () => { if (o.dismiss !== false && down >= born) h.close(); });
      wrap.appendChild(scrim);
    }
    const el = Cards.node('section', 'sheet' + (o.tall ? ' tall' : ''));
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', o.modal === false ? 'false' : 'true');
    el.setAttribute('aria-labelledby', id);
    el.tabIndex = -1;
    const head = Cards.node('div', 'sh-head');
    const title = Cards.node('h2', 'sh-title', o.title);
    title.id = id;
    head.appendChild(title);
    el.appendChild(head);
    const body = Cards.node('div', 'sh-body');
    if (o.body) body.appendChild(o.body);
    else body.hidden = true;
    el.appendChild(body);
    if (o.note) {
      el.classList.add('fn');
      el.appendChild(o.note);
    }
    const a = Cards.node('div', 'sh-acts');
    el.appendChild(a);
    wrap.appendChild(el);
    root.appendChild(wrap);
    const h = {
      el: el,
      o: o,
      wrap: wrap,
      head: head,
      title: title,
      acts: a,
      from: document.activeElement,
      set: (text, actions) => {
        if (text != null) title.textContent = text;
        if (actions) { o.actions = actions; acts(h); }
      },
      close: () => {
        const i = stack.indexOf(h);
        if (i < 0) return;
        stack.splice(i, 1);
        wrap.remove();
        syncInert();
        if (o.onClose) o.onClose();
        // a rebuilt home screen replaces the opener, so find its twin by key
        let f = h.from;
        if (f && !document.contains(f) && f.dataset && f.dataset.k) f = document.querySelector('[data-k="' + f.dataset.k + '"]');
        if (f && f !== document.body && document.contains(f) && !f.inert) f.focus({ preventScroll: true });
        if (!stack.length) {
          park();
          // the action that closed the sheet may still be about to redraw
          setTimeout(park, 0);
        }
      }
    };
    acts(h);
    stack.push(h);
    syncInert();
    // a scrolling body needs to be reachable from the keyboard
    if (body.scrollHeight > body.clientHeight) {
      body.tabIndex = 0;
      body.setAttribute('role', 'region');
      body.setAttribute('aria-labelledby', id);
    }
    el.focus({ preventScroll: true });
    return h;
  }

  // false lets the caller treat back as its own (the pause menu, leaving the app)
  function back() {
    const top = stack[stack.length - 1];
    if (!top) return false;
    if (top.o.dismiss !== false) {
      top.close();
      return true;
    }
    return top.o.modal !== false;
  }

  function count() {
    return stack.length;
  }

  function closeAll() {
    while (stack.length) stack[stack.length - 1].close();
  }

  function trap(e) {
    const top = stack[stack.length - 1];
    if (!top || top.o.modal === false) return;
    const list = [...top.el.querySelectorAll(FOCUSABLE)].filter(x => x.getClientRects().length && x.tabIndex >= 0 && !(x.type === 'radio' && !x.checked && top.el.querySelector('input[type=radio][name="' + x.name + '"]:checked')));
    const now = document.activeElement;
    if (!list.length) {
      e.preventDefault();
      top.el.focus();
    } else if (e.shiftKey && (now === list[0] || now === top.el)) {
      e.preventDefault();
      list[list.length - 1].focus();
    } else if (!e.shiftKey && now === list[list.length - 1]) {
      e.preventDefault();
      list[0].focus();
    }
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && back()) e.preventDefault();
    else if (e.key === 'Tab') trap(e);
  });

  const S = { open: open, back: back, count: count, closeAll: closeAll, changed: null };
  return S;
})();
