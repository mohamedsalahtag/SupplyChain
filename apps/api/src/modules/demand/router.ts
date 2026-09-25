/** Demands (specs 12, 13). Thin: every rule lives in demandService / demandRead. */
import { DEFAULT_TABLE_PAGE_SIZE, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { loadActor } from '../workflow/access.js';
import { listAttachments } from '../workflow/attachments.js';
import { assertEntityAccess } from '../workflow/entityAccess.js';
import { listThread } from '../workflow/threads.js';
import './access.js';
import { draftInput } from './content.js';
import { demandHistory, getDemand, listDemands } from './demandRead.js';
import { acceptDemand, addComment, createDemand, recallDemand, returnDemand, saveDraft, submitDemand } from './demandService.js';
import { composeOptions, searchMaterials, specOptions } from './lookups.js';
import { diffSnapshots, listVersions } from './versions.js';

const open = procedure.meta({ permission: P.demandsOpen });
const id = z.object({ demandId: z.string().regex(/^\d+$/) });
const command = z.object({ commandId: z.string().uuid() });
const withVersion = id.merge(command).extend({ rowVer: z.string() });
const WEEK = z.string().regex(/^\d{4}-W\d{2}$/);

export const demandRouter = router({
  list: open
    .input(z.object({
      mine: z.boolean().default(false),
      q: z.string().trim().max(100).optional(),
      company: z.array(z.string().max(10)).max(20).optional(),
      status: z.array(z.string().max(30)).max(20).optional(),
      weekFrom: WEEK.optional(),
      weekTo: WEEK.optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n)).default(DEFAULT_TABLE_PAGE_SIZE),
    }))
    .query(async ({ ctx, input }) => listDemands(ctx.db, await loadActor(ctx.db, ctx.user), input)),

  get: open.input(id).query(async ({ ctx, input }) => getDemand(ctx.db, await loadActor(ctx.db, ctx.user), input.demandId)),

  /** Versions with, for each, what changed compared with the baseline (version 1). */
  versions: open.input(id).query(async ({ ctx, input }) => {
    await getDemand(ctx.db, await loadActor(ctx.db, ctx.user), input.demandId); // access check
    const versions = await listVersions(ctx.db, input.demandId);
    const baseline = versions.find((v) => v.versionNo === 1);
    return versions.map((v) => ({ ...v, diffFromBaseline: baseline && v.versionNo !== 1 ? diffSnapshots(baseline.snapshot, v.snapshot) : [] }));
  }),

  history: open.input(id).query(async ({ ctx, input }) => {
    await getDemand(ctx.db, await loadActor(ctx.db, ctx.user), input.demandId);
    return demandHistory(ctx.db, input.demandId);
  }),

  thread: open.input(id).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'DEMAND', input.demandId, false);
    return listThread(ctx.db, 'DEMAND', input.demandId);
  }),

  attachments: open.input(id.extend({ includeOld: z.boolean().default(false) })).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'DEMAND', input.demandId, false);
    return listAttachments(ctx.db, 'DEMAND', input.demandId, input.includeOld);
  }),

  /** Choices for a line: each level narrows the next (spec 12). */
  specOptions: open
    .input(z.object({
      majorCategory: z.string().max(80).optional(), subMajorCategory: z.string().max(80).optional(),
      sizes: z.array(z.string().max(80)).max(50).optional(), classes: z.array(z.string().max(80)).max(30).optional(), originCode: z.string().max(3).optional(),
    }))
    .query(({ ctx, input }) => specOptions(ctx.db, input)),
  /** Every size x class combination for the chosen criteria, whether SAP has it, and its SKUs (spec 12). */
  composeOptions: open
    .input(z.object({
      majorCategory: z.string().max(80), subMajorCategory: z.string().max(80), sizes: z.array(z.string().max(80)).max(50),
      classes: z.array(z.string().max(80)).max(30), originCode: z.string().regex(/^[A-Z]{2}$/), unit: z.string().max(10),
    }))
    .query(({ ctx, input }) => composeOptions(ctx.db, input)),
  searchMaterials: open.input(z.object({ q: z.string().trim().min(2).max(60) })).query(({ ctx, input }) => searchMaterials(ctx.db, input.q)),

  create: procedure.meta({ permission: P.demandCreate }).input(command.extend({ companyCode: z.string().max(10) }))
    .mutation(async ({ ctx, input }) => createDemand(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.companyCode)),

  save: procedure.meta({ permission: P.demandCreate }).input(withVersion.extend({ content: draftInput }))
    .mutation(async ({ ctx, input }) => saveDraft(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.demandId, input.rowVer, input.content)),

  submit: procedure.meta({ permission: P.demandSubmit }).input(withVersion.extend({ content: draftInput }))
    .mutation(async ({ ctx, input }) => submitDemand(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.demandId, input.rowVer, input.content)),

  accept: procedure.meta({ permission: P.demandAccept }).input(withVersion)
    .mutation(async ({ ctx, input }) => acceptDemand(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.demandId, input.rowVer)),

  /** Sales takes a submitted demand back to change it (before Procurement accepts). */
  recall: procedure.meta({ permission: P.demandSubmit }).input(withVersion.extend({ comment: z.string().trim().max(2000).default('') }))
    .mutation(async ({ ctx, input }) => recallDemand(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.demandId, input.rowVer, input.comment)),
  return: procedure.meta({ permission: P.demandReturn }).input(withVersion.extend({ comment: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => returnDemand(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.demandId, input.rowVer, input.comment)),

  comment: procedure.meta({ permission: P.demandComment }).input(id.merge(command).extend({ body: z.string().trim().min(1).max(4000) }))
    .mutation(async ({ ctx, input }) => addComment(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.demandId, input.body)),
});
