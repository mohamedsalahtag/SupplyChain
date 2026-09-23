import { defineConfig } from '@playwright/test';

/** Smoke tests against the running dev app (`npm run dev`): one per screen. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5300',
    channel: 'msedge', // installed with Windows; no browser download needed
    viewport: { width: 1440, height: 900 },
  },
  reporter: 'list',
});
