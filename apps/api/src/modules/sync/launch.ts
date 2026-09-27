/** Starts a sync in the background and answers the UI at once; the UI then follows sync.status. */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { loadSapConnection, type SapConnection } from '../../settings/sapConnection.js';
import type { Context } from '../../trpc/trpc.js';
import { heartbeat, MaintenanceRunningError, startRun, SyncAlreadyRunningError, type SyncSource } from './syncRun.js';

/** How often a running sync records that it is alive (well inside STALE_AFTER_MINUTES). */
const HEARTBEAT_MS = 60_000;
/** A sync still not done after this long is stuck: its beats stop, so the next start marks it abandoned. */
const MAX_BEATING_MS = 2 * 60 * 60_000;

export type LaunchResult = { started: true; runId: number } | { started: false; reason: string };
export type Prepare = (conn: SapConnection) => Promise<((runId: number) => Promise<void>) | string>;
type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
export type SyncHost = { db: Kysely<Database>; encKey: string; log: Log };

/**
 * `prepare` runs before the run row is created, so a missing setting is
 * reported without a failed run in the history. It returns the work to do,
 * or a reason not to start. The work must record its own finish (finishRun)
 * and never throw. `startedBy` is the user's name, or "Scheduler" (sync schedule).
 */
export async function startSync(host: SyncHost, source: SyncSource, startedBy: string, prepare: Prepare): Promise<LaunchResult> {
  const { db, log } = host;
  const conn = await loadSapConnection(db, host.encKey);
  if (!conn) return { started: false, reason: 'No SAP connection saved yet (SAP connection tab).' };
  const work = await prepare(conn);
  if (typeof work === 'string') return { started: false, reason: work };
  try {
    const runId = await startRun(db, source, startedBy);
    log.info({ runId, source, user: startedBy }, 'Sync started');
    // Heartbeat while the work runs: the run is judged abandoned only when the beats stop (the server stopped), not by its age.
    const since = Date.now();
    const beat = setInterval(() => {
      if (Date.now() - since > MAX_BEATING_MS) { clearInterval(beat); log.warn({ runId, source }, 'Sync still running after 2 hours: heartbeat stopped'); return; }
      heartbeat(db, runId).catch((err: unknown) => log.warn({ err, runId }, 'Sync heartbeat failed'));
    }, HEARTBEAT_MS);
    beat.unref();
    void work(runId).then(() => log.info({ runId, source }, 'Sync finished'), (err: unknown) => log.error({ err, runId, source }, 'Sync work threw'))
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

/** A sync started by the signed-in user (the Sync buttons). */
export function launchSync(ctx: Context & { user: NonNullable<Context['user']> }, source: SyncSource, prepare: Prepare): Promise<LaunchResult> {
  return startSync({ db: ctx.db, encKey: ctx.encKey, log: ctx.log }, source, ctx.user.displayName, prepare);
}
