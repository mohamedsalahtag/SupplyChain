/** PO drafts & SAP (spec 23). Thin: rules live in poService / outbox / poRead. */
import { hostname } from 'node:os';
import { DEFAULT_TABLE_PAGE_SIZE, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { hasPermission, loadActor } from '../workflow/access.js';
import { listAttachments } from '../workflow/attachments.js';
import { assertEntityAccess, registerEntityAccess } from '../workflow/entityAccess.js';
import { listThread } from '../workflow/threads.js';
import { runOutbox } from './outbox.js';
import { getDraft, listDrafts, listMdr, preparation, skuCandidates } from './poRead.js';
import { buildDraft, closeMasterDataRequest, markMasterDataMissing, P_PO, resolveUnknown, selectSkus, submitDraft, validateDraft } from './poService.js';
import { poAdapter } from './sapAdapter.js';

registerEntityAccess('PO_DRAFT', async (db, actor, entityId, write) => {
  if (!/^\d+$/.test(entityId)) return null;
  const d = await db.selectFrom('scm.PoDraft').select('CompanyCode').where('PoDraftId', '=', entityId).executeTakeFirst();
  if (!d || !actor.companies.has(d.CompanyCode)) return null;
  return (write ? hasPermission(actor, P_PO.manage) : hasPermission(actor, P_PO.open)) ? { companyCode: d.CompanyCode } : null;
});

const open = procedure.meta({ permission: P.poOpen });
const manage = procedure.meta({ permission: P.poManage });
/** Fault injection changes how the (simulated) SAP answers for every company: SAP-settings holders only, never on the real adapter. */
const stubAdmin = procedure.meta({ permission: P.configSapEdit });
const idOf = z.string().regex(/^\d+$/);
const command = z.object({ commandId: z.string().uuid() });
const qty = z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/, 'A quantity');
export const workerId = () => `api-${hostname()}-${process.pid}`;

export const poRouter = router({
  preparation: open.input(z.object({ handoffId: idOf })).query(async ({ ctx, input }) => preparation(ctx.db, await loadActor(ctx.db, ctx.user), input.handoffId)),
  candidates: open.input(z.object({ awardItemId: idOf })).query(async ({ ctx, input }) => skuCandidates(ctx.db, await loadActor(ctx.db, ctx.user), input.awardItemId)),
  selectSkus: manage.input(command.extend({ awardItemId: idOf, allocations: z.array(z.object({ materialCode: z.string().trim().min(1).max(40), qty })).min(1).max(20) }))
    .mutation(async ({ ctx, input }) => selectSkus(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.awardItemId, input.allocations)),
  markMissing: manage.input(command.extend({ awardItemId: idOf, note: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => markMasterDataMissing(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.awardItemId, input.note)),
  closeRequest: manage.input(command.extend({ mdrId: idOf })).mutation(async ({ ctx, input }) => closeMasterDataRequest(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.mdrId)),
  requests: open.query(async ({ ctx }) => listMdr(ctx.db, await loadActor(ctx.db, ctx.user))),

  build: manage.input(command.extend({ handoffId: idOf })).mutation(async ({ ctx, input }) => buildDraft(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.handoffId)),
  list: open.input(z.object({
    q: z.string().trim().max(60).optional(), status: z.array(z.enum(['DRAFT', 'VALIDATED', 'SUBMITTED', 'UNKNOWN', 'CREATED', 'REJECTED', 'VOID'])).max(7).optional(),
    page: z.number().int().min(1).default(1), pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n)).default(DEFAULT_TABLE_PAGE_SIZE),
  })).query(async ({ ctx, input }) => listDrafts(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  get: open.input(z.object({ poDraftId: idOf })).query(async ({ ctx, input }) => getDraft(ctx.db, await loadActor(ctx.db, ctx.user), input.poDraftId)),
  thread: open.input(z.object({ poDraftId: idOf })).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'PO_DRAFT', input.poDraftId, false);
    return listThread(ctx.db, 'PO_DRAFT', input.poDraftId);
  }),
  attachments: open.input(z.object({ poDraftId: idOf, includeOld: z.boolean().default(false) })).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'PO_DRAFT', input.poDraftId, false);
    return listAttachments(ctx.db, 'PO_DRAFT', input.poDraftId, input.includeOld);
  }),
  validate: manage.input(command.extend({ poDraftId: idOf, rowVer: z.string() }))
    .mutation(async ({ ctx, input }) => validateDraft(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.poDraftId, input.rowVer)),
  submit: manage.input(command.extend({ poDraftId: idOf, rowVer: z.string() }))
    .mutation(async ({ ctx, input }) => submitDraft(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.poDraftId, input.rowVer)),
  resolve: manage.input(command.extend({
    poDraftId: idOf, rowVer: z.string(), outcome: z.enum(['CREATED', 'NOT_CREATED']), sapPoNumber: z.string().trim().max(20).default(''), comment: z.string().trim().min(1).max(2000),
  })).mutation(async ({ ctx, input }) => resolveUnknown(ctx.db, await loadActor(ctx.db, ctx.user), poAdapter(ctx.db), input.commandId, input.poDraftId, input.rowVer,
    input.outcome === 'CREATED' ? { outcome: 'CREATED', sapPoNumber: input.sapPoNumber } : { outcome: 'NOT_CREATED' }, input.comment)),
  /** Runs the SAP outbox now (it also runs every 30 seconds). */
  processNow: manage.mutation(({ ctx }) => runOutbox(ctx.db, poAdapter(ctx.db), workerId())),

  /** The stub SAP adapter (until the real ZCON adapter): inject a fault for the next submission — administrators (SAP settings) only. */
  faults: stubAdmin.query(({ ctx }) => ctx.db.selectFrom('scm.StubSapFault').select(['FaultId', 'Reference', 'Mode', 'Remaining', 'CreatedAt']).orderBy('FaultId', 'desc').execute()),
  addFault: stubAdmin.input(z.object({ reference: z.string().trim().regex(/^(\*|POD-\d{6,})$/), mode: z.enum(['reject', 'timeout-before-create', 'timeout-after-create', 'lookup-unknown']) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.insertInto('scm.StubSapFault').values({ Reference: input.reference, Mode: input.mode, CreatedBy: ctx.user.id }).execute();
      return { saved: true };
    }),
  clearFaults: stubAdmin.mutation(async ({ ctx }) => { await ctx.db.deleteFrom('scm.StubSapFault').execute(); return { cleared: true }; }),
});
