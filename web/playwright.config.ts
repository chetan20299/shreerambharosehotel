import { defineConfig, devices } from '@playwright/test';

// Runs against the Firebase emulators (Hosting on :5000 serves web/dist and proxies /api to Functions).
// Start them with `npm run demo` (repo root) or run everything with `npm run test:e2e`.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../docs/e2e-report' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5000',
    ...devices['Pixel 7'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'android-chrome', use: { ...devices['Pixel 7'] } }],
});
