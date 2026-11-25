const { defineConfig } = require('@playwright/test');

// PW_CHANNEL=chrome runs the local Chrome instead of the downloaded browsers
const channel = process.env.PW_CHANNEL;
const use = { viewport: { width: 844, height: 390 }, reducedMotion: 'reduce', baseURL: undefined };

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  globalSetup: require.resolve('./setup.js'),
  outputDir: 'out/results',
  retries: 0,
  workers: 1,
  timeout: 240000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'out/report' }]],
  use: Object.assign({ actionTimeout: 15000, navigationTimeout: 30000 }, use),
  projects: [
    { name: 'chromium', use: channel ? { channel } : {} },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
