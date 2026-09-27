/**
 * Stage 8 reports and KPIs (spec 24, plan v5 §8). Rules: quantities are never added across units; a ratio with a
 * zero denominator is N/A (null); business origin (not merge arrival) decides the category; cycle times are
 * quantity-weighted at slice level; baseline = version 1, shown apart from the cumulative requested quantity.
 */
import { P } from '@supplychain/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Snapshot } from '../demand/versions.js';
import { hasPermission, type Actor } from '../workflow/access.js';
import { NotFoundError } from '../workflow/errors.js';
import { loadWfSettings } from '../workflow/settings.js';
import type { Db } from '../workflow/tx.js';
import { headlineOf, q3, ratio, type Milestone, type ReportFilter } from './pure.js';

export { headlineOf, q3, ratio, type Milestone, type ReportFilter };
export const P_REPORTS = P.reportsOpen;

/** The companies a report may read: the actor's, narrowed by the filter. Shared with the dashboard (spec 26). */
export function scope(actor: Actor, f: ReportFilter) {
  if (!hasPermission(actor, P_REPORTS)) throw new NotFoundError('Reports');
  const companies = [...actor.companies].filter((c) => !f.company?.length || f.company.includes(c));
  return companies.length ? companies : ['—none—'];
}
/** AND <column> within the From/To dates (To inclusive). */
export const between = (col: RawBuilder<unknown>, f: ReportFilter) => sql`${f.from ? sql`AND ${col} >= ${f.from}` : sql``} ${f.to ? sql`AND ${col} < DATEADD(day, 1, CAST(${f.to} AS date))` : sql``}`;
const acceptedBetween = (f: ReportFilter) => between(sql`d.AcceptedAt`, f);
export const likeOf = (q: string) => `%${q.replace(/[[%_]/g, '[$&]')}%`;
/** AND the record's demand number contains the search (the Performance search applies to every section: spec 24). */
export const demandNoLike = (demandId: RawBuilder<unknown>, f: ReportFilter) =>
  (f.q ? sql`AND EXISTS (SELECT 1 FROM scm.Demand dq WHERE dq.DemandId = ${demandId} AND dq.DemandNo LIKE ${likeOf(f.q)})` : sql``);

