/**
 * Stage 7 (spec 23): the PO team executes what Procurement sent — SKU selection only where none was provided,
 * one PO draft per accepted handoff (all weeks), validation (again at submit), submission to the SAP outbox with a
 * frozen payload, and the manual resolution of an unknown SAP outcome.
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { skusForSpec } from '../demand/lookups.js';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { eventSql, recordEvent } from '../workflow/events.js';
import { closeInbox, openInbox } from '../workflow/inbox.js';
import { lastSuccessfulSyncs, staleSources, vendorProblems } from '../workflow/masterData.js';
import { formatQty, fromDb, parseQty, type Milli } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import { moveSlicesSql, runSliceBatch } from '../workflow/sliceBatch.js';
import { threadEntrySql } from '../workflow/threads.js';
import { updateWithRowVer, type Db, type Tx } from '../workflow/tx.js';
import type { Snapshot } from '../handoff/handoffData.js';
import type { SapPoAdapter } from './sapAdapter.js';

export const P_PO = { open: 'po.open', manage: 'po.manage' } as const;

// ───────────────────────── SKU selection ─────────────────────────

type ItemRow = {
  AwardItemId: string; AwardBatchId: string; CompanyCode: string; DemandId: string; Qty: string; Unit: string; SkuStatus: string; HandoffId: string | null; HoStatus: string | null;
  MajorCategory: string; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string; InPrep: number;
};
async function lockItem(tx: Tx, actor: Actor, awardItemId: string): Promise<ItemRow> {
  const i = (await sql<ItemRow>`
    SELECT i.AwardItemId, i.AwardBatchId, b.CompanyCode, b.DemandId, i.Qty, i.Unit, i.SkuStatus, h.HandoffId, h.Status AS HoStatus,
      l.MajorCategory, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode,
      (SELECT COUNT(*) FROM scm.QtySlice s WHERE s.AwardItemId = i.AwardItemId AND s.ExecState = 'PO_PREPARATION') AS InPrep
    FROM scm.AwardItem i WITH (UPDLOCK) JOIN scm.AwardBatch b ON b.AwardBatchId = i.AwardBatchId JOIN scm.RfqLine l ON l.RfqLineId = i.RfqLineId
    OUTER APPLY (SELECT TOP 1 s.HandoffId FROM scm.QtySlice s WHERE s.AwardItemId = i.AwardItemId AND s.HandoffId IS NOT NULL) x
    LEFT JOIN scm.Handoff h ON h.HandoffId = x.HandoffId
    WHERE i.AwardItemId = ${awardItemId}`.execute(tx)).rows[0];
  if (!i || !actor.companies.has(i.CompanyCode)) throw new NotFoundError(`Award item ${awardItemId}`);
  assertCan(actor, P_PO.manage, i.CompanyCode);
  return { ...i, AwardItemId: String(i.AwardItemId), AwardBatchId: String(i.AwardBatchId), DemandId: String(i.DemandId), HandoffId: i.HandoffId ? String(i.HandoffId) : null };
}

/** SKUs that may be picked: same category, sub-category, size, class, origin, base unit (in SAP, usable). */
export const candidateSkus = (db: Db | Tx, i: Pick<ItemRow, 'MajorCategory' | 'SubMajorCategory' | 'Size' | 'MaterialClass' | 'OriginCode' | 'Unit'>) =>
  skusForSpec(db, { majorCategory: i.MajorCategory, subMajorCategory: i.SubMajorCategory, size: i.Size, materialClass: i.MaterialClass, originCode: i.OriginCode, unit: i.Unit });

/** Unsubmitted drafts of a handoff are voided (they are rebuilt after a change). */
export const voidOpenDrafts = (tx: Tx, handoffId: string) =>
  sql`UPDATE scm.PoDraft SET Status = 'VOID' WHERE HandoffId = ${handoffId} AND Status IN ('DRAFT', 'VALIDATED')`.execute(tx);
/** A handoff cannot be returned once its PO is submitted (or created, or its outcome is unknown). */
export async function draftBlocksReturn(tx: Tx | Db, handoffId: string): Promise<string | null> {
  const d = await tx.selectFrom('scm.PoDraft').select(['PoDraftNo', 'Status']).where('HandoffId', '=', handoffId).where('Status', 'in', ['SUBMITTED', 'UNKNOWN', 'CREATED']).executeTakeFirst();
  return d ? `${d.PoDraftNo} is ${d.Status.toLowerCase()} in SAP` : null;
}

