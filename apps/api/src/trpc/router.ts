import { sql } from 'kysely';
import { PERMISSIONS } from '@supplychain/shared';
import { materialsRouter } from '../modules/materials/router.js';
import { settingsRouter } from '../settings/router.js';
import { prefsRouter } from '../settings/userPrefs.js';
import { procedure, router } from './trpc.js';

export const appRouter = router({
  materials: materialsRouter,
  settings: settingsRouter,
  prefs: prefsRouter,
  health: procedure.meta({ permission: PERMISSIONS.systemHealth }).query(async ({ ctx }) => {
    try {
      await sql`SELECT 1`.execute(ctx.db);
      return { database: 'connected' as const };
    } catch (err) {
      return { database: 'error' as const, message: err instanceof Error ? err.message : String(err) };
    }
  }),
});

export type AppRouter = typeof appRouter;
