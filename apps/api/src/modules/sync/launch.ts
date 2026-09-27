/** Starts a sync in the background and answers the UI at once; the UI then follows sync.status. */
import { loadSapConnection, type SapConnection } from '../../settings/sapConnection.js';
import type { Context } from '../../trpc/trpc.js';
import { heartbeat, MaintenanceRunningError, startRun, SyncAlreadyRunningError, type SyncSource } from './syncRun.js';

/** How often a running sync records that it is alive (well inside STALE_AFTER_MINUTES). */
const HEARTBEAT_MS = 60_000;
/** A sync still not done after this long is stuck: its beats stop, so the next start marks it abandoned. */
const MAX_BEATING_MS = 2 * 60 * 60_000;

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
    // Heartbeat while the work runs: the run is judged abandoned only when the beats stop (the server stopped), not by its age.
    const since = Date.now();
    const beat = setInterval(() => {
      if (Date.now() - since > MAX_BEATING_MS) { clearInterval(beat); ctx.log.warn({ runId, source }, 'Sync still running after 2 hours: heartbeat stopped'); return; }
      heartbeat(ctx.db, runId).catch((err: unknown) => ctx.log.warn({ err, runId }, 'Sync heartbeat failed'));
    }, HEARTBEAT_MS);
    beat.unref();
    void work(runId).then(() => ctx.log.info({ runId, source }, 'Sync finished'), (err: unknown) => ctx.log.error({ err, runId, source }, 'Sync work threw'))
      .finally(() => clearInterval(beat));
    return { started: true, runId };
  } catch (err) {
    if (err instanceof MaintenanceRunningError) return { started: false, reason: err.message };
    if (err instanceof SyncAlreadyRunningError) {
      return { started: false, reason: `A sync is already running — started by ${err.startedBy} at ${err.startedAt.toISOString()}.` };
    }
    throw err;
  }
}
