import { defineConfig } from '@playwright/test';

/** Smoke tests against the running dev app (`npm run dev`, with ALLOW_TEST_LOGIN=true in .env). */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5300',
    channel: 'msedge', // installed with Windows; no browser download needed
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'app', dependencies: ['setup'], testIgnore: /auth\.setup\.ts/, use: { storageState: 'e2e/.auth/admin.json' } },
  ],
  reporter: 'list',
});
