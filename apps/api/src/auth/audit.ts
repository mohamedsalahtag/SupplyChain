/** Writes one row to app.AuditLog. Never throws: a failed audit write must not break the action. */
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

export async function audit(
  db: Kysely<Database>,
  entry: { userId: number | null; action: string; target?: string; details?: Record<string, unknown> },
  log?: { error: (obj: object, msg: string) => void },
): Promise<void> {
  try {
    await db
      .insertInto('app.AuditLog')
      .values({
        UserId: entry.userId,
        Action: entry.action,
        Target: entry.target ?? '',
        Details: entry.details ? JSON.stringify(entry.details) : null,
      })
      .execute();
  } catch (err) {
    log?.error({ err, entry }, 'Audit write failed');
  }
}
