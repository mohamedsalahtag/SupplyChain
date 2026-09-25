/**
 * Conversation threads (plan v5 §0.1): one per business object; comments and
 * system events in one timeline. Entries are immutable (DB trigger); a
 * correction is a new entry pointing at the one it corrects.
 */
import { sql, type RawBuilder } from 'kysely';
import type { Db, Tx } from './tx.js';

export type EntryKind = 'COMMENT' | 'SYSTEM' | 'DECISION' | 'CLARIFICATION';

export async function getOrCreateThread(tx: Tx, entityType: string, entityId: string | number): Promise<string> {
  const id = String(entityId);
  const found = (await sql<{ ThreadId: string }>`
    SELECT ThreadId FROM scm.Thread WITH (UPDLOCK, HOLDLOCK) WHERE EntityType = ${entityType} AND EntityId = ${id}`.execute(tx)).rows[0];
  if (found) return String(found.ThreadId);
  const created = await tx.insertInto('scm.Thread').values({ EntityType: entityType, EntityId: id }).output('inserted.ThreadId').executeTakeFirstOrThrow();
  return String(created.ThreadId);
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
  return sql`DECLARE ${t} bigint = (SELECT ThreadId FROM scm.Thread WITH (UPDLOCK, HOLDLOCK) WHERE EntityType = ${e.entityType} AND EntityId = ${id});
IF ${t} IS NULL BEGIN INSERT INTO scm.Thread (EntityType, EntityId) VALUES (${e.entityType}, ${id}); SET ${t} = SCOPE_IDENTITY(); END;
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
