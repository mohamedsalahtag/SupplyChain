/**
 * Award batches (spec 20, plan v5 §5.2): award quoted quantity to suppliers with a shipment per
 * supplier × week; un-award; SKU correction within the specification; shipment edits. Every
 * change is logged (AwardItemChange) and puts Sales' acknowledgement back to Pending.
 */
import { sql, type RawBuilder } from 'kysely';
import { skuForCriteria } from '../demand/lookups.js';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { eventSql, queueNotification, recordEvent } from '../workflow/events.js';
import { openInbox } from '../workflow/inbox.js';
import { formatQty, fromDb, parseQty, type Milli } from '../workflow/qty.js';
import { runSliceBatch, takeTransitionSql } from '../workflow/sliceBatch.js';
import { type SliceCtx } from '../workflow/slices.js';
import { addThreadEntry, threadEntrySql } from '../workflow/threads.js';
import { rowVerHex, updateWithRowVer, type Db, type Tx } from '../workflow/tx.js';
import { refreshHandoffTasks } from '../handoff/handoffService.js';
import { createAck, resetAck } from './ack.js';
import { checkAward, lineLabel, type AwardInput, type Checked } from './awardCheck.js';

export const P_AWARD = { open: 'awards.open', manage: 'award.manage' } as const;

export async function createAward(db: Db, actor: Actor, commandId: string, rfqId: string, rfqRowVer: string, input: AwardInput, dryRun = false) {
  return runCommand(db, actor.id, commandId, dryRun ? 'award.check' : 'award.create', async (tx) => {
    const rfq = (await sql<{ RfqId: string; RfqNo: string; DemandId: string; CompanyCode: string; ManualStatus: string }>`
      SELECT RfqId, RfqNo, DemandId, CompanyCode, ManualStatus FROM scm.Rfq WITH (UPDLOCK) WHERE RfqId = ${rfqId}`.execute(tx)).rows[0];
    if (!rfq || !actor.companies.has(rfq.CompanyCode)) throw new NotFoundError(`RFQ ${rfqId}`);
    assertCan(actor, P_AWARD.manage, rfq.CompanyCode);
    const r = { ...rfq, RfqId: String(rfq.RfqId), DemandId: String(rfq.DemandId) };
    const c = await checkAward(tx, r, input);
    if (dryRun) return { dryRun: true as const, problems: c.problems, warnings: c.warnings };
    if (c.problems.length) throw new DomainError('NOT_AWARDABLE', 'The award cannot be made', 422, { problems: c.problems });
    await updateWithRowVer(tx, 'scm.Rfq', 'RfqId', r.RfqId, rfqRowVer, sql`ManualStatus = ManualStatus`); // the quotes are what the buyer saw
    const { awardBatchId, abNo } = await writeAward(tx, actor, r, c, input, () => false);
    return { awardBatchId, abNo, warnings: c.warnings };
  });
}

type RfqRow = { RfqId: string; RfqNo: string; DemandId: string; CompanyCode: string };

/**
 * Writes a checked award: the batch, its items (price and currency copied from the quote), SKUs, the quantity
 * Quoted → Awarded, shipments, releases, Sales' acknowledgement. `byContainers` marks items worked out from containers.
 */