/** The PO team's only change: SKU(s) for an item whose SKU was not provided; quantities must add up exactly. */
export async function selectSkus(db: Db, actor: Actor, commandId: string, awardItemId: string, allocations: { materialCode: string; qty: string }[]) {
  return runCommand(db, actor.id, commandId, 'po.selectSkus', async (tx) => {
    const i = await lockItem(tx, actor, awardItemId);
    if (!i.InPrep || i.HoStatus !== 'ACCEPTED') throw new DomainError('BAD_STATE', 'SKUs are selected only while the PO is prepared (handoff accepted)', 409);
    if (!['PENDING', 'RESOLVED_AT_PO'].includes(i.SkuStatus)) throw new DomainError('SKU_PROVIDED', 'The SKU was provided by Sales or Procurement — return the handoff (SKU issue) if it is wrong', 409);
    const parts = allocations.map((a) => ({ code: a.materialCode.trim(), qty: parseQty(a.qty, 1000) as Milli })).filter((a) => a.qty > 0);
    const total = parts.reduce((s, a) => s + a.qty, 0);
    if (total !== fromDb(i.Qty)) throw new DomainError('QTY_MISMATCH', `The SKU quantities (${formatQty(total)}) must equal the awarded quantity (${formatQty(fromDb(i.Qty))})`);
    if (new Set(parts.map((p) => p.code)).size !== parts.length) throw new DomainError('DUPLICATE_SKU', 'Each SKU once');
    const valid = new Set((await candidateSkus(tx, i)).map((m) => m.MaterialCode));
    const invalid = parts.filter((p) => !valid.has(p.code)).map((p) => p.code);
    if (invalid.length) throw new DomainError('INVALID_SKU', `Not a material of this specification, origin and unit: ${invalid.join(', ')}`);
    await sql`UPDATE scm.AwardItem SET SkuStatus = 'RESOLVED_AT_PO' WHERE AwardItemId = ${awardItemId}`.execute(tx);
    await sql`UPDATE scm.AwardItemSku SET IsActive = 0 WHERE AwardItemId = ${awardItemId} AND IsActive = 1`.execute(tx);
    for (const p of parts) await tx.insertInto('scm.AwardItemSku').values({ AwardItemId: awardItemId, MaterialCode: p.code, Qty: p.qty, SetStage: 'PO', ChangeReason: null, SetBy: actor.id }).execute();
    if (i.HandoffId) await voidOpenDrafts(tx, i.HandoffId); // a draft built before this selection is rebuilt
    await recordEvent(tx, { type: 'SKU_SELECTED_AT_PO', entityType: 'AWARD_ITEM', entityId: awardItemId, demandId: i.DemandId, payload: { allocations: parts.map((p) => ({ code: p.code, qty: formatQty(p.qty) })) }, actorUserId: actor.id });
    return { saved: true };
  });
}

/** No SKU exists in SAP yet: the item waits (PENDING_MASTER_DATA) and a request is tracked. */
export async function markMasterDataMissing(db: Db, actor: Actor, commandId: string, awardItemId: string, note: string) {
  if (!note.trim()) throw new DomainError('NOTE_REQUIRED', 'Say which material must be created in SAP');
  return runCommand(db, actor.id, commandId, 'po.mdr', async (tx) => {
    const i = await lockItem(tx, actor, awardItemId);
    if (i.SkuStatus !== 'PENDING') throw new DomainError('BAD_STATE', 'Only an item still waiting for its SKU', 409);
    await sql`UPDATE scm.AwardItem SET SkuStatus = 'PENDING_MASTER_DATA' WHERE AwardItemId = ${awardItemId}`.execute(tx);
    const mdr = await tx.insertInto('scm.MasterDataRequest').values({ AwardItemId: awardItemId, Note: note.trim(), CreatedBy: actor.id, ClosedBy: null, ClosedAt: null }).output('inserted.MdrId').executeTakeFirstOrThrow();
    await openInbox(tx, {
      itemType: 'MASTER_DATA_MISSING', permission: P_PO.manage, companyCode: i.CompanyCode, entityType: 'MDR', entityId: String(mdr.MdrId), number: `MDR-${mdr.MdrId}`,
      title: `Material missing in SAP · ${i.SubMajorCategory} ${i.Size} ${i.MaterialClass} ${i.OriginCode}`, note: note.trim(), link: i.HandoffId ? `/handoffs/${i.HandoffId}` : '/po-drafts?tab=mdr', raisedBy: actor.id,
    });
    return { mdrId: String(mdr.MdrId) };
  });
}

