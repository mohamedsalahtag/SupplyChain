/**
 * Reports · Arrivals schedule (S1), Supplier scorecard (P1) and the monthly KPI trend (M1) — spec 28. Company-scoped under
 * reports.open, with spec 24's rules: quantities never added across units, money never across currencies, N/A on a zero denominator.
 */
import { sql } from 'kysely';
import type { Actor } from '../workflow/access.js';
import { isoWeekMonday, isoWeekOf } from '../workflow/isoWeek.js';
import { fromDb } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import type { Db } from '../workflow/tx.js';
import { trendMonths } from './pure.js';
import { between, executionSummary, headlineOf, likeOf, q3, ratio, scope, sliceMilestones, type ReportFilter } from './reports.js';

export { trendMonths };

const DAY = 86_400_000;
const num = (v: unknown) => Number(v ?? 0);
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const money = (qtyMilli: string | number, price: string | number) => Math.round((fromDb(qtyMilli) / 1000) * Number(price) * 100) / 100;

/* ---------------------------------------------------------------- S1 · Arrivals schedule ---------------------------------------------------------------- */
const STAGE_LABEL: Record<number, string> = { 6: 'PO created', 5: 'Sent to SAP', 4: 'PO being prepared', 3: 'Handed off', 2: 'Awarded', 1: 'Awarded' };

/** What is coming: one row per awarded material (award item) with its shipment, terms of progress and SAP PO. The dates filter on the ETD week; the default is this week onward. */
/** The rows of the arrivals schedule: FROM + WHERE, shared by the list and its count (`reports.counts`). */
export function arrivalsScope(companies: string[], f: ReportFilter) {
  const fromWeek = isoWeekOf(f.from ? new Date(`${f.from}T00:00:00Z`) : new Date());
  const toWeek = f.to ? isoWeekOf(new Date(`${f.to}T00:00:00Z`)) : null;
  const like = f.q ? likeOf(f.q) : null;
  const inRange = sql`ai.IsActive = 1 AND ai.Qty > 0 AND b.CompanyCode IN (${sql.join(companies)}) AND ai.EtdWeek >= ${fromWeek} ${toWeek ? sql`AND ai.EtdWeek <= ${toWeek}` : sql``}`;
  const from = sql`FROM scm.AwardItem ai
      JOIN scm.AwardBatch b ON b.AwardBatchId = ai.AwardBatchId
      JOIN scm.Demand d ON d.DemandId = b.DemandId
      JOIN scm.RfqLine rl ON rl.RfqLineId = ai.RfqLineId
      LEFT JOIN scm.AwardShipment sh ON sh.AwardBatchId = ai.AwardBatchId AND sh.SupplierCode = ai.SupplierCode AND sh.EtdWeek = ai.EtdWeek AND sh.IsActive = 1
      LEFT JOIN md.Supplier s ON s.SupplierCode = ai.SupplierCode
      LEFT JOIN scm.Handoff h ON h.AwardBatchId = ai.AwardBatchId AND h.SupplierCode = ai.SupplierCode AND h.Status IN ('HANDED_OFF', 'ACCEPTED')
      LEFT JOIN scm.PoDraft p ON p.HandoffId = h.HandoffId AND p.Status IN ('DRAFT', 'VALIDATED', 'SUBMITTED', 'UNKNOWN', 'CREATED')`;
  const where = sql`WHERE ${inRange}
        ${like ? sql`AND (d.DemandNo LIKE ${like} OR ISNULL(s.Name, '') LIKE ${like} OR ai.SupplierCode LIKE ${like} OR rl.SubMajorCategory LIKE ${like} OR ISNULL(rl.MaterialCode, '') LIKE ${like} OR ISNULL(p.SapPoNumber, '') LIKE ${like})` : sql``}`;
  return { fromWeek, toWeek, inRange, from, where };
}