export async function writeAward(tx: Tx, actor: Actor, r: RfqRow, c: Checked, input: AwardInput, byContainers: (rfqLineId: string, supplierCode: string) => boolean) {
  // Round trips matter (the database may be far away): number + batch in one query, then the items in chunks of
  // CHUNK per query — each item's insert, SKU and slice moves as one set-based fragment (sliceBatch.ts).
  const head = (await sql<{ AwardBatchId: string; AbNo: string }>`SET NOCOUNT ON;
    DECLARE @n bigint = NEXT VALUE FOR scm.AwardNoSeq;
    DECLARE @no nvarchar(20) = CONCAT('AB-', CASE WHEN @n < 1000000 THEN RIGHT(CONCAT('000000', @n), 6) ELSE CAST(@n AS nvarchar(20)) END);
    INSERT INTO scm.AwardBatch (AbNo, RfqId, DemandId, CompanyCode, Comment, CreatedBy) VALUES (@no, ${r.RfqId}, ${r.DemandId}, ${r.CompanyCode}, ${input.comment.trim()}, ${actor.id});
    SELECT CAST(SCOPE_IDENTITY() AS nvarchar(20)) AS AwardBatchId, @no AS AbNo;`.execute(tx)).rows[0];
  const batchId = String(head.AwardBatchId);
  const abNo = head.AbNo;
  const ctx: SliceCtx = { actorUserId: actor.id, docType: 'AWARD_BATCH', docId: batchId };

  const parts: RawBuilder<unknown>[] = c.awards.map((a, i) => {
    const dl = a.line.DemandLineId!;
    const skuIsDemand = sql`dl.SpecMode = 'SKU' AND dl.MaterialCode IS NOT NULL`;
    return sql`DECLARE ${sql.raw(`@item${i}`)} bigint;
INSERT INTO scm.AwardItem (AwardBatchId, RfqLineId, SupplierCode, EtdWeek, LineKey, Qty, Unit, QuoteId, UnitPrice, Currency, OverrideReason, SkuStatus, ByContainers)
  SELECT ${batchId}, ${a.rfqLineId}, ${a.supplierCode}, ${a.line.ProposedEtdWeek}, ${a.line.LineKey}, ${a.milli}, ${a.line.Unit}, q.QuoteId, q.UnitPrice, q.Currency,
    ${a.overrideReason?.trim() || null}, CASE WHEN ${skuIsDemand} THEN 'RESOLVED_AT_DEMAND' WHEN q.QuotedSku IS NOT NULL THEN 'RESOLVED_AT_RFQ' ELSE 'PENDING' END,
    ${byContainers(a.rfqLineId, a.supplierCode) ? 1 : 0}
  FROM scm.SupplierQuote q JOIN scm.DemandLine dl ON dl.LineId = ${dl} WHERE q.QuoteId = ${a.quote.QuoteId};
SET ${sql.raw(`@item${i}`)} = SCOPE_IDENTITY();
INSERT INTO scm.AwardItemSku (AwardItemId, MaterialCode, Qty, SetStage, ChangeReason, SetBy)
  SELECT ${sql.raw(`@item${i}`)}, CASE WHEN ${skuIsDemand} THEN dl.MaterialCode ELSE q.QuotedSku END, ${a.milli}, CASE WHEN ${skuIsDemand} THEN 'DEMAND' ELSE 'RFQ' END, NULL, ${actor.id}
  FROM scm.SupplierQuote q JOIN scm.DemandLine dl ON dl.LineId = ${dl} WHERE q.QuoteId = ${a.quote.QuoteId} AND ((${skuIsDemand}) OR q.QuotedSku IS NOT NULL);
${takeTransitionSql(i, { lineId: dl, qty: a.milli, states: ['QUOTED'], where: sql`RfqLineId = ${a.rfqLineId}`, trigger: 'AWARD', ctx, extraSet: sql.raw(`AwardItemId = @item${i}`) })}`;
  });
  c.releases.forEach((rel, j) => parts.push(takeTransitionSql(c.awards.length + j, {
    lineId: rel.line.DemandLineId!, qty: rel.milli, states: ['QUOTED', 'IN_RFQ'], where: sql`RfqLineId = ${rel.rfqLineId}`, trigger: 'RELEASE', ctx: { ...ctx, reasonCode: rel.reasonCode }, extraSet: sql`RfqLineId = NULL`,
  })));
  const ships = [...new Set(c.awards.map((a) => `${a.supplierCode}|${a.line.ProposedEtdWeek}`))].map((k) => {
    const [supplier, week] = k.split('|');
    const sh = input.shipments.find((x) => x.supplierCode === supplier && x.etdWeek === week)!;
    return sql`(${batchId}, ${supplier}, ${week}, ${sh.containerCount}, ${sh.confirmedEtd || null}, ${actor.id})`;
  });
  if (ships.length) parts.push(sql`INSERT INTO scm.AwardShipment (AwardBatchId, SupplierCode, EtdWeek, ContainerCount, ConfirmedEtd, UpdatedBy) VALUES ${sql.join(ships)};`);
  for (let i = 0; i < parts.length; i += CHUNK) await runSliceBatch(tx, parts.slice(i, i + CHUNK));

  await createAck(tx, batchId, actor.id);
  const suppliers = [...new Set(c.awards.map((a) => a.supplierCode))].length;
  await sql`SET NOCOUNT ON;
${eventSql('ev', { type: 'AWARD_BATCH_CREATED', entityType: 'AWARD_BATCH', entityId: batchId, demandId: r.DemandId, payload: { abNo, items: c.awards.length }, actorUserId: actor.id })}
${threadEntrySql(1, { entityType: 'AWARD_BATCH', entityId: batchId, kind: 'SYSTEM', body: `Awarded from ${r.RfqNo}: ${c.awards.length} item(s), ${suppliers} supplier(s)`, authorUserId: actor.id }, 'ev')}
${threadEntrySql(2, { entityType: 'RFQ', entityId: r.RfqId, kind: 'SYSTEM', body: `${abNo}: ${c.awards.length} item(s) awarded`, authorUserId: actor.id }, 'ev')}
${threadEntrySql(3, { entityType: 'DEMAND', entityId: r.DemandId, kind: 'SYSTEM', body: `${abNo} awarded (${r.RfqNo})`, authorUserId: actor.id }, 'ev')}`.execute(tx);
  await refreshHandoffTasks(tx, batchId); // spec 22: "Hand off" per supplier on My work
  return { awardBatchId: batchId, abNo };
}

