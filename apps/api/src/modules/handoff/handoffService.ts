/**
 * Stage 6 commands (spec 22): shipping terms, hand off one supplier's award (one handoff = one future PO),
 * accept / return by the PO team, automatic return when a change request cancels handed-off quantity,
 * and the My work items that go with them.
 */
import { sql } from 'kysely';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { eventSql } from '../workflow/events.js';
import { closeInbox, openInbox } from '../workflow/inbox.js';
import { moveSlicesSql, runSliceBatch } from '../workflow/sliceBatch.js';
import type { SliceCtx } from '../workflow/slices.js';
import { threadEntrySql } from '../workflow/threads.js';
import { updateWithRowVer, type Db, type Tx } from '../workflow/tx.js';
import { draftBlocksReturn, voidOpenDrafts } from '../po/poService.js';
import { awardCurrency, buildSnapshot, readiness, termsFor, type Terms } from './handoffData.js';

export const P_HANDOFF = { open: 'handoffs.open', send: 'handoff.send', accept: 'handoff.accept', return: 'handoff.return' } as const;
const key = (batchId: string, supplier: string) => `${batchId}|${supplier}`;

type Batch = { AwardBatchId: string; AbNo: string; RfqNo: string; DemandId: string; DemandNo: string; CompanyCode: string };
async function batchOf(tx: Db | Tx, actor: Actor, batchId: string, lock = false): Promise<Batch> {
  const b = (await sql<Batch>`
    SELECT b.AwardBatchId, b.AbNo, r.RfqNo, b.DemandId, d.DemandNo, b.CompanyCode
    FROM scm.AwardBatch b ${lock ? sql`WITH (UPDLOCK)` : sql``} JOIN scm.Rfq r ON r.RfqId = b.RfqId JOIN scm.Demand d ON d.DemandId = b.DemandId
    WHERE b.AwardBatchId = ${batchId}`.execute(tx)).rows[0];
  if (!b || !actor.companies.has(b.CompanyCode)) throw new NotFoundError(`Award ${batchId}`);
  return { ...b, AwardBatchId: String(b.AwardBatchId), DemandId: String(b.DemandId) };
}
const openHandoff = (tx: Db | Tx, batchId: string, supplier: string) =>
  tx.selectFrom('scm.Handoff').select(['HandoffId', 'HoNo', 'Status']).where('AwardBatchId', '=', batchId).where('SupplierCode', '=', supplier).where('Status', 'in', ['HANDED_OFF', 'ACCEPTED']).executeTakeFirst();

/**
 * My work "Hand off" (Procurement): open for each supplier of the batch with Awarded quantity, no open handoff
 * and no returned-handoff exception already asking for the same thing; closed otherwise.
 */
export async function refreshHandoffTasks(tx: Tx, batchId: string): Promise<void> {
  const rows = (await sql<{ SupplierCode: string; Name: string; AbNo: string; CompanyCode: string; Awarded: string; OpenHo: number; Returned: number }>`
    SELECT i.SupplierCode, sp.Name, b.AbNo, b.CompanyCode,
      SUM(CASE WHEN s.ExecState = 'AWARDED' THEN s.Qty ELSE 0 END) AS Awarded,
      (SELECT COUNT(*) FROM scm.Handoff h WHERE h.AwardBatchId = b.AwardBatchId AND h.SupplierCode = i.SupplierCode AND h.Status IN ('HANDED_OFF', 'ACCEPTED')) AS OpenHo,
      (SELECT COUNT(*) FROM scm.InboxItem x WHERE x.IsOpen = 1 AND x.ItemType IN ('HANDOFF_RETURNED', 'HANDOFF_AUTO_RETURNED') AND x.EntityType = 'AWARD_SUPPLIER'
         AND x.EntityId = CONCAT(b.AwardBatchId, '|', i.SupplierCode)) AS Returned
    FROM scm.AwardItem i JOIN scm.AwardBatch b ON b.AwardBatchId = i.AwardBatchId JOIN md.Supplier sp ON sp.SupplierCode = i.SupplierCode
    LEFT JOIN scm.QtySlice s ON s.AwardItemId = i.AwardItemId
    WHERE i.AwardBatchId = ${batchId}
    GROUP BY i.SupplierCode, sp.Name, b.AbNo, b.CompanyCode, b.AwardBatchId`.execute(tx)).rows;
  for (const r of rows) {
    const k = key(batchId, r.SupplierCode);
    if (Number(r.Awarded) > 0 && !Number(r.OpenHo) && !Number(r.Returned)) {
      await openInbox(tx, {
        itemType: 'HANDOFF_READY', permission: P_HANDOFF.send, companyCode: r.CompanyCode, entityType: 'AWARD_SUPPLIER', entityId: k, number: r.AbNo,
        title: `Hand off ${r.AbNo} · ${r.Name}`, note: 'Complete the shipping terms and the confirmed ETD, then hand off to the PO team', link: `/awards/${batchId}?tab=handoff`, raisedBy: null,
      });
    } else await closeInbox(tx, 'HANDOFF_READY', 'AWARD_SUPPLIER', k, null);
  }
}

