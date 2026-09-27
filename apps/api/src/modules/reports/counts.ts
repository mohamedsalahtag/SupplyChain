/**
 * The row counts on the Reports tab titles (spec 24): COUNT queries only, with the same filter, scope and rows as each tab's
 * report, so the page does not run four full reports just to label its tabs. Each tab loads its own data when it is opened.
 */
import { sql } from 'kysely';
import type { Actor } from '../workflow/access.js';
import type { Db } from '../workflow/tx.js';
import { arrivalsScope, scorecardPeriod } from './insights.js';
import { between, likeOf, scope, type ReportFilter } from './reports.js';

export async function reportCounts(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const co = sql.join(companies);
  const like = f.q ? likeOf(f.q) : null;
  const arr = arrivalsScope(companies, f);
  const p = scorecardPeriod(f);
  const [execution, crs, arrivals, suppliers] = await Promise.all([
    // executionSummary: one row per accepted demand × unit that has slices
    sql<{ N: number }>`SELECT COUNT(*) AS N FROM (
        SELECT d.DemandId, l.Unit FROM scm.Demand d JOIN scm.DemandLine l ON l.DemandId = d.DemandId JOIN scm.QtySlice s ON s.LineId = l.LineId
        WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${co}) ${between(sql`d.AcceptedAt`, f)} ${like ? sql`AND d.DemandNo LIKE ${like}` : sql``}
        GROUP BY d.DemandId, l.Unit) x`.execute(db),
    // crRegister
    sql<{ N: number }>`SELECT COUNT(*) AS N FROM scm.ChangeRequest c JOIN scm.Demand d ON d.DemandId = c.DemandId
      WHERE c.CompanyCode IN (${co}) ${between(sql`c.SubmittedAt`, f)} ${like ? sql`AND (c.CrNo LIKE ${like} OR d.DemandNo LIKE ${like})` : sql``}`.execute(db),
    // arrivals: the same FROM / WHERE as the list
    sql<{ N: number }>`SELECT COUNT(*) AS N ${arr.from} ${arr.where}`.execute(db),
    // the supplier scorecard: suppliers invited, awarded or handed off in its period, matched on code or name
    sql<{ N: number }>`SELECT COUNT(*) AS N FROM (
        SELECT rs.SupplierCode FROM scm.RfqSupplier rs JOIN scm.Rfq r ON r.RfqId = rs.RfqId WHERE r.CompanyCode IN (${co}) AND r.SentAt IS NOT NULL ${between(sql`r.SentAt`, p)}
        UNION SELECT sh.SupplierCode FROM scm.AwardShipment sh JOIN scm.AwardBatch b ON b.AwardBatchId = sh.AwardBatchId WHERE sh.IsActive = 1 AND b.CompanyCode IN (${co}) ${between(sql`b.CreatedAt`, p)}
        UNION SELECT h.SupplierCode FROM scm.Handoff h WHERE h.CompanyCode IN (${co}) ${between(sql`h.SentAt`, p)}) x
      LEFT JOIN md.Supplier s ON s.SupplierCode = x.SupplierCode
      ${like ? sql`WHERE x.SupplierCode LIKE ${like} OR ISNULL(s.Name, x.SupplierCode) LIKE ${like}` : sql``}`.execute(db),
  ]);
  const n = (r: { rows: { N: number }[] }) => Number(r.rows[0]?.N ?? 0);
  return { execution: n(execution), changeRequests: n(crs), arrivals: n(arrivals), suppliers: n(suppliers) };
}