/** Award items per round trip (each ~25 parameters; SQL Server allows 2,100 per request). */
const CHUNK = 20;

/** Shrinks an award item: logged; inactive at 0; SKU allocation follows; a shipment with nothing left becomes inactive. */
export async function reduceAwardItem(tx: Tx, itemId: string, qty: Milli, type: 'UNAWARD_KEEP_QUOTES' | 'UNAWARD_RELEASE' | 'CANCELLED_BY_CR', reasonCode: string | null, crId: string | null, actorUserId: number) {
  await sql`UPDATE scm.AwardItem SET Qty = Qty - ${qty}, IsActive = CASE WHEN Qty - ${qty} = 0 THEN 0 ELSE 1 END WHERE AwardItemId = ${itemId}`.execute(tx);
  await tx.insertInto('scm.AwardItemChange').values({ AwardItemId: itemId, ChangeType: type, Qty: qty, ReasonCode: reasonCode, DetailJson: null, CrId: crId, ActorUserId: actorUserId }).execute();
  const it = await tx.selectFrom('scm.AwardItem').select(['AwardBatchId', 'SupplierCode', 'EtdWeek', 'Qty']).where('AwardItemId', '=', itemId).executeTakeFirstOrThrow();
  const allocs = await tx.selectFrom('scm.AwardItemSku').select('AllocId').where('AwardItemId', '=', itemId).where('IsActive', '=', true).execute();
  if (fromDb(it.Qty) === 0 || allocs.length > 1) { // several SKUs (split at PO) no longer add up: cleared, the PO team resolves again
    await tx.updateTable('scm.AwardItemSku').set({ IsActive: false }).where('AwardItemId', '=', itemId).where('IsActive', '=', true).execute();
    if (allocs.length > 1 && fromDb(it.Qty) > 0) await tx.updateTable('scm.AwardItem').set({ SkuStatus: 'PENDING' }).where('AwardItemId', '=', itemId).execute();
  } else if (allocs.length === 1) {
    await tx.updateTable('scm.AwardItemSku').set({ Qty: it.Qty }).where('AllocId', '=', allocs[0].AllocId).execute();
  }
  const left = await tx.selectFrom('scm.AwardItem').select('AwardItemId').where('AwardBatchId', '=', it.AwardBatchId).where('SupplierCode', '=', it.SupplierCode)
    .where('EtdWeek', '=', it.EtdWeek).where('IsActive', '=', true).executeTakeFirst();
  if (!left) await tx.updateTable('scm.AwardShipment').set({ IsActive: false }).where('AwardBatchId', '=', it.AwardBatchId).where('SupplierCode', '=', it.SupplierCode).where('EtdWeek', '=', it.EtdWeek).execute();
  return String(it.AwardBatchId);
}

export type LockedItem = Awaited<ReturnType<typeof lockItem>>;

