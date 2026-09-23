import { DEFAULT_TABLE_PAGE_SIZE, MATERIAL_SORT_FIELDS, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { z } from 'zod';
import { loadInclude } from '../../settings/materialsInclude.js';
import { procedure, router } from '../../trpc/trpc.js';
import { launchSync } from '../sync/launch.js';
import { runMaterialSync } from './materialSync.js';
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

  /** Starts a sync in the background; the UI follows it through sync.status. */
  startSync: sync.mutation(({ ctx }) =>
    launchSync(ctx, 'sap.materials', async (conn) => {
      const { materialTypes } = await loadInclude(ctx.db);
      return (runId) => runMaterialSync(ctx.db, conn, materialTypes, runId);
    }),
  ),
});
