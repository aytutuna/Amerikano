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
  // the page refreshes after the save; a reload while that request is in flight is an error in WebKit
  const refreshed = page.waitForResponse(r => r.url().endsWith('/admin/api/overview'));
  await page.click('button[data-save=chipsoff]');
  await refreshed;
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

test('the admin page mutes a player from the report list', async ({ page }) => {
  const api = process.env.AMK_API;
  // the server lets one address make three guests a minute
  const made = await fetch(api + '/api/guest', { method: 'POST', headers: { 'cf-connecting-ip': '10.7.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) } });
  const target = await made.json();
  const sender = await (await fetch(api + '/api/guest', { method: 'POST', headers: { 'cf-connecting-ip': '10.8.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) } })).json();
  // a profile report, so there is a row to pick the player from
  const aged = await (await fetch(api + '/api/guest', { method: 'POST', headers: { 'cf-connecting-ip': '10.6.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) } })).json();
  const rep = await fetch(api + '/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aged.id + '.' + aged.secret }, body: JSON.stringify({ pid: target.id, ctx: 'profile', text: 'rude ' + target.id.slice(0, 8) }) });
  expect(rep.status).toBe(200);
  const dm = () => fetch(api + '/api/dm', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + target.id + '.' + target.secret }, body: JSON.stringify({ to: sender.id, text: 'hi' }) }).then(r => r.json());
  expect((await dm()).error).toBe('nodm');

  await page.goto(api + '/admin');
  await page.fill('#key', process.env.AMK_ADMIN);
  await page.click('#go');
  const row = page.locator('#reports tr', { hasText: 'rude ' + target.id.slice(0, 8) });
  await expect(row).toBeVisible();
  await row.locator('td[data-id="' + target.id + '"]').click();
  await expect(page.locator('#pid')).toHaveValue(target.id);
  await page.click('button[data-do=mute]');
  await expect(page.locator('#log tr', { hasText: 'mute' }).filter({ hasText: target.id }).first()).toBeVisible();
  await expect(row.locator('td[data-id="' + target.id + '"]')).toContainText('muted');
  expect((await dm()).error).toBe('mute');
  await page.click('button[data-do=unmute]');
  await expect(row.locator('td[data-id="' + target.id + '"]')).not.toContainText('muted');
  expect((await dm()).error).toBe('nodm');
});