/** Moves `take` of an award item's Awarded quantity back (keep the quotes → Quoted, or release → Open) and logs it. */
export async function unawardQty(tx: Tx, actor: Actor, i: LockedItem, take: Milli, mode: 'KEEP_QUOTES' | 'RELEASE', reasonCode: string, comment: string) {
  if (take <= 0) throw new DomainError('BAD_QTY', 'Un-award a quantity above zero');
  const ctx: SliceCtx = { actorUserId: actor.id, reasonCode, docType: 'AWARD_BATCH', docId: i.AwardBatchId, comment };
  await runSliceBatch(tx, [takeTransitionSql(0, { // handed off is not un-awardable: Awarded only
    lineId: i.DemandLineId, qty: take, states: ['AWARDED'], where: sql`AwardItemId = ${i.AwardItemId}`, ctx,
    trigger: mode === 'KEEP_QUOTES' ? 'UNAWARD_KEEP_QUOTES' : 'UNAWARD_RELEASE', extraSet: mode === 'KEEP_QUOTES' ? sql`AwardItemId = NULL` : sql`AwardItemId = NULL, RfqLineId = NULL`,
  })]);
  await reduceAwardItem(tx, i.AwardItemId, take, mode === 'KEEP_QUOTES' ? 'UNAWARD_KEEP_QUOTES' : 'UNAWARD_RELEASE', reasonCode, null, actor.id);
  const eventId = await recordEvent(tx, { type: 'AWARD_UNAWARDED', entityType: 'AWARD_BATCH', entityId: i.AwardBatchId, demandId: i.DemandId, payload: { itemId: i.AwardItemId, qty: formatQty(take), mode, reasonCode }, actorUserId: actor.id });
  await addThreadEntry(tx, { entityType: 'AWARD_BATCH', entityId: i.AwardBatchId, kind: 'SYSTEM', body: `Un-awarded ${formatQty(take)} (${mode === 'KEEP_QUOTES' ? 'quotes kept' : 'released'}, ${reasonCode})${comment ? ` — ${comment}` : ''}`, authorUserId: actor.id, eventId });
}

export async function lockItem(tx: Tx, actor: Actor, itemId: string) {
  const i = (await sql<{ AwardItemId: string; AwardBatchId: string; RfqLineId: string; DemandLineId: string; CompanyCode: string; Qty: string; SkuStatus: string; AbNo: string; DemandId: string; RowVer: string }>`
    SELECT i.AwardItemId, i.AwardBatchId, i.RfqLineId, l.DemandLineId, b.CompanyCode, i.Qty, i.SkuStatus, b.AbNo, b.DemandId, ${rowVerHex('i.RowVer')} AS RowVer
    FROM scm.AwardItem i WITH (UPDLOCK) JOIN scm.AwardBatch b ON b.AwardBatchId = i.AwardBatchId JOIN scm.RfqLine l ON l.RfqLineId = i.RfqLineId
    WHERE i.AwardItemId = ${itemId}`.execute(tx)).rows[0];
  if (!i || !actor.companies.has(i.CompanyCode)) throw new NotFoundError(`Award item ${itemId}`);
  assertCan(actor, P_AWARD.manage, i.CompanyCode);
  return { ...i, AwardItemId: String(i.AwardItemId), AwardBatchId: String(i.AwardBatchId), RfqLineId: String(i.RfqLineId), DemandLineId: String(i.DemandLineId), DemandId: String(i.DemandId) };
}

/** Un-award all or part of an item (Awarded only): keep the quotes (→ Quoted) or release (→ Open). */
export async function unaward(db: Db, actor: Actor, commandId: string, itemId: string, rowVer: string, qty: string | 'ALL', mode: 'KEEP_QUOTES' | 'RELEASE', reasonCode: string, comment: string) {
  return runCommand(db, actor.id, commandId, 'award.unaward', async (tx) => {
    const i = await lockItem(tx, actor, itemId);
    await updateWithRowVer(tx, 'scm.AwardItem', 'AwardItemId', itemId, rowVer, sql`IsActive = IsActive`);
    const reason = await tx.selectFrom('scm.ReasonCode').select('ReasonCode').where('ReasonCode', '=', reasonCode).where('Context', '=', 'UNAWARD').where('IsActive', '=', true).executeTakeFirst();
    if (!reason) throw new DomainError('BAD_REASON', 'Choose an un-award reason');
    const take = qty === 'ALL' ? fromDb(i.Qty) : parseQty(qty, 1000);
    await unawardQty(tx, actor, i, take, mode, reasonCode, comment);
    await resetAck(tx, i.AwardBatchId, 'RESET_UNAWARD', actor.id);
    await refreshHandoffTasks(tx, i.AwardBatchId);
    return { unawarded: formatQty(take) };
  });
}

