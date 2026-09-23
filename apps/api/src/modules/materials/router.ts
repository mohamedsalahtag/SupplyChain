import { DEFAULT_TABLE_PAGE_SIZE, MATERIAL_SORT_FIELDS, P, SIGNED_IN, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { z } from 'zod';
import { loadInclude } from '../../settings/materialsInclude.js';
import { loadSapConnection } from '../../settings/sapConnection.js';
import { procedure, router } from '../../trpc/trpc.js';
import { runMaterialSync, startRun, SyncAlreadyRunningError, SOURCE } from './materialSync.js';
import { filterOptions, listMaterials } from './materialsRepo.js';

const view = procedure.meta({ permission: P.materialsOpen });
const sync = procedure.meta({ permission: P.configSyncRun });

const listInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z
    .number()
    .int()
    .refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n), 'Page size must be 25, 50 or 100')
    .default(DEFAULT_TABLE_PAGE_SIZE),
  q: z.string().trim().max(100).optional(),
  // Multi-select filters: a row matches when its value is any of the chosen ones.
  major: z.array(z.string()).max(200).optional(),
  subMajor: z.array(z.string()).max(500).optional(),
  group: z.array(z.string()).max(500).optional(),
  origin: z.array(z.string()).max(500).optional(),
  sortField: z.enum(MATERIAL_SORT_FIELDS).default('MaterialCode'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});
export type MaterialListInput = z.infer<typeof listInput>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const materialsRouter = router({
  list: view.input(listInput).query(async ({ ctx, input }) => {
    const { rows, total } = await listMaterials(ctx.db, input);
    return { total, rows: rows.map((r) => ({ ...r, SapChangedAt: iso(r.SapChangedAt)! })) };
  }),

  filterOptions: view.query(({ ctx }) => filterOptions(ctx.db)),

  /** The running sync (if any) and the last finished one. */
  syncStatus: procedure.meta({ permission: SIGNED_IN }).query(async ({ ctx }) => {
    const runs = await ctx.db
      .selectFrom('integ.SyncRun')
      .selectAll()
      .where('Source', '=', SOURCE)
      .orderBy('SyncRunId', 'desc')
      .top(2)
      .execute();
    const shape = (r: (typeof runs)[number] | undefined) =>
      r ? { ...r, SyncRunId: Number(r.SyncRunId), StartedAt: iso(r.StartedAt)!, FinishedAt: iso(r.FinishedAt) } : null;
    const running = runs.find((r) => r.Status === 'Running');
    const last = runs.find((r) => r.Status !== 'Running');
    return { running: shape(running), last: shape(last) };
  }),

  /** Starts a sync in the background; the UI follows it through syncStatus. */
  startSync: sync.mutation(async ({ ctx }) => {
    const conn = await loadSapConnection(ctx.db, ctx.encKey);
    if (!conn) return { started: false as const, reason: 'No SAP connection saved yet.' };
    try {
      const runId = await startRun(ctx.db, ctx.user.displayName);
      ctx.log.info({ runId, user: ctx.user.displayName }, 'Materials sync started');
      const { materialTypes } = await loadInclude(ctx.db);
      void runMaterialSync(ctx.db, conn, materialTypes, runId).then(() => ctx.log.info({ runId }, 'Materials sync finished'));
      return { started: true as const, runId };
    } catch (err) {
      if (err instanceof SyncAlreadyRunningError) {
        return { started: false as const, reason: `A sync is already running — started by ${err.startedBy} at ${iso(err.startedAt)}.` };
      }
      throw err;
    }
  }),
});
