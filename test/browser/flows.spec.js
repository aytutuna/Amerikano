const { test, expect, guest, signedIn, fakeStore } = require('./fixtures');

test('guest sign-in reaches the lobby', async ({ page }) => {
  await page.goto(process.env.AMK_WEB + '/');
  await expect(page.locator('[data-k=guest]')).toBeVisible();
  await page.click('[data-k=guest]');
  await expect(page.locator('[data-k=me]')).toBeVisible();
  await expect(page.locator('[data-k=quick]')).toBeEnabled();
});

// One step for the human at a Training table, from what the app says the phase is. Returns what it did.
async function humanStep(page) {
  const s = await page.evaluate(() => {
    const st = App.state();
    return { phase: st.phase, mine: st.turn === 0, claim: st.phase === 'claim' && Game.claimer(st) === 0, picked: App.sel.size };
  });
  if (s.phase === 'choose' && s.mine) {
    await page.locator('.sheet .tk').first().click();
    return 'choose';
  }
  if (s.claim) {
    await page.locator('.sheet .btn.plain').click();
    return 'pass';
  }
  if (s.phase === 'draw' && s.mine) {
    await page.click('#stock');
    return 'draw';
  }
  if (s.phase === 'play' && s.mine) {
    if (!s.picked) await page.locator('#hand .rc').first().click();
    await page.click('#discard');
    return 'discard';
  }
  return '';
}

test('a Training hand: draw and discard', async ({ page }) => {
  await guest(page);
  await page.click('[data-k=go]');
  await page.click('.sheet .btn.primary');
  await expect(page.locator('#game')).toBeVisible();
  const did = new Set();
  await expect.poll(async () => {
    const d = await humanStep(page);
    if (d) did.add(d);
    return did.has('draw') && did.has('discard');
  }, { timeout: 60000, intervals: [200] }).toBe(true);
  // the discard went through: the turn moved on to someone else
  await expect.poll(() => page.evaluate(() => App.state().turn), { timeout: 15000 }).not.toBe(0);
});

test('quick play to the end of an online match', async ({ page }) => {
  await guest(page);
  await page.click('[data-k=quick]');
  await expect(page.locator('#game')).toBeVisible({ timeout: 60000 });
  // the turn clock runs fast on the test server, so the computer plays for the person when they do not
  await expect.poll(() => page.evaluate(() => App.state().phase), { timeout: 200000, intervals: [500] }).toBe('matchend');
  await expect(page.locator('.sw.paper .hero')).toBeVisible();
});

test('after two missed turns the seat shows away with a button to take it back', async ({ page }) => {
  await guest(page);
  await page.click('[data-k=quick]');
  await expect(page.locator('#game')).toBeVisible({ timeout: 60000 });
  const idle = page.locator('#idle');
  await expect(idle).toBeHidden();
  // the clock runs fast on the test server: the first missed turn is played for the person, the second sets the seat away
  await expect(idle).toBeVisible({ timeout: 90000 });
  await expect(idle).toContainText('Your time ran out');
  await page.click('#here');
  await expect(idle).toBeHidden();
  // the count starts over, so it takes two more missed turns to show again
  await expect(idle).toBeVisible({ timeout: 90000 });
});

test('shop: buy a token pack and wear a cosmetic', async ({ page }) => {
  await fakeStore(page);
  await guest(page);
  await page.click('[data-k=tokens]');
  const tiles = page.locator('.sheet .itile');
  // the store's prices arrive after the sheet opens
  await expect(tiles.nth(1).locator('.btn.primary')).toBeEnabled();
  await tiles.nth(1).locator('.btn.primary').click();
  // the sheet's own sync is still inside the server's ten second gap, so the app waits it out
  await expect(page.locator('.shop-bal')).toContainText('500', { timeout: 40000 });
  await page.click('[data-k=tabframe]');
  const frame = page.locator('.sheet .itile').first();
  await frame.locator('.btn.primary').click();
  await frame.locator('.btn.primary').click();
  await expect(frame.locator('.btn.plain')).toBeVisible();
  await expect(page.locator('.shop-bal')).toContainText('250');
  await frame.locator('.btn.plain').click();
  await expect(page.locator('.sheet .itile.worn')).toHaveCount(1);
  const worn = await page.evaluate(() => Account.call('GET', '/api/shop'));
  expect(worn.worn.frame).toBe('frame-brass');
});

test('a quick phrase and an emote at an online table', async ({ page }) => {
  await guest(page);
  await page.click('[data-k=quick]');
  await expect(page.locator('#chat')).toBeVisible({ timeout: 60000 });
  await page.click('#chat');
  const phrase = page.locator('.sheet .says .btn').first();
  const said = await phrase.textContent();
  await phrase.click();
  await expect(page.locator('.seat[data-p="0"] .bub:not(.emo)', { hasText: said })).toHaveCount(1);
  await page.click('#chat');
  await page.locator('.sheet .emos .emo').first().click();
  await expect(page.locator('.seat[data-p="0"] .bub.emo use[href="#e-smile"]')).toHaveCount(1);
  // leaving a public table can cost chips, and the pause sheet says so
  await page.click('#menu');
  await expect(page.locator('.sheet .note', { hasText: 'Leaving a public table can cost chips' })).toBeVisible();
});

