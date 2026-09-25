import { DEFAULT_TABLE_PAGE_SIZE, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../auth/audit.js';
import { loadSapConnection } from '../../settings/sapConnection.js';
import { procedure, router } from '../../trpc/trpc.js';
import { loadCodeCounts } from '../sync/codeList.js';
import { launchSync } from '../sync/launch.js';
import { loadPoInclude, loadWatermark, poIncludeSchema, refreshPoTypes, runPoSync, savePoInclude, TYPES_KEY } from './poSync.js';

const view = procedure.meta({ permission: P.purchaseOrdersOpen });
const edit = procedure.meta({ permission: P.configPoEdit });
const run = procedure.meta({ permission: P.configPoRun });
const fresh = procedure.meta({ permission: P.configPoFresh });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SORT_FIELDS = ['PurchaseOrder', 'OrderDate', 'OrderType', 'SupplierCode'] as const;
const listInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n)).default(DEFAULT_TABLE_PAGE_SIZE),
  q: z.string().trim().max(100).optional(), // PO number, supplier code or name
  type: z.array(z.string()).max(50).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sortField: z.enum(SORT_FIELDS).default('OrderDate'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const contains = (s: string) => `%${s.replace(/[[%_]/g, '[$&]')}%`;

export const purchaseOrdersRouter = router({
  list: view.input(listInput).query(async ({ ctx, input: f }) => {
    let q = ctx.db.selectFrom('md.PurchaseOrder as po').leftJoin('md.Supplier as s', 's.SupplierCode', 'po.SupplierCode');
    if (f.q) {
      const p = contains(f.q);
      q = q.where((eb) => eb.or([eb('po.PurchaseOrder', 'like', p), eb('po.SupplierCode', 'like', p), eb('s.Name', 'like', p)]));
    }
    if (f.type?.length) q = q.where('po.OrderType', 'in', f.type);
    if (f.from) q = q.where('po.OrderDate', '>=', sql<Date>`${f.from}`);
    if (f.to) q = q.where('po.OrderDate', '<=', sql<Date>`${f.to}`);
    let ordered = q
      .select(['po.PurchaseOrder', 'po.OrderType', 'po.SupplierCode', 'po.OrderDate', 'po.Currency', 'po.CompanyCode', 's.Name as SupplierName'])
      .select((eb) =>
        eb.selectFrom('md.PurchaseOrderLine as l').whereRef('l.PurchaseOrder', '=', 'po.PurchaseOrder').select((e) => e.fn.countAll<number>().as('n')).as('LineCount'),
      )
      .orderBy(`po.${f.sortField}`, f.sortOrder);
    if (f.sortField !== 'PurchaseOrder') ordered = ordered.orderBy('po.PurchaseOrder', 'desc');
    const [rows, count] = await Promise.all([
      ordered.offset((f.page - 1) * f.pageSize).fetch(f.pageSize).execute(),
      q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      total: Number(count.n),
      rows: rows.map((r) => ({ ...r, OrderDate: r.OrderDate.toISOString().slice(0, 10), LineCount: Number(r.LineCount ?? 0), SupplierName: r.SupplierName ?? '' })),
    };
  }),

  /** One order's lines, with the material description when the material is in Materials. */
  lines: view.input(z.object({ purchaseOrder: z.string().max(20) })).query(async ({ ctx, input }) =>
    (
      await ctx.db
        .selectFrom('md.PurchaseOrderLine as l')
        .leftJoin('md.Material as m', 'm.MaterialCode', 'l.Material')
        .select(['l.ItemNo', 'l.Material', 'l.Quantity', 'l.Unit', 'l.NetPrice', 'l.PriceQuantity', 'm.Description as MaterialDescription'])
        .where('l.PurchaseOrder', '=', input.purchaseOrder)
        .orderBy('l.ItemNo')
        .execute()
    ).map((l) => ({ ...l, ItemNo: Number(l.ItemNo), Quantity: Number(l.Quantity), NetPrice: Number(l.NetPrice), PriceQuantity: Number(l.PriceQuantity), MaterialDescription: l.MaterialDescription ?? '' })),
  ),

  typeOptions: view.query(async ({ ctx }) =>
    (await ctx.db.selectFrom('md.PurchaseOrder').select('OrderType').distinct().orderBy('OrderType').execute()).map((r) => r.OrderType),
  ),

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
    launchSync(ctx, 'sap.purchaseOrders', async (conn) => {
      const { orderTypes, startDate } = await loadPoInclude(ctx.db);
      if (orderTypes.length === 0 || !startDate) return 'Choose the order types and a start date, and save them first.';
      return (runId) => runPoSync(ctx.db, conn, { orderTypes, startDate }, runId, input.full ? 'full' : 'changes');
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
