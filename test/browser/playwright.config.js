const { defineConfig } = require('@playwright/test');

// PW_CHANNEL=chrome runs the local Chrome instead of the downloaded browsers
const channel = process.env.PW_CHANNEL;

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
  use: { viewport: { width: 844, height: 390 }, reducedMotion: 'reduce', actionTimeout: 15000, navigationTimeout: 30000 },
  projects: [
    { name: 'chromium', use: channel ? { channel } : {} },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