/** Save the shipping terms of one supplier of an award (any time before it is handed off). */
export async function saveTerms(db: Db, actor: Actor, commandId: string, batchId: string, supplierCode: string, t: Omit<Terms, 'currency'>) {
  return runCommand(db, actor.id, commandId, 'handoff.terms', async (tx) => {
    const b = await batchOf(tx, actor, batchId, true);
    assertCan(actor, P_HANDOFF.send, b.CompanyCode);
    if (await openHandoff(tx, batchId, supplierCode)) throw new DomainError('BAD_STATE', 'Already handed off — the PO team must return it before the terms can change', 409);
    const problems: string[] = [];
    if (t.incoterm && !(await tx.selectFrom('scm.Incoterm').select('Code').where('Code', '=', t.incoterm).where('IsActive', '=', true).executeTakeFirst())) problems.push(`Incoterm ${t.incoterm} is not in the list`);
    for (const [id, what, not] of [[t.portOfLoadingId, 'Port of loading', 'DISCHARGE'], [t.portOfDischargeId, 'Port of discharge', 'LOADING']] as const) {
      if (id && !(await tx.selectFrom('scm.Port').select('PortId').where('PortId', '=', id).where('IsActive', '=', true).where('UsedFor', '!=', not).executeTakeFirst())) problems.push(`${what} is not in the list`);
    }
    if (t.paymentTerms && !(await tx.selectFrom('scm.PaymentTerm').select('Code').where('Code', '=', t.paymentTerms).where('IsActive', '=', true).executeTakeFirst())) problems.push(`Payment terms ${t.paymentTerms} are not in the list`);
    if (problems.length) throw new DomainError('BAD_TERMS', 'The shipping terms cannot be saved', 422, { problems });
    const currency = await awardCurrency(tx, batchId, supplierCode);
    await sql`MERGE scm.ShippingTerms AS t USING (SELECT ${batchId} AS AwardBatchId, ${supplierCode} AS SupplierCode) AS s
      ON t.AwardBatchId = s.AwardBatchId AND t.SupplierCode = s.SupplierCode
      WHEN MATCHED THEN UPDATE SET Incoterm = ${t.incoterm}, PortOfLoadingId = ${t.portOfLoadingId}, PortOfDischargeId = ${t.portOfDischargeId}, PaymentTerms = ${t.paymentTerms},
        Currency = ${currency}, UpdatedBy = ${actor.id}, UpdatedAt = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (AwardBatchId, SupplierCode, Incoterm, PortOfLoadingId, PortOfDischargeId, PaymentTerms, Currency, UpdatedBy, UpdatedAt)
        VALUES (${batchId}, ${supplierCode}, ${t.incoterm}, ${t.portOfLoadingId}, ${t.portOfDischargeId}, ${t.paymentTerms}, ${currency}, ${actor.id}, SYSUTCDATETIME());`.execute(tx);
    return { saved: true };
  });
}

