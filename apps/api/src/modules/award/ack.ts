/**
 * Sales acknowledgement of an award batch (spec 20, plan v5 §5.3): a heads-up, never
 * a blocker. Any change to the batch resets it to Pending with a new revision; the
 * history keeps what was acknowledged at each revision.
 */
import { sql } from 'kysely';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { queueNotification, recordEvent } from '../workflow/events.js';
import { closeInbox, openInbox } from '../workflow/inbox.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { addThreadEntry } from '../workflow/threads.js';
import { updateWithRowVer, type Db, type Tx } from '../workflow/tx.js';

export const P_ACK = 'ack.respond';
export type AckCause = 'CREATED' | 'ACKNOWLEDGED' | 'QUERY' | 'ANSWERED' | 'RESET_UNAWARD' | 'RESET_CANCEL' | 'RESET_SKU' | 'RESET_SHIPMENT' | 'LATE';

type Batch = { AwardBatchId: string; AbNo: string; DemandId: string; CompanyCode: string; DemandNo: string; CreatedBy: number };
async function batchOf(db: Db | Tx, awardBatchId: string): Promise<Batch> {
  const b = await db.selectFrom('scm.AwardBatch as b').innerJoin('scm.Demand as d', 'd.DemandId', 'b.DemandId')
    .select(['b.AwardBatchId', 'b.AbNo', 'b.DemandId', 'b.CompanyCode', 'd.DemandNo', 'd.CreatedBy']).where('b.AwardBatchId', '=', awardBatchId).executeTakeFirstOrThrow();
  return { ...b, AwardBatchId: String(b.AwardBatchId), DemandId: String(b.DemandId), CreatedBy: Number(b.CreatedBy) };
}

async function history(tx: Tx, ackId: string, revision: number, from: string | null, to: string, cause: AckCause, actorUserId: number | null, snapshot: unknown, comment: string | null = null) {
  await tx.insertInto('scm.SalesAckHistory').values({
    AckId: ackId, Revision: revision, FromStatus: from, ToStatus: to, Cause: cause, AwardSnapshotJson: snapshot ? JSON.stringify(snapshot) : null, Comment: comment, ActorUserId: actorUserId,
  }).execute();
}

/** Sales' task on My work, and a notification to the demand's owner. */
async function askSales(tx: Tx, b: Batch, ackId: string, revision: number, actorUserId: number) {
  await openInbox(tx, {
    itemType: 'ACK_PENDING', permission: P_ACK, companyCode: b.CompanyCode, entityType: 'ACK', entityId: ackId, number: b.AbNo,
    title: `${b.DemandNo} · award ${b.AbNo}${revision > 1 ? ` (changed, revision ${revision})` : ''}`, link: `/awards/${b.AwardBatchId}`, raisedBy: actorUserId, excludeUserId: actorUserId,
  });
  await queueNotification(tx, { type: 'AWARD_ACK_REQUESTED', userId: b.CreatedBy, entityType: 'AWARD_BATCH', entityId: b.AwardBatchId, payload: { revision } });
}

/** What was awarded, as Sales saw it (stored with each acknowledgement). */
export async function awardSnapshot(db: Db | Tx, awardBatchId: string) {
  const [items, shipments] = await Promise.all([
    db.selectFrom('scm.AwardItem as i').innerJoin('scm.RfqLine as l', 'l.RfqLineId', 'i.RfqLineId')
      .select(['i.SupplierCode', 'i.EtdWeek', 'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.OriginCode', 'i.Qty', 'i.Unit', 'i.UnitPrice', 'i.Currency', 'i.SkuStatus'])
      .where('i.AwardBatchId', '=', awardBatchId).where('i.IsActive', '=', true).orderBy('i.EtdWeek').execute(),
    db.selectFrom('scm.AwardShipment').select(['SupplierCode', 'EtdWeek', 'ContainerCount', 'ConfirmedEtd']).where('AwardBatchId', '=', awardBatchId).where('IsActive', '=', true).execute(),
  ]);
  return {
    items: items.map((i) => ({ ...i, Qty: formatQty(fromDb(i.Qty)), UnitPrice: String(i.UnitPrice) })),
    shipments: shipments.map((s) => ({ ...s, ConfirmedEtd: s.ConfirmedEtd ? new Date(s.ConfirmedEtd).toISOString().slice(0, 10) : null })),
  };
}

