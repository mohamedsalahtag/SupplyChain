/**
 * Stage 6 reads (spec 22): shipping-term choices and defaults, the readiness checklist of one award × supplier,
 * and the snapshot a handoff stores (supplier, terms, shipments, materials, acknowledgement — exactly as sent).
 */
import { sql } from 'kysely';
import { lineLabel } from '../award/awardCheck.js';
import { lastSuccessfulSyncs, staleSources, vendorProblems } from '../workflow/masterData.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import { originsOf } from '../workflow/supplierOrigins.js';
import type { Db, Tx } from '../workflow/tx.js';

export type Terms = { incoterm: string | null; portOfLoadingId: number | null; portOfDischargeId: number | null; paymentTerms: string | null; currency: string | null };
type Source = 'SAVED' | 'LAST_HANDOFF' | 'SAP' | null;

/** The choices (active entries of the Configuration lists). */
export async function termOptions(db: Db | Tx) {
  const [incoterms, ports, payment] = await Promise.all([
    db.selectFrom('scm.Incoterm').select(['Code', 'Description']).where('IsActive', '=', true).orderBy('SortOrder').execute(),
    db.selectFrom('scm.Port').select(['PortId', 'Name', 'CountryCode', 'UsedFor']).where('IsActive', '=', true).orderBy('CountryCode').orderBy('Name').execute(),
    db.selectFrom('scm.PaymentTerm').select(['Code', 'Description']).where('IsActive', '=', true).orderBy('Code').execute(),
  ]);
  return {
    incoterms: incoterms.map((i) => ({ code: i.Code, description: i.Description })),
    ports: ports.map((p) => ({ portId: Number(p.PortId), name: p.Name, countryCode: p.CountryCode, usedFor: p.UsedFor })), // the driver returns identities as strings
    paymentTerms: payment.map((p) => ({ code: p.Code, description: p.Description })),
  };
}

/** The supplier's award currency in a batch (one per supplier, Stage 5 rule). */
export async function awardCurrency(db: Db | Tx, batchId: string, supplierCode: string): Promise<string | null> {
  const r = await db.selectFrom('scm.AwardItem').select('Currency').distinct().where('AwardBatchId', '=', batchId).where('SupplierCode', '=', supplierCode).where('IsActive', '=', true).execute();
  return r.length === 1 ? r[0].Currency : null;
}

/** Saved terms, else the supplier's last handoff, else the SAP defaults (payment terms, Incoterm) — with where each came from. */
export async function termsFor(db: Db | Tx, batchId: string, supplierCode: string, companyCode: string): Promise<{ terms: Terms; source: Source; sourceNote: string | null; sap: { paymentTerms: string; incoterm: string; location: string } | null }> {
  const currency = await awardCurrency(db, batchId, supplierCode);
  const sap = await sql<{ PaymentTerms: string; Incoterm: string; IncotermLocation: string }>`
    SELECT o.PaymentTerms, o.Incoterm, o.IncotermLocation FROM md.SupplierPurchasingOrg o JOIN scm.Company c ON c.PurchasingOrg = o.PurchasingOrg
    WHERE o.SupplierCode = ${supplierCode} AND c.CompanyCode = ${companyCode}`.execute(db).then((r) => r.rows[0] ?? null);
  const sapOut = sap ? { paymentTerms: sap.PaymentTerms, incoterm: sap.Incoterm, location: sap.IncotermLocation } : null;
  const saved = await db.selectFrom('scm.ShippingTerms').select(['Incoterm', 'PortOfLoadingId', 'PortOfDischargeId', 'PaymentTerms', 'Currency'])
    .where('AwardBatchId', '=', batchId).where('SupplierCode', '=', supplierCode).executeTakeFirst();
  const id = (v: number | string | null | undefined) => (v == null ? null : Number(v));
  if (saved) return { terms: { incoterm: saved.Incoterm, portOfLoadingId: id(saved.PortOfLoadingId), portOfDischargeId: id(saved.PortOfDischargeId), paymentTerms: saved.PaymentTerms, currency: currency ?? saved.Currency }, source: 'SAVED', sourceNote: null, sap: sapOut };

  const last = await db.selectFrom('scm.Handoff').select(['HoNo', 'SentAt', 'SnapshotJson']).where('SupplierCode', '=', supplierCode).where('CompanyCode', '=', companyCode)
    .orderBy('SentAt', 'desc').top(1).executeTakeFirst();
  if (last) {
    const t = (JSON.parse(last.SnapshotJson) as { terms: { incoterm: string; portOfLoadingId: number; portOfDischargeId: number; paymentTerms: string } }).terms;
    return { terms: { incoterm: t.incoterm, portOfLoadingId: id(t.portOfLoadingId), portOfDischargeId: id(t.portOfDischargeId), paymentTerms: t.paymentTerms, currency }, source: 'LAST_HANDOFF', sourceNote: `${last.HoNo}, ${last.SentAt.toISOString().slice(0, 10)}`, sap: sapOut };
  }
  // SAP: payment terms (almost always there); Incoterm and its location only for a few suppliers.
  const [pay, inco, port] = await Promise.all([
    sap?.PaymentTerms ? db.selectFrom('scm.PaymentTerm').select('Code').where('Code', '=', sap.PaymentTerms).where('IsActive', '=', true).executeTakeFirst() : null,
    sap?.Incoterm ? db.selectFrom('scm.Incoterm').select('Code').where('Code', '=', sap.Incoterm).where('IsActive', '=', true).executeTakeFirst() : null,
    sap?.IncotermLocation ? db.selectFrom('scm.Port').select('PortId').where('Name', '=', sap.IncotermLocation).where('IsActive', '=', true).where('UsedFor', '!=', 'DISCHARGE').executeTakeFirst() : null,
  ]);
  return {
    terms: { incoterm: inco?.Code ?? null, portOfLoadingId: id(port?.PortId), portOfDischargeId: null, paymentTerms: pay?.Code ?? null, currency },
    source: sap ? 'SAP' : null, sourceNote: null, sap: sapOut,
  };
}