/** Hand off one supplier of an award to the PO team. Without Sales' acknowledgement only with `confirmWithoutAck` and a reason. */
export async function sendHandoff(db: Db, actor: Actor, commandId: string, batchId: string, supplierCode: string,
  opts: { confirmWithoutAck?: boolean; reasonCode?: string | null; comment?: string | null } = {}) {
  return runCommand(db, actor.id, commandId, 'handoff.send', async (tx) => {
    const b = await batchOf(tx, actor, batchId, true);
    assertCan(actor, P_HANDOFF.send, b.CompanyCode);
    if (await openHandoff(tx, batchId, supplierCode)) throw new DomainError('BAD_STATE', 'This supplier is already handed off', 409);
    const { terms } = await termsFor(tx, batchId, supplierCode, b.CompanyCode);
    const r = await readiness(tx, b, supplierCode, terms);
    if (!r.ready) throw new DomainError('NOT_READY', 'Not ready to hand off', 422, { problems: r.checks.filter((c) => !c.ok && !c.warning).map((c) => `${c.label}${c.detail ? ` — ${c.detail}` : ''}`) });
    if (r.ackMissing) {
      if (!opts.confirmWithoutAck) throw new DomainError('ACK_MISSING', `Sales has not acknowledged ${b.AbNo}`, 409);
      const reason = await tx.selectFrom('scm.ReasonCode').select('ReasonCode').where('ReasonCode', '=', opts.reasonCode ?? '').where('Context', '=', 'PROCEED_NO_ACK').where('IsActive', '=', true).executeTakeFirst();
      if (!reason) throw new DomainError('BAD_REASON', 'Choose why you hand off without Sales’ acknowledgement');
      if (opts.reasonCode === 'OTHER_NO_ACK' && !opts.comment?.trim()) throw new DomainError('COMMENT_REQUIRED', 'Explain in the comment');
    }
    // The saved terms are what goes out (the defaults are stored now if they were never saved).
    const currency = await awardCurrency(tx, batchId, supplierCode);
    const t = { ...terms, currency };
    const snapshot = await buildSnapshot(tx, b, supplierCode, t);
    const head = (await sql<{ HandoffId: string; HoNo: string }>`SET NOCOUNT ON;
      DECLARE @n bigint = NEXT VALUE FOR scm.HandoffNoSeq;
      DECLARE @no nvarchar(20) = CONCAT('HO-', CASE WHEN @n < 1000000 THEN RIGHT(CONCAT('000000', @n), 6) ELSE CAST(@n AS nvarchar(20)) END);
      INSERT INTO scm.Handoff (HoNo, AwardBatchId, SupplierCode, CompanyCode, Status, HandedOffQty, SnapshotJson, SentBy, SentWithoutAck, ProceedReason, ProceedComment, AckRevision)
        VALUES (@no, ${batchId}, ${supplierCode}, ${b.CompanyCode}, 'HANDED_OFF', ${r.awarded}, ${JSON.stringify(snapshot)}, ${actor.id}, ${r.ackMissing ? 1 : 0},
          ${r.ackMissing ? opts.reasonCode ?? null : null}, ${r.ackMissing ? opts.comment?.trim() || null : null}, ${r.ackRevision});
      SELECT CAST(SCOPE_IDENTITY() AS nvarchar(20)) AS HandoffId, @no AS HoNo;`.execute(tx)).rows[0];
    const hoId = String(head.HandoffId);
    const ctx: SliceCtx = { actorUserId: actor.id, docType: 'HANDOFF', docId: hoId };
    const name = snapshot.supplier.name;
    await runSliceBatch(tx, [
      sql`MERGE scm.ShippingTerms AS x USING (SELECT ${batchId} AS AwardBatchId, ${supplierCode} AS SupplierCode) AS s ON x.AwardBatchId = s.AwardBatchId AND x.SupplierCode = s.SupplierCode
        WHEN NOT MATCHED THEN INSERT (AwardBatchId, SupplierCode, Incoterm, PortOfLoadingId, PortOfDischargeId, PaymentTerms, Currency, UpdatedBy, UpdatedAt)
        VALUES (${batchId}, ${supplierCode}, ${t.incoterm}, ${t.portOfLoadingId}, ${t.portOfDischargeId}, ${t.paymentTerms}, ${currency}, ${actor.id}, SYSUTCDATETIME());`,
      moveSlicesSql(0, {
        from: sql`FROM scm.QtySlice s WITH (UPDLOCK, ROWLOCK) JOIN scm.AwardItem i ON i.AwardItemId = s.AwardItemId`,
        where: sql`i.AwardBatchId = ${batchId} AND i.SupplierCode = ${supplierCode}`, states: ['AWARDED'], trigger: 'HANDOFF_SEND', ctx, extraSet: sql`HandoffId = ${hoId}`,
      }),
      r.ackMissing ? sql`UPDATE scm.SalesAck SET HandedOffWithoutAck = 1 WHERE AwardBatchId = ${batchId};` : sql``,
      eventSql('ev', { type: r.ackMissing ? 'HANDOFF_SENT_WITHOUT_ACK' : 'HANDOFF_SENT', entityType: 'HANDOFF', entityId: hoId, demandId: b.DemandId, payload: { hoNo: head.HoNo, abNo: b.AbNo, supplierCode, reasonCode: opts.reasonCode ?? null }, actorUserId: actor.id }),
      threadEntrySql(1, { entityType: 'AWARD_BATCH', entityId: batchId, kind: 'SYSTEM', authorUserId: actor.id,
        body: `${head.HoNo} (${name}) handed off to the PO team${r.ackMissing ? ` WITHOUT Sales acknowledgement (${opts.reasonCode}${opts.comment?.trim() ? `: ${opts.comment.trim()}` : ''})` : ''}` }, 'ev'),
      threadEntrySql(2, { entityType: 'HANDOFF', entityId: hoId, kind: 'SYSTEM', authorUserId: actor.id, body: `Handed off by Procurement (${b.AbNo}, ${name})` }, 'ev'),
    ]);
    await closeInbox(tx, 'HANDOFF_READY', 'AWARD_SUPPLIER', key(batchId, supplierCode), actor.id);
    await closeInbox(tx, 'HANDOFF_RETURNED', 'AWARD_SUPPLIER', key(batchId, supplierCode), actor.id);
    await closeInbox(tx, 'HANDOFF_AUTO_RETURNED', 'AWARD_SUPPLIER', key(batchId, supplierCode), actor.id);
    await openInbox(tx, {
      itemType: 'HANDOFF_TO_ACCEPT', permission: P_HANDOFF.accept, companyCode: b.CompanyCode, entityType: 'HANDOFF', entityId: hoId, number: head.HoNo,
      title: `Accept ${head.HoNo} · ${name}`, note: `${snapshot.shipments.map((s) => `${s.containers} container(s) ${s.week}`).join(', ')}${r.ackMissing ? ' · without Sales acknowledgement' : ''}`,
      link: `/handoffs/${hoId}`, raisedBy: actor.id,
    });
    return { handoffId: hoId, hoNo: head.HoNo, sentWithoutAck: r.ackMissing };
  });
}