/** Execution by business origin, per accepted demand and unit (plan §8.2 v_demand_execution). */
export async function executionSummary(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const like = f.q ? likeOf(f.q) : null;
  const rows = (await sql<{ DemandId: string; DemandNo: string; CompanyCode: string; Unit: string; AcceptedAt: Date | null; Committed: string; Executed: string; NotSourced: string;
    SalesCancelled: string; ProcApproved: string; ProcOrdered: string; ProcCancelled: string; Outstanding: string }>`
    SELECT d.DemandId, d.DemandNo, d.CompanyCode, l.Unit, d.AcceptedAt,
      SUM(CASE WHEN s.BusinessOrigin IN ('SALES', 'CHANGE') AND s.ExecState <> 'MERGED_OUT' AND NOT (s.ExecState = 'CANCELLED' AND s.CancelOrigin IN ('SALES', 'CHANGE')) THEN s.Qty ELSE 0 END) AS Committed,
      SUM(CASE WHEN s.BusinessOrigin IN ('SALES', 'CHANGE') AND s.ExecState = 'PO_CREATED' THEN s.Qty ELSE 0 END) AS Executed,
      SUM(CASE WHEN s.ExecState = 'CANCELLED' AND s.CancelOrigin = 'PROCUREMENT' AND s.BusinessOrigin IN ('SALES', 'CHANGE') THEN s.Qty ELSE 0 END) AS NotSourced,
      SUM(CASE WHEN s.ExecState = 'CANCELLED' AND s.CancelOrigin = 'SALES' THEN s.Qty ELSE 0 END) AS SalesCancelled,
      SUM(CASE WHEN s.BusinessOrigin = 'PROCUREMENT' AND s.ExecState NOT IN ('MERGED_OUT', 'CANCELLED') THEN s.Qty ELSE 0 END) AS ProcApproved,
      SUM(CASE WHEN s.BusinessOrigin = 'PROCUREMENT' AND s.ExecState = 'PO_CREATED' THEN s.Qty ELSE 0 END) AS ProcOrdered,
      SUM(CASE WHEN s.BusinessOrigin = 'PROCUREMENT' AND s.ExecState = 'CANCELLED' THEN s.Qty ELSE 0 END) AS ProcCancelled,
      SUM(CASE WHEN s.ExecState IN ('OPEN', 'IN_RFQ', 'QUOTED', 'AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED') THEN s.Qty ELSE 0 END) AS Outstanding
    FROM scm.Demand d JOIN scm.DemandLine l ON l.DemandId = d.DemandId JOIN scm.QtySlice s ON s.LineId = l.LineId
    WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${sql.join(companies)}) ${acceptedBetween(f)} ${like ? sql`AND d.DemandNo LIKE ${like}` : sql``}
    GROUP BY d.DemandId, d.DemandNo, d.CompanyCode, l.Unit, d.AcceptedAt
    ORDER BY d.DemandId DESC`.execute(db)).rows;
  return rows.map((r) => ({
    demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode, unit: r.Unit, acceptedAt: r.AcceptedAt?.toISOString() ?? null,
    committed: q3(r.Committed), executed: q3(r.Executed), notSourced: q3(r.NotSourced), salesCancelled: q3(r.SalesCancelled), outstanding: q3(r.Outstanding),
    procApproved: q3(r.ProcApproved), procOrdered: q3(r.ProcOrdered), procCancelled: q3(r.ProcCancelled),
    executionRate: ratio(Number(r.Executed), Number(r.Committed)), notSourcedRate: ratio(Number(r.NotSourced), Number(r.Committed)),
  }));
}

