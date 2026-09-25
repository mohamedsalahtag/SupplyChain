/**
 * Conversation threads (plan v5 §0.1): one per business object; comments and
 * system events in one timeline. Entries are immutable (DB trigger); a
 * correction is a new entry pointing at the one it corrects.
 */
import { sql, type RawBuilder } from 'kysely';
import type { Db, Tx } from './tx.js';

export type EntryKind = 'COMMENT' | 'SYSTEM' | 'DECISION' | 'CLARIFICATION';

export async function getOrCreateThread(tx: Tx, entityType: string, entityId: string | number): Promise<string> {
  const r = await sql<{ ThreadId: string }>`SET NOCOUNT ON; ${threadSql(0, entityType, String(entityId))} SELECT CAST(@thread0 AS nvarchar(20)) AS ThreadId;`.execute(tx);
  return String(r.rows[0].ThreadId);
}

/**
 * The object's thread into `@thread<n>`, created if missing. No HOLDLOCK: a range lock on a missing key made new objects
 * with neighbouring ids (demands submitted at the same time) queue behind each other for their whole transaction
 * (database review 2026-09). The unique index still guarantees one thread per object: when two transactions create it
 * at the same moment, the second gets a duplicate key, ignores it and reads the first one's thread.
 */
function threadSql(n: number, entityType: string, id: string): RawBuilder<unknown> {
  const t = sql.raw(`@thread${n}`);
  return sql`DECLARE ${t} bigint = (SELECT ThreadId FROM scm.Thread WHERE EntityType = ${entityType} AND EntityId = ${id});
IF ${t} IS NULL BEGIN
  BEGIN TRY INSERT INTO scm.Thread (EntityType, EntityId) VALUES (${entityType}, ${id}); SET ${t} = SCOPE_IDENTITY(); END TRY
  BEGIN CATCH IF ERROR_NUMBER() NOT IN (2601, 2627) THROW; END CATCH;
  IF ${t} IS NULL SET ${t} = (SELECT ThreadId FROM scm.Thread WHERE EntityType = ${entityType} AND EntityId = ${id});
END;`;
}

type NewEntry = { entityType: string; entityId: string | number; kind: EntryKind; body: string; authorUserId: number | null; eventId?: string | null; correctsEntryId?: string | null };

/**
 * One entry as a batch fragment (thread found or created, then the entry): one round trip instead of two.
 * `eventVar` names a T-SQL variable holding the event id (from eventSql) instead of `eventId`.
 * The new EntryId lands in `@entry<n>`.
 */
export function threadEntrySql(n: number, e: NewEntry, eventVar?: string): RawBuilder<unknown> {
  const t = sql.raw(`@thread${n}`);
  const id = String(e.entityId);
  const ev = eventVar ? sql.raw(`@${eventVar}`) : sql`${e.eventId ?? null}`;
  return sql`${threadSql(n, e.entityType, id)}
INSERT INTO scm.ThreadEntry (ThreadId, EntryKind, Body, AuthorUserId, EventId, CorrectsEntryId) VALUES (${t}, ${e.kind}, ${e.body}, ${e.authorUserId}, ${ev}, ${e.correctsEntryId ?? null});
DECLARE ${sql.raw(`@entry${n}`)} bigint = SCOPE_IDENTITY();`;
}

export async function addThreadEntry(tx: Tx, e: NewEntry): Promise<string> {
  const r = await sql<{ EntryId: string }>`SET NOCOUNT ON;
${threadEntrySql(0, e)}
SELECT CAST(@entry0 AS nvarchar(20)) AS EntryId;`.execute(tx);
  return String(r.rows[0].EntryId);
}

export async function listThread(db: Db | Tx, entityType: string, entityId: string | number) {
  const rows = await db
    .selectFrom('scm.Thread as t')
    .innerJoin('scm.ThreadEntry as e', 'e.ThreadId', 't.ThreadId')
    .leftJoin('app.User as u', 'u.UserId', 'e.AuthorUserId')
    .select(['e.EntryId', 'e.EntryKind', 'e.Body', 'e.CorrectsEntryId', 'e.CreatedAt', 'u.DisplayName'])
    .where('t.EntityType', '=', entityType)
    .where('t.EntityId', '=', String(entityId))
    .orderBy('e.CreatedAt')
    .orderBy('e.EntryId')
    .execute();
  return rows.map((r) => ({
    entryId: String(r.EntryId),
    kind: r.EntryKind,
    body: r.Body,
    correctsEntryId: r.CorrectsEntryId ? String(r.CorrectsEntryId) : null,
    author: r.DisplayName ?? 'System',
    createdAt: r.CreatedAt.toISOString(),
  }));
}