type HandoffRow = { HandoffId: string; HoNo: string; AwardBatchId: string; SupplierCode: string; CompanyCode: string; Status: string; DemandId: string; AbNo: string };
async function lockHandoff(tx: Tx, handoffId: string) {
  const h = (await sql<HandoffRow>`
    SELECT h.HandoffId, h.HoNo, h.AwardBatchId, h.SupplierCode, h.CompanyCode, h.Status, b.DemandId, b.AbNo
    FROM scm.Handoff h WITH (UPDLOCK) JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId WHERE h.HandoffId = ${handoffId}`.execute(tx)).rows[0];
  return h ? { ...h, HandoffId: String(h.HandoffId), AwardBatchId: String(h.AwardBatchId), DemandId: String(h.DemandId) } : null;
}

/** The PO team accepts: the quantity moves to PO preparation (Stage 7). */
export async function acceptHandoff(db: Db, actor: Actor, commandId: string, handoffId: string, rowVer: string) {
  return runCommand(db, actor.id, commandId, 'handoff.accept', async (tx) => {
    const h = await lockHandoff(tx, handoffId);
    if (!h || !actor.companies.has(h.CompanyCode)) throw new NotFoundError(`Handoff ${handoffId}`);
    assertCan(actor, P_HANDOFF.accept, h.CompanyCode);
    if (h.Status !== 'HANDED_OFF') throw new DomainError('BAD_STATE', 'Only a handoff waiting for the PO team can be accepted', 409);
    // Separation of duties: whoever handed it off does not accept it (administrators excepted).
    const sent = await tx.selectFrom('scm.Handoff').select('SentBy').where('HandoffId', '=', handoffId).executeTakeFirstOrThrow();
    if (!actor.isAdmin && Number(sent.SentBy) === actor.id) throw new DomainError('OWN_HANDOFF', 'You handed this off, so someone else in the PO team must accept it', 403);
    await updateWithRowVer(tx, 'scm.Handoff', 'HandoffId', handoffId, rowVer, sql`Status = 'ACCEPTED', AcceptedBy = ${actor.id}, AcceptedAt = SYSUTCDATETIME()`);
    await runSliceBatch(tx, [
      moveSlicesSql(0, { from: sql`FROM scm.QtySlice s WITH (UPDLOCK, ROWLOCK)`, where: sql`s.HandoffId = ${handoffId}`, states: ['HANDED_OFF'], trigger: 'HANDOFF_ACCEPT', ctx: { actorUserId: actor.id, docType: 'HANDOFF', docId: handoffId } }),
      eventSql('ev', { type: 'HANDOFF_ACCEPTED', entityType: 'HANDOFF', entityId: handoffId, demandId: h.DemandId, payload: { hoNo: h.HoNo, abNo: h.AbNo }, actorUserId: actor.id }),
      threadEntrySql(1, { entityType: 'AWARD_BATCH', entityId: h.AwardBatchId, kind: 'SYSTEM', authorUserId: actor.id, body: `${h.HoNo} accepted by the PO team` }, 'ev'),
      threadEntrySql(2, { entityType: 'HANDOFF', entityId: handoffId, kind: 'SYSTEM', authorUserId: actor.id, body: 'Accepted by the PO team — the PO is prepared next' }, 'ev'),
    ]);
    await closeInbox(tx, 'HANDOFF_TO_ACCEPT', 'HANDOFF', handoffId, actor.id);
    await openInbox(tx, { // spec 23: the PO team prepares the PO
      itemType: 'PO_TO_PREPARE', permission: 'po.manage', companyCode: h.CompanyCode, entityType: 'HANDOFF', entityId: handoffId, number: h.HoNo,
      title: `Prepare the PO for ${h.HoNo}`, note: 'Select the missing SKUs, build the PO draft, validate and submit it to SAP', link: `/handoffs/${handoffId}`, raisedBy: actor.id,
    });
    return { accepted: true };
  });
}

