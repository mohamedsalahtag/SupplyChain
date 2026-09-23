import { sql } from 'kysely';
import { authRouter } from '../auth/router.js';
import { materialsRouter } from '../modules/materials/router.js';
import { securityRouter } from '../modules/security/router.js';
import { usersRouter } from '../modules/users/router.js';
import { adRouter } from '../settings/adRouter.js';
import { settingsRouter } from '../settings/router.js';
import { prefsRouter } from '../settings/userPrefs.js';
import { publicProcedure, router } from './trpc.js';

export const appRouter = router({
  auth: authRouter,
  materials: materialsRouter,
  users: usersRouter,
  security: securityRouter,
  settings: settingsRouter,
  ad: adRouter,
  prefs: prefsRouter,
  health: publicProcedure.query(async ({ ctx }) => {
    try {
      await sql`SELECT 1`.execute(ctx.db);
      return { database: 'connected' as const };
    } catch (err) {
      return { database: 'error' as const, message: err instanceof Error ? err.message : String(err) };
    }
  }),
});

export type AppRouter = typeof appRouter;
