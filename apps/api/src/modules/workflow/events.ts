/** Domain event log and notification outbox (plan v5 §0.1). Written in the caller's transaction. */
import { sql, type RawBuilder } from 'kysely';
import type { Db, Tx } from './tx.js';

export type DomainEventInput = {
  type: string;
  entityType: string;
  entityId: string | number;
  demandId?: string | number | null;
  payload?: unknown;
  /** null = the system (hourly job, sync). */
  actorUserId: number | null;
};

export async function recordEvent(db: Db | Tx, e: DomainEventInput): Promise<string> {
  const row = await db
    .insertInto('scm.DomainEvent')
    .values({
      EventType: e.type,
      EntityType: e.entityType,
      EntityId: String(e.entityId),
      DemandId: e.demandId == null ? null : String(e.demandId),
      PayloadJson: e.payload === undefined ? null : JSON.stringify(e.payload),
      ActorUserId: e.actorUserId,
    })
    .output('inserted.EventId')
    .executeTakeFirstOrThrow();
  return String(row.EventId);
}

/** Queued now, delivered later (plan Stage 9). */
export async function queueNotification(
  db: Db | Tx,
  n: { type: string; permission?: string; userId?: number; entityType: string; entityId: string | number; payload?: unknown },
): Promise<void> {
  await db
    .insertInto('scm.NotificationOutbox')
    .values({
      NotificationType: n.type,
      RecipientPermission: n.permission ?? null,
      RecipientUserId: n.userId ?? null,
      EntityType: n.entityType,
      EntityId: String(n.entityId),
      PayloadJson: n.payload === undefined ? null : JSON.stringify(n.payload),
    })
    .execute();
}

/** The same insert as recordEvent, as a batch fragment: the new EventId lands in the T-SQL variable `@<variable>`. */
export function eventSql(variable: string, e: DomainEventInput): RawBuilder<unknown> {
  const v = sql.raw(`@${variable}`);
  return sql`DECLARE ${v} bigint;
INSERT INTO scm.DomainEvent (EventType, EntityType, EntityId, DemandId, PayloadJson, ActorUserId)
  VALUES (${e.type}, ${e.entityType}, ${String(e.entityId)}, ${e.demandId == null ? null : String(e.demandId)}, ${e.payload === undefined ? null : JSON.stringify(e.payload)}, ${e.actorUserId});
SET ${v} = SCOPE_IDENTITY();`;
}
