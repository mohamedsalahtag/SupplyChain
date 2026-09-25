/** Stage 6 screens (spec 22): the award's Handoff tab, the Handoffs list, one handoff as the PO team sees it. */
import { sql } from 'kysely';
import { hasPermission, type Actor } from '../workflow/access.js';
import { NotFoundError } from '../workflow/errors.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { rowVerHex, type Db } from '../workflow/tx.js';
import { readiness, termOptions, termsFor, type Snapshot } from './handoffData.js';
import { P_HANDOFF } from './handoffService.js';

const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const num = (m: number) => Number(formatQty(m)).toLocaleString('en-GB', { maximumFractionDigits: 3 });

/** The award's Handoff tab: one card per supplier. */
export async function handoffPanel(db: Db, actor: Actor, batchId: string) {
  const b = await db.selectFrom('scm.AwardBatch as b').innerJoin('scm.Rfq as r', 'r.RfqId', 'b.RfqId').innerJoin('scm.Demand as d', 'd.DemandId', 'b.DemandId')
    .select(['b.AwardBatchId', 'b.AbNo', 'r.RfqNo', 'd.DemandNo', 'b.CompanyCode']).where('b.AwardBatchId', '=', batchId).executeTakeFirst();
  if (!b || !actor.companies.has(b.CompanyCode)) throw new NotFoundError(`Award ${batchId}`);
  const batch = { AwardBatchId: String(b.AwardBatchId), CompanyCode: b.CompanyCode };
  const suppliers = (await sql<{ SupplierCode: string; Name: string; Unit: string; Q: string; Value: string }>`
    SELECT i.SupplierCode, sp.Name, i.Unit, SUM(i.Qty) AS Q, SUM(i.Qty * i.UnitPrice) / 1000 AS Value
    FROM scm.AwardItem i JOIN md.Supplier sp ON sp.SupplierCode = i.SupplierCode
    WHERE i.AwardBatchId = ${batchId} AND i.IsActive = 1 GROUP BY i.SupplierCode, sp.Name, i.Unit ORDER BY sp.Name`.execute(db)).rows;
  const handoffs = await db.selectFrom('scm.Handoff as h').leftJoin('app.User as s', 's.UserId', 'h.SentBy').leftJoin('app.User as a', 'a.UserId', 'h.AcceptedBy').leftJoin('app.User as r', 'r.UserId', 'h.ReturnedBy')
    .select(['h.HandoffId', 'h.HoNo', 'h.SupplierCode', 'h.Status', 'h.SentAt', 's.DisplayName as SentBy', 'h.SentWithoutAck', 'h.AcceptedAt', 'a.DisplayName as AcceptedBy',
      'h.ReturnedAt', 'r.DisplayName as ReturnedBy', 'h.ReturnReason', 'h.ReturnComment'])
    .where('h.AwardBatchId', '=', batchId).orderBy('h.HandoffId', 'desc').execute();
  const [shipments, containers, currencies] = await Promise.all([
    db.selectFrom('scm.AwardShipment').select(['ShipmentId', 'SupplierCode', 'EtdWeek', 'ContainerCount', 'ConfirmedEtd', 'IsActive', rowVerHex('RowVer').as('RowVer')])
      .where('AwardBatchId', '=', batchId).where('IsActive', '=', true).orderBy('EtdWeek').execute(),
    db.selectFrom('scm.AwardContainer').select(['SupplierCode', (eb) => eb.fn.sum<number>('Containers').as('n')]).where('AwardBatchId', '=', batchId).where('IsActive', '=', true).groupBy('SupplierCode').execute(),
    db.selectFrom('scm.AwardItem').select(['SupplierCode', 'Currency']).distinct().where('AwardBatchId', '=', batchId).where('IsActive', '=', true).execute(),
  ]);
  const canSend = hasPermission(actor, P_HANDOFF.send);
  const codes = [...new Set([...suppliers.map((s) => s.SupplierCode), ...handoffs.map((h) => h.SupplierCode)])];
  const cards = [];
  for (const code of codes) {
    const mine = suppliers.filter((s) => s.SupplierCode === code);
    const hs = handoffs.filter((h) => h.SupplierCode === code);
    const open = hs.find((h) => h.Status === 'HANDED_OFF' || h.Status === 'ACCEPTED') ?? null;
    const t = await termsFor(db, batch.AwardBatchId, code, b.CompanyCode);
    const ready = open || !mine.length ? null : await readiness(db, batch, code, t.terms);
    const ships = shipments.filter((s) => s.SupplierCode === code);
    cards.push({
      supplierCode: code, name: mine[0]?.Name ?? hs[0]?.SupplierCode ?? code,
      containers: Number(containers.find((c) => c.SupplierCode === code)?.n ?? ships.reduce((a, s) => a + s.ContainerCount, 0)),
      quantity: mine.map((s) => `${num(fromDb(s.Q))} ${s.Unit}`).join(' + '),
      value: mine.length ? `${Number(mine.reduce((a, s) => a + Number(s.Value), 0)).toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${currencies.find((c) => c.SupplierCode === code)?.Currency ?? ''}` : '',
      terms: t.terms, termsSource: t.source, termsSourceNote: t.sourceNote, sap: t.sap,
      shipments: ships.map((s) => ({ shipmentId: String(s.ShipmentId), week: s.EtdWeek, containers: s.ContainerCount, confirmedEtd: day(s.ConfirmedEtd), rowVer: s.RowVer })),
      readiness: ready,
      open: open ? { handoffId: String(open.HandoffId), hoNo: open.HoNo, status: open.Status, withoutAck: open.SentWithoutAck } : null,
      handoffs: hs.map((h) => ({
        handoffId: String(h.HandoffId), hoNo: h.HoNo, status: h.Status, sentAt: h.SentAt.toISOString(), sentBy: h.SentBy ?? '', withoutAck: h.SentWithoutAck,
        acceptedAt: h.AcceptedAt?.toISOString() ?? null, acceptedBy: h.AcceptedBy ?? null, returnedAt: h.ReturnedAt?.toISOString() ?? null,
        returnedBy: h.ReturnedAt ? h.ReturnedBy ?? 'automatically' : null, returnReason: h.ReturnReason, returnComment: h.ReturnComment,
      })),
      canEdit: canSend && !open && mine.length > 0,
    });
  }
  return { abNo: b.AbNo, cards, options: await termOptions(db) };
}