/** The material now exists in SAP: the item goes back to waiting for its SKU. */
export async function closeMasterDataRequest(db: Db, actor: Actor, commandId: string, mdrId: string) {
  return runCommand(db, actor.id, commandId, 'po.mdrClose', async (tx) => {
    const m = await tx.selectFrom('scm.MasterDataRequest').select(['AwardItemId', 'Status']).where('MdrId', '=', mdrId).executeTakeFirst();
    if (!m) throw new NotFoundError(`Request ${mdrId}`);
    await lockItem(tx, actor, String(m.AwardItemId));
    if (m.Status !== 'OPEN') throw new DomainError('BAD_STATE', 'Already closed', 409);
    await sql`UPDATE scm.MasterDataRequest SET Status = 'DONE', ClosedBy = ${actor.id}, ClosedAt = SYSUTCDATETIME() WHERE MdrId = ${mdrId}`.execute(tx);
    await sql`UPDATE scm.AwardItem SET SkuStatus = 'PENDING' WHERE AwardItemId = ${String(m.AwardItemId)} AND SkuStatus = 'PENDING_MASTER_DATA'`.execute(tx);
    await closeInbox(tx, 'MASTER_DATA_MISSING', 'MDR', mdrId, actor.id);
    return { closed: true };
  });
}

// ───────────────────────── PO drafts ─────────────────────────

type HandoffRow = { HandoffId: string; HoNo: string; AwardBatchId: string; SupplierCode: string; CompanyCode: string; Status: string; SnapshotJson: string; DemandId: string };

