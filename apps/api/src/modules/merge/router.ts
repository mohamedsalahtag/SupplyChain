/** Merge and unmerge (spec 17). Thin: the rules live in mergeCheck / mergeService / mergeRead. */
import { P } from '@supplychain/shared';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { loadActor } from '../workflow/access.js';
import { mergeCandidates, listMerges, mergePlanView } from './mergeRead.js';
import { executeMerge, unmerge } from './mergeService.js';

const idOf = z.string().regex(/^\d+$/);
const week = z.string().regex(/^\d{4}-W\d{2}$/);

export const mergeRouter = router({
  /** Step 1: accepted demands of the target's company that still have Open quantity. */
  candidates: procedure.meta({ permission: P.demandMerge }).input(z.object({ targetDemandId: idOf }))
    .query(async ({ ctx, input }) => mergeCandidates(ctx.db, await loadActor(ctx.db, ctx.user), input.targetDemandId)),
  /** Step 2: what each source week would add, and what blocks it. */
  plan: procedure.meta({ permission: P.demandMerge }).input(z.object({ targetDemandId: idOf, sourceDemandId: idOf }))
    .query(async ({ ctx, input }) => mergePlanView(ctx.db, await loadActor(ctx.db, ctx.user), input.targetDemandId, input.sourceDemandId)),
  execute: procedure.meta({ permission: P.demandMerge })
    .input(z.object({
      commandId: z.string().uuid(), targetDemandId: idOf, targetRowVer: z.string(), sourceDemandId: idOf,
      weeks: z.union([z.literal('ALL'), z.array(week).min(1).max(60)]), comment: z.string().trim().max(2000).default(''),
    }))
    .mutation(async ({ ctx, input }) => executeMerge(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input)),
  /** Merges in and out of one demand. */
  list: procedure.meta({ permission: P.demandsOpen }).input(z.object({ demandId: idOf }))
    .query(async ({ ctx, input }) => listMerges(ctx.db, await loadActor(ctx.db, ctx.user), input.demandId)),
  unmerge: procedure.meta({ permission: P.demandUnmerge })
    .input(z.object({ commandId: z.string().uuid(), mergeId: idOf, rowVer: z.string(), reason: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => unmerge(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.mergeId, input.rowVer, input.reason)),
});