export async function arrivals(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const { fromWeek, toWeek, inRange, from, where } = arrivalsScope(companies, f);
  const [rows, skus] = await Promise.all([
    sql<{ AwardBatchId: string; AbNo: string; CompanyCode: string; DemandId: string; DemandNo: string; AwardItemId: string; SupplierCode: string; SupplierName: string | null; Country: string | null;
      EtdWeek: string; ConfirmedEtd: Date | null; ContainerCount: number | null; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string; MaterialCode: string | null;
      Qty: string; Unit: string; UnitPrice: string | number; Currency: string; HandoffId: string | null; HoNo: string | null; HandoffStatus: string | null; PoDraftId: string | null; PoDraftNo: string | null; PoStatus: string | null; SapPoNumber: string | null; Stage: number | null }>`
      SELECT b.AwardBatchId, b.AbNo, b.CompanyCode, d.DemandId, d.DemandNo, ai.AwardItemId, ai.SupplierCode, s.Name AS SupplierName, s.Country,
        ai.EtdWeek, sh.ConfirmedEtd, sh.ContainerCount, rl.SubMajorCategory, rl.Size, rl.MaterialClass, rl.OriginCode, rl.MaterialCode, ai.Qty, ai.Unit, ai.UnitPrice, ai.Currency,
        h.HandoffId, h.HoNo, h.Status AS HandoffStatus, p.PoDraftId, p.PoDraftNo, p.Status AS PoStatus, p.SapPoNumber, st.Stage
      ${from}
      OUTER APPLY (SELECT MAX(CASE q.ExecState WHEN 'PO_CREATED' THEN 6 WHEN 'PO_SUBMITTED' THEN 5 WHEN 'PO_PREPARATION' THEN 4 WHEN 'HANDED_OFF' THEN 3 WHEN 'AWARDED' THEN 2 ELSE 1 END) AS Stage
                   FROM scm.QtySlice q WHERE q.AwardItemId = ai.AwardItemId) st
      ${where}
      ORDER BY ai.EtdWeek, ISNULL(s.Name, ai.SupplierCode), d.DemandNo, rl.SubMajorCategory, rl.Size, ai.AwardItemId`.execute(db),
    sql<{ AwardItemId: string; MaterialCode: string; Qty: string }>`
      SELECT k.AwardItemId, k.MaterialCode, k.Qty FROM scm.AwardItemSku k JOIN scm.AwardItem ai ON ai.AwardItemId = k.AwardItemId JOIN scm.AwardBatch b ON b.AwardBatchId = ai.AwardBatchId
      WHERE k.IsActive = 1 AND ${inRange} ORDER BY k.AllocId`.execute(db),
  ]);
  const skuOf = new Map<string, string[]>();
  for (const k of skus.rows) { const key = String(k.AwardItemId); skuOf.set(key, [...(skuOf.get(key) ?? []), `${k.MaterialCode} ${q3(k.Qty)}`]); }
  const shipments = new Map<string, number>();
  const units = new Map<string, number>();
  const values = new Map<string, number>();
  const out = rows.rows.map((r) => {
    const shipKey = `${r.AwardBatchId}|${r.SupplierCode}|${r.EtdWeek}`;
    shipments.set(shipKey, num(r.ContainerCount));
    units.set(r.Unit, (units.get(r.Unit) ?? 0) + fromDb(r.Qty));
    const value = money(r.Qty, r.UnitPrice);
    values.set(r.Currency, (values.get(r.Currency) ?? 0) + value);
    return {
      awardBatchId: String(r.AwardBatchId), abNo: r.AbNo, companyCode: r.CompanyCode, demandId: String(r.DemandId), demandNo: r.DemandNo, awardItemId: String(r.AwardItemId),
      supplierCode: r.SupplierCode, supplierName: r.SupplierName ?? r.SupplierCode, country: r.Country ?? '', week: r.EtdWeek, monday: dateOnly(isoWeekMonday(r.EtdWeek)),
      confirmedEtd: r.ConfirmedEtd ? dateOnly(new Date(r.ConfirmedEtd)) : null, containers: r.ContainerCount == null ? null : num(r.ContainerCount),
      material: [r.SubMajorCategory, r.Size, r.MaterialClass, r.OriginCode, r.MaterialCode].filter(Boolean).join(' '), skus: (skuOf.get(String(r.AwardItemId)) ?? []).join(' · '),
      qty: q3(r.Qty), unit: r.Unit, unitPrice: Number(r.UnitPrice), currency: r.Currency, value,
      status: STAGE_LABEL[num(r.Stage)] ?? 'Awarded', handoffId: r.HandoffId ? String(r.HandoffId) : null, hoNo: r.HoNo, poDraftId: r.PoDraftId ? String(r.PoDraftId) : null, poDraftNo: r.PoDraftNo,
      sapPoNumber: r.SapPoNumber,
    };
  });
  return {
    fromWeek, toWeek, rows: out,
    totals: {
      shipments: shipments.size, containers: [...shipments.values()].reduce((s, c) => s + c, 0),
      units: [...units].map(([unit, milli]) => ({ unit, qty: q3(milli) })).sort((a, b) => a.unit.localeCompare(b.unit)),
      values: [...values].map(([currency, value]) => ({ currency, value: Math.round(value * 100) / 100 })).sort((a, b) => a.currency.localeCompare(b.currency)),
    },
  };
}

