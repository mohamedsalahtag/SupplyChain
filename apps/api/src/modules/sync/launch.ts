/** Starts a sync in the background and answers the UI at once; the UI then follows sync.status. */
import { loadSapConnection, type SapConnection } from '../../settings/sapConnection.js';
import type { Context } from '../../trpc/trpc.js';
import { startRun, SyncAlreadyRunningError, type SyncSource } from './syncRun.js';

export type LaunchResult = { started: true; runId: number } | { started: false; reason: string };

/**
 * `prepare` runs before the run row is created, so a missing setting is
 * reported without a failed run in the history. It returns the work to do,
 * or a reason not to start. The work must record its own finish (finishRun)
 * and never throw.
 */
export async function launchSync(
  ctx: Context & { user: NonNullable<Context['user']> },
  source: SyncSource,
  prepare: (conn: SapConnection) => Promise<((runId: number) => Promise<void>) | string>,
): Promise<LaunchResult> {
  const conn = await loadSapConnection(ctx.db, ctx.encKey);
  if (!conn) return { started: false, reason: 'No SAP connection saved yet (SAP connection tab).' };
  const work = await prepare(conn);
  if (typeof work === 'string') return { started: false, reason: work };
  try {
    const runId = await startRun(ctx.db, source, ctx.user.displayName);
    ctx.log.info({ runId, source, user: ctx.user.displayName }, 'Sync started');
    void work(runId).then(() => ctx.log.info({ runId, source }, 'Sync finished'));
    return { started: true, runId };
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) {
      return { started: false, reason: `A sync is already running — started by ${err.startedBy} at ${err.startedAt.toISOString()}.` };
    }
    throw err;
  }
}