/** Another SKU of the same specification for an Awarded item (reason required). */
export async function correctSku(db: Db, actor: Actor, commandId: string, itemId: string, rowVer: string, materialCode: string, reason: string) {
  if (!reason.trim()) throw new DomainError('REASON_REQUIRED', 'A reason is required');
  return runCommand(db, actor.id, commandId, 'award.sku', async (tx) => {
    const i = await lockItem(tx, actor, itemId);
    const later = await tx.selectFrom('scm.QtySlice').select('SliceId').where('AwardItemId', '=', itemId).where('ExecState', 'not in', ['AWARDED', 'CANCELLED']).executeTakeFirst();
    if (later) throw new DomainError('BAD_STATE', 'The SKU can be corrected only before handoff', 409);
    if (fromDb(i.Qty) === 0) throw new DomainError('BAD_STATE', 'Nothing is awarded on this item any more', 409);
    const l = await tx.selectFrom('scm.RfqLine').select(['MajorCategory', 'SubMajorCategory', 'Size', 'MaterialClass', 'OriginCode', 'Unit']).where('RfqLineId', '=', i.RfqLineId).executeTakeFirstOrThrow();
    if (!(await skuForCriteria(tx, materialCode, { majorCategory: l.MajorCategory, subMajorCategory: l.SubMajorCategory, size: l.Size, materialClass: l.MaterialClass, originCode: l.OriginCode, unit: l.Unit }))) {
      throw new DomainError('SKU_MISMATCH', `${materialCode} is not a material of this specification (${lineLabel({ ...l, MaterialCode: null })} ${l.OriginCode}, ${l.Unit})`);
    }
    await updateWithRowVer(tx, 'scm.AwardItem', 'AwardItemId', itemId, rowVer, sql`SkuStatus = 'RESOLVED_AT_RFQ'`);
    await tx.updateTable('scm.AwardItemSku').set({ IsActive: false }).where('AwardItemId', '=', itemId).where('IsActive', '=', true).execute();
    await tx.insertInto('scm.AwardItemSku').values({ AwardItemId: itemId, MaterialCode: materialCode, Qty: i.Qty, SetStage: 'RFQ', ChangeReason: reason.trim(), SetBy: actor.id }).execute();
    await tx.insertInto('scm.AwardItemChange').values({ AwardItemId: itemId, ChangeType: 'SKU_CORRECTED', Qty: null, ReasonCode: null, DetailJson: JSON.stringify({ from: i.SkuStatus, to: materialCode, reason: reason.trim() }), CrId: null, ActorUserId: actor.id }).execute();
    if (i.SkuStatus === 'RESOLVED_AT_DEMAND') { // the demand's own SKU was replaced: Sales is told
      const owner = await tx.selectFrom('scm.Demand').select('CreatedBy').where('DemandId', '=', i.DemandId).executeTakeFirstOrThrow();
      await queueNotification(tx, { type: 'DEMAND_SKU_REPLACED', userId: Number(owner.CreatedBy), entityType: 'AWARD_ITEM', entityId: itemId, payload: { materialCode } });
    }
    const eventId = await recordEvent(tx, { type: 'AWARD_SKU_CORRECTED', entityType: 'AWARD_BATCH', entityId: i.AwardBatchId, demandId: i.DemandId, payload: { itemId, materialCode }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'AWARD_BATCH', entityId: i.AwardBatchId, kind: 'SYSTEM', body: `SKU set to ${materialCode} — ${reason.trim()}`, authorUserId: actor.id, eventId });
    await resetAck(tx, i.AwardBatchId, 'RESET_SKU', actor.id);
    return { sku: materialCode };
  });
}

