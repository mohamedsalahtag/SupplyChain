/**
 * Bookkeeping shared by every SAP sync: one integ.SyncRun row per run, at most
 * one running per source (unique index UX_SyncRun_OneRunning), and a clean
 * Succeeded/Failed finish.
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';

export const SYNC_SOURCES = ['sap.materials', 'sap.suppliers', 'sap.purchaseOrders'] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

const STALE_AFTER_MINUTES = 30;

export class SyncAlreadyRunningError extends Error {
  constructor(
    readonly startedBy: string,
    readonly startedAt: Date,
  ) {
    super(`A sync is already running (started by ${startedBy})`);
  }
}

/** Creates the Running row. Throws SyncAlreadyRunningError if one is in progress for this source. */
export async function startRun(db: Kysely<Database>, source: SyncSource, user: string): Promise<number> {
  // A run with no finish after 30 minutes means the server stopped mid-sync.
  await db
    .updateTable('integ.SyncRun')
    .set({ Status: 'Failed', FinishedAt: sql<Date>`SYSUTCDATETIME()`, Message: 'Abandoned: no result recorded within 30 minutes (server stopped?)' })
    .where('Source', '=', source)
    .where('Status', '=', 'Running')
    .where('StartedAt', '<', sql<Date>`DATEADD(minute, ${-STALE_AFTER_MINUTES}, SYSUTCDATETIME())`)
    .execute();

  try {
    const row = await db
      .insertInto('integ.SyncRun')
      .values({ Source: source, Status: 'Running', StartedBy: user, FinishedAt: null, RowsRead: null, RowsInserted: null, RowsUpdated: null, RowsMarkedMissing: null, Message: null })
      .output('inserted.SyncRunId')
      .executeTakeFirstOrThrow();
    return Number(row.SyncRunId); // msnodesqlv8 returns IDENTITY values as strings
  } catch (err) {
    if (!String(err).includes('UX_SyncRun_OneRunning')) throw err;
    const running = await db
      .selectFrom('integ.SyncRun')
      .select(['StartedBy', 'StartedAt'])
      .where('Source', '=', source)
      .where('Status', '=', 'Running')
      .executeTakeFirst();
    throw new SyncAlreadyRunningError(running?.StartedBy ?? 'another user', running?.StartedAt ?? new Date());
  }
}

export type RunCounts = { read: number | null; inserted: number | null; updated: number | null; missing: number | null };

export async function finishRun(
  db: Kysely<Database>,
  runId: number,
  status: 'Succeeded' | 'Failed',
  counts: Partial<RunCounts>,
  message: string | null,
): Promise<void> {
  await db
    .updateTable('integ.SyncRun')
    .set({
      Status: status,
      FinishedAt: sql<Date>`SYSUTCDATETIME()`,
      RowsRead: counts.read ?? null,
      RowsInserted: counts.inserted ?? null,
      RowsUpdated: counts.updated ?? null,
      RowsMarkedMissing: counts.missing ?? null,
      Message: message,
    })
    .where('SyncRunId', '=', runId)
    .execute();
}

/** The running run (if any) and the last finished one, shaped for the UI. */
export async function syncStatus(db: Kysely<Database>, source: SyncSource) {
  const runs = await db.selectFrom('integ.SyncRun').selectAll().where('Source', '=', source).orderBy('SyncRunId', 'desc').top(2).execute();
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const shape = (r: (typeof runs)[number] | undefined) =>
    r ? { ...r, SyncRunId: Number(r.SyncRunId), StartedAt: iso(r.StartedAt)!, FinishedAt: iso(r.FinishedAt) } : null;
  return { running: shape(runs.find((r) => r.Status === 'Running')), last: shape(runs.find((r) => r.Status !== 'Running')) };
}