/** Active quantity of a supplier in a batch, per state, and the lines on hold. */
async function supplierSlices(db: Db | Tx, batchId: string, supplierCode: string) {
  return (await sql<{ ExecState: string; Q: string; HoldCrNo: string | null; Label: string }>`
    SELECT s.ExecState, SUM(s.Qty) AS Q, hc.CrNo AS HoldCrNo, MIN(l.SubMajorCategory + ' ' + l.Size) AS Label
    FROM scm.AwardItem i JOIN scm.QtySlice s ON s.AwardItemId = i.AwardItemId JOIN scm.DemandLine l ON l.LineId = s.LineId
    LEFT JOIN scm.ChangeRequest hc ON hc.CrId = l.ChangeHoldCrId
    WHERE i.AwardBatchId = ${batchId} AND i.SupplierCode = ${supplierCode} AND i.IsActive = 1 AND s.ExecState <> 'CANCELLED'
    GROUP BY s.ExecState, hc.CrNo`.execute(db)).rows;
}

export type Check = { key: string; label: string; ok: boolean; detail: string | null; warning?: boolean };

/** The "Ready to hand off?" checklist (spec 22). Warnings never block. */
export async function readiness(db: Db | Tx, b: { AwardBatchId: string; CompanyCode: string }, supplierCode: string, terms?: Terms) {
  const t = terms ?? (await termsFor(db, b.AwardBatchId, supplierCode, b.CompanyCode)).terms;
  const currency = await awardCurrency(db, b.AwardBatchId, supplierCode);
  const shipments = await db.selectFrom('scm.AwardShipment').select(['EtdWeek', 'ConfirmedEtd']).where('AwardBatchId', '=', b.AwardBatchId).where('SupplierCode', '=', supplierCode).where('IsActive', '=', true).execute();
  const slices = await supplierSlices(db, b.AwardBatchId, supplierCode);
  const vendor = (await vendorProblems(db, [supplierCode], b.CompanyCode)).get(supplierCode);
  const ack = await db.selectFrom('scm.SalesAck').select(['Status', 'Revision']).where('AwardBatchId', '=', b.AwardBatchId).executeTakeFirst();
  const stale = staleSources(await lastSuccessfulSyncs(db), (await loadWfSettings(db)).masterDataMaxAgeHours, new Date());
  const missing = [!t.incoterm && 'Incoterm', !t.portOfLoadingId && 'port of loading', !t.portOfDischargeId && 'port of discharge', !t.paymentTerms && 'payment terms'].filter(Boolean) as string[];
  const noEtd = shipments.filter((s) => !s.ConfirmedEtd).map((s) => s.EtdWeek);
  const held = [...new Set(slices.filter((s) => s.HoldCrNo).map((s) => s.HoldCrNo!))];
  const notAwarded = slices.filter((s) => s.ExecState !== 'AWARDED');
  const awarded = slices.filter((s) => s.ExecState === 'AWARDED').reduce((a, s) => a + fromDb(s.Q), 0);
  const ackMissing = !!ack && ['PENDING', 'QUERY_RAISED'].includes(ack.Status);
  const checks: Check[] = [
    { key: 'terms', label: 'Shipping terms complete', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : null },
    { key: 'currency', label: `Terms currency = award currency${currency ? ` (${currency})` : ''}`, ok: !!currency && t.currency === currency, detail: currency ? null : 'the supplier has items in several currencies' },
    { key: 'etd', label: 'Confirmed ETD for every shipment', ok: shipments.length > 0 && noEtd.length === 0, detail: noEtd.length ? `missing for ${noEtd.join(', ')}` : shipments.map((s) => s.EtdWeek).join(', ') },
    { key: 'hold', label: 'No material on hold by a change request', ok: held.length === 0, detail: held.length ? held.join(', ') : null },
    { key: 'awarded', label: 'All of this supplier’s quantity is Awarded', ok: awarded > 0 && notAwarded.length === 0, detail: notAwarded.length ? `part is ${notAwarded.map((s) => s.ExecState.toLowerCase().replace(/_/g, ' ')).join(', ')}` : awarded ? `${formatQty(awarded).replace(/\.000$/, '')} in total` : 'nothing awarded' },
    { key: 'vendor', label: `Supplier usable in SAP (not blocked, set up for company ${b.CompanyCode})`, ok: !vendor, detail: vendor?.message ?? null },
    { key: 'ack', label: 'Sales acknowledged', ok: !ackMissing, warning: true, detail: ack ? (ackMissing ? 'not yet — you can still hand off' : `revision ${ack.Revision}`) : null },
    ...(stale.length ? [{ key: 'fresh', label: 'SAP data up to date', ok: false, warning: true, detail: `last sync too old: ${stale.join(', ')}` }] : []),
  ];
  return { ready: checks.every((c) => c.ok || c.warning), checks, ackMissing, ackRevision: ack?.Revision ?? 1, awarded };
}