test('a 1,000 cup from joining to the result', async ({ page }) => {
  test.setTimeout(360000);
  await guest(page);
  await signedIn(page);
  await page.click('[data-k=tabcups]');
  await page.click('[data-k=cup1000]');
  await expect(page.locator('#cup')).toBeVisible({ timeout: 60000 });
  const title = page.locator('.sw.paper:has(.hero) .sh-title');
  // A first round that ends with a place in the final shows "Through" and moves on to the final by itself when the other table
  // is done, so the sheet may or may not still be there to press. Anything else is the result.
  await expect.poll(async () => {
    if (!await title.count()) return 'playing';
    if (/^Through/.test(await title.first().textContent())) return 'through';
    return 'result';
  }, { timeout: 300000, intervals: [500] }).toBe('result');
  await page.locator('.sw .sh-acts .btn.primary').click();
  await expect(page.locator('[data-k=tabcups]')).toBeVisible();
});

test('no pace switch, and the friend table form takes a stake a guest cannot use', async ({ page }) => {
  await guest(page);
  await expect(page.locator('[data-f^=mode]')).toHaveCount(0);
  await expect(page.locator('#home')).not.toContainText(/Fast/);
  await page.click('[data-k=friends]');
  const stake = page.locator('.sheet [data-f=stake]');
  await expect(stake).toHaveValue('0');
  await expect(page.locator('.sheet [data-f^=level]')).toHaveCount(0);
  await expect(page.locator('.sheet [data-f^=mode]')).toHaveCount(0);
  await stake.fill('15');
  await page.locator('.sheet .sh-acts .btn.primary').click();
  await expect(page.getByText('The stake must be a multiple of 10.')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.click('[data-k=friends]');
  await stake.fill('100');
  await page.locator('.sheet .sh-acts .btn.primary').click();
  await expect(page.getByText('Sign in with Apple to unlock this.').first()).toBeVisible();
});

// a second player in a browser of their own, from an address of their own
async function otherGuest(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const ip = '10.8.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
  await page.route('**/api/guest', route => route.continue({ headers: Object.assign({}, route.request().headers(), { 'cf-connecting-ip': ip }) }));
  await page.addInitScript(() => localStorage.setItem('amerikano.settings', JSON.stringify({ lang: 'en', speed: 'fast' })));
  await page.goto(process.env.AMK_WEB + path);
  await page.click('[data-k=guest]');
  await page.waitForSelector('[data-k=quick]');
  return { ctx, page };
}

async function makeTable(page) {
  await page.click('[data-k=friends]');
  await page.locator('.sheet .sh-acts .btn.primary').click();
  const code = page.locator('.wt-mid .code');
  await expect(code).toBeVisible({ timeout: 30000 });
  return (await code.textContent()).trim();
}

test('a friend table: join by a typed code and by a /t/CODE link', async ({ page, browser }) => {
  await guest(page);
  const code = await makeTable(page);
  expect(code).toMatch(/^[A-Z]{4}$/);

  const typed = await otherGuest(browser, '/');
  await typed.page.click('[data-k=friends]');
  await typed.page.fill('[data-k=code]', code);
  await typed.page.keyboard.press('Enter');
  await expect(typed.page.locator('.wt-mid .code')).toHaveText(code, { timeout: 30000 });
  await expect(page.locator('.wt-table .ws:not(.free)')).toHaveCount(2, { timeout: 30000 });
  await typed.ctx.close();

  const linked = await otherGuest(browser, '/t/' + code);
  await linked.page.locator('.sheet .sh-acts .btn.primary').click();
  await expect(linked.page.locator('.wt-mid .code')).toHaveText(code, { timeout: 30000 });
  await expect(page.locator('.wt-table .ws:not(.free)')).toHaveCount(2, { timeout: 30000 });
  await linked.ctx.close();
});

test('a cooldown from leaving locks the tables it covers and shows the time left', async ({ page }) => {
  await guest(page);
  await signedIn(page, 10, ', cool_until = ' + (Date.now() + 14 * 60000) + ', cool_stake = 500');
  await expect(page.locator('[data-k=room100]')).toBeEnabled();
  for (const s of [500, 2500]) {
    await expect(page.locator('[data-k=room' + s + ']')).toBeDisabled();
    await expect(page.locator('[data-k=room' + s + ']')).toContainText('Wait 14 min');
  }
});

test('tables above the player level are locked and say what they need', async ({ page }) => {
  await guest(page);
  await expect(page.locator('[data-k=room100]')).toBeEnabled();
  await expect(page.locator('[data-k=room100]')).toContainText('fee 5');
  await expect(page.locator('[data-k=room500]')).toBeDisabled();
  await expect(page.locator('[data-k=room500]')).toContainText('Lv 4');
  // a guest is shut out of the larger tables whatever the level, and a signed-in account sees the level instead
  await expect(page.locator('[data-k=room2500]')).toBeDisabled();
  await expect(page.locator('[data-k=room2500]')).toContainText('Sign in to unlock');
  await signedIn(page);
  await expect(page.locator('[data-k=room2500]')).toContainText('Lv 10');
  await signedIn(page, 4);
  await expect(page.locator('[data-k=room500]')).toBeEnabled();
});
