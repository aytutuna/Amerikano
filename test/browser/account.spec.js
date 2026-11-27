const { test, expect, guest } = require('./fixtures');

// A native shell with Capacitor's Preferences plugin, backed by sessionStorage so it outlives a reload. The mode says how the
// plugin behaves: ok, reject (every call fails) or slow (a read comes back after the splash screen has gone).
async function shell(page, mode) {
  await page.addInitScript(m => {
    if (!sessionStorage.getItem('stub.mode')) sessionStorage.setItem('stub.mode', m);
    const mode = () => sessionStorage.getItem('stub.mode');
    const wait = () => mode() === 'reject' ? Promise.reject(new Error('storage is broken')) : mode() === 'slow' ? new Promise(r => setTimeout(r, 4000)) : Promise.resolve();
    window.Capacitor = {
      getPlatform: () => 'web',
      Plugins: {
        App: { addListener: () => {}, getLaunchUrl: async () => ({}), exitApp: () => {} },
        SplashScreen: { hide: async () => {} },
        Preferences: {
          get: async o => { await wait(); return { value: sessionStorage.getItem('stub:' + o.key) }; },
          set: async o => { if (mode() === 'reject') throw new Error('storage is broken'); sessionStorage.setItem('stub:' + o.key, o.value); },
          remove: async o => { if (mode() === 'reject') throw new Error('storage is broken'); sessionStorage.removeItem('stub:' + o.key); },
        },
      },
    };
  }, mode);
}

const stored = page => page.evaluate(() => sessionStorage.getItem('stub:amerikano.account'));
const kept = page => page.evaluate(() => localStorage.getItem('amerikano.account'));
const mode = (page, m) => page.evaluate(v => sessionStorage.setItem('stub.mode', v), m);

test('a new account is kept in the plugin and not in localStorage', async ({ page }) => {
  await shell(page, 'ok');
  await guest(page);
  expect(JSON.parse(await stored(page)).id).toBeTruthy();
  expect(await kept(page)).toBeNull();
});

test('a key left in localStorage moves into the plugin', async ({ page }) => {
  await shell(page, 'ok');
  await guest(page);
  const key = await stored(page);
  await page.evaluate(k => {
    sessionStorage.removeItem('stub:amerikano.account');
    sessionStorage.removeItem('stub:amerikano.me');
    localStorage.setItem('amerikano.account', k);
  }, key);
  const made = [];
  page.on('request', r => { if (r.url().endsWith('/api/guest')) made.push(r.url()); });
  await page.reload();
  await page.waitForSelector('[data-k=quick]');
  expect(await stored(page)).toBe(key);
  expect(await kept(page)).toBeNull();
  expect(made).toEqual([]);
});

test('signing out and deleting the account clear the plugin and tell the server', async ({ page }) => {
  await shell(page, 'ok');
  await guest(page);
  const key = JSON.parse(await stored(page));
  const seen = [];
  page.on('request', r => { if (/\/api\/(signout|me)$/.test(r.url()) && r.method() !== 'GET') seen.push(r.method() + ' ' + new URL(r.url()).pathname); });
  await page.evaluate(() => Account.forget());
  await expect.poll(() => seen).toContain('POST /api/signout');
  await expect.poll(() => stored(page)).toBeNull();
  // the request is seen when it leaves the page, so the server may not have answered yet
  const status = async () => (await page.request.get(process.env.AMK_API + '/api/me', { headers: { Authorization: 'Bearer ' + key.id + '.' + key.secret } })).status();
  await expect.poll(status).toBe(401);

  await page.reload();
  await page.click('[data-k=guest]');
  await page.waitForSelector('[data-k=quick]');
  expect(await stored(page)).not.toBeNull();
  await page.click('[data-k=me]');
  await page.click('.sheet [data-f=delete]');
  await page.click('.sheet [data-f=deleteGo]');
  await expect.poll(() => stored(page)).toBeNull();
  expect(seen).toContain('DELETE /api/me');
});

test('a plugin that fails still reaches the lobby', async ({ page }) => {
  await shell(page, 'reject');
  await guest(page);
  // the key could not be written to the plugin, so it is in localStorage for next time
  expect(JSON.parse(await kept(page)).id).toBeTruthy();
  expect(await stored(page)).toBeNull();
});

test('a slow read brings back the stored account and never makes a guest', async ({ page }) => {
  await shell(page, 'ok');
  await guest(page);
  const key = await stored(page);
  await mode(page, 'slow');
  const made = [];
  page.on('request', r => { if (r.url().endsWith('/api/guest')) made.push(r.url()); });
  await page.reload();
  // the first screen is the sign-in page while the read is out, and the lobby follows by itself
  await page.waitForSelector('[data-k=quick]', { timeout: 20000 });
  expect(made).toEqual([]);
  expect(await stored(page)).toBe(key);
  const me = await page.evaluate(() => Account.id());
  expect(me).toBe(JSON.parse(key).id);
});

test('pressing guest while the read is out signs in as the stored account', async ({ page }) => {
  await shell(page, 'ok');
  await guest(page);
  const key = await stored(page);
  await mode(page, 'slow');
  const made = [];
  page.on('request', r => { if (r.url().endsWith('/api/guest')) made.push(r.url()); });
  await page.reload();
  await page.click('[data-k=guest]');
  await page.waitForSelector('[data-k=quick]', { timeout: 20000 });
  expect(made).toEqual([]);
  expect(await stored(page)).toBe(key);
});
