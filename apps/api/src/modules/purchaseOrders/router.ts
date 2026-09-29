import { DEFAULT_TABLE_PAGE_SIZE, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { audit } from '../../auth/audit.js';
import { loadSapConnection } from '../../settings/sapConnection.js';
import type { AuthUser } from '../../auth/authUser.js';
import { procedure, router, type Context } from '../../trpc/trpc.js';
import { loadActor } from '../workflow/access.js';
import { loadCodeCounts } from '../sync/codeList.js';
import { SYNC_JOBS } from '../sync/jobs.js';
import { launchSync } from '../sync/launch.js';
import { listPurchaseOrders, PO_SORT_FIELDS, poFilterOptions } from './poRead.js';
import { loadPoInclude, loadWatermark, poIncludeSchema, refreshPoTypes, runPoSync, savePoInclude, TYPES_KEY } from './poSync.js';

const view = procedure.meta({ permission: P.purchaseOrdersOpen });
const edit = procedure.meta({ permission: P.configPoEdit });
const run = procedure.meta({ permission: P.configPoRun });
const fresh = procedure.meta({ permission: P.configPoFresh });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const listInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n)).default(DEFAULT_TABLE_PAGE_SIZE),
  q: z.string().trim().max(100).optional(), // PO number, supplier code or name
  type: z.array(z.string().max(20)).max(50).optional(),
  supplier: z.array(z.string().max(20)).max(200).optional(),
  major: z.array(z.string().max(80)).max(100).optional(),
  subMajor: z.array(z.string().max(80)).max(300).optional(),
  company: z.array(z.string().max(10)).max(20).optional(),
  from: isoDate.optional(), // order date, from – to
  to: isoDate.optional(),
  sortField: z.enum(PO_SORT_FIELDS).default('OrderDate'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * The companies whose SAP orders the user may see (security review 2026-09-26, F05): md.PurchaseOrder.CompanyCode is the
 * SAP company code, the same code as scm.Company / scm.UserCompany. Administrators see every active company (loadActor).
 */
const companiesOf = async (ctx: Pick<Context, 'db'> & { user: AuthUser }) => [...(await loadActor(ctx.db, ctx.user)).companies];

export const purchaseOrdersRouter = router({
  list: view.input(listInput).query(async ({ ctx, input }) => listPurchaseOrders(ctx.db, await companiesOf(ctx), input)),

  /** The filter section's choices (order types, suppliers, categories, companies) from the user's companies' orders. */
  filterOptions: view.query(async ({ ctx }) => poFilterOptions(ctx.db, await companiesOf(ctx))),

  /** One order's lines, with the material description when the material is in Materials. Another company's order: not found. */
  lines: view.input(z.object({ purchaseOrder: z.string().max(20) })).query(async ({ ctx, input }) => {
    const companies = await companiesOf(ctx);
    const po = companies.length
      ? await ctx.db.selectFrom('md.PurchaseOrder').select('PurchaseOrder').where('PurchaseOrder', '=', input.purchaseOrder).where('CompanyCode', 'in', companies).executeTakeFirst()
      : undefined;
    if (!po) throw new TRPCError({ code: 'NOT_FOUND', message: 'Purchase order not found' });
    return (
      await ctx.db
        .selectFrom('md.PurchaseOrderLine as l')
        .leftJoin('md.Material as m', 'm.MaterialCode', 'l.Material')
        .select(['l.ItemNo', 'l.Material', 'l.Quantity', 'l.Unit', 'l.NetPrice', 'l.PriceQuantity', 'm.Description as MaterialDescription'])
        .where('l.PurchaseOrder', '=', input.purchaseOrder)
        .orderBy('l.ItemNo')
        .execute()
    ).map((l) => ({ ...l, ItemNo: Number(l.ItemNo), Quantity: Number(l.Quantity), NetPrice: Number(l.NetPrice), PriceQuantity: Number(l.PriceQuantity), MaterialDescription: l.MaterialDescription ?? '' }));
  }),

  /** Z types SAP offers (last check), the chosen types and start date, and the watermark. */
  include: procedure.meta({ permission: P.configOpen }).query(async ({ ctx }) => {
    const [include, available, watermark] = await Promise.all([loadPoInclude(ctx.db), loadCodeCounts(ctx.db, TYPES_KEY), loadWatermark(ctx.db)]);
    return { ...include, available, watermark: watermark?.toISOString() ?? null };
  }),

  saveInclude: edit.input(poIncludeSchema).mutation(async ({ ctx, input }) => {
    const r = await savePoInclude(ctx.db, input);
    await audit(ctx.db, { userId: ctx.user.id, action: 'config.po.include', details: input }, ctx.log);
    return { saved: true, ...r };
  }),

  refreshTypes: edit.mutation(async ({ ctx }) => {
    const conn = await loadSapConnection(ctx.db, ctx.encKey);
    if (!conn) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No SAP connection saved yet (SAP connection tab).' });
    return refreshPoTypes(ctx.db, conn);
  }),

  /** full: ignore the watermark and re-read everything ("Re-sync everything"). */
  startSync: run.input(z.object({ full: z.boolean().default(false) })).mutation(({ ctx, input }) =>
    launchSync(ctx, 'sap.purchaseOrders', !input.full ? SYNC_JOBS['sap.purchaseOrders'](ctx.db) : async (conn) => {
      const { orderTypes, startDate } = await loadPoInclude(ctx.db);
      if (orderTypes.length === 0 || !startDate) return 'Choose the order types and a start date, and save them first.';
      return (runId) => runPoSync(ctx.db, conn, { orderTypes, startDate }, runId, 'full');
    }),
  ),

  /** Deletes every order (with its lines) and copies everything after the start date again. */
  startFreshSync: fresh.mutation(async ({ ctx }) => {
    const r = await launchSync(ctx, 'sap.purchaseOrders', async (conn) => {
      const { orderTypes, startDate } = await loadPoInclude(ctx.db);
      if (orderTypes.length === 0 || !startDate) return 'Choose the order types and a start date, and save them first.';
      return (runId) => runPoSync(ctx.db, conn, { orderTypes, startDate }, runId, 'fresh');
    });
    if (r.started) await audit(ctx.db, { userId: ctx.user.id, action: 'config.po.freshSync', target: `SyncRun ${r.runId}` }, ctx.log);
    return r;
  }),
});
