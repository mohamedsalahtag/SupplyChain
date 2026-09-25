import { defineConfig } from 'vitest/config';

// Database tests: a throw-away database (supplychain_test) on the same server,
// recreated and migrated once per run by test/db/globalSetup.ts.
export default defineConfig({
  test: {
    include: ['test/db/**/*.spec.ts'],
    globalSetup: ['test/db/globalSetup.ts'],
    setupFiles: ['test/db/env.ts'],
    fileParallelism: false,
    // Generous: every test makes hundreds of round trips, and over a slow link (VPN, ~100 ms) a timed-out
    // test would leave its transaction open and block the next one.
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
