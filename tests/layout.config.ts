import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'terminal-layout.spec.mjs',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:1420' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: process.env.LAYOUT_BROWSER_EXECUTABLE ? { executablePath: process.env.LAYOUT_BROWSER_EXECUTABLE } : {} } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  },
});
