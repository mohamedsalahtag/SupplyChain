import { sql } from 'kysely';
import { authRouter } from '../auth/router.js';
import { crRouter } from '../modules/cr/router.js';
import { mergeRouter } from '../modules/merge/router.js';
import { rfqRouter } from '../modules/rfq/router.js';
import { awardRouter } from '../modules/award/router.js';
import { handoffRouter } from '../modules/handoff/router.js';
import { poRouter } from '../modules/po/router.js';
import { reportsRouter } from '../modules/reports/router.js';
import { opsRouter } from '../modules/ops/router.js';
import { demandRouter } from '../modules/demand/router.js';
import { materialsRouter } from '../modules/materials/router.js';
import { purchaseOrdersRouter } from '../modules/purchaseOrders/router.js';
import { securityRouter } from '../modules/security/router.js';
import { suppliersRouter } from '../modules/suppliers/router.js';
import { syncRouter } from '../modules/sync/router.js';
import { usersRouter } from '../modules/users/router.js';
import { workRouter } from '../modules/work/router.js';
import { workflowSetupRouter } from '../modules/workflowSetup/router.js';
import { adRouter } from '../settings/adRouter.js';
import { settingsRouter } from '../settings/router.js';
import { prefsRouter } from '../settings/userPrefs.js';
import { publicProcedure, router } from './trpc.js';

export const appRouter = router({
  auth: authRouter,
  work: workRouter,
  demand: demandRouter,
  cr: crRouter,
  merge: mergeRouter,
  rfq: rfqRouter,
  award: awardRouter,
  handoff: handoffRouter,
  po: poRouter,
  reports: reportsRouter,
  ops: opsRouter,
  workflowSetup: workflowSetupRouter,
  materials: materialsRouter,
  suppliers: suppliersRouter,
  purchaseOrders: purchaseOrdersRouter,
  sync: syncRouter,
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
      ctx.log.error({ err }, 'Health check: database unreachable'); // the detail stays in the log, not in a public reply
      return { database: 'error' as const };
    }
  }),
});

export type AppRouter = typeof appRouter;
