const { test, expect } = require('./fixtures');

test('the admin page asks for the key and saves a setting', async ({ page }) => {
  await page.goto(process.env.AMK_API + '/admin');
  await page.fill('#key', 'not the key');
  await page.click('#go');
  await expect(page.locator('#msg')).toHaveText('auth');
  await expect(page.locator('#main')).toBeHidden();
  await page.fill('#key', process.env.AMK_ADMIN);
  await page.click('#go');
  await expect(page.locator('#main')).toBeVisible();
  await page.fill('textarea[data-k=chipsoff]', 'TR');
  await page.click('button[data-save=chipsoff]');
  await expect(page.locator('#log tr', { hasText: 'chipsoff' }).first()).toBeVisible();
  await page.reload();
  await expect(page.locator('textarea[data-k=chipsoff]')).toHaveValue('TR');
  // the log of an earlier run in the same server may already hold rows
  await expect(page.locator('#log tr', { hasText: 'chipsoff' }).first()).toBeVisible();
  const rows = await page.locator('#log tr', { hasText: 'chipsoff' }).count();
  await page.fill('textarea[data-k=chipsoff]', '');
  await page.click('button[data-save=chipsoff]');
  await expect(page.locator('#log tr', { hasText: 'chipsoff' })).toHaveCount(rows + 1);
});
