import { defineConfig } from 'vitest/config';

// Unit tests only; the database tests (test/db) run with vitest.db.config.ts.
export default defineConfig({
  test: { include: ['src/**/*.spec.ts'] },
});