/* ---------------------------------------------------------------- P1 · Supplier scorecard ---------------------------------------------------------------- */
/** The period defaults to the last 12 months. Invitations, quotes and price position follow the RFQ's sent date; awards the batch date; handoffs the sent date. */
export function scorecardPeriod(f: ReportFilter): ReportFilter {
  return f.from || f.to ? f : { ...f, from: dateOnly(new Date(Date.now() - 365 * DAY)) };
}

async function supplierNames(db: Db, codes: string[]) {
  const out = new Map<string, { name: string; country: string; blocked: boolean }>();
  for (let i = 0; i < codes.length; i += 500) { // never an unbounded parameter list (database review)
    const chunk = codes.slice(i, i + 500);
    const rows = (await sql<{ SupplierCode: string; Name: string; Country: string; Blocked: boolean | number }>`
      SELECT SupplierCode, Name, Country, PurchasingIsBlocked AS Blocked FROM md.Supplier WHERE SupplierCode IN (${sql.join(chunk)})`.execute(db)).rows;
    for (const r of rows) out.set(r.SupplierCode, { name: r.Name, country: r.Country, blocked: Boolean(Number(r.Blocked)) });
  }
  return out;
}

export async function suppliers(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const p = scorecardPeriod(f);
  const co = sql.join(companies);
  const [inv, price, aw, val, ch, sku, ho] = await Promise.all([
    sql<{ SupplierCode: string; Invited: number; Quoted: number; Quotes: number; AvgHours: number | null; Outside: number }>`
      SELECT rs.SupplierCode, COUNT(*) AS Invited, SUM(CASE WHEN x.Quotes > 0 THEN 1 ELSE 0 END) AS Quoted, ISNULL(SUM(x.Quotes), 0) AS Quotes,
        AVG(CASE WHEN x.FirstQuote IS NOT NULL THEN DATEDIFF(minute, r.SentAt, x.FirstQuote) / 60.0 END) AS AvgHours, ISNULL(SUM(CAST(rs.OutsideShortlist AS int)), 0) AS Outside
      FROM scm.RfqSupplier rs JOIN scm.Rfq r ON r.RfqId = rs.RfqId
      -- first quote over every quote row (current and replaced: a revision must not move it); counts over the current ones
      CROSS APPLY (SELECT MIN(q.RecordedAt) AS FirstQuote, ISNULL(SUM(CASE WHEN q.IsCurrent = 1 THEN 1 ELSE 0 END), 0) AS Quotes
                   FROM scm.SupplierQuote q WHERE q.RfqId = rs.RfqId AND q.SupplierCode = rs.SupplierCode) x
      WHERE r.CompanyCode IN (${co}) AND r.SentAt IS NOT NULL ${between(sql`r.SentAt`, p)} GROUP BY rs.SupplierCode`.execute(db),
    sql<{ SupplierCode: string; Compared: number; Cheapest: number }>`
      WITH q AS (
        SELECT q.SupplierCode, RANK() OVER (PARTITION BY q.RfqId, q.EtdWeek, q.LineKey, q.Currency ORDER BY q.UnitPrice) AS Rnk,
               COUNT(*) OVER (PARTITION BY q.RfqId, q.EtdWeek, q.LineKey, q.Currency) AS N
        FROM scm.SupplierQuote q JOIN scm.Rfq r ON r.RfqId = q.RfqId
        WHERE q.IsCurrent = 1 AND r.CompanyCode IN (${co}) AND r.SentAt IS NOT NULL ${between(sql`r.SentAt`, p)})
      SELECT SupplierCode, SUM(CASE WHEN N >= 2 THEN 1 ELSE 0 END) AS Compared, SUM(CASE WHEN N >= 2 AND Rnk = 1 THEN 1 ELSE 0 END) AS Cheapest FROM q GROUP BY SupplierCode`.execute(db),
    sql<{ SupplierCode: string; Batches: number; Containers: number; LastAward: Date }>`
      SELECT sh.SupplierCode, COUNT(DISTINCT sh.AwardBatchId) AS Batches, SUM(sh.ContainerCount) AS Containers, MAX(b.CreatedAt) AS LastAward
      FROM scm.AwardShipment sh JOIN scm.AwardBatch b ON b.AwardBatchId = sh.AwardBatchId
      WHERE sh.IsActive = 1 AND b.CompanyCode IN (${co}) ${between(sql`b.CreatedAt`, p)} GROUP BY sh.SupplierCode`.execute(db),
    sql<{ SupplierCode: string; Currency: string; Value: string | number }>`
      SELECT ai.SupplierCode, ai.Currency, SUM(ai.Qty * ai.UnitPrice) / 1000.0 AS Value FROM scm.AwardItem ai JOIN scm.AwardBatch b ON b.AwardBatchId = ai.AwardBatchId
      WHERE ai.IsActive = 1 AND b.CompanyCode IN (${co}) ${between(sql`b.CreatedAt`, p)} GROUP BY ai.SupplierCode, ai.Currency`.execute(db),
    sql<{ SupplierCode: string; AboveOffer: number; Unawarded: number }>`
      SELECT c.SupplierCode, SUM(CASE WHEN c.ChangeType = 'ABOVE_OFFER' THEN 1 ELSE 0 END) AS AboveOffer,
        SUM(CASE WHEN c.ChangeType IN ('UNAWARD_KEEP_QUOTES', 'UNAWARD_RELEASE') THEN c.Containers ELSE 0 END) AS Unawarded
      FROM scm.AwardContainerChange c JOIN scm.AwardBatch b ON b.AwardBatchId = c.AwardBatchId
      WHERE c.SupplierCode IS NOT NULL AND b.CompanyCode IN (${co}) ${between(sql`c.ChangedAt`, p)} GROUP BY c.SupplierCode`.execute(db),
    sql<{ SupplierCode: string; N: number }>`
      SELECT ai.SupplierCode, COUNT(*) AS N FROM scm.AwardItemChange c JOIN scm.AwardItem ai ON ai.AwardItemId = c.AwardItemId JOIN scm.AwardBatch b ON b.AwardBatchId = ai.AwardBatchId
      WHERE c.ChangeType = 'SKU_CORRECTED' AND b.CompanyCode IN (${co}) ${between(sql`c.ChangedAt`, p)} GROUP BY ai.SupplierCode`.execute(db),
    sql<{ SupplierCode: string; Handoffs: number; Returned: number; SkuIssues: number; PosCreated: number }>`
      SELECT h.SupplierCode, COUNT(*) AS Handoffs, SUM(CASE WHEN h.Status = 'RETURNED' AND h.ReturnedBy IS NOT NULL THEN 1 ELSE 0 END) AS Returned,
        SUM(CASE WHEN h.ReturnReason = 'SKU_ISSUE' THEN 1 ELSE 0 END) AS SkuIssues, SUM(x.Created) AS PosCreated
      FROM scm.Handoff h CROSS APPLY (SELECT CASE WHEN EXISTS (SELECT 1 FROM scm.PoDraft d WHERE d.HandoffId = h.HandoffId AND d.Status = 'CREATED') THEN 1 ELSE 0 END AS Created) x
      WHERE h.CompanyCode IN (${co}) ${between(sql`h.SentAt`, p)} GROUP BY h.SupplierCode`.execute(db),
  ]);
  const codes = [...new Set([...inv.rows, ...aw.rows, ...ho.rows].map((r) => r.SupplierCode))];
  const names = await supplierNames(db, codes);
  const by = <T extends { SupplierCode: string }>(rows: T[]) => new Map(rows.map((r) => [r.SupplierCode, r]));
  const invBy = by(inv.rows), priceBy = by(price.rows), awBy = by(aw.rows), chBy = by(ch.rows), skuBy = by(sku.rows), hoBy = by(ho.rows);
  const like = f.q?.trim().toLowerCase();
  const rows = codes.map((code) => {
    const n = names.get(code), i = invBy.get(code), pr = priceBy.get(code), a = awBy.get(code), c = chBy.get(code), s = skuBy.get(code), h = hoBy.get(code);
    return {
      supplierCode: code, name: n?.name ?? code, country: n?.country ?? '', blocked: n?.blocked ?? false,
      invited: num(i?.Invited), quoted: num(i?.Quoted), quoteRate: ratio(num(i?.Quoted), num(i?.Invited)), quotes: num(i?.Quotes), outsideShortlist: num(i?.Outside),
      avgResponseHours: i?.AvgHours == null ? null : Math.round(Number(i.AvgHours) * 10) / 10,
      compared: num(pr?.Compared), cheapest: num(pr?.Cheapest), cheapestRate: ratio(num(pr?.Cheapest), num(pr?.Compared)),
      batches: num(a?.Batches), containers: num(a?.Containers), lastAwardAt: iso(a?.LastAward),
      values: val.rows.filter((v) => v.SupplierCode === code).map((v) => ({ currency: v.Currency, value: Math.round(Number(v.Value) * 100) / 100 })),
      aboveOffer: num(c?.AboveOffer), unawarded: num(c?.Unawarded), skuCorrections: num(s?.N),
      handoffs: num(h?.Handoffs), returned: num(h?.Returned), returnRate: ratio(num(h?.Returned), num(h?.Handoffs)), skuIssues: num(h?.SkuIssues), posCreated: num(h?.PosCreated),
    };
  }).filter((r) => !like || r.supplierCode.toLowerCase().includes(like) || r.name.toLowerCase().includes(like))
    .sort((a, b) => b.containers - a.containers || b.invited - a.invited || a.name.localeCompare(b.name));
  return { from: p.from ?? null, to: p.to ?? null, rows };
}