/** Containers and confirmed ETD of a shipment, while its quantity is Awarded (before handoff). */
export async function updateShipment(db: Db, actor: Actor, commandId: string, shipmentId: string, rowVer: string, containerCount: number, confirmedEtd: string | null) {
  if (!Number.isInteger(containerCount) || containerCount < 1) throw new DomainError('BAD_CONTAINERS', 'A shipment has at least 1 container');
  if (confirmedEtd && Number.isNaN(new Date(`${confirmedEtd}T00:00:00Z`).getTime())) throw new DomainError('BAD_DATE', 'The confirmed ETD is not a date');
  return runCommand(db, actor.id, commandId, 'award.shipment', async (tx) => {
    const sh = await tx.selectFrom('scm.AwardShipment as s').innerJoin('scm.AwardBatch as b', 'b.AwardBatchId', 's.AwardBatchId')
      .select(['s.AwardBatchId', 's.SupplierCode', 's.EtdWeek', 's.IsActive', 'b.CompanyCode', 'b.DemandId']).where('s.ShipmentId', '=', shipmentId).executeTakeFirst();
    if (!sh || !actor.companies.has(sh.CompanyCode)) throw new NotFoundError(`Shipment ${shipmentId}`);
    assertCan(actor, P_AWARD.manage, sh.CompanyCode);
    if (!sh.IsActive) throw new DomainError('BAD_STATE', 'Nothing is awarded on this shipment any more', 409);
    const later = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM scm.QtySlice s JOIN scm.AwardItem i ON i.AwardItemId = s.AwardItemId
      WHERE i.AwardBatchId = ${sh.AwardBatchId} AND i.SupplierCode = ${sh.SupplierCode} AND i.EtdWeek = ${sh.EtdWeek} AND s.ExecState NOT IN ('AWARDED', 'CANCELLED')`.execute(tx);
    if (Number(later.rows[0].n) > 0) throw new DomainError('BAD_STATE', 'The shipment is handed off; it can change only after a return', 409);
    const before = await tx.selectFrom('scm.AwardShipment').select(['ContainerCount', 'ConfirmedEtd']).where('ShipmentId', '=', shipmentId).executeTakeFirstOrThrow();
    await updateWithRowVer(tx, 'scm.AwardShipment', 'ShipmentId', shipmentId, rowVer, sql`ContainerCount = ${containerCount}, ConfirmedEtd = ${confirmedEtd || null}, UpdatedBy = ${actor.id}, UpdatedAt = SYSUTCDATETIME()`);
    // Spec 22: entering the confirmed ETD for the first time is expected work before the handoff — Sales is not asked again for it.
    const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    const firstEtdOnly = before.ContainerCount === containerCount && !before.ConfirmedEtd && !!confirmedEtd;
    const changed = before.ContainerCount !== containerCount || day(before.ConfirmedEtd) !== (confirmedEtd || null);
    const eventId = await recordEvent(tx, { type: 'AWARD_SHIPMENT_CHANGED', entityType: 'AWARD_BATCH', entityId: String(sh.AwardBatchId), demandId: String(sh.DemandId), payload: { shipmentId, containerCount, confirmedEtd }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'AWARD_BATCH', entityId: String(sh.AwardBatchId), kind: 'SYSTEM', body: `Shipment ${sh.SupplierCode} · ${sh.EtdWeek}: ${containerCount} container(s)${confirmedEtd ? `, ETD ${confirmedEtd}` : ''}`, authorUserId: actor.id, eventId });
    if (changed && !firstEtdOnly) await resetAck(tx, String(sh.AwardBatchId), 'RESET_SHIPMENT', actor.id);
    return { saved: true };
  });
}

/**
 * Called when a change request cancels Awarded quantity (Stage 2 rule 9): the award items shrink,
 * Procurement gets "Tell the supplier" on My work, Sales' acknowledgement goes back to Pending.
 */
export async function onAwardedCancelled(tx: Tx, cancelled: { awardItemId: string; qty: Milli }[], crId: string, crNo: string, actorUserId: number): Promise<void> {
  const byItem = new Map<string, Milli>();
  for (const c of cancelled) byItem.set(c.awardItemId, (byItem.get(c.awardItemId) ?? 0) + c.qty);
  const batches = new Set<string>();
  for (const [itemId, qty] of byItem) {
    const batchId = await reduceAwardItem(tx, itemId, qty, 'CANCELLED_BY_CR', null, crId, actorUserId);
    batches.add(batchId);
    const i = await tx.selectFrom('scm.AwardItem as i').innerJoin('scm.AwardBatch as b', 'b.AwardBatchId', 'i.AwardBatchId').innerJoin('md.Supplier as s', 's.SupplierCode', 'i.SupplierCode')
      .select(['i.SupplierCode', 's.Name', 'i.EtdWeek', 'i.Unit', 'b.AbNo', 'b.CompanyCode']).where('i.AwardItemId', '=', itemId).executeTakeFirstOrThrow();
    await openInbox(tx, {
      itemType: 'SUPPLIER_CHANGE', permission: P_AWARD.manage, companyCode: i.CompanyCode, entityType: 'AWARD_ITEM', entityId: itemId, number: i.AbNo,
      title: `Tell ${i.Name}: ${formatQty(qty).replace(/\.000$/, '')} ${i.Unit} less for ${i.EtdWeek}`, note: `Cancelled by ${crNo}`, link: `/awards/${batchId}`, raisedBy: actorUserId,
    });
  }
  for (const b of batches) { await resetAck(tx, b, 'RESET_CANCEL', actorUserId); await refreshHandoffTasks(tx, b); }
}