/** One PO draft per accepted handoff: all its weeks; header from the handoff's terms; containers = its active shipments. */
export async function buildDraft(db: Db, actor: Actor, commandId: string, handoffId: string) {
  return runCommand(db, actor.id, commandId, 'po.build', async (tx) => {
    const h = (await sql<HandoffRow>`SELECT h.HandoffId, h.HoNo, h.AwardBatchId, h.SupplierCode, h.CompanyCode, h.Status, h.SnapshotJson, b.DemandId
      FROM scm.Handoff h WITH (UPDLOCK) JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId WHERE h.HandoffId = ${handoffId}`.execute(tx)).rows[0];
    if (!h || !actor.companies.has(h.CompanyCode)) throw new NotFoundError(`Handoff ${handoffId}`);
    assertCan(actor, P_PO.manage, h.CompanyCode);
    if (h.Status !== 'ACCEPTED') throw new DomainError('BAD_STATE', 'Accept the handoff first', 409);
    const live = await tx.selectFrom('scm.PoDraft').select('PoDraftNo').where('HandoffId', '=', handoffId).where('Status', 'in', ['DRAFT', 'VALIDATED', 'SUBMITTED', 'UNKNOWN', 'CREATED']).executeTakeFirst();
    if (live) throw new DomainError('DRAFT_EXISTS', `${live.PoDraftNo} already exists for this handoff`, 409);
    const pending = (await sql<{ Label: string }>`SELECT CONCAT(l.SubMajorCategory, ' ', l.Size, ' ', l.MaterialClass, ' · ', i.EtdWeek) AS Label
      FROM scm.AwardItem i JOIN scm.RfqLine l ON l.RfqLineId = i.RfqLineId
      WHERE i.AwardBatchId = ${String(h.AwardBatchId)} AND i.SupplierCode = ${h.SupplierCode} AND i.IsActive = 1 AND i.SkuStatus IN ('PENDING', 'PENDING_MASTER_DATA')`.execute(tx)).rows;
    if (pending.length) throw new DomainError('SKU_PENDING', 'Select the SKUs first', 422, { problems: pending.map((p) => `${p.Label}: SKU not selected`) });
    const t = (JSON.parse(h.SnapshotJson) as Snapshot).terms;
    const co = await tx.selectFrom('scm.Company').select(['DefaultPlant', 'PurchasingOrg', 'PurchasingGroup']).where('CompanyCode', '=', h.CompanyCode).executeTakeFirstOrThrow();
    const head = (await sql<{ PoDraftId: string; PoDraftNo: string }>`SET NOCOUNT ON;
      DECLARE @n bigint = NEXT VALUE FOR scm.PoDraftNoSeq;
      DECLARE @no nvarchar(20) = CONCAT('POD-', CASE WHEN @n < 1000000 THEN RIGHT(CONCAT('000000', @n), 6) ELSE CAST(@n AS nvarchar(20)) END);
      DECLARE @boxes int = (SELECT SUM(ContainerCount) FROM scm.AwardShipment WHERE AwardBatchId = ${String(h.AwardBatchId)} AND SupplierCode = ${h.SupplierCode} AND IsActive = 1);
      INSERT INTO scm.PoDraft (PoDraftNo, HandoffId, CompanyCode, SupplierCode, Plant, PurchasingOrg, PurchasingGroup, Incoterm, PortOfLoading, PortOfDischarge, PaymentTerms, Currency, ContainerCount, CreatedBy)
        VALUES (@no, ${handoffId}, ${h.CompanyCode}, ${h.SupplierCode}, ${co.DefaultPlant}, ${co.PurchasingOrg}, ${co.PurchasingGroup}, ${t.incoterm ?? ''}, ${t.portOfLoading ?? ''}, ${t.portOfDischarge ?? ''}, ${t.paymentTerms ?? ''}, ${t.currency ?? ''}, @boxes, ${actor.id});
      DECLARE @d bigint = SCOPE_IDENTITY();
      INSERT INTO scm.PoDraftItem (PoDraftId, ItemNo, AwardItemId, AllocId, DemandId, DemandLineId, MaterialCode, Qty, Unit, UnitPrice, Currency, EtdWeek, ConfirmedEtd)
        SELECT @d, 10 * ROW_NUMBER() OVER (ORDER BY i.EtdWeek, i.AwardItemId, a.AllocId), i.AwardItemId, a.AllocId, b.DemandId, rl.DemandLineId, a.MaterialCode, a.Qty, i.Unit,
          i.UnitPrice, i.Currency, i.EtdWeek, sh.ConfirmedEtd
        FROM scm.AwardItem i JOIN scm.AwardBatch b ON b.AwardBatchId = i.AwardBatchId JOIN scm.RfqLine rl ON rl.RfqLineId = i.RfqLineId
        JOIN scm.AwardItemSku a ON a.AwardItemId = i.AwardItemId AND a.IsActive = 1
        JOIN scm.AwardShipment sh ON sh.AwardBatchId = i.AwardBatchId AND sh.SupplierCode = i.SupplierCode AND sh.EtdWeek = i.EtdWeek AND sh.IsActive = 1
        WHERE i.AwardBatchId = ${String(h.AwardBatchId)} AND i.SupplierCode = ${h.SupplierCode} AND i.IsActive = 1;
      SELECT CAST(@d AS nvarchar(20)) AS PoDraftId, @no AS PoDraftNo;`.execute(tx)).rows[0];
    // a rebuilt PO replaces a rejected one: its "not created in SAP" item is done
    for (const x of await tx.selectFrom('scm.PoDraft').select('PoDraftId').where('HandoffId', '=', handoffId).where('Status', '=', 'REJECTED').execute()) {
      await closeInbox(tx, 'SAP_REJECTED', 'PO_DRAFT', String(x.PoDraftId), actor.id);
    }
    await sql`SET NOCOUNT ON;
${eventSql('ev', { type: 'PO_DRAFT_BUILT', entityType: 'PO_DRAFT', entityId: head.PoDraftId, demandId: String(h.DemandId), payload: { poDraftNo: head.PoDraftNo, hoNo: h.HoNo }, actorUserId: actor.id })}
${threadEntrySql(1, { entityType: 'HANDOFF', entityId: handoffId, kind: 'SYSTEM', authorUserId: actor.id, body: `${head.PoDraftNo} built by the PO team` }, 'ev')}`.execute(tx);
    return { poDraftId: String(head.PoDraftId), poDraftNo: head.PoDraftNo };
  });
}

type DraftRow = { PoDraftId: string; PoDraftNo: string; HandoffId: string; CompanyCode: string; SupplierCode: string; Currency: string; ContainerCount: number; Status: string; AwardBatchId: string; DemandId: string };
async function lockDraft(tx: Tx, actor: Actor, draftId: string): Promise<DraftRow> {
  const d = (await sql<DraftRow>`SELECT d.PoDraftId, d.PoDraftNo, d.HandoffId, d.CompanyCode, d.SupplierCode, d.Currency, d.ContainerCount, d.Status, h.AwardBatchId, b.DemandId
    FROM scm.PoDraft d WITH (UPDLOCK) JOIN scm.Handoff h ON h.HandoffId = d.HandoffId JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId WHERE d.PoDraftId = ${draftId}`.execute(tx)).rows[0];
  if (!d || !actor.companies.has(d.CompanyCode)) throw new NotFoundError(`PO draft ${draftId}`);
  assertCan(actor, P_PO.manage, d.CompanyCode);
  return { ...d, PoDraftId: String(d.PoDraftId), HandoffId: String(d.HandoffId), AwardBatchId: String(d.AwardBatchId), DemandId: String(d.DemandId) };
}