/** One demand: per line (baseline, cumulative requested, where the quantity is, SAP POs) and per week (containers). */
export async function demandReport(db: Db, actor: Actor, demandId: string) {
  const d = await db.selectFrom('scm.Demand').select(['DemandId', 'DemandNo', 'CompanyCode', 'BaselineVersion', 'BaselineStatus', 'AcceptedAt']).where('DemandId', '=', demandId).executeTakeFirst();
  if (!d || !actor.companies.has(d.CompanyCode) || !hasPermission(actor, P_REPORTS)) throw new NotFoundError(`Demand ${demandId}`);
  const v1 = d.BaselineVersion ? await db.selectFrom('scm.DemandVersion').select('SnapshotJson').where('DemandId', '=', demandId).where('VersionNo', '=', d.BaselineVersion).executeTakeFirst() : null;
  const base = v1 ? (JSON.parse(v1.SnapshotJson) as Snapshot) : null;
  const lines = (await sql<{ LineId: string; EtdWeek: string; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string; MaterialCode: string | null; Unit: string; RequestedQty: string;
    Open: string; InRfq: string; Awarded: string; HandedOff: string; PoSubmitted: string; PoCreated: string; CancelledSales: string; NotSourced: string; CancelledChange: string; MergedIn: string; MergedOut: string; ProcAdded: string }>`
    SELECT l.LineId, w.EtdWeek, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, l.Unit, l.RequestedQty,
      SUM(CASE WHEN s.ExecState = 'OPEN' THEN s.Qty ELSE 0 END) AS [Open],
      SUM(CASE WHEN s.ExecState IN ('IN_RFQ', 'QUOTED') THEN s.Qty ELSE 0 END) AS InRfq,
      SUM(CASE WHEN s.ExecState = 'AWARDED' THEN s.Qty ELSE 0 END) AS Awarded,
      SUM(CASE WHEN s.ExecState IN ('HANDED_OFF', 'PO_PREPARATION') THEN s.Qty ELSE 0 END) AS HandedOff,
      SUM(CASE WHEN s.ExecState = 'PO_SUBMITTED' THEN s.Qty ELSE 0 END) AS PoSubmitted,
      SUM(CASE WHEN s.ExecState = 'PO_CREATED' THEN s.Qty ELSE 0 END) AS PoCreated,
      SUM(CASE WHEN s.ExecState = 'CANCELLED' AND s.CancelOrigin = 'SALES' THEN s.Qty ELSE 0 END) AS CancelledSales,
      SUM(CASE WHEN s.ExecState = 'CANCELLED' AND s.CancelOrigin = 'PROCUREMENT' THEN s.Qty ELSE 0 END) AS NotSourced,
      SUM(CASE WHEN s.ExecState = 'CANCELLED' AND s.CancelOrigin = 'CHANGE' THEN s.Qty ELSE 0 END) AS CancelledChange,
      SUM(CASE WHEN s.ArrivedVia = 'MERGE' THEN s.Qty ELSE 0 END) AS MergedIn,
      SUM(CASE WHEN s.ExecState = 'MERGED_OUT' THEN s.Qty ELSE 0 END) AS MergedOut,
      SUM(CASE WHEN s.BusinessOrigin = 'PROCUREMENT' THEN s.Qty ELSE 0 END) AS ProcAdded
    FROM scm.DemandLine l JOIN scm.DemandWeek w ON w.DemandWeekId = l.DemandWeekId LEFT JOIN scm.QtySlice s ON s.LineId = l.LineId
    WHERE l.DemandId = ${demandId} AND l.IsActive = 1
    GROUP BY l.LineId, w.EtdWeek, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, l.Unit, l.RequestedQty
    ORDER BY w.EtdWeek, l.LineId`.execute(db)).rows;
  const pos = (await sql<{ DemandLineId: string; SapPoNumber: string }>`
    SELECT DISTINCT i.DemandLineId, p.SapPoNumber FROM scm.PoDraftItem i JOIN scm.PoDraft p ON p.PoDraftId = i.PoDraftId
    WHERE i.DemandId = ${demandId} AND p.Status = 'CREATED'`.execute(db)).rows;
  const weeks = (await sql<{ EtdWeek: string; Current: number | null; Awarded: number; Ordered: number }>`
    WITH wk AS (
      SELECT EtdWeek FROM scm.DemandWeek WHERE DemandId = ${demandId}
      UNION SELECT s.ApprovedEtdWeek FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId WHERE l.DemandId = ${demandId}
      UNION SELECT sh.EtdWeek FROM scm.AwardShipment sh JOIN scm.AwardBatch b ON b.AwardBatchId = sh.AwardBatchId WHERE b.DemandId = ${demandId})
    SELECT wk.EtdWeek, dw.ContainerCount AS [Current],
      ISNULL((SELECT SUM(sh.ContainerCount) FROM scm.AwardShipment sh JOIN scm.AwardBatch b ON b.AwardBatchId = sh.AwardBatchId WHERE b.DemandId = ${demandId} AND sh.EtdWeek = wk.EtdWeek AND sh.IsActive = 1), 0) AS Awarded,
      ISNULL((SELECT SUM(sh.ContainerCount) FROM scm.AwardShipment sh JOIN scm.AwardBatch b ON b.AwardBatchId = sh.AwardBatchId
        WHERE b.DemandId = ${demandId} AND sh.EtdWeek = wk.EtdWeek AND sh.IsActive = 1
          AND EXISTS (SELECT 1 FROM scm.Handoff h JOIN scm.PoDraft p ON p.HandoffId = h.HandoffId WHERE h.AwardBatchId = sh.AwardBatchId AND h.SupplierCode = sh.SupplierCode AND p.Status = 'CREATED')), 0) AS Ordered
    FROM wk LEFT JOIN scm.DemandWeek dw ON dw.DemandId = ${demandId} AND dw.EtdWeek = wk.EtdWeek ORDER BY wk.EtdWeek`.execute(db)).rows;
  return {
    demandId: String(d.DemandId), demandNo: d.DemandNo, companyCode: d.CompanyCode, baselineAvailable: !!base, acceptedAt: d.AcceptedAt?.toISOString() ?? null,
    lines: lines.map((l) => {
      const b = base?.lines.find((x) => x.lineId === String(l.LineId));
      return {
        lineId: String(l.LineId), week: l.EtdWeek, label: [l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode].filter(Boolean).join(' '), unit: l.Unit,
        baseline: b ? b.requestedQty : null, requested: q3(l.RequestedQty), open: q3(l.Open), inRfq: q3(l.InRfq), awarded: q3(l.Awarded), handedOff: q3(l.HandedOff),
        poSubmitted: q3(l.PoSubmitted), poCreated: q3(l.PoCreated), cancelledSales: q3(l.CancelledSales), notSourced: q3(l.NotSourced), cancelledChange: q3(l.CancelledChange),
        mergedIn: q3(l.MergedIn), mergedOut: q3(l.MergedOut), procurementAdded: q3(l.ProcAdded),
        sapPos: pos.filter((p) => String(p.DemandLineId) === String(l.LineId)).map((p) => p.SapPoNumber),
      };
    }),
    weeks: weeks.map((w) => ({
      week: w.EtdWeek, baseline: base?.weeks.find((x) => x.etdWeek === w.EtdWeek)?.containerCount ?? null, current: w.Current, awarded: Number(w.Awarded), ordered: Number(w.Ordered),
    })),
  };
}

