const { test, expect } = require('./fixtures');

test('an unknown address gets a real 404 page in English and Turkish', async ({ page }) => {
  const r = await page.goto(process.env.AMK_WEB + '/no/such/page');
  expect(r.status()).toBe(404);
  await expect(page.locator('#en h1')).toHaveText('Page not found');
  await expect(page.locator('#tr h1')).toHaveText('Sayfa bulunamadı');
  await expect(page.locator('#en a')).toHaveAttribute('href', '/');
  // the page is styled from a file, which the policy allows, and not from the address it was asked at
  expect(await page.locator('#en h1').evaluate(e => getComputedStyle(e).fontFamily)).toContain('Yeseva One');
});

test('a table link still opens the game', async ({ page }) => {
  const r = await page.goto(process.env.AMK_WEB + '/t/ABCD');
  expect(r.status()).toBe(200);
  await expect(page.locator('[data-k=guest]')).toBeVisible();
});

test('every page carries the security headers', async ({ page }) => {
  for (const p of ['/', '/t/ABCD', '/privacy.html', '/missing']) {
    const h = (await page.goto(process.env.AMK_WEB + p)).headers();
    expect(h['x-content-type-options'], p).toBe('nosniff');
    expect(h['referrer-policy'], p).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy'], p).toBe('camera=(), geolocation=(), microphone=()');
    const csp = h['content-security-policy'];
    expect(csp, p).toContain("frame-ancestors 'none'");
    expect(csp, p).toContain("default-src 'self'");
    expect(csp, p).toContain('https://appleid.cdn-apple.com');
    expect(csp, p).toContain('https://appleid.apple.com');
    // an inline style or script would need an exception that is not there
    expect(csp, p).not.toContain('unsafe-inline');
    expect(h['cross-origin-opener-policy'], p).toBeUndefined();
  }
});

test('the privacy page keeps its look without an inline style', async ({ page }) => {
  await page.goto(process.env.AMK_WEB + '/privacy.html');
  expect(await page.locator('style').count()).toBe(0);
  expect(await page.locator('h1').first().evaluate(e => getComputedStyle(e).fontFamily)).toContain('Yeseva One');
});
