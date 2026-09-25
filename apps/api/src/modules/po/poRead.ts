/** Stage 7 screens (spec 23): PO preparation of a handoff, one PO draft, the drafts list, master data requests. */
import { sql } from 'kysely';
import { lineLabel } from '../award/awardCheck.js';
import { hasPermission, type Actor } from '../workflow/access.js';
import { NotFoundError } from '../workflow/errors.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { rowVerHex, type Db } from '../workflow/tx.js';
import { candidateSkus, P_PO } from './poService.js';

const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** What the PO team works on for one handoff: the materials and their SKUs, and the drafts. */
export async function preparation(db: Db, actor: Actor, handoffId: string) {
  const h = await db.selectFrom('scm.Handoff').select(['HandoffId', 'AwardBatchId', 'SupplierCode', 'CompanyCode', 'Status']).where('HandoffId', '=', handoffId).executeTakeFirst();
  if (!h || !actor.companies.has(h.CompanyCode) || !hasPermission(actor, P_PO.open)) throw new NotFoundError(`Handoff ${handoffId}`);
  const items = await db.selectFrom('scm.AwardItem as i').innerJoin('scm.RfqLine as l', 'l.RfqLineId', 'i.RfqLineId')
    .leftJoin('scm.AwardShipment as sh', (j) => j.onRef('sh.AwardBatchId', '=', 'i.AwardBatchId').onRef('sh.SupplierCode', '=', 'i.SupplierCode').onRef('sh.EtdWeek', '=', 'i.EtdWeek').on('sh.IsActive', '=', true))
    .select(['i.AwardItemId', 'i.EtdWeek', 'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.MaterialCode', 'l.OriginCode', 'i.Qty', 'i.Unit', 'i.UnitPrice', 'i.Currency', 'i.SkuStatus', 'sh.ConfirmedEtd'])
    .where('i.AwardBatchId', '=', String(h.AwardBatchId)).where('i.SupplierCode', '=', h.SupplierCode).where('i.IsActive', '=', true).orderBy('i.EtdWeek').orderBy('i.AwardItemId').execute();
  const ids = items.map((i) => String(i.AwardItemId));
  const [allocs, mdrs, drafts] = await Promise.all([
    ids.length ? db.selectFrom('scm.AwardItemSku as a').leftJoin('md.Material as m', 'm.MaterialCode', 'a.MaterialCode').select(['a.AwardItemId', 'a.MaterialCode', 'm.Description', 'a.Qty', 'a.SetStage'])
      .where('a.AwardItemId', 'in', ids).where('a.IsActive', '=', true).execute() : [],
    ids.length ? db.selectFrom('scm.MasterDataRequest').select(['MdrId', 'AwardItemId', 'Note', 'CreatedAt']).where('AwardItemId', 'in', ids).where('Status', '=', 'OPEN').execute() : [],
    db.selectFrom('scm.PoDraft').select(['PoDraftId', 'PoDraftNo', 'Status', 'SapPoNumber', 'CreatedAt']).where('HandoffId', '=', handoffId).orderBy('PoDraftId', 'desc').execute(),
  ]);
  const manage = hasPermission(actor, P_PO.manage) && h.Status === 'ACCEPTED';
  const live = drafts.find((d) => ['DRAFT', 'VALIDATED', 'SUBMITTED', 'UNKNOWN', 'CREATED'].includes(d.Status));
  return {
    handoffStatus: h.Status,
    items: items.map((i) => {
      const id = String(i.AwardItemId);
      return {
        awardItemId: id, week: i.EtdWeek, label: `${lineLabel(i)} ${i.OriginCode}`, qty: formatQty(fromDb(i.Qty)), unit: i.Unit, unitPrice: Number(i.UnitPrice).toFixed(2), currency: i.Currency,
        confirmedEtd: day(i.ConfirmedEtd), skuStatus: i.SkuStatus,
        skus: allocs.filter((a) => String(a.AwardItemId) === id).map((a) => ({ code: a.MaterialCode, description: a.Description ?? '', qty: formatQty(fromDb(a.Qty)), stage: a.SetStage })),
        mdr: mdrs.filter((m) => String(m.AwardItemId) === id).map((m) => ({ mdrId: String(m.MdrId), note: m.Note, at: m.CreatedAt.toISOString() }))[0] ?? null,
        canSelect: manage && !live?.Status.match(/SUBMITTED|UNKNOWN|CREATED/) && ['PENDING', 'RESOLVED_AT_PO'].includes(i.SkuStatus),
      };
    }),
    drafts: drafts.map((d) => ({ poDraftId: String(d.PoDraftId), poDraftNo: d.PoDraftNo, status: d.Status, sapPoNumber: d.SapPoNumber, createdAt: d.CreatedAt.toISOString() })),
    canBuild: manage && !live,
  };
}

