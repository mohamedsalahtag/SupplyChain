/** Per-user table preferences (rows per page, hidden columns), kept in app.UserPreference. */
import { DEFAULT_TABLE_PAGE_SIZE, SIGNED_IN, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/schema.js';
import { procedure, router } from '../trpc/trpc.js';

const tableKey = z.string().regex(/^[a-z0-9.-]{1,60}$/, 'Invalid table key');

const tablePrefsSchema = z.object({
  pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n), 'Page size must be 25, 50 or 100'),
  /** null = the user never chose: the table shows its own default columns. */
  hiddenColumns: z.array(z.string().max(60)).max(60).nullable(),
});
export type TablePrefs = z.infer<typeof tablePrefsSchema>;

const DEFAULTS: TablePrefs = { pageSize: DEFAULT_TABLE_PAGE_SIZE, hiddenColumns: null };

async function load(db: Kysely<Database>, userId: string, table: string): Promise<TablePrefs> {
  const row = await db
    .selectFrom('app.UserPreference')
    .select('PrefValue')
    .where('UserId', '=', userId)
    .where('PrefKey', '=', `table:${table}`)
    .executeTakeFirst();
  const parsed = tablePrefsSchema.safeParse(row ? JSON.parse(row.PrefValue) : null);
  return parsed.success ? parsed.data : DEFAULTS;
}

async function save(db: Kysely<Database>, userId: string, table: string, prefs: TablePrefs): Promise<void> {
  const key = `table:${table}`;
  const value = JSON.stringify(tablePrefsSchema.parse(prefs));
  await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('app.UserPreference')
      .set({ PrefValue: value, UpdatedAt: sql<Date>`SYSUTCDATETIME()` })
      .where('UserId', '=', userId)
      .where('PrefKey', '=', key)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) {
      await trx
        .insertInto('app.UserPreference')
        .values({ UserId: userId, PrefKey: key, PrefValue: value, UpdatedAt: sql<Date>`SYSUTCDATETIME()` })
        .execute();
    }
  });
}

/** Each user reads and writes only their own preferences. */
const view = procedure.meta({ permission: SIGNED_IN });

export const prefsRouter = router({
  getTable: view.input(z.object({ table: tableKey })).query(({ ctx, input }) => load(ctx.db, String(ctx.user.id), input.table)),

  /** Changes only the fields given; the rest stay as saved. */
  setTable: view
    .input(z.object({ table: tableKey }).merge(tablePrefsSchema.partial()))
    .mutation(async ({ ctx, input }) => {
      const { table, ...patch } = input;
      const next = { ...(await load(ctx.db, String(ctx.user.id), table)), ...patch };
      await save(ctx.db, String(ctx.user.id), table, next);
      return next;
    }),
});