/** Plan §7 rule 7 — checked at Validate and again at Submit (master data may have changed in between). */
export async function draftProblems(tx: Tx | Db, d: DraftRow): Promise<string[]> {
  const p: string[] = [];
  const vendor = (await vendorProblems(tx, [d.SupplierCode], d.CompanyCode)).get(d.SupplierCode);
  if (vendor) p.push(vendor.message);
  const items = await sql<{ ItemNo: number; MaterialCode: string; Unit: string; Currency: string; InSap: boolean | null; BaseUnit: string | null; AllocActive: boolean | null; HoldCrNo: string | null }>`
    SELECT i.ItemNo, i.MaterialCode, i.Unit, i.Currency, m.InSap, m.BaseUnit, a.IsActive AS AllocActive, hc.CrNo AS HoldCrNo
    FROM scm.PoDraftItem i LEFT JOIN md.Material m ON m.MaterialCode = i.MaterialCode LEFT JOIN scm.AwardItemSku a ON a.AllocId = i.AllocId
    LEFT JOIN scm.DemandLine l ON l.LineId = i.DemandLineId LEFT JOIN scm.ChangeRequest hc ON hc.CrId = l.ChangeHoldCrId
    WHERE i.PoDraftId = ${d.PoDraftId} ORDER BY i.ItemNo`.execute(tx);
  if (!items.rows.length) p.push('The draft has no items');
  for (const it of items.rows) {
    if (!it.InSap) p.push(`Item ${it.ItemNo}: SKU ${it.MaterialCode} is not active in SAP`);
    else if (it.BaseUnit !== it.Unit) p.push(`Item ${it.ItemNo}: SKU ${it.MaterialCode} is in ${it.BaseUnit}, the line in ${it.Unit}`);
    if (it.Currency !== d.Currency) p.push(`Item ${it.ItemNo}: currency ${it.Currency} differs from the PO currency ${d.Currency}`);
    if (!it.AllocActive) p.push(`Item ${it.ItemNo}: the SKU selection changed since the draft was built — build a new draft`);
    if (it.HoldCrNo) p.push(`Item ${it.ItemNo}: on hold by ${it.HoldCrNo}`);
  }
  const perItem = await sql<{ AwardItemId: string; Awarded: string; InDraft: string; SkuStatus: string }>`
    SELECT i.AwardItemId, i.Qty AS Awarded, ISNULL((SELECT SUM(x.Qty) FROM scm.PoDraftItem x WHERE x.PoDraftId = ${d.PoDraftId} AND x.AwardItemId = i.AwardItemId), 0) AS InDraft, i.SkuStatus
    FROM scm.AwardItem i WHERE i.AwardBatchId = ${d.AwardBatchId} AND i.SupplierCode = ${d.SupplierCode} AND i.IsActive = 1`.execute(tx);
  for (const r of perItem.rows) {
    if (['PENDING', 'PENDING_MASTER_DATA'].includes(r.SkuStatus)) p.push('A material still waits for its SKU');
    if (fromDb(r.Awarded) !== fromDb(r.InDraft)) p.push(`The draft has ${formatQty(fromDb(r.InDraft))} of an awarded ${formatQty(fromDb(r.Awarded))} — build a new draft`);
  }
  const boxes = (await sql<{ n: number | null }>`SELECT SUM(ContainerCount) AS n FROM scm.AwardShipment WHERE AwardBatchId = ${d.AwardBatchId} AND SupplierCode = ${d.SupplierCode} AND IsActive = 1`.execute(tx)).rows[0].n;
  if (Number(boxes ?? 0) !== d.ContainerCount) p.push(`Containers: the draft has ${d.ContainerCount}, the shipments now ${boxes ?? 0} — build a new draft`);
  const stale = staleSources(await lastSuccessfulSyncs(tx), (await loadWfSettings(tx)).masterDataMaxAgeHours, new Date());
  if (stale.length) p.push(`SAP data is too old (${stale.join(', ')}) — run the sync first`);
  return [...new Set(p)];
}

export async function validateDraft(db: Db, actor: Actor, commandId: string, draftId: string, rowVer: string) {
  return runCommand(db, actor.id, commandId, 'po.validate', async (tx) => {
    const d = await lockDraft(tx, actor, draftId);
    if (!['DRAFT', 'VALIDATED'].includes(d.Status)) throw new DomainError('BAD_STATE', 'Only a draft can be validated', 409);
    const problems = await draftProblems(tx, d);
    await updateWithRowVer(tx, 'scm.PoDraft', 'PoDraftId', draftId, rowVer,
      problems.length ? sql`Status = 'DRAFT', ValidatedAt = NULL, LastError = ${problems.join('\n')}` : sql`Status = 'VALIDATED', ValidatedAt = SYSUTCDATETIME(), LastError = NULL`);
    return { problems };
  });
}