/** One supplier's RFQs and handoffs in the period, for the scorecard drawer. */
export async function supplierDetail(db: Db, actor: Actor, f: ReportFilter & { supplierCode: string }) {
  const companies = scope(actor, f);
  const p = scorecardPeriod(f);
  const co = sql.join(companies);
  const [rfqs, handoffs] = await Promise.all([
    sql<{ RfqId: string; RfqNo: string; DemandId: string; DemandNo: string; CompanyCode: string; SentAt: Date | null; FirstQuote: Date | null; Outside: boolean | number; Containers: number | null }>`
      SELECT r.RfqId, r.RfqNo, d.DemandId, d.DemandNo, r.CompanyCode, r.SentAt, x.FirstQuote, rs.OutsideShortlist AS Outside,
        (SELECT SUM(sh.ContainerCount) FROM scm.AwardShipment sh JOIN scm.AwardBatch b ON b.AwardBatchId = sh.AwardBatchId WHERE b.RfqId = r.RfqId AND sh.SupplierCode = rs.SupplierCode AND sh.IsActive = 1) AS Containers
      FROM scm.RfqSupplier rs JOIN scm.Rfq r ON r.RfqId = rs.RfqId JOIN scm.Demand d ON d.DemandId = r.DemandId
      CROSS APPLY (SELECT MIN(q.RecordedAt) AS FirstQuote FROM scm.SupplierQuote q WHERE q.RfqId = rs.RfqId AND q.SupplierCode = rs.SupplierCode) x -- current and replaced quotes
      WHERE rs.SupplierCode = ${f.supplierCode} AND r.CompanyCode IN (${co}) AND r.SentAt IS NOT NULL ${between(sql`r.SentAt`, p)}
      ORDER BY r.SentAt DESC`.execute(db),
    sql<{ HandoffId: string; HoNo: string; AwardBatchId: string; AbNo: string; DemandNo: string; SentAt: Date; Status: string; ReturnReason: string | null; SapPoNumber: string | null }>`
      SELECT h.HandoffId, h.HoNo, h.AwardBatchId, b.AbNo, d.DemandNo, h.SentAt, h.Status, h.ReturnReason,
        (SELECT TOP 1 p.SapPoNumber FROM scm.PoDraft p WHERE p.HandoffId = h.HandoffId AND p.Status = 'CREATED') AS SapPoNumber
      FROM scm.Handoff h JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId JOIN scm.Demand d ON d.DemandId = b.DemandId
      WHERE h.SupplierCode = ${f.supplierCode} AND h.CompanyCode IN (${co}) ${between(sql`h.SentAt`, p)} ORDER BY h.SentAt DESC`.execute(db),
  ]);
  return {
    rfqs: rfqs.rows.map((r) => ({ rfqId: String(r.RfqId), rfqNo: r.RfqNo, demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode, sentAt: iso(r.SentAt), firstQuoteAt: iso(r.FirstQuote),
      outsideShortlist: Boolean(Number(r.Outside)), containers: num(r.Containers) })),
    handoffs: handoffs.rows.map((h) => ({ handoffId: String(h.HandoffId), hoNo: h.HoNo, awardBatchId: String(h.AwardBatchId), abNo: h.AbNo, demandNo: h.DemandNo, sentAt: iso(h.SentAt)!, status: h.Status,
      returnReason: h.ReturnReason, sapPoNumber: h.SapPoNumber })),
  };
}

