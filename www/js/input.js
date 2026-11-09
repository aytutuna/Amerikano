var Input = (function () {
  const game = document.getElementById('game');
  const HOLD = 450;
  const SLOP = 9;
  const SLOP_TOUCH = 14;
  let g = null;
  let quiet = 0;

  function over(x, y) {
    const e = document.elementFromPoint(x, y);
    if (!e) return null;
    const m = e.closest('.meld');
    if (m) return { meld: +m.dataset.mid };
    if (e.closest('#discard')) return { discard: true };
    if (e.closest('#rack')) return { rack: true };
    return null;
  }

  function startDrag(e) {
    const r = g.el.getBoundingClientRect();
    g.drag = true;
    g.ox = e.clientX - r.left;
    g.oy = e.clientY - r.top;
    g.el.classList.add('dragging');
    Table.drag = g.id;
    App.dragStart(g.id);
  }

  function moveDrag(e) {
    const hr = document.getElementById('hand').getBoundingClientRect();
    g.el.style.transform = 'translate(' + (e.clientX - hr.left - g.ox) + 'px,' + (e.clientY - hr.top - g.oy) + 'px) scale(1.08)';
    g.el.style.zIndex = 500;
    const o = over(e.clientX, e.clientY);
    g.over = o;
    if (o && o.rack) {
      const i = Table.slotAt(e.clientX, e.clientY);
      if (i >= 0 && i !== App.order.indexOf(g.id)) App.moveTo(g.id, i);
    }
    App.dragOver(o);
  }

  function end(e, cancel) {
    if (!g) return;
    const s = g;
    g = null;
    clearTimeout(s.lp);
    if (s.long || s.drag) quiet = performance.now() + 350;
    if (!s.drag) return;
    s.el.classList.remove('dragging');
    Table.drag = null;
    App.dragEnd(s.id, cancel ? null : s.over);
  }

  game.addEventListener('pointerdown', e => {
    // a lost pointerup (node replaced, app backgrounded) must not block every later press
    if (g && e.isPrimary) end(e, true);
    if (g || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = e.target.closest('.card');
    if (!el || !el.dataset.id || el.classList.contains('dunder') || el.classList.contains('pc')) return;
    g = { id: +el.dataset.id, el: el, pid: e.pointerId, slop: e.pointerType === 'mouse' ? SLOP : SLOP_TOUCH, x: e.clientX, y: e.clientY, rack: el.classList.contains('rc') };
    g.lp = setTimeout(() => {
      g.long = true;
      App.preview(g.id);
    }, HOLD);
  });

  window.addEventListener('pointermove', e => {
    if (!g || g.long || e.pointerId !== g.pid) return;
    if (!g.drag) {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < g.slop) return;
      clearTimeout(g.lp);
      if (!g.rack) { g = null; return; }
      startDrag(e);
    }
    moveDrag(e);
  });
  window.addEventListener('pointerup', e => { if (g && e.pointerId === g.pid) end(e, false); });
  window.addEventListener('pointercancel', e => { if (g && e.pointerId === g.pid) end(e, true); });

  game.addEventListener('contextmenu', e => e.preventDefault());

  game.addEventListener('keydown', e => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('rc') || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const id = +el.dataset.id;
    const i = App.order.indexOf(id) + (e.key === 'ArrowLeft' ? -1 : 1);
    App.moveTo(id, Math.max(0, Math.min(App.order.length - 1, i)));
  });

  game.addEventListener('click', e => {
    if (performance.now() < quiet) return;
    const el = e.target.closest('button');
    if (!el) return;
    if (el.classList.contains('rc')) return App.tapCard(+el.dataset.id);
    if (el.classList.contains('mc')) {
      const m = el.closest('.meld');
      return m.classList.contains('tg') ? App.addTo(+m.dataset.mid) : App.preview(+el.dataset.id);
    }
    if (el.classList.contains('plus')) return App.addTo(+el.dataset.mid);
    if (el.id === 'stock') return App.tapStock();
    if (el.id === 'discard') {
      return App.tapDiscard();
    }
    if (el.dataset.key && el.parentNode.id === 'acts') return App.act(el.dataset.key);
    if (el.id === 'sort') return App.sort();
    if (el.id === 'mvl' || el.id === 'mvr') return App.move(el.id === 'mvl' ? -1 : 1);
    if (el.id === 'score') return UI.score();
    if (el.id === 'menu') return UI.pause();
  });

  return {};
})();