/**
 * Returns a handoff: its quantity goes back to Awarded (terms, shipments and SKU editable again) and Procurement gets
 * an exception on My work. By the PO team (reason + comment), or automatically (actor null) when a change request
 * cancels handed-off quantity. Stage 7 adds: not after the PO is submitted; an unsubmitted PO draft is voided.
 */
export async function returnHandoffTx(tx: Tx, actorUserId: number, byPoTeam: boolean, h: HandoffRow, reasonCode: string, comment: string, crId: string | null) {
  if (!['HANDED_OFF', 'ACCEPTED'].includes(h.Status)) throw new DomainError('BAD_STATE', 'This handoff is not open', 409);
  const blocked = await draftBlocksReturn(tx, h.HandoffId); // spec 23: not once the PO is submitted
  if (blocked) throw new DomainError('PO_SUBMITTED', `It can no longer be returned: ${blocked}`, 409);
  await voidOpenDrafts(tx, h.HandoffId);
  await closeInbox(tx, 'PO_TO_PREPARE', 'HANDOFF', h.HandoffId, null);
  const auto = !byPoTeam;
  const ctx: SliceCtx = { actorUserId, reasonCode, docType: 'HANDOFF', docId: h.HandoffId, comment };
  const name = (await tx.selectFrom('md.Supplier').select('Name').where('SupplierCode', '=', h.SupplierCode).executeTakeFirst())?.Name ?? h.SupplierCode;
  await runSliceBatch(tx, [
    moveSlicesSql(0, { from: sql`FROM scm.QtySlice s WITH (UPDLOCK, ROWLOCK)`, where: sql`s.HandoffId = ${h.HandoffId}`, states: ['HANDED_OFF', 'PO_PREPARATION'], trigger: 'HANDOFF_RETURN', ctx, extraSet: sql`HandoffId = NULL` }),
    sql`UPDATE scm.Handoff SET Status = 'RETURNED', ReturnedBy = ${auto ? null : actorUserId}, ReturnedAt = SYSUTCDATETIME(), ReturnedFrom = Status,
      ReturnReason = ${reasonCode}, ReturnComment = ${comment}, ReturnCrId = ${crId} WHERE HandoffId = ${h.HandoffId};`,
    eventSql('ev', { type: auto ? 'HANDOFF_AUTO_RETURNED' : 'HANDOFF_RETURNED', entityType: 'HANDOFF', entityId: h.HandoffId, demandId: h.DemandId, payload: { hoNo: h.HoNo, abNo: h.AbNo, reasonCode, comment }, actorUserId: auto ? null : actorUserId }),
    threadEntrySql(1, { entityType: 'AWARD_BATCH', entityId: h.AwardBatchId, kind: 'CLARIFICATION', authorUserId: auto ? null : actorUserId, body: `${h.HoNo} (${name}) returned${auto ? ' automatically' : ' by the PO team'} (${reasonCode}): ${comment}` }, 'ev'),
    threadEntrySql(2, { entityType: 'HANDOFF', entityId: h.HandoffId, kind: 'CLARIFICATION', authorUserId: auto ? null : actorUserId, body: `Returned${auto ? ' automatically' : ''} (${reasonCode}): ${comment}` }, 'ev'),
  ]);
  await closeInbox(tx, 'HANDOFF_TO_ACCEPT', 'HANDOFF', h.HandoffId, auto ? null : actorUserId);
  await openInbox(tx, {
    itemType: auto ? 'HANDOFF_AUTO_RETURNED' : 'HANDOFF_RETURNED', permission: P_HANDOFF.send, companyCode: h.CompanyCode, entityType: 'AWARD_SUPPLIER', entityId: key(h.AwardBatchId, h.SupplierCode),
    number: h.HoNo, title: `${h.HoNo} returned · ${name}`, note: auto ? 'Quantity changed by a change request — reconfirm the containers and ETD, then hand off again' : `${reasonCode}: ${comment}`,
    link: `/awards/${h.AwardBatchId}?tab=handoff`, raisedBy: auto ? null : actorUserId,
  });
  await closeInbox(tx, 'HANDOFF_READY', 'AWARD_SUPPLIER', key(h.AwardBatchId, h.SupplierCode), null);
}

