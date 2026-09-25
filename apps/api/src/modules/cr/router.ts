/** Change requests (specs 14, 15). Thin: every rule lives in crService / crApply / crRead. */
import { DEFAULT_TABLE_PAGE_SIZE, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { draftInput } from '../demand/content.js';
import { loadActor } from '../workflow/access.js';
import { listAttachments } from '../workflow/attachments.js';
import { assertEntityAccess, registerEntityAccess } from '../workflow/entityAccess.js';
import { NotFoundError } from '../workflow/errors.js';
import { listThread } from '../workflow/threads.js';
import { formatQty } from '../workflow/qty.js';
import { withTx } from '../workflow/tx.js';
import { decideCr } from './crApply.js';
import { crHistory, getCr, listCrs, reasonOptions } from './crRead.js';
import { planContainerChange, raiseContainerChange, raiseNotSourced, withdrawCr } from './crService.js';

registerEntityAccess('CR', async (db, actor, entityId, write) => {
  if (!/^\d+$/.test(entityId)) return null;
  const cr = await db.selectFrom('scm.ChangeRequest').select('CompanyCode').where('CrId', '=', entityId).executeTakeFirst();
  if (!cr || !actor.companies.has(cr.CompanyCode)) return null;
  const perms = write ? ['cr.raise.sales', 'cr.raise.procurement', 'cr.decide.sales', 'cr.decide.procurement'] : ['crs.open'];
  return actor.isAdmin || perms.some((p) => actor.permissions.has(p)) ? { companyCode: cr.CompanyCode } : null;
});

const open = procedure.meta({ permission: P.crsOpen });
const id = z.object({ crId: z.string().regex(/^\d+$/) });
const command = z.object({ commandId: z.string().uuid() });
const demandId = z.string().regex(/^\d+$/);
/** The editor's weeks, each group carrying the id of the group it edits (none = new). */
const proposed = z.object({
  weeks: z.array(draftInput.shape.weeks.element.extend({
    groups: z.array(draftInput.shape.weeks.element.shape.groups.element.extend({ groupId: z.string().regex(/^\d+$/).nullable().optional() })).max(50),
  })).max(60),
});

export const crRouter = router({
  list: open.input(z.object({
    mine: z.boolean().default(false), q: z.string().trim().max(60).optional(), type: z.array(z.string().max(30)).max(10).optional(),
    status: z.array(z.string().max(30)).max(10).optional(), company: z.array(z.string().max(10)).max(20).optional(), demandId: demandId.optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n)).default(DEFAULT_TABLE_PAGE_SIZE),
  })).query(async ({ ctx, input }) => listCrs(ctx.db, await loadActor(ctx.db, ctx.user), input)),

  get: open.input(id).query(async ({ ctx, input }) => getCr(ctx.db, await loadActor(ctx.db, ctx.user), input.crId)),
  history: open.input(id).query(async ({ ctx, input }) => {
    await getCr(ctx.db, await loadActor(ctx.db, ctx.user), input.crId);
    return crHistory(ctx.db, input.crId);
  }),
  thread: open.input(id).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'CR', input.crId, false);
    return listThread(ctx.db, 'CR', input.crId);
  }),
  attachments: open.input(id.extend({ includeOld: z.boolean().default(false) })).query(async ({ ctx, input }) => {
    await assertEntityAccess(ctx.db, await loadActor(ctx.db, ctx.user), 'CR', input.crId, false);
    return listAttachments(ctx.db, 'CR', input.crId, input.includeOld);
  }),
  reasons: open.input(z.object({ context: z.enum(['CR_SALES', 'CR_PROC']) })).query(({ ctx, input }) => reasonOptions(ctx.db, input.context)),

  /** Check & send, step 1: the items and the pre-check result, without saving anything. */
  previewContainerChange: procedure.meta({ permission: P.crRaiseSales }).input(z.object({ demandId, proposal: proposed })).query(async ({ ctx, input }) => {
    const actor = await loadActor(ctx.db, ctx.user);
    return withTx(ctx.db, async (tx) => {
      const d = await tx.selectFrom('scm.Demand').select(['DemandId', 'DemandNo', 'CompanyCode', 'WorkflowStatus']).where('DemandId', '=', input.demandId).executeTakeFirst();
      if (!d || !actor.companies.has(d.CompanyCode)) throw new NotFoundError(`Demand ${input.demandId}`);
      const plan = await planContainerChange(tx, { ...d, DemandId: String(d.DemandId) }, input.proposal);
      return {
        crType: plan.crType, problems: plan.problems,
        items: plan.items.map((i) => ({
          kind: i.kind, etdWeek: i.etdWeek,
          effect: i.effect.map((e) => `${e.subMajorCategory} ${e.size || 'any size'} ${e.materialClass || 'any class'} ${e.originCode}${e.materialCode ? ` ${e.materialCode}` : ''} ${e.delta > 0 ? '+' : '−'}${Number(formatQty(Math.abs(e.delta))).toLocaleString('en-GB')} ${e.unit}`),
          before: i.before ? i.before.containerCount : null, after: i.after ? i.after.containerCount : null, name: (i.after ?? i.before)?.name ?? '',
        })),
      };
    });
  }),

  raiseContainerChange: procedure.meta({ permission: P.crRaiseSales })
    .input(command.extend({ demandId, proposal: proposed, reasonCode: z.string().max(40), comment: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => raiseContainerChange(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.demandId, { ...input.proposal, reasonCode: input.reasonCode, comment: input.comment })),

  raiseNotSourced: procedure.meta({ permission: P.crRaiseProcurement })
    .input(command.extend({
      demandId, reasonCode: z.string().max(40), comment: z.string().trim().min(1).max(2000),
      lines: z.array(z.object({ lineId: z.string().regex(/^\d+$/), qty: z.string().max(20) })).max(200),
      weeks: z.array(z.object({ etdWeek: z.string().regex(/^\d{4}-W\d{2}$/), containerCount: z.number().int().min(0).max(999) })).max(60),
    }))
    .mutation(async ({ ctx, input }) => raiseNotSourced(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.demandId, input)),

  /** Permission per department is checked inside (cr.decide.sales / cr.decide.procurement). */
  decide: open.input(id.merge(command).extend({
    rowVer: z.string(), comment: z.string().trim().min(1).max(2000),
    decisions: z.array(z.object({ crItemId: z.string().regex(/^\d+$/), decision: z.enum(['APPROVE', 'PARTIAL', 'REJECT']), approvedCount: z.number().int().min(0).max(999).optional(), approvedQty: z.string().max(20).optional() })).max(200),
  })).mutation(async ({ ctx, input }) => decideCr(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.crId, input.rowVer, input.decisions, input.comment)),

  withdraw: procedure.meta({ permission: P.crWithdraw }).input(id.merge(command).extend({ rowVer: z.string(), comment: z.string().trim().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => withdrawCr(ctx.db, await loadActor(ctx.db, ctx.user), input.commandId, input.crId, input.rowVer, input.comment)),
});