/** Every change request with its decision, application and quantities (plan §8.2 v_cr_register). */
export async function crRegister(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const rows = (await sql<{ CrId: string; CrNo: string; DemandId: string; DemandNo: string; CompanyCode: string; CrType: string; RaisedByDept: string; RaisedBy: string | null; SubmittedAt: Date;
    ReasonCode: string; Comment: string; Status: string; ApplyStatus: string; DecidedBy: string | null; DecidedAt: Date | null; DecisionComment: string | null; Requested: string | null; Approved: string | null; Applied: string | null; Unit: string | null; Units: number }>`
    SELECT c.CrId, c.CrNo, d.DemandId, d.DemandNo, c.CompanyCode, c.CrType, c.RaisedByDept, ru.DisplayName AS RaisedBy, c.SubmittedAt, c.ReasonCode, c.Comment, c.Status, c.ApplyStatus,
      du.DisplayName AS DecidedBy, c.DecidedAt, c.DecisionComment,
      (SELECT SUM(i.RequestedQty) FROM scm.ChangeRequestItem i WHERE i.CrId = c.CrId) AS Requested,
      (SELECT SUM(i.ApprovedQty) FROM scm.ChangeRequestItem i WHERE i.CrId = c.CrId) AS Approved,
      (SELECT SUM(i.AppliedQty) FROM scm.ChangeRequestItem i WHERE i.CrId = c.CrId) AS Applied,
      (SELECT MIN(l.Unit) FROM scm.ChangeRequestItem i JOIN scm.DemandLine l ON l.LineId = i.LineId WHERE i.CrId = c.CrId) AS Unit,
      (SELECT COUNT(DISTINCT l.Unit) FROM scm.ChangeRequestItem i JOIN scm.DemandLine l ON l.LineId = i.LineId WHERE i.CrId = c.CrId) AS Units
    FROM scm.ChangeRequest c JOIN scm.Demand d ON d.DemandId = c.DemandId LEFT JOIN app.[User] ru ON ru.UserId = c.RaisedBy LEFT JOIN app.[User] du ON du.UserId = c.DecidedBy
    WHERE c.CompanyCode IN (${sql.join(companies)}) ${between(sql`c.SubmittedAt`, f)}
      ${f.q ? sql`AND (c.CrNo LIKE ${likeOf(f.q)} OR d.DemandNo LIKE ${likeOf(f.q)})` : sql``}
    ORDER BY c.CrId DESC`.execute(db)).rows;
  // Quantities of one request are only summed when they share one unit (never across units).
  return rows.map((r) => ({ ...r, mixed: Number(r.Units) > 1 })).map((r) => ({
    crId: String(r.CrId), crNo: r.CrNo, demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode, type: r.CrType, raisedByDept: r.RaisedByDept, raisedBy: r.RaisedBy ?? '',
    submittedAt: r.SubmittedAt.toISOString(), reason: r.ReasonCode, comment: r.Comment, status: r.Status, applyStatus: r.ApplyStatus, decidedBy: r.DecidedBy, decidedAt: r.DecidedAt?.toISOString() ?? null,
    decisionComment: r.DecisionComment, responseHours: r.DecidedAt ? Math.round((r.DecidedAt.getTime() - r.SubmittedAt.getTime()) / 36e5 * 10) / 10 : null,
    requested: r.Requested == null || r.mixed ? null : q3(r.Requested), approved: r.Approved == null || r.mixed ? null : q3(r.Approved),
    applied: r.Applied == null || r.mixed ? null : q3(r.Applied), unit: r.mixed ? 'several units' : r.Unit,
  }));
}

