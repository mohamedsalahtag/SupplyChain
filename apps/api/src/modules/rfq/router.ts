/** RFQs (spec 18). Thin: rules live in rfqService / quotes / rfqRead / shortlist / aging. */
import { DEFAULT_TABLE_PAGE_SIZE, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { hasPermission, loadActor } from '../workflow/access.js';
import { listAttachments } from '../workflow/attachments.js';
import { assertEntityAccess, registerEntityAccess } from '../workflow/entityAccess.js';
import { listThread } from '../workflow/threads.js';
import { flagMissingOrigin, refreshAging } from './aging.js';
import { raiseAddQuantity, raiseMixChange, raiseWeekShift } from '../cr/procCr.js';
import { recordQuotes } from './quotes.js';
import { builderData, getRfq, listRfqs, rfqHistory, shortlistFor } from './rfqRead.js';
import { searchOutsideSuppliers } from './outsideSuppliers.js';
import { cancelRfq, createRfq, P_RFQ, releaseQty, sendRfq } from './rfqService.js';

registerEntityAccess('RFQ', async (db, actor, entityId, write) => {
  if (!/^\d+$/.test(entityId)) return null;
  const r = await db.selectFrom('scm.Rfq').select('CompanyCode').where('RfqId', '=', entityId).executeTakeFirst();
  if (!r || !actor.companies.has(r.CompanyCode)) return null;
  return hasPermission(actor, write ? P_RFQ.manage : P_RFQ.open) ? { companyCode: r.CompanyCode } : null;
});

const open = procedure.meta({ permission: P.rfqsOpen });
const manage = procedure.meta({ permission: P.rfqManage });
const idOf = z.string().regex(/^\d+$/);
const id = z.object({ rfqId: idOf });
const command = z.object({ commandId: z.string().uuid() });
const week = z.string().regex(/^\d{4}-W\d{2}$/);
const qty = z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/, 'A quantity');
const propose = procedure.meta({ permission: P.crRaiseProcurement });
const spec = z.object({
  majorCategory: z.string().max(80), subMajorCategory: z.string().max(80), size: z.string().max(40), materialClass: z.string().max(80),
  originCode: z.string().regex(/^[A-Z]{2}$/), materialCode: z.string().max(40).nullable(), unit: z.string().min(1).max(10),
});
const why = { reasonCode: z.string().max(40), comment: z.string().trim().max(2000), dryRun: z.boolean().default(false) };

/** RFQ commands also refresh the "near ETD" exceptions; a failure there never undoes the command. */
const afterwards = (db: Parameters<typeof refreshAging>[0]) => void refreshAging(db).catch(() => undefined);