export async function createAck(tx: Tx, awardBatchId: string, actorUserId: number): Promise<void> {
  const b = await batchOf(tx, awardBatchId);
  const ackId = String((await tx.insertInto('scm.SalesAck').values({ AwardBatchId: awardBatchId, DemandId: b.DemandId, RespondedBy: null, RespondedAt: null, Comment: null })
    .output('inserted.AckId').executeTakeFirstOrThrow()).AckId);
  await history(tx, ackId, 1, null, 'PENDING', 'CREATED', actorUserId, null);
  await askSales(tx, b, ackId, 1, actorUserId);
}

/** Any change to an award batch: back to Pending with a new revision (and a new task if Sales had responded). */
export async function resetAck(tx: Tx, awardBatchId: string, cause: AckCause, actorUserId: number): Promise<void> {
  const a = (await sql<{ AckId: string; Status: string; Revision: number }>`SELECT AckId, Status, Revision FROM scm.SalesAck WITH (UPDLOCK) WHERE AwardBatchId = ${awardBatchId}`.execute(tx)).rows[0];
  if (!a) return;
  const ackId = String(a.AckId);
  await sql`UPDATE scm.SalesAck SET Status = 'PENDING', Revision = Revision + 1, RespondedBy = NULL, RespondedAt = NULL WHERE AckId = ${ackId}`.execute(tx);
  await history(tx, ackId, Number(a.Revision) + 1, a.Status, 'PENDING', cause, actorUserId, null);
  await closeInbox(tx, 'ACK_QUERY', 'ACK', ackId, actorUserId);
  await askSales(tx, await batchOf(tx, awardBatchId), ackId, Number(a.Revision) + 1, actorUserId);
}

async function lockAck(tx: Tx, actor: Actor, ackId: string, permission: string) {
  const a = (await sql<{ AckId: string; AwardBatchId: string; Status: string; Revision: number; HandedOffWithoutAck: boolean; CompanyCode: string }>`
    SELECT a.AckId, a.AwardBatchId, a.Status, a.Revision, a.HandedOffWithoutAck, b.CompanyCode FROM scm.SalesAck a WITH (UPDLOCK)
    JOIN scm.AwardBatch b ON b.AwardBatchId = a.AwardBatchId WHERE a.AckId = ${ackId}`.execute(tx)).rows[0];
  if (!a || !actor.companies.has(a.CompanyCode)) throw new NotFoundError(`Acknowledgement ${ackId}`);
  assertCan(actor, permission, a.CompanyCode);
  return { ...a, AckId: String(a.AckId), AwardBatchId: String(a.AwardBatchId), Revision: Number(a.Revision) };
}

/** Sales: acknowledge the current revision (its rowVer proves Sales saw it). */
export async function acknowledge(db: Db, actor: Actor, commandId: string, ackId: string, rowVer: string, comment: string) {
  return runCommand(db, actor.id, commandId, 'ack.acknowledge', async (tx) => {
    const a = await lockAck(tx, actor, ackId, P_ACK);
    if (!['PENDING', 'QUERY_RAISED'].includes(a.Status)) throw new DomainError('BAD_STATE', 'Already acknowledged', 409);
    const to = a.HandedOffWithoutAck ? 'ACKNOWLEDGED_LATE' : 'ACKNOWLEDGED';
    await updateWithRowVer(tx, 'scm.SalesAck', 'AckId', ackId, rowVer, sql`Status = ${to}, RespondedBy = ${actor.id}, RespondedAt = SYSUTCDATETIME(), Comment = ${comment.trim() || null}`);
    await history(tx, ackId, a.Revision, a.Status, to, to === 'ACKNOWLEDGED_LATE' ? 'LATE' : 'ACKNOWLEDGED', actor.id, await awardSnapshot(tx, a.AwardBatchId), comment.trim() || null);
    await closeInbox(tx, 'ACK_PENDING', 'ACK', ackId, actor.id);
    await closeInbox(tx, 'ACK_QUERY', 'ACK', ackId, actor.id);
    const eventId = await recordEvent(tx, { type: 'AWARD_ACKNOWLEDGED', entityType: 'AWARD_BATCH', entityId: a.AwardBatchId, payload: { revision: a.Revision }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'AWARD_BATCH', entityId: a.AwardBatchId, kind: 'SYSTEM', body: `Acknowledged by Sales (revision ${a.Revision})${comment.trim() ? ` — ${comment.trim()}` : ''}`, authorUserId: actor.id, eventId });
    return { status: to };
  });
}

