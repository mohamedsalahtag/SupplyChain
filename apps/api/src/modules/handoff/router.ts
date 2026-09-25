/** Handoffs (spec 22). Thin: rules live in handoffService / handoffData / handoffRead. */
import { DEFAULT_TABLE_PAGE_SIZE, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { hasPermission, loadActor } from '../workflow/access.js';
import { assertEntityAccess, registerEntityAccess } from '../workflow/entityAccess.js';
import { DomainError } from '../workflow/errors.js';
import { listThread } from '../workflow/threads.js';
import { getHandoff, handoffPanel, listHandoffs, termLists } from './handoffRead.js';
import { acceptHandoff, P_HANDOFF, returnHandoff, saveTerms, sendHandoff } from './handoffService.js';

registerEntityAccess('HANDOFF', async (db, actor, entityId, write) => {
  if (!/^\d+$/.test(entityId)) return null;
  const h = await db.selectFrom('scm.Handoff').select('CompanyCode').where('HandoffId', '=', entityId).executeTakeFirst();
  if (!h || !actor.companies.has(h.CompanyCode)) return null;
  const ok = write ? hasPermission(actor, P_HANDOFF.accept) || hasPermission(actor, P_HANDOFF.return) || hasPermission(actor, P_HANDOFF.send) : hasPermission(actor, P_HANDOFF.open);
  return ok ? { companyCode: h.CompanyCode } : null;
});

const open = procedure.meta({ permission: P.handoffsOpen });
const awardsOpen = procedure.meta({ permission: P.awardsOpen });
const send = procedure.meta({ permission: P.handoffSend });
const accept = procedure.meta({ permission: P.handoffAccept });
const ret = procedure.meta({ permission: P.handoffReturn });
const shipping = procedure.meta({ permission: P.configShippingEdit });
const idOf = z.string().regex(/^\d+$/);
const command = z.object({ commandId: z.string().uuid() });
const supplier = z.string().trim().min(1).max(20);

export const handoffRouter = router({
  /** The award's Handoff tab (anyone who can open awards; editing needs handoff.send). */
  panel: awardsOpen.input(z.object({ awardBatchId: idOf })).query(async ({ ctx, input }) => handoffPanel(ctx.db, await loadActor(ctx.db, ctx.user), input.awardBatchId)),
  saveTerms: send.input(command.extend({
    awardBatchId: idOf, supplierCode: supplier,
    incoterm: z.string().max(10).nullable(), portOfLoadingId: z.coerce.number().int().nullable(), portOfDischargeId: z.coerce.number().int().nullable(), paymentTerms: z.string().max(10).nullable(),
  })).mutation(async ({ ctx, input }) => saveTerms(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.awardBatchId, input.supplierCode,
    { incoterm: input.incoterm, portOfLoadingId: input.portOfLoadingId, portOfDischargeId: input.portOfDischargeId, paymentTerms: input.paymentTerms })),
  send: send.input(command.extend({
    awardBatchId: idOf, supplierCode: supplier, confirmWithoutAck: z.boolean().default(false), reasonCode: z.string().max(40).nullable().default(null), comment: z.string().trim().max(1000).nullable().default(null),
  })).mutation(async ({ ctx, input }) => sendHandoff(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.awardBatchId, input.supplierCode, input)),

  list: open.input(z.object({
    q: z.string().trim().max(60).optional(), status: z.array(z.enum(['HANDED_OFF', 'ACCEPTED', 'RETURNED'])).max(3).optional(),
    page: z.number().int().min(1).default(1), pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n)).default(DEFAULT_TABLE_PAGE_SIZE),
  })).query(async ({ ctx, input }) => listHandoffs(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  get: open.input(z.object({ handoffId: idOf })).query(async ({ ctx, input }) => getHandoff(ctx.db, await loadActor(ctx.db, ctx.user), input.handoffId)),
  thread: open.input(z.object({ handoffId: idOf })).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'HANDOFF', input.handoffId, false);
    return listThread(ctx.db, 'HANDOFF', input.handoffId);
  }),
  reasons: open.input(z.object({ context: z.enum(['HANDOFF_RETURN', 'PROCEED_NO_ACK']) })).query(({ ctx, input }) =>
    ctx.db.selectFrom('scm.ReasonCode').select(['ReasonCode', 'Description']).where('Context', '=', input.context).where('IsActive', '=', true).orderBy('ReasonCode').execute()),
  accept: accept.input(command.extend({ handoffId: idOf, rowVer: z.string() }))
    .mutation(async ({ ctx, input }) => acceptHandoff(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.handoffId, input.rowVer)),
  return: ret.input(command.extend({ handoffId: idOf, rowVer: z.string(), reasonCode: z.string().max(40), comment: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => returnHandoff(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.handoffId, input.rowVer, input.reasonCode, input.comment)),

  /** Configuration → Shipping terms. */
  lists: shipping.query(({ ctx }) => termLists(ctx.db)),
  setIncoterm: shipping.input(z.object({ code: z.string().max(10), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => { await ctx.db.updateTable('scm.Incoterm').set({ IsActive: input.isActive }).where('Code', '=', input.code).execute(); return { saved: true }; }),
  savePort: shipping.input(z.object({
    portId: z.coerce.number().int().nullable(), name: z.string().trim().min(1).max(80), countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/, 'A country code (e.g. SA)'),
    usedFor: z.enum(['LOADING', 'DISCHARGE', 'BOTH']), isActive: z.boolean(),
  })).mutation(async ({ ctx, input }) => {
    const dup = await ctx.db.selectFrom('scm.Port').select('PortId').where('Name', '=', input.name).where('CountryCode', '=', input.countryCode).executeTakeFirst();
    if (dup && Number(dup.PortId) !== input.portId) throw new DomainError('DUPLICATE', `${input.name} (${input.countryCode}) is already in the list`);
    if (input.portId) await ctx.db.updateTable('scm.Port').set({ Name: input.name, CountryCode: input.countryCode, UsedFor: input.usedFor, IsActive: input.isActive }).where('PortId', '=', input.portId).execute();
    else await ctx.db.insertInto('scm.Port').values({ Name: input.name, CountryCode: input.countryCode, UsedFor: input.usedFor, IsActive: input.isActive }).execute();
    return { saved: true };
  }),
  savePaymentTerm: shipping.input(z.object({ code: z.string().max(10), description: z.string().trim().max(100), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await sql`UPDATE scm.PaymentTerm SET Description = ${input.description}, IsActive = ${input.isActive ? 1 : 0} WHERE Code = ${input.code}`.execute(ctx.db);
      return { saved: true };
    }),
});
