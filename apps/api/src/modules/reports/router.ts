/** Reports (spec 24): company-scoped reads only. */
import { P } from '@supplychain/shared';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { loadActor } from '../workflow/access.js';
import { crRegister, demandReport, executionSummary, performance } from './reports.js';

const open = procedure.meta({ permission: P.reportsOpen });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filter = z.object({ company: z.array(z.string().max(10)).max(20).optional(), q: z.string().trim().max(40).optional(), from: day.optional(), to: day.optional() });

export const reportsRouter = router({
  execution: open.input(filter).query(async ({ ctx, input }) => executionSummary(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  demand: open.input(z.object({ demandId: z.string().regex(/^\d+$/) })).query(async ({ ctx, input }) => demandReport(ctx.db, await loadActor(ctx.db, ctx.user), input.demandId)),
  changeRequests: open.input(filter).query(async ({ ctx, input }) => crRegister(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  performance: open.input(filter).query(async ({ ctx, input }) => performance(ctx.db, await loadActor(ctx.db, ctx.user), input)),
});