/** The exact message SAP gets (the ZCON field mapping comes with the real adapter, Stage 9). */
async function buildPayload(tx: Tx, draftId: string) {
  const d = await tx.selectFrom('scm.PoDraft').selectAll().where('PoDraftId', '=', draftId).executeTakeFirstOrThrow();
  const items = await tx.selectFrom('scm.PoDraftItem').select(['ItemNo', 'MaterialCode', 'Qty', 'Unit', 'UnitPrice', 'Currency', 'EtdWeek', 'ConfirmedEtd']).where('PoDraftId', '=', draftId).orderBy('ItemNo').execute();
  return {
    reference: d.PoDraftNo,
    header: { supplier: d.SupplierCode, companyCode: d.CompanyCode, plant: d.Plant, purchasingOrg: d.PurchasingOrg, purchasingGroup: d.PurchasingGroup,
      incoterm: d.Incoterm, portOfLoading: d.PortOfLoading, portOfDischarge: d.PortOfDischarge, paymentTerms: d.PaymentTerms, currency: d.Currency, containers: d.ContainerCount },
    items: items.map((i) => ({ itemNo: i.ItemNo, material: i.MaterialCode, qty: formatQty(fromDb(i.Qty)), unit: i.Unit, price: Number(i.UnitPrice).toFixed(4), currency: i.Currency,
      etdWeek: i.EtdWeek, confirmedEtd: new Date(i.ConfirmedEtd).toISOString().slice(0, 10) })),
  };
}
export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Freeze the payload (hash + one idempotency key) and hand it to the SAP outbox; the quantity becomes PO submitted. */
export async function submitDraft(db: Db, actor: Actor, commandId: string, draftId: string, rowVer: string) {
  return runCommand(db, actor.id, commandId, 'po.submit', async (tx) => {
    // Handoff first (the order a return takes): a return and a submit of the same handoff never interleave.
    await sql`SELECT h.HandoffId FROM scm.Handoff h WITH (UPDLOCK, ROWLOCK) JOIN scm.PoDraft d ON d.HandoffId = h.HandoffId WHERE d.PoDraftId = ${draftId}`.execute(tx);
    const d = await lockDraft(tx, actor, draftId);
    if (d.Status !== 'VALIDATED') throw new DomainError('BAD_STATE', 'Validate the draft first', 409);
    const problems = await draftProblems(tx, d);
    if (problems.length) throw new DomainError('REVALIDATION_FAILED', 'The draft is no longer valid', 422, { problems });
    const json = JSON.stringify(await buildPayload(tx, draftId));
    await updateWithRowVer(tx, 'scm.PoDraft', 'PoDraftId', draftId, rowVer, sql`Status = 'SUBMITTED', SubmittedBy = ${actor.id}, SubmittedAt = SYSUTCDATETIME(), LastError = NULL`);
    await tx.insertInto('scm.SapSubmission').values({ PoDraftId: draftId, IdempotencyKey: randomUUID(), Reference: d.PoDraftNo, PayloadJson: json, PayloadSha256: sha256(json), ClaimedBy: null, LeaseUntil: null }).execute();
    await runSliceBatch(tx, [
      moveSlicesSql(0, { from: sql`FROM scm.QtySlice s WITH (UPDLOCK, ROWLOCK)`, where: sql`s.HandoffId = ${d.HandoffId}`, states: ['PO_PREPARATION'], trigger: 'PO_SUBMIT', ctx: { actorUserId: actor.id, docType: 'PO_DRAFT', docId: draftId } }),
      eventSql('ev', { type: 'PO_SUBMITTED', entityType: 'PO_DRAFT', entityId: draftId, demandId: d.DemandId, payload: { poDraftNo: d.PoDraftNo }, actorUserId: actor.id }),
      threadEntrySql(1, { entityType: 'PO_DRAFT', entityId: draftId, kind: 'SYSTEM', authorUserId: actor.id, body: `Submitted to SAP (reference ${d.PoDraftNo})` }, 'ev'),
    ]);
    await closeInbox(tx, 'PO_TO_PREPARE', 'HANDOFF', d.HandoffId, actor.id);
    return { submitted: true };
  });
}

// ───────────────────────── outcomes (shared with the outbox) ─────────────────────────

