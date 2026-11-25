const { test, expect, guest, fakeStore } = require('./fixtures');

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
  await expect(page.locator('.bub:not(.emo)', { hasText: said })).toHaveCount(1);
  await page.click('#chat');
  await page.locator('.sheet .emos .emo').first().click();
  await expect(page.locator('.bub.emo use[href="#e-smile"]')).toHaveCount(1);
});

test('a 1,000 cup from joining to the result', async ({ page }) => {
  await guest(page);
  await page.click('[data-k=tabcups]');
  await page.click('[data-k=cup1000]');
  await expect(page.locator('#cup')).toBeVisible({ timeout: 60000 });
  const hero = page.locator('.sw.paper .hero');
  const title = page.locator('.sw .sh-title');
  await expect(hero).toBeVisible({ timeout: 200000 });
  // a first round that ends with a place in the final goes on to the final
  if (/^Through/.test(await title.textContent())) {
    await page.click('.sw .sh-acts .btn.primary');
    await expect(page.locator('#cupr')).toHaveText(/^Final/, { timeout: 120000 });
    await expect(hero).toBeVisible({ timeout: 200000 });
  }
  await expect(title).not.toBeEmpty();
  await page.click('.sw .sh-acts .btn.primary');
  await expect(page.locator('[data-k=tabcups]')).toBeVisible();
});
