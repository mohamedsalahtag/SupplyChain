/** Writes rows to app.AuditLog. */
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

export type AuditEntry = { userId: number | null; action: string; target?: string; details?: Record<string, unknown> };

const row = (entry: AuditEntry) => ({
  UserId: entry.userId,
  Action: entry.action,
  Target: (entry.target ?? '').slice(0, 200),
  Details: entry.details ? JSON.stringify(entry.details) : null,
});

/**
 * Best effort, for sign-in events and other actions outside a transaction: never throws, because a failed audit write
 * must not break a sign-in.
 */
export async function audit(db: Kysely<Database>, entry: AuditEntry, log?: { error: (obj: object, msg: string) => void }): Promise<void> {
  try {
    await db.insertInto('app.AuditLog').values(row(entry)).execute();
  } catch (err) {
    log?.error({ err, entry }, 'Audit write failed');
  }
}

/**
 * For security changes (roles, permissions, users, their roles and companies): written inside the change's own
 * transaction, so the change and its audit row commit together — or neither does. Throws on failure.
 */
export async function auditTx(trx: Kysely<Database>, entry: AuditEntry): Promise<void> {
  await trx.insertInto('app.AuditLog').values(row(entry)).execute();
}
