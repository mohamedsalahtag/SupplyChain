import { DEFAULT_TABLE_PAGE_SIZE, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { z } from 'zod';
import { audit } from '../../auth/audit.js';
import { loadSapConnection } from '../../settings/sapConnection.js';
import { procedure, router } from '../../trpc/trpc.js';
import { loadCodeCounts } from '../sync/codeList.js';
import { launchSync } from '../sync/launch.js';
import { formatAddress } from './sapSupplier.js';
import { GROUPS_KEY, loadSupplierInclude, refreshSupplierGroups, runSupplierSync, saveSupplierInclude, supplierIncludeSchema } from './supplierSync.js';

const view = procedure.meta({ permission: P.suppliersOpen });
const edit = procedure.meta({ permission: P.configSuppliersEdit });
const run = procedure.meta({ permission: P.configSuppliersRun });
const fresh = procedure.meta({ permission: P.configSuppliersFresh });

const SORT_FIELDS = ['SupplierCode', 'Name', 'SupplierGroup', 'Country', 'City'] as const;
const listInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n)).default(DEFAULT_TABLE_PAGE_SIZE),
  q: z.string().trim().max(100).optional(),
  group: z.array(z.string()).max(100).optional(),
  country: z.array(z.string()).max(300).optional(),
  currency: z.array(z.string()).max(100).optional(),
  sortField: z.enum(SORT_FIELDS).default('Name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

const contains = (s: string) => `%${s.replace(/[[%_]/g, '[$&]')}%`;

export const suppliersRouter = router({
  list: view.input(listInput).query(async ({ ctx, input: f }) => {
    let q = ctx.db.selectFrom('md.Supplier');
    if (f.q) {
      const p = contains(f.q);
      q = q.where((eb) => eb.or([eb('SupplierCode', 'like', p), eb('Name', 'like', p), eb('Email', 'like', p)]));
    }
    if (f.group?.length) q = q.where('SupplierGroup', 'in', f.group);
    if (f.country?.length) q = q.where('Country', 'in', f.country);
    if (f.currency?.length) q = q.where('Currency', 'in', f.currency);
    let ordered = q.selectAll().orderBy(f.sortField, f.sortOrder);
    if (f.sortField !== 'SupplierCode') ordered = ordered.orderBy('SupplierCode'); // stable paging
    const [rows, count] = await Promise.all([
      ordered.offset((f.page - 1) * f.pageSize).fetch(f.pageSize).execute(),
      q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);
    // Purchasing organizations of this page's suppliers, as "1000, 2000 (blocked)" (spec 11).
    // Joined here: the server is SQL Server 2016, which has no STRING_AGG.
    const orgRows = rows.length
      ? await ctx.db.selectFrom('md.SupplierPurchasingOrg').selectAll().where('SupplierCode', 'in', rows.map((r) => r.SupplierCode)).orderBy('PurchasingOrg').execute()
      : [];
    const orgsOf = (code: string) =>
      orgRows.filter((o) => o.SupplierCode === code).map((o) => o.PurchasingOrg + (o.IsBlocked ? ' (blocked)' : '')).join(', ');
    // Spec 22: the SAP payment terms and Incoterm per purchasing org (the handoff defaults)
    const termsOf = (code: string) =>
      orgRows.filter((o) => o.SupplierCode === code && (o.PaymentTerms || o.Incoterm)).map((o) => `${o.PurchasingOrg}: ${[o.PaymentTerms, o.Incoterm && `${o.Incoterm} ${o.IncotermLocation}`.trim()].filter(Boolean).join(' · ')}`).join(', ');
    return {
      total: Number(count.n),
      rows: rows.map((r) => ({ ...r, PurchasingOrgs: orgsOf(r.SupplierCode), SapTerms: termsOf(r.SupplierCode), Address: formatAddress(r), SapChangedAt: r.SapChangedAt.toISOString() })),
    };
  }),

  filterOptions: view.query(async ({ ctx }) => {
    const distinct = async (col: 'SupplierGroup' | 'Country' | 'Currency') =>
      (await ctx.db.selectFrom('md.Supplier').select(col).distinct().where(col, '<>', '').orderBy(col).execute()).map((r) => r[col]);
    const [groups, countries, currencies] = await Promise.all([distinct('SupplierGroup'), distinct('Country'), distinct('Currency')]);
    return { groups, countries, currencies };
  }),

  /** The Z groups SAP offers (from the last check) and the chosen ones. */
  include: procedure.meta({ permission: P.configOpen }).query(async ({ ctx }) => {
    const [include, available] = await Promise.all([loadSupplierInclude(ctx.db), loadCodeCounts(ctx.db, GROUPS_KEY)]);
    return { ...include, available };
  }),

  saveInclude: edit.input(supplierIncludeSchema).mutation(async ({ ctx, input }) => {
    await saveSupplierInclude(ctx.db, input);
    await audit(ctx.db, { userId: ctx.user.id, action: 'config.suppliers.groups', details: input }, ctx.log);
    return { saved: true };
  }),

  refreshGroups: edit.mutation(async ({ ctx }) => {
    const conn = await loadSapConnection(ctx.db, ctx.encKey);
    if (!conn) throw new Error('No SAP connection saved yet (SAP connection tab).');
    return refreshSupplierGroups(ctx.db, conn);
  }),

  startSync: run.mutation(({ ctx }) =>
    launchSync(ctx, 'sap.suppliers', async (conn) => {
      const { groups } = await loadSupplierInclude(ctx.db);
      if (groups.length === 0) return 'Choose at least one supplier group and save it first.';
      return (runId) => runSupplierSync(ctx.db, conn, groups, runId);
    }),
  ),

  /** Deletes every supplier and copies the chosen groups again (after SAP has been read). */
  startFreshSync: fresh.mutation(async ({ ctx }) => {
    const r = await launchSync(ctx, 'sap.suppliers', async (conn) => {
      const { groups } = await loadSupplierInclude(ctx.db);
      if (groups.length === 0) return 'Choose at least one supplier group and save it first.';
      return (runId) => runSupplierSync(ctx.db, conn, groups, runId, true);
    });
    if (r.started) await audit(ctx.db, { userId: ctx.user.id, action: 'config.suppliers.freshSync', target: `SyncRun ${r.runId}` }, ctx.log);
    return r;
  }),
});
