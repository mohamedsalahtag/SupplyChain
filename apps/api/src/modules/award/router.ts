/** Awards (spec 20). Thin: rules live in awardCheck / awardService / ack / awardRead. */
import { DEFAULT_TABLE_PAGE_SIZE, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { skusForSpec } from '../demand/lookups.js';
import { hasPermission, loadActor } from '../workflow/access.js';
import { listAttachments } from '../workflow/attachments.js';
import { assertEntityAccess, registerEntityAccess } from '../workflow/entityAccess.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { rowVerHex } from '../workflow/tx.js';
import { addThreadEntry, listThread } from '../workflow/threads.js';
import { acknowledge, answerQuery, P_ACK, raiseQuery } from './ack.js';
import { getBatch, listBatches } from './awardRead.js';
import { awardContainers, unawardContainers } from './containerAward.js';
import { containerGrid } from './containerGrid.js';
import { correctSku, P_AWARD, unaward, updateShipment } from './awardService.js';

registerEntityAccess('AWARD_BATCH', async (db, actor, entityId, write) => {
  if (!/^\d+$/.test(entityId)) return null;
  const b = await db.selectFrom('scm.AwardBatch').select('CompanyCode').where('AwardBatchId', '=', entityId).executeTakeFirst();
  if (!b || !actor.companies.has(b.CompanyCode)) return null;
  const ok = write ? hasPermission(actor, P_AWARD.manage) || hasPermission(actor, P_ACK) : hasPermission(actor, P_AWARD.open);
  return ok ? { companyCode: b.CompanyCode } : null;
});

const open = procedure.meta({ permission: P.awardsOpen });
const manage = procedure.meta({ permission: P.awardManage });
const respond = procedure.meta({ permission: P.ackRespond });
const idOf = z.string().regex(/^\d+$/);
const command = z.object({ commandId: z.string().uuid() });
const week = z.string().regex(/^\d{4}-W\d{2}$/);
const qty = z.string().trim().regex(/^\d{1,12}(\.\d{1,3})?$/, 'A quantity');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const batch = z.object({ awardBatchId: idOf });

export const awardRouter = router({
  list: open.input(z.object({
    q: z.string().trim().max(60).optional(), rfqId: idOf.optional(), demandId: idOf.optional(), ack: z.array(z.string().max(20)).max(5).optional(),
    page: z.number().int().min(1).default(1), pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n)).default(DEFAULT_TABLE_PAGE_SIZE),
  })).query(async ({ ctx, input }) => listBatches(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  get: open.input(batch).query(async ({ ctx, input }) => getBatch(ctx.db, await loadActor(ctx.db, ctx.user), input.awardBatchId)),
  thread: open.input(batch).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'AWARD_BATCH', input.awardBatchId, false);
    return listThread(ctx.db, 'AWARD_BATCH', input.awardBatchId);
  }),
  attachments: open.input(batch.extend({ includeOld: z.boolean().default(false) })).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'AWARD_BATCH', input.awardBatchId, false);
    return listAttachments(ctx.db, 'AWARD_BATCH', input.awardBatchId, input.includeOld);
  }),
  comment: open.input(batch.merge(command).extend({ body: z.string().trim().min(1).max(4000) })).mutation(async ({ ctx, input }) => {
    const actor = await loadActor(ctx.db, ctx.user);
    await assertEntityAccess(ctx.db, actor, 'AWARD_BATCH', input.awardBatchId, true);
    return runCommand(ctx.db, actor.id, input.commandId, 'award.comment', async (tx) => ({
      entryId: await addThreadEntry(tx, { entityType: 'AWARD_BATCH', entityId: input.awardBatchId, kind: 'COMMENT', body: input.body, authorUserId: actor.id }),
    }));
  }),
  reasons: open.input(z.object({ context: z.enum(['UNAWARD', 'RELEASE']) })).query(({ ctx, input }) =>
    ctx.db.selectFrom('scm.ReasonCode').select(['ReasonCode', 'Description']).where('Context', '=', input.context).where('IsActive', '=', true).orderBy('ReasonCode').execute()),
  skuOptions: open.input(z.object({ majorCategory: z.string().max(80), subMajorCategory: z.string().max(80), size: z.string().max(40), materialClass: z.string().max(80), originCode: z.string().max(3), unit: z.string().max(10) }))
    .query(async ({ ctx, input }) => (await skusForSpec(ctx.db, input)).map((m) => ({ code: m.MaterialCode, description: m.Description }))),

  /** Procurement (spec 20 revision 1): the award grid — containers per supplier — and the award by containers. */
  grid: manage.input(z.object({ rfqId: idOf })).query(async ({ ctx, input }) => {
    const actor = await loadActor(ctx.db, ctx.user);
    const r = await ctx.db.selectFrom('scm.Rfq as r').innerJoin('scm.Demand as d', 'd.DemandId', 'r.DemandId')
      .select(['r.RfqId', 'r.RfqNo', 'r.DemandId', 'd.DemandNo', 'r.CompanyCode', 'r.ManualStatus', rowVerHex('r.RowVer').as('rowVer')]).where('r.RfqId', '=', input.rfqId).executeTakeFirst();
    if (!r || !actor.companies.has(r.CompanyCode)) throw new NotFoundError(`RFQ ${input.rfqId}`);
    if (r.ManualStatus !== 'SENT') throw new DomainError('BAD_STATE', r.ManualStatus === 'DRAFT' ? 'Send the RFQ and record quotes first' : 'The RFQ is cancelled', 409);
    const grid = await containerGrid(ctx.db, { RfqId: String(r.RfqId), DemandId: String(r.DemandId) });
    return { rfq: { rfqId: String(r.RfqId), rfqNo: r.RfqNo, demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode, rowVer: r.rowVer }, ...grid };
  }),
  awardContainers: manage.input(command.extend({
    rfqId: idOf, rfqRowVer: z.string(), comment: z.string().trim().max(2000).default(''),
    containers: z.array(z.object({ groupId: idOf, supplierCode: z.string().trim().min(1).max(20), count: z.number().int().min(0).max(999) })).max(500),
    added: z.array(z.object({ groupId: idOf, count: z.number().int().min(0).max(50) })).max(200).default([]),
    other: z.array(z.object({ rfqLineId: idOf, supplierCode: z.string().trim().min(1).max(20), qty })).max(300).default([]),
    shipments: z.array(z.object({ supplierCode: z.string().trim().min(1).max(20), etdWeek: week, confirmedEtd: date.nullable().optional(), note: z.string().trim().max(500).optional() })).max(300).default([]),
  })).mutation(async ({ ctx, input }) => awardContainers(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.rfqId, input.rfqRowVer, input)),
  unawardContainers: manage.input(command.extend({
    awardContainerId: idOf, rowVer: z.string(), count: z.number().int().min(1).max(999), mode: z.enum(['KEEP_QUOTES', 'RELEASE']), reasonCode: z.string().max(40), comment: z.string().trim().max(2000).default(''),
  })).mutation(async ({ ctx, input }) => unawardContainers(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.awardContainerId, input.rowVer, input.count, input.mode, input.reasonCode, input.comment)),

  unaward: manage.input(command.extend({
    awardItemId: idOf, rowVer: z.string(), qty: z.union([z.literal('ALL'), qty]), mode: z.enum(['KEEP_QUOTES', 'RELEASE']), reasonCode: z.string().max(40), comment: z.string().trim().max(2000).default(''),
  })).mutation(async ({ ctx, input }) => unaward(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.awardItemId, input.rowVer, input.qty, input.mode, input.reasonCode, input.comment)),
  correctSku: manage.input(command.extend({ awardItemId: idOf, rowVer: z.string(), materialCode: z.string().trim().min(1).max(40), reason: z.string().trim().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => correctSku(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.awardItemId, input.rowVer, input.materialCode, input.reason)),
  updateShipment: manage.input(command.extend({ shipmentId: idOf, rowVer: z.string(), containerCount: z.number().int().min(1).max(999), confirmedEtd: date.nullable() }))
    .mutation(async ({ ctx, input }) => updateShipment(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.shipmentId, input.rowVer, input.containerCount, input.confirmedEtd)),
  answerQuery: manage.input(command.extend({ ackId: idOf, rowVer: z.string(), answer: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => answerQuery(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.ackId, input.rowVer, input.answer)),

  /** Sales. */
  acknowledge: respond.input(command.extend({ ackId: idOf, rowVer: z.string(), comment: z.string().trim().max(2000).default('') }))
    .mutation(async ({ ctx, input }) => acknowledge(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.ackId, input.rowVer, input.comment)),
  raiseQuery: respond.input(command.extend({ ackId: idOf, rowVer: z.string(), comment: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => raiseQuery(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.ackId, input.rowVer, input.comment)),
});
