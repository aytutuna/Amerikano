const fs = require('fs');
const path = require('path');
const { test, expect, guest } = require('./fixtures');

const out = path.join(__dirname, 'out');
const variants = [
  { name: 'phone', w: 844, h: 390 },
  { name: 'large-text', w: 844, h: 390, scale: 1.3 },
  { name: 'ipad-mini', w: 1133, h: 744 },
  { name: 'ipad-air', w: 1180, h: 820 },
  { name: 'ipad-pro-13', w: 1376, h: 1032 },
];

// visible elements that hold text of their own and have more content than room
function cutOff() {
  const found = [];
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect();
    if (r.width < 3 || r.height < 3 || getComputedStyle(e).visibility === 'hidden') continue;
    if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    if (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1) {
      found.push({ el: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''),
        text: e.textContent.trim().slice(0, 60), scroll: e.scrollWidth + 'x' + e.scrollHeight, box: e.clientWidth + 'x' + e.clientHeight });
    }
  }
  return found;
}

for (const v of variants) {
  test('Arabic screens, ' + v.name, async ({ page }, info) => {
    await page.setViewportSize({ width: v.w, height: v.h });
    await guest(page, 'ar');
    if (v.scale) {
      await page.evaluate(s => {
        document.documentElement.style.setProperty('font-size', 17 * s + 'px', 'important');
        window.dispatchEvent(new Event('resize'));
      }, v.scale);
    }
    const dir = path.join(out, 'shots');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [];
    async function shot(screen) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(dir, info.project.name + '-' + v.name + '-' + screen + '.png') });
      for (const c of await page.evaluate(cutOff)) lines.push([info.project.name, v.name, screen, c.el, JSON.stringify(c.text), 'content ' + c.scroll, 'box ' + c.box].join(' | '));
    }
    const sheet = async (k, ready) => {
      // in Arabic the top bar runs off the screen, so these buttons cannot be reached by a real click (reported in the cut-off list)
      await page.locator(`[data-k=${k}]`).dispatchEvent('click');
      await expect(page.locator(ready)).toBeVisible();
      await shot(k);
      await page.evaluate(() => Sheet.closeAll());
      await expect(page.locator('.sw')).toHaveCount(0);
    };

    await shot('lobby');
    await sheet('me', '.sw');
    await sheet('set', '.sw');
    await sheet('tokens', '.sw .shop-top');
    await page.click('[data-k=go]');
    await page.click('.sheet .btn.primary');
    await expect(page.locator('#hand .rc').first()).toBeVisible();
    // the first game opens with the task to pick
    await page.locator('.sheet .tk').first().click();
    await expect(page.locator('.sw')).toHaveCount(0);
    await shot('table');
    // an online table the player does not touch: the banner that says the seat is being played for them
    await page.evaluate(() => App.leave(false));
    await page.click('[data-k=quick]');
    await expect(page.locator('#idle')).toBeVisible({ timeout: 90000 });
    await shot('away');

    fs.appendFileSync(path.join(out, 'cutoff.txt'), lines.map(l => l + '\n').join(''));
    expect(await page.locator('html').getAttribute('class')).toContain('rtl');
  });
}
