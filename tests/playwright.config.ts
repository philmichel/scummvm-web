import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'smoke.spec.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:8080',
    browserName: 'chromium',
    headless: true,
  },
});