export type ExecRow = Awaited<ReturnType<typeof executionSummary>>[number];

/** Slice milestones of the PO-created quantity of demands accepted in the period (split ancestry walked for events before a split). */
export async function sliceMilestones(db: Db, companies: string[], f: ReportFilter): Promise<Milestone[]> {
  return (await sql<Milestone>`
    SET NOCOUNT ON;
    -- 1. Each PO-created slice with its split ancestors, and for each ancestor the moment its child split off (computed once
    --    per step, not per history row: database review 2026-09, 4.9 million → a fraction of the page reads).
    CREATE TABLE #lin (LeafId bigint NOT NULL, AncId bigint NOT NULL, CutAt datetime2 NULL);
    WITH lineage AS (
      SELECT s.SliceId AS LeafId, s.SliceId AS AncId, CAST(NULL AS bigint) AS ChildId FROM scm.QtySlice s
        JOIN scm.DemandLine l ON l.LineId = s.LineId JOIN scm.Demand d ON d.DemandId = l.DemandId
        WHERE s.ExecState = 'PO_CREATED' AND d.CompanyCode IN (${sql.join(companies)}) ${acceptedBetween(f)} ${f.q ? sql`AND d.DemandNo LIKE ${likeOf(f.q)}` : sql``}
      UNION ALL
      SELECT lg.LeafId, p.SplitFromSliceId, p.SliceId FROM lineage lg JOIN scm.QtySlice p ON p.SliceId = lg.AncId WHERE p.SplitFromSliceId IS NOT NULL)
    INSERT INTO #lin (LeafId, AncId, CutAt)
    SELECT lg.LeafId, lg.AncId, CASE WHEN lg.ChildId IS NULL THEN NULL ELSE (SELECT MIN(c.ChangedAt) FROM scm.SliceHistory c WHERE c.SliceId = lg.ChildId) END
    FROM lineage lg OPTION (MAXRECURSION 1000);
    CREATE CLUSTERED INDEX IX_lin ON #lin (AncId);
    -- 2. The milestones: an ancestor's events count only until its child split off (the parent lives on with its own path).
    WITH m AS (
      SELECT lg.LeafId,
        MIN(CASE WHEN h.TriggerName = 'ADD_TO_RFQ' THEN h.ChangedAt END) AS InRfq,
        MIN(CASE WHEN h.TriggerName = 'QUOTE_RECORDED' THEN h.ChangedAt END) AS Quoted,
        MIN(CASE WHEN h.TriggerName = 'AWARD' THEN h.ChangedAt END) AS Awarded,
        MIN(CASE WHEN h.TriggerName = 'HANDOFF_SEND' THEN h.ChangedAt END) AS HandedOff,
        MAX(CASE WHEN h.TriggerName = 'HANDOFF_ACCEPT' THEN h.ChangedAt END) AS HandoffAccepted,
        MIN(CASE WHEN h.TriggerName = 'SAP_CONFIRMED' THEN h.ChangedAt END) AS PoCreated
      FROM #lin lg JOIN scm.SliceHistory h ON h.SliceId = lg.AncId AND (lg.CutAt IS NULL OR h.ChangedAt <= lg.CutAt)
        AND h.TriggerName IN ('ADD_TO_RFQ', 'QUOTE_RECORDED', 'AWARD', 'HANDOFF_SEND', 'HANDOFF_ACCEPT', 'SAP_CONFIRMED')
      GROUP BY lg.LeafId)
    -- aggregated first, then one confirmed ETD per slice (was evaluated before grouping: seconds of CPU)
    SELECT d.DemandId, l.Unit, s.Qty, s.EffectiveSubmittedAt AS ClockStart, d.AcceptedAt, m.InRfq, m.Quoted, m.Awarded, m.HandedOff, m.HandoffAccepted, m.PoCreated, e.ConfirmedEtd
    FROM m JOIN scm.QtySlice s ON s.SliceId = m.LeafId JOIN scm.DemandLine l ON l.LineId = s.LineId JOIN scm.Demand d ON d.DemandId = l.DemandId
    OUTER APPLY (SELECT MIN(sh.ConfirmedEtd) AS ConfirmedEtd FROM scm.AwardItem ai JOIN scm.AwardShipment sh ON sh.AwardBatchId = ai.AwardBatchId AND sh.SupplierCode = ai.SupplierCode AND sh.EtdWeek = ai.EtdWeek
      WHERE ai.AwardItemId = s.AwardItemId) e;
    DROP TABLE #lin;`.execute(db)).rows;
}