/** SAP created the PO: the draft is CREATED and its quantity PO created. */
export async function markCreated(tx: Tx, draftId: string, poNumber: string, resolution: 'SAP_REPLY' | 'RECONCILED' | 'MANUAL_CREATED', actorUserId: number | null) {
  const d = await tx.selectFrom('scm.PoDraft as d').innerJoin('scm.Handoff as h', 'h.HandoffId', 'd.HandoffId').innerJoin('scm.AwardBatch as b', 'b.AwardBatchId', 'h.AwardBatchId')
    .select(['d.PoDraftNo', 'd.HandoffId', 'b.DemandId']).where('d.PoDraftId', '=', draftId).executeTakeFirstOrThrow();
  // Only an open outcome can be settled: a late reply for a draft already settled changes nothing (the caller raises it).
  const upd = await tx.updateTable('scm.PoDraft').set({ Status: 'CREATED', SapPoNumber: poNumber, SapCreatedAt: sql`SYSUTCDATETIME()`, Resolution: resolution, LastError: null })
    .where('PoDraftId', '=', draftId).where('Status', 'in', ['SUBMITTED', 'UNKNOWN']).executeTakeFirst();
  if (Number(upd.numUpdatedRows) === 0) return false;
  await sql`UPDATE scm.SapSubmission SET Status = 'CREATED', ClaimedBy = NULL, LeaseUntil = NULL WHERE PoDraftId = ${draftId}`.execute(tx);
  await runSliceBatch(tx, [
    moveSlicesSql(0, { from: sql`FROM scm.QtySlice s WITH (UPDLOCK, ROWLOCK)`, where: sql`s.HandoffId = ${String(d.HandoffId)}`, states: ['PO_SUBMITTED'], trigger: 'SAP_CONFIRMED', ctx: { actorUserId, docType: 'PO_DRAFT', docId: draftId } }),
    eventSql('ev', { type: 'PO_CREATED', entityType: 'PO_DRAFT', entityId: draftId, demandId: String(d.DemandId), payload: { poDraftNo: d.PoDraftNo, poNumber, resolution }, actorUserId }),
    threadEntrySql(1, { entityType: 'PO_DRAFT', entityId: draftId, kind: 'SYSTEM', authorUserId: actorUserId, body: `SAP PO ${poNumber} created (${resolution.toLowerCase().replace(/_/g, ' ')})` }, 'ev'),
    threadEntrySql(2, { entityType: 'DEMAND', entityId: String(d.DemandId), kind: 'SYSTEM', authorUserId: actorUserId, body: `SAP PO ${poNumber} created (${d.PoDraftNo})` }, 'ev'),
  ]);
  for (const t of ['SAP_UNKNOWN', 'SAP_REJECTED']) await closeInbox(tx, t, 'PO_DRAFT', draftId, actorUserId);
  return true;
}

/** SAP refused the PO (or it was confirmed not created): quantity back to PO preparation; the team fixes and rebuilds. */
export async function markRejected(tx: Tx, draftId: string, errors: string[], resolution: 'MANUAL_NOT_CREATED' | null, actorUserId: number | null) {
  const d = await tx.selectFrom('scm.PoDraft as d').innerJoin('scm.Handoff as h', 'h.HandoffId', 'd.HandoffId').innerJoin('scm.AwardBatch as b', 'b.AwardBatchId', 'h.AwardBatchId')
    .select(['d.PoDraftNo', 'd.HandoffId', 'd.CompanyCode', 'd.SupplierCode', 'b.DemandId']).where('d.PoDraftId', '=', draftId).executeTakeFirstOrThrow();
  const upd = await tx.updateTable('scm.PoDraft').set({ Status: 'REJECTED', Resolution: resolution, LastError: errors.join('\n') })
    .where('PoDraftId', '=', draftId).where('Status', 'in', ['SUBMITTED', 'UNKNOWN']).executeTakeFirst();
  if (Number(upd.numUpdatedRows) === 0) return false;
  await sql`UPDATE scm.SapSubmission SET Status = 'REJECTED', ClaimedBy = NULL, LeaseUntil = NULL WHERE PoDraftId = ${draftId}`.execute(tx);
  await runSliceBatch(tx, [
    moveSlicesSql(0, { from: sql`FROM scm.QtySlice s WITH (UPDLOCK, ROWLOCK)`, where: sql`s.HandoffId = ${String(d.HandoffId)}`, states: ['PO_SUBMITTED'], trigger: 'SAP_REJECTED', ctx: { actorUserId, docType: 'PO_DRAFT', docId: draftId, comment: errors.join('; ').slice(0, 2000) } }),
    eventSql('ev', { type: 'PO_REJECTED', entityType: 'PO_DRAFT', entityId: draftId, demandId: String(d.DemandId), payload: { poDraftNo: d.PoDraftNo, errors, resolution }, actorUserId }),
    threadEntrySql(1, { entityType: 'PO_DRAFT', entityId: draftId, kind: 'SYSTEM', authorUserId: actorUserId, body: `${resolution ? 'Confirmed not created in SAP' : 'Rejected by SAP'}: ${errors.join('; ')}` }, 'ev'),
  ]);
  await closeInbox(tx, 'SAP_UNKNOWN', 'PO_DRAFT', draftId, actorUserId);
  await openInbox(tx, {
    itemType: 'SAP_REJECTED', permission: P_PO.manage, companyCode: d.CompanyCode, entityType: 'PO_DRAFT', entityId: draftId, number: d.PoDraftNo,
    title: `${d.PoDraftNo} not created in SAP`, note: errors.join('; ').slice(0, 500), link: `/po-drafts/${draftId}`, raisedBy: actorUserId,
  });
  return true;
}