/** SKU choices for one award item (same specification, origin and unit). */
export async function skuCandidates(db: Db, actor: Actor, awardItemId: string) {
  const i = await db.selectFrom('scm.AwardItem as i').innerJoin('scm.AwardBatch as b', 'b.AwardBatchId', 'i.AwardBatchId').innerJoin('scm.RfqLine as l', 'l.RfqLineId', 'i.RfqLineId')
    .select(['b.CompanyCode', 'l.MajorCategory', 'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.OriginCode', 'i.Unit']).where('i.AwardItemId', '=', awardItemId).executeTakeFirst();
  if (!i || !actor.companies.has(i.CompanyCode) || !hasPermission(actor, P_PO.open)) throw new NotFoundError(`Award item ${awardItemId}`);
  return (await candidateSkus(db, i)).map((m) => ({ code: m.MaterialCode, description: m.Description }));
}

export async function getDraft(db: Db, actor: Actor, draftId: string) {
  const d = await db.selectFrom('scm.PoDraft as d').innerJoin('scm.Handoff as h', 'h.HandoffId', 'd.HandoffId').innerJoin('scm.AwardBatch as b', 'b.AwardBatchId', 'h.AwardBatchId')
    .innerJoin('scm.Demand as dm', 'dm.DemandId', 'b.DemandId').innerJoin('md.Supplier as sp', 'sp.SupplierCode', 'd.SupplierCode')
    .leftJoin('app.User as u', 'u.UserId', 'd.CreatedBy').leftJoin('app.User as su', 'su.UserId', 'd.SubmittedBy')
    .select(['d.PoDraftId', 'd.PoDraftNo', 'd.HandoffId', 'h.HoNo', 'b.AwardBatchId', 'b.AbNo', 'b.DemandId', 'dm.DemandNo', 'd.CompanyCode', 'd.SupplierCode', 'sp.Name as SupplierName', 'd.Plant',
      'd.PurchasingOrg', 'd.PurchasingGroup', 'd.Incoterm', 'd.PortOfLoading', 'd.PortOfDischarge', 'd.PaymentTerms', 'd.Currency', 'd.ContainerCount', 'd.Status', 'd.SapPoNumber',
      'd.SapCreatedAt', 'd.Resolution', 'd.LastError', 'd.ValidatedAt', 'd.SubmittedAt', 'su.DisplayName as SubmittedBy', 'd.CreatedAt', 'u.DisplayName as CreatedBy', rowVerHex('d.RowVer').as('RowVer')])
    .where('d.PoDraftId', '=', draftId).executeTakeFirst();
  if (!d || !actor.companies.has(d.CompanyCode) || !hasPermission(actor, P_PO.open)) throw new NotFoundError(`PO draft ${draftId}`);
  const [items, sub] = await Promise.all([
    db.selectFrom('scm.PoDraftItem as i').innerJoin('scm.AwardItem as a', 'a.AwardItemId', 'i.AwardItemId').innerJoin('scm.RfqLine as l', 'l.RfqLineId', 'a.RfqLineId')
      .leftJoin('md.Material as m', 'm.MaterialCode', 'i.MaterialCode')
      .select(['i.ItemNo', 'i.MaterialCode', 'm.Description', 'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.MaterialCode as LineSku', 'l.OriginCode', 'i.Qty', 'i.Unit', 'i.UnitPrice', 'i.Currency', 'i.EtdWeek', 'i.ConfirmedEtd'])
      .where('i.PoDraftId', '=', draftId).orderBy('i.ItemNo').execute(),
    db.selectFrom('scm.SapSubmission').select(['SubmissionId', 'Status', 'Attempts', 'ReconcileChecks', 'NextActionAt', 'Reference', 'PayloadSha256', 'IdempotencyKey']).where('PoDraftId', '=', draftId).executeTakeFirst(),
  ]);
  const attempts = sub ? await db.selectFrom('scm.SapSubmissionAttempt').select(['Kind', 'StartedAt', 'FinishedAt', 'Outcome', 'Detail', 'WorkerId']).where('SubmissionId', '=', String(sub.SubmissionId)).orderBy('AttemptId', 'desc').execute() : [];
  const manage = hasPermission(actor, P_PO.manage);
  return {
    poDraftId: String(d.PoDraftId), poDraftNo: d.PoDraftNo, handoffId: String(d.HandoffId), hoNo: d.HoNo, awardBatchId: String(d.AwardBatchId), abNo: d.AbNo, demandId: String(d.DemandId), demandNo: d.DemandNo,
    companyCode: d.CompanyCode, supplierCode: d.SupplierCode, supplierName: d.SupplierName, plant: d.Plant, purchasingOrg: d.PurchasingOrg, purchasingGroup: d.PurchasingGroup,
    incoterm: d.Incoterm, portOfLoading: d.PortOfLoading, portOfDischarge: d.PortOfDischarge, paymentTerms: d.PaymentTerms, currency: d.Currency, containers: d.ContainerCount,
    status: d.Status, sapPoNumber: d.SapPoNumber, sapCreatedAt: d.SapCreatedAt?.toISOString() ?? null, resolution: d.Resolution, problems: d.LastError ? d.LastError.split('\n') : [],
    validatedAt: d.ValidatedAt?.toISOString() ?? null, submittedAt: d.SubmittedAt?.toISOString() ?? null, submittedBy: d.SubmittedBy ?? null, createdAt: d.CreatedAt.toISOString(), createdBy: d.CreatedBy ?? '', rowVer: d.RowVer,
    items: items.map((i) => ({
      itemNo: i.ItemNo, material: i.MaterialCode, description: i.Description ?? '', spec: `${lineLabel({ SubMajorCategory: i.SubMajorCategory, Size: i.Size, MaterialClass: i.MaterialClass, MaterialCode: null })} ${i.OriginCode}`,
      qty: formatQty(fromDb(i.Qty)), unit: i.Unit, unitPrice: Number(i.UnitPrice).toFixed(2), currency: i.Currency, value: (Number(formatQty(fromDb(i.Qty))) * Number(i.UnitPrice)).toFixed(2), week: i.EtdWeek, confirmedEtd: day(i.ConfirmedEtd),
    })),
    submission: sub ? { status: sub.Status, attempts: sub.Attempts, checks: sub.ReconcileChecks, nextActionAt: sub.NextActionAt.toISOString(), key: String(sub.IdempotencyKey), hash: sub.PayloadSha256 } : null,
    attempts: attempts.map((a) => ({ kind: a.Kind, startedAt: a.StartedAt.toISOString(), finishedAt: a.FinishedAt?.toISOString() ?? null, outcome: a.Outcome, detail: a.Detail, worker: a.WorkerId })),
    actions: {
      validate: manage && ['DRAFT', 'VALIDATED'].includes(d.Status), submit: manage && d.Status === 'VALIDATED', resolve: manage && d.Status === 'UNKNOWN',
    },
  };
}

