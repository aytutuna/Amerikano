// The app is drawn on a stage of 844 x 390 units. u is one unit in pixels; text is sized from the root font so system text zoom still applies.
var Stage = (function () {
  const root = document.documentElement;
  const box = document.getElementById('stage');
  const W = 844, H = 390;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:max(env(safe-area-inset-top,0px),var(--safe-area-inset-top,0px)) max(env(safe-area-inset-right,0px),var(--safe-area-inset-right,0px)) max(env(safe-area-inset-bottom,0px),var(--safe-area-inset-bottom,0px)) max(env(safe-area-inset-left,0px),var(--safe-area-inset-left,0px))';
  root.appendChild(probe);
  // turning the phone over only swaps the left and right insets, which leaves the size of the probe above unchanged
  const edge = document.createElement('div');
  edge.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-left:max(env(safe-area-inset-left,0px),var(--safe-area-inset-left,0px))';
  root.appendChild(edge);
  const S = { u: 1 };
  // Android scales rendered text without changing the computed font size, so a ruler is compared with the same text on a canvas
  const ruler = document.createElement('span');
  ruler.style.cssText = 'position:fixed;visibility:hidden;white-space:nowrap;font:100px sans-serif';
  ruler.textContent = 'Hamburgefonstiv';
  root.appendChild(ruler);
  const pen = document.createElement('canvas').getContext('2d');
  pen.font = '100px sans-serif';
  const flat = pen.measureText(ruler.textContent).width;

  function typing() {
    const e = document.activeElement;
    return !!e && (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && /^(text|search|email|number|tel|url|password)$/.test(e.type)));
  }

  function fit() {
    // the soft keyboard shrinks the window; keep the stage and let the sheet scroll
    if (typing() && innerWidth === S.iw && innerHeight < S.ih) return;
    S.iw = innerWidth;
    S.ih = innerHeight;
    const c = getComputedStyle(probe);
    S.pad = c.padding;
    const top = parseFloat(c.paddingTop) || 0, right = parseFloat(c.paddingRight) || 0;
    const bottom = parseFloat(c.paddingBottom) || 0, left = parseFloat(c.paddingLeft) || 0;
    const aw = innerWidth - left - right, ah = innerHeight - top - bottom;
    // wider than 2.4:1 or squarer than 3:2 would stretch the layout, so the stage stops there and the wood shows around it
    const w = Math.min(aw, ah * 2.4);
    const h = Math.min(ah, w / 1.5);
    const u = Math.max(.5, Math.min(w / W, h / H, 2.2));
    const zr = ruler.getBoundingClientRect().width / flat;
    const z = Math.max((parseFloat(getComputedStyle(root).fontSize) || 17) / 17, zr);
    const moved = u !== S.u;
    S.u = u;
    box.style.left = Math.round(left + (aw - w) / 2) + 'px';
    box.style.top = Math.round(top + (ah - h) / 2) + 'px';
    box.style.width = Math.round(w) + 'px';
    box.style.height = Math.round(h) + 'px';
    root.style.setProperty('--u', u + 'px');
    // text grows with the system setting up to 1.3 times, boxes never do
    root.style.setProperty('--fz', u * Math.min(z, 1.3) / z);
    root.style.setProperty('--tz', z);
    // only text scaling that also scales pixels (Android) is divided out of sizes drawn in pixels
    root.style.setProperty('--tzr', zr);
    root.style.setProperty('--mw', Math.round(38 * u) + 'px');
    root.classList.toggle('zoomed', z > 1.15);
    // screens drawn in pixels redraw on resize
    if (moved && S.ready) window.dispatchEvent(new Event('resize'));
  }

  fit();
  S.ready = true;
  window.addEventListener('resize', fit);
  document.addEventListener('focusout', () => setTimeout(fit, 50));
  // the insets arrive after load and move when the phone is turned over, with no resize
  new ResizeObserver(fit).observe(probe, { box: 'border-box' });
  new ResizeObserver(fit).observe(edge, { box: 'border-box' });
  // a text size changed in the system settings shows up with no resize
  // turning the phone half way round moves the inset to the other side without changing the size
  // the native bar insets land a moment after the event, as style properties on the root, and env() can lag on iOS
  const turned = () => { fit(); setTimeout(fit, 150); };
  window.addEventListener('orientationchange', turned);
  if (screen.orientation) screen.orientation.addEventListener('change', turned);
  new MutationObserver(() => { if (getComputedStyle(probe).padding !== S.pad) fit(); }).observe(root, { attributes: true, attributeFilter: ['style'] });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fit(); });
  return S;
})();