/** The performance dashboard: headline per unit + diagnostics (plan §8.3). */
export async function performance(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const [settings, summary, milestones] = await Promise.all([loadWfSettings(db), executionSummary(db, actor, f), sliceMilestones(db, companies, f)]);
  const [cr, ack, ho, sap] = await Promise.all([
    sql<{ Dept: string; N: number; Avg: number | null }>`SELECT CASE c.RaisedByDept WHEN 'SALES' THEN 'Procurement' ELSE 'Sales' END AS Dept, COUNT(*) AS N,
      AVG(DATEDIFF(minute, c.SubmittedAt, c.DecidedAt) / 60.0) AS [Avg] FROM scm.ChangeRequest c WHERE c.CompanyCode IN (${sql.join(companies)}) AND c.DecidedAt IS NOT NULL ${between(sql`c.SubmittedAt`, f)} ${demandNoLike(sql`c.DemandId`, f)} GROUP BY c.RaisedByDept`.execute(db),
    sql<{ Batches: number; Resets: number; WithoutAck: number; AvgHours: number | null }>`SELECT COUNT(*) AS Batches, ISNULL(SUM(a.Revision - 1), 0) AS Resets, ISNULL(SUM(CAST(a.HandedOffWithoutAck AS int)), 0) AS WithoutAck,
      AVG(CASE WHEN a.Status IN ('ACKNOWLEDGED', 'ACKNOWLEDGED_LATE') THEN DATEDIFF(minute, b.CreatedAt, a.RespondedAt) / 60.0 END) AS AvgHours
      FROM scm.AwardBatch b JOIN scm.SalesAck a ON a.AwardBatchId = b.AwardBatchId WHERE b.CompanyCode IN (${sql.join(companies)}) ${between(sql`b.CreatedAt`, f)} ${demandNoLike(sql`b.DemandId`, f)}`.execute(db),
    sql<{ Handoffs: number; Manual: number; Auto: number; Sku: number; WithoutAck: number }>`SELECT COUNT(*) AS Handoffs, ISNULL(SUM(CASE WHEN Status = 'RETURNED' AND ReturnedBy IS NOT NULL THEN 1 ELSE 0 END), 0) AS Manual,
      ISNULL(SUM(CASE WHEN Status = 'RETURNED' AND ReturnedBy IS NULL THEN 1 ELSE 0 END), 0) AS Auto, ISNULL(SUM(CASE WHEN ReturnReason = 'SKU_ISSUE' THEN 1 ELSE 0 END), 0) AS Sku,
      ISNULL(SUM(CAST(SentWithoutAck AS int)), 0) AS WithoutAck FROM scm.Handoff h WHERE CompanyCode IN (${sql.join(companies)}) ${between(sql`SentAt`, f)}
      ${demandNoLike(sql`(SELECT qb.DemandId FROM scm.AwardBatch qb WHERE qb.AwardBatchId = h.AwardBatchId)`, f)}`.execute(db),
    sql<{ Submitted: number; FirstReply: number; Reconciled: number; Manual: number; Rejected: number; Unknown: number }>`SELECT COUNT(*) AS Submitted,
      ISNULL(SUM(CASE WHEN Resolution = 'SAP_REPLY' THEN 1 ELSE 0 END), 0) AS FirstReply, ISNULL(SUM(CASE WHEN Resolution = 'RECONCILED' THEN 1 ELSE 0 END), 0) AS Reconciled,
      ISNULL(SUM(CASE WHEN Resolution IN ('MANUAL_CREATED', 'MANUAL_NOT_CREATED') THEN 1 ELSE 0 END), 0) AS Manual, ISNULL(SUM(CASE WHEN Status = 'REJECTED' THEN 1 ELSE 0 END), 0) AS Rejected,
      ISNULL(SUM(CASE WHEN Status = 'UNKNOWN' THEN 1 ELSE 0 END), 0) AS Unknown FROM scm.PoDraft p WHERE CompanyCode IN (${sql.join(companies)}) AND Status IN ('SUBMITTED', 'UNKNOWN', 'CREATED', 'REJECTED') ${between(sql`SubmittedAt`, f)}
      ${demandNoLike(sql`(SELECT qb.DemandId FROM scm.Handoff qh JOIN scm.AwardBatch qb ON qb.AwardBatchId = qh.AwardBatchId WHERE qh.HandoffId = p.HandoffId)`, f)}`.execute(db),
  ]);
  const a = ack.rows[0]; const h = ho.rows[0]; const s = sap.rows[0];
  return {
    onTimeDays: settings.kpiOnTimeDaysBeforeEtd,
    headline: headlineOf(summary, milestones, settings.kpiOnTimeDaysBeforeEtd),
    crResponse: cr.rows.map((r) => ({ decidedBy: r.Dept, decided: Number(r.N), avgHours: r.Avg == null ? null : Math.round(Number(r.Avg) * 10) / 10 })),
    acknowledgement: { batches: Number(a.Batches), resets: Number(a.Resets), handedOffWithoutAck: Number(a.WithoutAck), avgHoursToAck: a.AvgHours == null ? null : Math.round(Number(a.AvgHours) * 10) / 10 },
    handoffs: { handoffs: Number(h.Handoffs), returnedByPoTeam: Number(h.Manual), returnedAutomatically: Number(h.Auto), skuIssues: Number(h.Sku), sentWithoutAck: Number(h.WithoutAck), returnRate: ratio(Number(h.Manual), Number(h.Handoffs)) },
    sap: { submitted: Number(s.Submitted), createdFirstReply: Number(s.FirstReply), createdAfterReconcile: Number(s.Reconciled), manualResolutions: Number(s.Manual), rejected: Number(s.Rejected), unknownNow: Number(s.Unknown),
      firstReplyRate: ratio(Number(s.FirstReply), Number(s.Submitted)) },
  };
}
