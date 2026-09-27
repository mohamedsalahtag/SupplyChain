/**
 * The maintenance lock (Configuration → Start over). The purge holds it, exclusively, for its whole transaction
 * (sp_getapplock, transaction owner: released by the commit or the rollback, also when the process dies).
 * The SAP outbox and the sync start test it first and stay out while it is held.
 */
import { sql } from 'kysely';
import type { Db, Tx } from '../workflow/tx.js';

export const MAINTENANCE_LOCK = 'scm.maintenance';

/** Inside the purge transaction: true when taken, false when another maintenance run holds it (never waits). */
export async function takeMaintenanceLock(tx: Tx): Promise<boolean> {
  const r = await sql<{ r: number }>`SET NOCOUNT ON; DECLARE @r int;
    EXEC @r = sp_getapplock @Resource = ${MAINTENANCE_LOCK}, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0;
    SELECT @r AS r;`.execute(tx);
  return Number(r.rows[0]?.r ?? -999) >= 0;
}

/** A cheap test (no lock is taken): is a maintenance run (the purge) in progress right now? */
export async function maintenanceRunning(db: Db | Tx): Promise<boolean> {
  const r = await sql<{ free: number | null }>`SELECT APPLOCK_TEST('public', ${MAINTENANCE_LOCK}, 'Shared', 'Session') AS free`.execute(db);
  return Number(r.rows[0]?.free ?? 1) === 0;
}