/** Everything the PO team needs, exactly as it is at the moment of the handoff. */
export async function buildSnapshot(db: Db | Tx, b: { AwardBatchId: string; AbNo: string; CompanyCode: string; RfqNo: string; DemandNo: string }, supplierCode: string, t: Terms) {
  const [supplier, org, origins, ports, incoterm, payTerm, shipments, items, containers, ack] = await Promise.all([
    db.selectFrom('md.Supplier').select(['SupplierCode', 'Name', 'Country', 'City', 'Email']).where('SupplierCode', '=', supplierCode).executeTakeFirst(),
    sql<{ PurchasingOrg: string; IsBlocked: boolean; PaymentTerms: string; Incoterm: string; IncotermLocation: string }>`
      SELECT o.PurchasingOrg, o.IsBlocked, o.PaymentTerms, o.Incoterm, o.IncotermLocation FROM md.SupplierPurchasingOrg o JOIN scm.Company c ON c.PurchasingOrg = o.PurchasingOrg
      WHERE o.SupplierCode = ${supplierCode} AND c.CompanyCode = ${b.CompanyCode}`.execute(db).then((r) => r.rows[0] ?? null),
    originsOf(db, [supplierCode]),
    db.selectFrom('scm.Port').select(['PortId', 'Name', 'CountryCode']).where('PortId', 'in', [t.portOfLoadingId ?? -1, t.portOfDischargeId ?? -1]).execute(),
    t.incoterm ? db.selectFrom('scm.Incoterm').select(['Code', 'Description']).where('Code', '=', t.incoterm).executeTakeFirst() : null,
    t.paymentTerms ? db.selectFrom('scm.PaymentTerm').select(['Code', 'Description']).where('Code', '=', t.paymentTerms).executeTakeFirst() : null,
    db.selectFrom('scm.AwardShipment').select(['EtdWeek', 'ContainerCount', 'ConfirmedEtd']).where('AwardBatchId', '=', b.AwardBatchId).where('SupplierCode', '=', supplierCode).where('IsActive', '=', true).orderBy('EtdWeek').execute(),
    db.selectFrom('scm.AwardItem as i').innerJoin('scm.RfqLine as l', 'l.RfqLineId', 'i.RfqLineId')
      .select(['i.AwardItemId', 'i.EtdWeek', 'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.MaterialCode', 'l.OriginCode', 'i.Qty', 'i.Unit', 'i.UnitPrice', 'i.Currency', 'i.SkuStatus'])
      .where('i.AwardBatchId', '=', b.AwardBatchId).where('i.SupplierCode', '=', supplierCode).where('i.IsActive', '=', true).orderBy('i.EtdWeek').execute(),
    db.selectFrom('scm.AwardContainer as c').innerJoin('scm.ContainerGroup as g', 'g.ContainerGroupId', 'c.ContainerGroupId')
      .select(['c.EtdWeek', 'g.Name', 'c.Containers']).where('c.AwardBatchId', '=', b.AwardBatchId).where('c.SupplierCode', '=', supplierCode).where('c.IsActive', '=', true).execute(),
    db.selectFrom('scm.SalesAck').select(['Status', 'Revision']).where('AwardBatchId', '=', b.AwardBatchId).executeTakeFirst(),
  ]);
  const skus = items.length ? await db.selectFrom('scm.AwardItemSku').select(['AwardItemId', 'MaterialCode']).where('AwardItemId', 'in', items.map((i) => String(i.AwardItemId))).where('IsActive', '=', true).execute() : [];
  const port = (id: number | null) => (id == null ? undefined : ports.find((p) => Number(p.PortId) === Number(id)));
  const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  return {
    award: { abNo: b.AbNo, rfqNo: b.RfqNo, demandNo: b.DemandNo, companyCode: b.CompanyCode },
    supplier: {
      code: supplierCode, name: supplier?.Name ?? supplierCode, country: supplier?.Country ?? '', city: supplier?.City ?? '', email: supplier?.Email ?? '',
      origins: origins.get(supplierCode) ?? [], purchasingOrg: org?.PurchasingOrg ?? null, orgBlocked: org?.IsBlocked ?? null,
      sapPaymentTerms: org?.PaymentTerms || null, sapIncoterm: org?.Incoterm ? `${org.Incoterm}${org.IncotermLocation ? ` ${org.IncotermLocation}` : ''}` : null,
    },
    terms: {
      incoterm: t.incoterm, incotermText: incoterm ? `${incoterm.Code} · ${incoterm.Description}` : t.incoterm,
      portOfLoadingId: t.portOfLoadingId, portOfLoading: port(t.portOfLoadingId) ? `${port(t.portOfLoadingId)!.Name} (${port(t.portOfLoadingId)!.CountryCode})` : null,
      portOfDischargeId: t.portOfDischargeId, portOfDischarge: port(t.portOfDischargeId) ? `${port(t.portOfDischargeId)!.Name} (${port(t.portOfDischargeId)!.CountryCode})` : null,
      paymentTerms: t.paymentTerms, paymentTermsText: payTerm ? `${payTerm.Code}${payTerm.Description ? ` · ${payTerm.Description}` : ''}` : t.paymentTerms, currency: t.currency,
    },
    shipments: shipments.map((s) => ({ week: s.EtdWeek, containers: s.ContainerCount, confirmedEtd: day(s.ConfirmedEtd) })),
    containers: containers.map((c) => ({ week: c.EtdWeek, group: c.Name || 'Container group', containers: c.Containers })),
    items: items.map((i) => ({
      week: i.EtdWeek, label: `${lineLabel(i)} ${i.OriginCode}`, qty: formatQty(fromDb(i.Qty)), unit: i.Unit, unitPrice: Number(i.UnitPrice).toFixed(2), currency: i.Currency,
      value: (Number(formatQty(fromDb(i.Qty))) * Number(i.UnitPrice)).toFixed(2), skuStatus: i.SkuStatus, skus: skus.filter((k) => String(k.AwardItemId) === String(i.AwardItemId)).map((k) => k.MaterialCode),
    })),
    ack: ack ? { status: ack.Status, revision: ack.Revision } : null,
  };
}
export type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;