/** An unknown outcome the outbox could not settle: the PO team decides, with evidence attached; SAP is asked first when reachable. */
export async function resolveUnknown(db: Db, actor: Actor, adapter: SapPoAdapter, commandId: string, draftId: string, rowVer: string,
  r: { outcome: 'CREATED'; sapPoNumber: string } | { outcome: 'NOT_CREATED' }, comment: string) {
  if (!comment.trim()) throw new DomainError('COMMENT_REQUIRED', 'Explain how you checked SAP');
  // Ask SAP before the transaction: an external call never runs under a lock or inside a deadlock retry.
  const ref = await db.selectFrom('scm.PoDraft').select('PoDraftNo').where('PoDraftId', '=', draftId).executeTakeFirst();
  const look = ref ? await adapter.findPoByReference(ref.PoDraftNo).catch((e: unknown) => ({ kind: 'UNKNOWN' as const, detail: e instanceof Error ? e.message : String(e) })) : null;
  return runCommand(db, actor.id, commandId, 'po.resolve', async (tx) => {
    const d = await lockDraft(tx, actor, draftId);
    if (d.Status !== 'UNKNOWN' || !look) throw new DomainError('BAD_STATE', 'Only an unknown outcome can be resolved', 409);
    // Evidence must be uploaded after the draft was first sent: an older file proves nothing about this outcome.
    const evidence = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM scm.Attachment a WHERE a.EntityType = 'PO_DRAFT' AND a.EntityId = ${draftId}
      AND a.UploadedAt >= ISNULL((SELECT MIN(x.StartedAt) FROM scm.SapSubmissionAttempt x JOIN scm.SapSubmission s ON s.SubmissionId = x.SubmissionId WHERE s.PoDraftId = ${draftId}), '19000101')`.execute(tx);
    if (!Number(evidence.rows[0].n)) throw new DomainError('EVIDENCE_REQUIRED', 'Attach the evidence (e.g. a screenshot of SAP) first');
    await updateWithRowVer(tx, 'scm.PoDraft', 'PoDraftId', draftId, rowVer, sql`Status = Status`);
    if (r.outcome === 'CREATED') {
      const po = r.sapPoNumber.trim();
      if (!/^[0-9A-Z-]{4,20}$/i.test(po)) throw new DomainError('BAD_PO', 'Enter the SAP PO number');
      if (look.kind === 'FOUND' && look.poNumber !== po) throw new DomainError('PO_MISMATCH', `SAP has ${look.poNumber} for ${d.PoDraftNo}, not ${po}`);
      if (look.kind === 'NOT_FOUND') throw new DomainError('PO_NOT_FOUND', `SAP has no PO with the reference ${d.PoDraftNo}`);
      await markCreated(tx, draftId, po, 'MANUAL_CREATED', actor.id);
    } else {
      if (look.kind === 'FOUND') throw new DomainError('PO_FOUND', `SAP has PO ${look.poNumber} for ${d.PoDraftNo} — it was created`);
      await markRejected(tx, draftId, [`Confirmed not created: ${comment.trim()}`], 'MANUAL_NOT_CREATED', actor.id);
    }
    await recordEvent(tx, { type: 'SAP_UNKNOWN_RESOLVED', entityType: 'PO_DRAFT', entityId: draftId, demandId: d.DemandId, payload: { outcome: r.outcome, comment: comment.trim(), sapCheck: look.kind }, actorUserId: actor.id });
    return { resolved: r.outcome };
  });
}