export type DraftFilter = { q?: string; status?: string[]; page: number; pageSize: number };
export async function listDrafts(db: Db, actor: Actor, f: DraftFilter) {
  const companies = [...actor.companies];
  if (!companies.length || !hasPermission(actor, P_PO.open)) return { rows: [], total: 0 };
  let q = db.selectFrom('scm.PoDraft as d').innerJoin('scm.Handoff as h', 'h.HandoffId', 'd.HandoffId').innerJoin('scm.AwardBatch as b', 'b.AwardBatchId', 'h.AwardBatchId')
    .innerJoin('scm.Demand as dm', 'dm.DemandId', 'b.DemandId').innerJoin('md.Supplier as sp', 'sp.SupplierCode', 'd.SupplierCode').where('d.CompanyCode', 'in', companies);
  if (f.status?.length) q = q.where('d.Status', 'in', f.status as never[]);
  if (f.q) { const p = `%${f.q.replace(/[[%_]/g, '[$&]')}%`; q = q.where((eb) => eb.or([eb('d.PoDraftNo', 'like', p), eb('h.HoNo', 'like', p), eb('dm.DemandNo', 'like', p), eb('sp.Name', 'like', p), eb('d.SapPoNumber', 'like', p)])); }
  const [rows, count] = await Promise.all([
    q.leftJoin('scm.SapSubmission as s', 's.PoDraftId', 'd.PoDraftId')
      .select(['d.PoDraftId', 'd.PoDraftNo', 'h.HandoffId', 'h.HoNo', 'dm.DemandNo', 'd.CompanyCode', 'sp.Name', 'd.SupplierCode', 'd.Status', 'd.SapPoNumber', 'd.ContainerCount', 'd.Currency', 'd.SubmittedAt', 'd.CreatedAt', 's.Attempts', 'd.LastError'])
      .orderBy('d.PoDraftId', 'desc').offset((f.page - 1) * f.pageSize).fetch(f.pageSize).execute(),
    q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  return {
    total: Number(count.n),
    rows: rows.map((r) => ({
      poDraftId: String(r.PoDraftId), poDraftNo: r.PoDraftNo, handoffId: String(r.HandoffId), hoNo: r.HoNo, demandNo: r.DemandNo, companyCode: r.CompanyCode, supplierName: r.Name, supplierCode: r.SupplierCode,
      status: r.Status, sapPoNumber: r.SapPoNumber, containers: r.ContainerCount, currency: r.Currency, submittedAt: r.SubmittedAt?.toISOString() ?? null, createdAt: r.CreatedAt.toISOString(),
      attempts: r.Attempts ?? 0, lastError: r.LastError?.split('\n')[0] ?? null,
    })),
  };
}

export async function listMdr(db: Db, actor: Actor) {
  if (!hasPermission(actor, P_PO.open)) return [];
  const rows = await sql<{ MdrId: string; Status: string; Note: string; CreatedAt: Date; ClosedAt: Date | null; CreatedBy: string; Label: string; HandoffId: string | null; CompanyCode: string }>`
    SELECT r.MdrId, r.Status, r.Note, r.CreatedAt, r.ClosedAt, u.DisplayName AS CreatedBy, CONCAT(l.SubMajorCategory, ' ', l.Size, ' ', l.MaterialClass, ' ', l.OriginCode, ' · ', i.Unit) AS Label,
      (SELECT TOP 1 s.HandoffId FROM scm.QtySlice s WHERE s.AwardItemId = i.AwardItemId AND s.HandoffId IS NOT NULL) AS HandoffId, b.CompanyCode
    FROM scm.MasterDataRequest r JOIN scm.AwardItem i ON i.AwardItemId = r.AwardItemId JOIN scm.AwardBatch b ON b.AwardBatchId = i.AwardBatchId
    JOIN scm.RfqLine l ON l.RfqLineId = i.RfqLineId LEFT JOIN app.[User] u ON u.UserId = r.CreatedBy
    ORDER BY CASE r.Status WHEN 'OPEN' THEN 0 ELSE 1 END, r.MdrId DESC`.execute(db);
  return rows.rows.filter((r) => actor.companies.has(r.CompanyCode)).map((r) => ({
    mdrId: String(r.MdrId), status: r.Status, note: r.Note, createdAt: r.CreatedAt.toISOString(), closedAt: r.ClosedAt?.toISOString() ?? null, createdBy: r.CreatedBy ?? '', label: r.Label, handoffId: r.HandoffId ? String(r.HandoffId) : null,
  }));
}