export const rfqRouter = router({
  list: open.input(z.object({
    q: z.string().trim().max(60).optional(), company: z.array(z.string().max(10)).max(20).optional(), status: z.array(z.string().max(30)).max(10).optional(),
    demandId: idOf.optional(), page: z.number().int().min(1).default(1),
    pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n)).default(DEFAULT_TABLE_PAGE_SIZE),
  })).query(async ({ ctx, input }) => listRfqs(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  get: open.input(id).query(async ({ ctx, input }) => getRfq(ctx.db, await loadActor(ctx.db, ctx.user), input.rfqId)),
  history: open.input(id).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'RFQ', input.rfqId, false);
    return rfqHistory(ctx.db, input.rfqId);
  }),
  thread: open.input(id).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'RFQ', input.rfqId, false);
    return listThread(ctx.db, 'RFQ', input.rfqId);
  }),
  attachments: open.input(id.extend({ includeOld: z.boolean().default(false) })).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'RFQ', input.rfqId, false);
    return listAttachments(ctx.db, 'RFQ', input.rfqId, input.includeOld);
  }),
  reasons: open.input(z.object({ context: z.enum(['RELEASE', 'RFQ_CANCEL']) })).query(({ ctx, input }) =>
    ctx.db.selectFrom('scm.ReasonCode').select(['ReasonCode', 'Description']).where('Context', '=', input.context).where('IsActive', '=', true).orderBy('ReasonCode').execute()),

  builder: manage.input(z.object({ demandId: idOf })).query(async ({ ctx, input }) => builderData(ctx.db, await loadActor(ctx.db, ctx.user), input.demandId)),
  /** Any supplier in SAP, for an invite outside the shortlist (a new supplier's first contact). */
  searchSuppliers: manage.input(z.object({ demandId: idOf, lineIds: z.array(idOf).max(500), q: z.string().max(60) }))
    .query(async ({ ctx, input }) => searchOutsideSuppliers(ctx.db, await loadActor(ctx.db, ctx.user), input.demandId, input.lineIds, input.q)),
  shortlist: manage.input(z.object({ demandId: idOf, lineIds: z.array(idOf).max(500) }))
    .query(async ({ ctx, input }) => shortlistFor(ctx.db, await loadActor(ctx.db, ctx.user), input.demandId, input.lineIds)),
  flagMissingOrigin: manage.input(z.object({ demandId: idOf, originCode: z.string().regex(/^[A-Z]{2}$/) })).mutation(async ({ ctx, input }) => {
    const actor = await loadActor(ctx.db, ctx.user);
    const d = await builderData(ctx.db, actor, input.demandId); // access
    await flagMissingOrigin(ctx.db, d.demand.companyCode, input.originCode, d.demand.demandNo, ctx.user.id);
    return { flagged: true };
  }),
  create: manage.input(command.extend({
    demandId: idOf,
    lines: z.array(z.object({ lineId: idOf, week, qty })).min(1).max(500),
    weeks: z.array(z.object({ etdWeek: week, containerCount: z.number().int().min(0).max(999) })).max(60),
    suppliers: z.array(z.string().trim().min(1).max(20)).max(50),
    extraSuppliers: z.array(z.string().trim().min(1).max(20)).max(20).default([]),
  })).mutation(async ({ ctx, input }) => {
    const r = await createRfq(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input);
    afterwards(ctx.db);
    return r;
  }),
  send: manage.input(id.merge(command).extend({ rowVer: z.string() }))
    .mutation(async ({ ctx, input }) => sendRfq(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.rfqId, input.rowVer)),
  recordQuotes: manage.input(id.merge(command).extend({
    supplierCode: z.string().trim().min(1).max(20), currency: z.string().trim().length(3),
    rows: z.array(z.object({
      etdWeek: week, lineKey: z.string().max(400), unitPrice: z.string().trim().max(20), availableQty: z.string().trim().max(20),
      quotedSku: z.string().trim().max(40).nullable().optional(),
    })).max(200),
    /** Containers offered per week (spec 18 revision). */
    weeks: z.array(z.object({ etdWeek: week, containersOffered: z.number().int().min(0).max(999) })).max(60).default([]),
  })).mutation(async ({ ctx, input }) => recordQuotes(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.rfqId, input.supplierCode, input.currency.toUpperCase(), input.rows, input.weeks)),
  release: manage.input(command.extend({ rfqLineId: idOf, qty, reasonCode: z.string().max(40), comment: z.string().trim().max(2000).default('') }))
    .mutation(async ({ ctx, input }) => {
      const r = await releaseQty(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.rfqLineId, input.qty, input.reasonCode, input.comment);
      afterwards(ctx.db);
      return r;
    }),
  /** Spec 19: Procurement change requests from this RFQ, decided by Sales (`dryRun` = the pre-check only). */
  addQuantity: propose.input(id.merge(command).extend({ etdWeek: week, spec, qty, extraContainers: z.number().int().min(0).max(99).default(0), ...why }))
    .mutation(async ({ ctx, input }) => raiseAddQuantity(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.rfqId, input, input.dryRun)),
  weekShift: propose.input(id.merge(command).extend({ rfqLineId: idOf, toWeek: week, containers: z.number().int().min(0).max(999), ...why }))
    .mutation(async ({ ctx, input }) => raiseWeekShift(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.rfqId, input, input.dryRun)),
  mixChange: propose.input(id.merge(command).extend({
    reductions: z.array(z.object({ rfqLineId: idOf, qty })).max(100), additions: z.array(z.object({ etdWeek: week, spec, qty })).max(50), ...why,
  })).mutation(async ({ ctx, input }) => raiseMixChange(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.rfqId, input, input.dryRun)),
  cancel: manage.input(id.merge(command).extend({ rowVer: z.string(), reasonCode: z.string().max(40), comment: z.string().trim().max(2000).default('') }))
    .mutation(async ({ ctx, input }) => {
      const r = await cancelRfq(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.rfqId, input.rowVer, input.reasonCode, input.comment);
      afterwards(ctx.db);
      return r;
    }),
});