export type HandoffFilter = { q?: string; status?: string[]; page: number; pageSize: number };

/** Purchasing → Handoffs. */
export async function listHandoffs(db: Db, actor: Actor, f: HandoffFilter) {
  const companies = [...actor.companies];
  if (!companies.length || !hasPermission(actor, P_HANDOFF.open)) return { rows: [], total: 0 };
  let q = db.selectFrom('scm.Handoff as h').innerJoin('scm.AwardBatch as b', 'b.AwardBatchId', 'h.AwardBatchId').innerJoin('scm.Demand as d', 'd.DemandId', 'b.DemandId')
    .innerJoin('md.Supplier as sp', 'sp.SupplierCode', 'h.SupplierCode').where('h.CompanyCode', 'in', companies);
  if (f.status?.length) q = q.where('h.Status', 'in', f.status as ('HANDED_OFF' | 'ACCEPTED' | 'RETURNED')[]);
  if (f.q) { const p = `%${f.q.replace(/[[%_]/g, '[$&]')}%`; q = q.where((eb) => eb.or([eb('h.HoNo', 'like', p), eb('b.AbNo', 'like', p), eb('d.DemandNo', 'like', p), eb('sp.Name', 'like', p), eb('h.SupplierCode', 'like', p)])); }
  const [rows, count] = await Promise.all([
    q.leftJoin('app.User as s', 's.UserId', 'h.SentBy').leftJoin('app.User as a', 'a.UserId', 'h.AcceptedBy').leftJoin('app.User as r', 'r.UserId', 'h.ReturnedBy')
      .select(['h.HandoffId', 'h.HoNo', 'h.SupplierCode', 'sp.Name', 'b.AwardBatchId', 'b.AbNo', 'd.DemandId', 'd.DemandNo', 'h.CompanyCode', 'h.Status', 'h.SentWithoutAck', 'h.SnapshotJson',
        'h.SentAt', 's.DisplayName as SentBy', 'h.AcceptedAt', 'a.DisplayName as AcceptedBy', 'h.ReturnedAt', 'r.DisplayName as ReturnedBy', 'h.ReturnReason'])
      .orderBy('h.HandoffId', 'desc').offset((f.page - 1) * f.pageSize).fetch(f.pageSize).execute(),
    q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  return {
    total: Number(count.n),
    rows: rows.map((r) => {
      const s = JSON.parse(r.SnapshotJson) as Snapshot;
      const last = r.ReturnedAt ? { text: `Returned ${r.ReturnedBy ? `by ${r.ReturnedBy} (PO team)` : 'automatically'} · ${r.ReturnReason}`, at: r.ReturnedAt }
        : r.AcceptedAt ? { text: `Accepted by ${r.AcceptedBy} (PO team)`, at: r.AcceptedAt } : { text: `Handed off by ${r.SentBy} (Procurement)`, at: r.SentAt };
      return {
        handoffId: String(r.HandoffId), hoNo: r.HoNo, supplierCode: r.SupplierCode, supplierName: r.Name, awardBatchId: String(r.AwardBatchId), abNo: r.AbNo,
        demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode, status: r.Status, withoutAck: r.SentWithoutAck,
        containers: s.shipments.reduce((a, x) => a + x.containers, 0), weeks: s.shipments.map((x) => x.week.slice(5)).join(', '),
        terms: [s.terms.incoterm, s.terms.portOfLoading && `${s.terms.portOfLoading} → ${s.terms.portOfDischarge}`, s.terms.paymentTerms, s.terms.currency].filter(Boolean).join(' · '),
        lastStep: { text: last.text, note: null, at: last.at.toISOString() },
      };
    }),
  };
}

/** One handoff, exactly as sent, with what the viewer can do. */
export async function getHandoff(db: Db, actor: Actor, handoffId: string) {
  const h = await db.selectFrom('scm.Handoff as h').innerJoin('scm.AwardBatch as b', 'b.AwardBatchId', 'h.AwardBatchId')
    .leftJoin('app.User as s', 's.UserId', 'h.SentBy').leftJoin('app.User as a', 'a.UserId', 'h.AcceptedBy').leftJoin('app.User as r', 'r.UserId', 'h.ReturnedBy')
    .select(['h.HandoffId', 'h.HoNo', 'h.AwardBatchId', 'b.DemandId', 'h.SupplierCode', 'h.CompanyCode', 'h.Status', 'h.SnapshotJson', 'h.SentAt', 'h.SentBy as SentById', 's.DisplayName as SentBy', 'h.SentWithoutAck',
      'h.ProceedReason', 'h.ProceedComment', 'h.AckRevision', 'h.AcceptedAt', 'a.DisplayName as AcceptedBy', 'h.ReturnedAt', 'r.DisplayName as ReturnedBy', 'h.ReturnedFrom',
      'h.ReturnReason', 'h.ReturnComment', rowVerHex('h.RowVer').as('RowVer')])
    .where('h.HandoffId', '=', handoffId).executeTakeFirst();
  if (!h || !actor.companies.has(h.CompanyCode) || !hasPermission(actor, P_HANDOFF.open)) throw new NotFoundError(`Handoff ${handoffId}`);
  const hasDrafts = !!(await db.selectFrom('scm.PoDraft').select('PoDraftId').where('HandoffId', '=', handoffId).executeTakeFirst());
  const ackNow = await db.selectFrom('scm.SalesAck').select(['Status', 'Revision']).where('AwardBatchId', '=', String(h.AwardBatchId)).executeTakeFirst();
  const open = h.Status === 'HANDED_OFF' || h.Status === 'ACCEPTED';
  return {
    handoffId: String(h.HandoffId), hoNo: h.HoNo, awardBatchId: String(h.AwardBatchId), demandId: String(h.DemandId), companyCode: h.CompanyCode, status: h.Status, rowVer: h.RowVer,
    snapshot: JSON.parse(h.SnapshotJson) as Snapshot, hasDrafts,
    sentAt: h.SentAt.toISOString(), sentBy: h.SentBy ?? '', withoutAck: h.SentWithoutAck, proceedReason: h.ProceedReason, proceedComment: h.ProceedComment, ackRevision: h.AckRevision,
    ackNow: ackNow ? { status: ackNow.Status, revision: ackNow.Revision } : null,
    acceptedAt: h.AcceptedAt?.toISOString() ?? null, acceptedBy: h.AcceptedBy ?? null,
    returned: h.ReturnedAt ? { at: h.ReturnedAt.toISOString(), by: h.ReturnedBy ?? null, from: h.ReturnedFrom, reason: h.ReturnReason, comment: h.ReturnComment } : null,
    actions: {
      accept: h.Status === 'HANDED_OFF' && hasPermission(actor, P_HANDOFF.accept) && (actor.isAdmin || Number(h.SentById) !== actor.id), // not one's own handoff
      return: open && hasPermission(actor, P_HANDOFF.return) && !(await db.selectFrom('scm.PoDraft').select('PoDraftId').where('HandoffId', '=', handoffId).where('Status', 'in', ['SUBMITTED', 'UNKNOWN', 'CREATED']).executeTakeFirst()),
    },
  };
}

/** Configuration → Shipping terms: every entry (active or not) and how many suppliers use each payment term. */
export async function termLists(db: Db) {
  const [incoterms, ports, payment] = await Promise.all([
    db.selectFrom('scm.Incoterm').selectAll().orderBy('SortOrder').execute(),
    db.selectFrom('scm.Port').selectAll().orderBy('CountryCode').orderBy('Name').execute(),
    sql<{ Code: string; Description: string; IsActive: boolean; Suppliers: number }>`
      SELECT p.Code, p.Description, p.IsActive, (SELECT COUNT(DISTINCT o.SupplierCode) FROM md.SupplierPurchasingOrg o WHERE o.PaymentTerms = p.Code) AS Suppliers
      FROM scm.PaymentTerm p ORDER BY p.Code`.execute(db).then((r) => r.rows),
  ]);
  return {
    incoterms: incoterms.map((i) => ({ code: i.Code, description: i.Description, isActive: i.IsActive })),
    ports: ports.map((p) => ({ portId: Number(p.PortId), name: p.Name, countryCode: p.CountryCode, usedFor: p.UsedFor, isActive: p.IsActive })),
    paymentTerms: payment.map((p) => ({ code: p.Code, description: p.Description, isActive: p.IsActive, suppliers: Number(p.Suppliers) })),
  };
}
