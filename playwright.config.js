const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    ...devices['Desktop Chrome'],
  },
});