/* ---------------------------------------------------------------- M1 · Monthly KPI trend ---------------------------------------------------------------- */
/**
 * The Performance headline per month of acceptance. One fetch for the whole range (execution rows, slice milestones, and the
 * handoff / SAP / accepted counts grouped by month), then bucketed by month here — it used to run the full performance query
 * once per month, twelve times in a row (~12 s on the dev database).
 */
export async function trend(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const { months: list, truncated } = trendMonths(f);
  if (!list.length) return { onTimeDays: (await loadWfSettings(db)).kpiOnTimeDaysBeforeEtd, truncated, months: [] };
  const range: ReportFilter = { company: f.company, from: list[0].from, to: list[list.length - 1].to };
  const co = sql.join(companies);
  const monthOf = (col: ReturnType<typeof sql>) => sql`CONVERT(char(7), ${col}, 126)`; // 'YYYY-MM' of a UTC timestamp
  const [settings, summary, milestones, accepted, ho, sap] = await Promise.all([
    loadWfSettings(db),
    executionSummary(db, actor, range),
    sliceMilestones(db, companies, range),
    sql<{ M: string; N: number }>`SELECT ${monthOf(sql`d.AcceptedAt`)} AS M, COUNT(*) AS N FROM scm.Demand d
      WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${co}) ${between(sql`d.AcceptedAt`, range)} GROUP BY ${monthOf(sql`d.AcceptedAt`)}`.execute(db),
    sql<{ M: string; Handoffs: number; Manual: number }>`SELECT ${monthOf(sql`SentAt`)} AS M, COUNT(*) AS Handoffs, SUM(CASE WHEN Status = 'RETURNED' AND ReturnedBy IS NOT NULL THEN 1 ELSE 0 END) AS Manual
      FROM scm.Handoff WHERE CompanyCode IN (${co}) ${between(sql`SentAt`, range)} GROUP BY ${monthOf(sql`SentAt`)}`.execute(db),
    sql<{ M: string; Submitted: number; FirstReply: number }>`SELECT ${monthOf(sql`SubmittedAt`)} AS M, COUNT(*) AS Submitted, SUM(CASE WHEN Resolution = 'SAP_REPLY' THEN 1 ELSE 0 END) AS FirstReply
      FROM scm.PoDraft WHERE CompanyCode IN (${co}) AND Status IN ('SUBMITTED', 'UNKNOWN', 'CREATED', 'REJECTED') ${between(sql`SubmittedAt`, range)} GROUP BY ${monthOf(sql`SubmittedAt`)}`.execute(db),
  ]);
  const monthKey = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 7) : '');
  const months = list.map((m) => {
    const h = ho.rows.find((r) => r.M === m.month);
    const s = sap.rows.find((r) => r.M === m.month);
    return {
      month: m.month, from: m.from, to: m.to, accepted: num(accepted.rows.find((r) => r.M === m.month)?.N),
      units: headlineOf(summary.filter((r) => monthKey(r.acceptedAt) === m.month), milestones.filter((x) => monthKey(x.AcceptedAt) === m.month), settings.kpiOnTimeDaysBeforeEtd)
        .map((u) => ({ unit: u.unit, committed: u.committed, executed: u.executed, outstanding: u.outstanding, executionRate: u.executionRate, executionN: u.executionN, notSourcedRate: u.notSourcedRate,
          onTimeRate: u.onTimeRate, onTimeN: u.onTimeN, endToEndHours: u.endToEndHours, endToEndN: u.endToEndN, stages: u.stages })),
      handoffs: { handoffs: num(h?.Handoffs), returnRate: ratio(num(h?.Manual), num(h?.Handoffs)) },
      sap: { submitted: num(s?.Submitted), firstReplyRate: ratio(num(s?.FirstReply), num(s?.Submitted)) },
    };
  });
  return { onTimeDays: settings.kpiOnTimeDaysBeforeEtd, truncated, months };
}