export async function returnHandoff(db: Db, actor: Actor, commandId: string, handoffId: string, rowVer: string, reasonCode: string, comment: string) {
  if (!comment.trim()) throw new DomainError('COMMENT_REQUIRED', 'Say what Procurement must fix');
  return runCommand(db, actor.id, commandId, 'handoff.return', async (tx) => {
    const h = await lockHandoff(tx, handoffId);
    if (!h || !actor.companies.has(h.CompanyCode)) throw new NotFoundError(`Handoff ${handoffId}`);
    assertCan(actor, P_HANDOFF.return, h.CompanyCode);
    const reason = await tx.selectFrom('scm.ReasonCode').select('ReasonCode').where('ReasonCode', '=', reasonCode).where('Context', '=', 'HANDOFF_RETURN').where('IsActive', '=', true).executeTakeFirst();
    if (!reason) throw new DomainError('BAD_REASON', 'Choose a return reason');
    await updateWithRowVer(tx, 'scm.Handoff', 'HandoffId', handoffId, rowVer, sql`Status = Status`);
    await returnHandoffTx(tx, actor.id, true, h, reasonCode, comment.trim(), null);
    return { returned: true };
  });
}

/**
 * Called by change-request apply before it cancels quantity of a line: every open handoff holding handed-off or
 * accepted quantity of that line is returned automatically (CR_CHANGE), so the cancellation takes Awarded quantity.
 */
export async function autoReturnForLine(tx: Tx, lineId: string, crId: string, crNo: string, actorUserId: number): Promise<number> {
  const ids = (await sql<{ HandoffId: string }>`SELECT DISTINCT HandoffId FROM scm.QtySlice WHERE LineId = ${lineId} AND HandoffId IS NOT NULL AND ExecState IN ('HANDED_OFF', 'PO_PREPARATION')`.execute(tx)).rows;
  for (const { HandoffId } of ids) {
    const h = await lockHandoff(tx, String(HandoffId));
    if (h && ['HANDED_OFF', 'ACCEPTED'].includes(h.Status)) await returnHandoffTx(tx, actorUserId, false, h, 'CR_CHANGE', `Quantity changed by ${crNo}`, crId);
  }
  return ids.length;
}