/** Sales: a question on the award (nothing is blocked); Procurement gets an exception. */
export async function raiseQuery(db: Db, actor: Actor, commandId: string, ackId: string, rowVer: string, comment: string) {
  if (!comment.trim()) throw new DomainError('COMMENT_REQUIRED', 'Write the question for Procurement');
  return runCommand(db, actor.id, commandId, 'ack.query', async (tx) => {
    const a = await lockAck(tx, actor, ackId, P_ACK);
    if (a.Status !== 'PENDING') throw new DomainError('BAD_STATE', a.Status === 'QUERY_RAISED' ? 'A query is already open — add to the comments' : 'Already acknowledged', 409);
    await updateWithRowVer(tx, 'scm.SalesAck', 'AckId', ackId, rowVer, sql`Status = 'QUERY_RAISED', RespondedBy = ${actor.id}, RespondedAt = SYSUTCDATETIME(), Comment = ${comment.trim()}`);
    await history(tx, ackId, a.Revision, a.Status, 'QUERY_RAISED', 'QUERY', actor.id, null, comment.trim());
    await closeInbox(tx, 'ACK_PENDING', 'ACK', ackId, actor.id);
    const b = await batchOf(tx, a.AwardBatchId);
    const eventId = await recordEvent(tx, { type: 'AWARD_QUERY', entityType: 'AWARD_BATCH', entityId: a.AwardBatchId, payload: { comment: comment.trim() }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'AWARD_BATCH', entityId: a.AwardBatchId, kind: 'CLARIFICATION', body: `Query: ${comment.trim()}`, authorUserId: actor.id, eventId });
    await openInbox(tx, {
      itemType: 'ACK_QUERY', permission: 'award.manage', companyCode: b.CompanyCode, entityType: 'ACK', entityId: ackId, number: b.AbNo,
      title: `${b.DemandNo} · Sales asks about ${b.AbNo}`, note: comment.trim().slice(0, 1000), link: `/awards/${b.AwardBatchId}`, raisedBy: actor.id, excludeUserId: actor.id,
    });
    return { status: 'QUERY_RAISED' };
  });
}

/** Procurement: the query is answered (in the comments); Sales is asked to acknowledge again. */
export async function answerQuery(db: Db, actor: Actor, commandId: string, ackId: string, rowVer: string, answer: string) {
  if (!answer.trim()) throw new DomainError('COMMENT_REQUIRED', 'Write the answer for Sales');
  return runCommand(db, actor.id, commandId, 'ack.answer', async (tx) => {
    const a = await lockAck(tx, actor, ackId, 'award.manage');
    if (a.Status !== 'QUERY_RAISED') throw new DomainError('BAD_STATE', 'There is no open query', 409);
    await updateWithRowVer(tx, 'scm.SalesAck', 'AckId', ackId, rowVer, sql`Status = 'PENDING', RespondedBy = NULL, RespondedAt = NULL`);
    await history(tx, ackId, a.Revision, 'QUERY_RAISED', 'PENDING', 'ANSWERED', actor.id, null, answer.trim());
    await closeInbox(tx, 'ACK_QUERY', 'ACK', ackId, actor.id);
    const eventId = await recordEvent(tx, { type: 'AWARD_QUERY_ANSWERED', entityType: 'AWARD_BATCH', entityId: a.AwardBatchId, payload: { answer: answer.trim() }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'AWARD_BATCH', entityId: a.AwardBatchId, kind: 'CLARIFICATION', body: `Answer: ${answer.trim()}`, authorUserId: actor.id, eventId });
    await askSales(tx, await batchOf(tx, a.AwardBatchId), ackId, a.Revision, actor.id);
    return { status: 'PENDING' };
  });
}
