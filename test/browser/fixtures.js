const base = require('@playwright/test');
const path = require('path');
const { execFileSync } = require('child_process');

// Console errors that are known and harmless, matched against the message and the address it came from.
const allowed = [
  // the shop asks the server to sync right after its sheet opened, gets 429 and the app waits out the gap on purpose
  /429.*\/api\/shop\/sync/,
  // the admin spec tries a wrong key first
  /401.*\/admin\/api\//,
  // the site spec asks for addresses that do not exist
  /404.*\/(no\/such\/page|missing)$/,
];

let ips = Math.floor(Math.random() * 15000);

const test = base.test.extend({
  page: async ({ page }, use) => {
    // the server lets one address make three guests a minute, so each guest comes from its own address, as in the server suite
    await page.route('**/api/guest', route => route.continue({ headers: Object.assign({}, route.request().headers(), { 'cf-connecting-ip': '10.1.' + Math.floor(++ips / 250) + '.' + (ips % 250) }) }));
    const errors = [];
    page.on('pageerror', e => errors.push('page error: ' + e.message));
    page.on('console', m => {
      if (m.type() === 'error' && !allowed.some(re => re.test(m.text() + ' ' + m.location().url))) errors.push('console: ' + m.text() + ' ' + JSON.stringify(m.location()));
    });
    await page.addInitScript(() => {
      localStorage.setItem('amerikano.settings', JSON.stringify({ lang: 'en', speed: 'fast' }));
    });
    await use(page);
    base.expect(errors, 'errors in the page').toEqual([]);
  },
});

// the sign-in page, then a guest account, then the lobby with the server connected
async function guest(page, lang) {
  if (lang) await page.addInitScript(l => localStorage.setItem('amerikano.settings', JSON.stringify({ lang: l, speed: 'fast' })), lang);
  await page.goto(process.env.AMK_WEB + '/');
  await page.click('[data-k=guest]');
  await page.waitForSelector('[data-k=quick]');
}

// a statement straight into the test database
function sql(q) {
  const wrangler = path.join(__dirname, '../../server/node_modules/wrangler/bin/wrangler.js');
  // wrangler now and then dies on a busy machine; a statement that is really wrong fails the same way each time
  for (let i = 0; ; i++) {
    try {
      execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'amerikano', '--local', '--persist-to', process.env.AMK_PERSIST, '--command', q], { cwd: path.join(__dirname, '../../server'), stdio: 'ignore', timeout: 60000 });
      return;
    } catch (e) {
      if (i === 2) throw e;
    }
  }
}

// Gives the page's account an Apple identity and a level straight in the test database; the cups and the larger tables are not for guests.
async function signedIn(page, level, more) {
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('amerikano.account')).id);
  sql("UPDATE players SET apple = 'test-' || id, level = " + (level || 1) + (more || '') + " WHERE id = '" + id + "'");
  await page.reload();
  await page.waitForSelector('[data-k=quick]');
}

// A store that answers like RevenueCat on an iPhone. A purchase is credited the way RevenueCat's webhook would.
async function fakeStore(page) {
  await page.exposeFunction('amkBuy', async product => {
    const id = await page.evaluate(() => JSON.parse(localStorage.getItem('amerikano.account')).id);
    const r = await fetch(process.env.AMK_API + '/api/rc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: process.env.AMK_HOOK },
      body: JSON.stringify({ event: { type: 'NON_RENEWING_PURCHASE', app_user_id: id, product_id: product, transaction_id: 'tx-' + id + '-' + Date.now(), environment: 'SANDBOX' } }),
    });
    if (!r.ok) throw new Error('webhook ' + r.status);
  });
  await page.addInitScript(() => {
    const usd = { 80: '0.99', 500: '4.99', 1200: '9.99', 2500: '19.99', 6500: '49.99', 14000: '99.99', 30000: '199.99' };
    const price = i => usd[i.split('.').pop()] || '4.99';
    window.Capacitor = { getPlatform: () => 'ios', Plugins: { Purchases: {
      configure: async () => ({}), logIn: async () => ({}), restorePurchases: async () => ({}),
      purchaseStoreProduct: async o => { await window.amkBuy(o.product.identifier); return {}; },
      getProducts: async o => ({ products: o.productIdentifiers.map(i => ({ identifier: i, price: Number(price(i)), priceString: '$' + price(i) })) }),
    } } };
  });
}

module.exports = { test, expect: base.expect, guest, signedIn, fakeStore, sql };
