/** Compares the demand status from vDemandStatus with the original rule computed from vLineLedger (0009) for every demand. */
import { sql } from 'kysely';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/db.js';
const db = createDb({ ...loadConfig(), DB_NAME: process.env.CHECK_DB || 'supplychain_perf' });
const r = (await sql<{ total: number; diff: number }>`
  WITH old AS (
    SELECT d.DemandId, CASE
      WHEN d.WorkflowStatus <> 'ACCEPTED' THEN d.WorkflowStatus
      WHEN t.Requested > 0 AND t.Final = t.Requested AND t.MergedOut = t.Requested THEN 'MERGED'
      WHEN t.Requested > 0 AND t.Final = t.Requested AND t.PoCreated > 0 AND t.Cancelled > 0 THEN 'CLOSED_PARTIALLY_EXECUTED'
      WHEN t.Requested > 0 AND t.Final = t.Requested AND t.PoCreated > 0 THEN 'CLOSED_FULLY_EXECUTED'
      WHEN t.Requested > 0 AND t.Final = t.Requested THEN 'CANCELLED'
      WHEN t.InProgress = 0 AND t.PoCreated = 0 THEN 'NOT_STARTED'
      WHEN t.OpenQty > 0 THEN 'PARTIALLY_IN_EXECUTION' ELSE 'FULLY_IN_EXECUTION' END AS Status
    FROM scm.Demand d OUTER APPLY (
      SELECT ISNULL(SUM(RequestedQty), 0) AS Requested, ISNULL(SUM(OpenQty), 0) AS OpenQty,
        ISNULL(SUM(InRfqQty + QuotedQty + AwardedQty + HandedOffQty + PoPrepQty + PoSubmittedQty), 0) AS InProgress,
        ISNULL(SUM(PoCreatedQty), 0) AS PoCreated, ISNULL(SUM(CancelledQty), 0) AS Cancelled, ISNULL(SUM(MergedOutQty), 0) AS MergedOut,
        ISNULL(SUM(PoCreatedQty + CancelledQty + MergedOutQty), 0) AS Final FROM scm.vLineLedger WHERE DemandId = d.DemandId) t)
  SELECT COUNT(*) AS total, SUM(CASE WHEN o.Status <> n.Status THEN 1 ELSE 0 END) AS diff FROM old o JOIN scm.vDemandStatus n ON n.DemandId = o.DemandId`.execute(db)).rows[0];
const by = (await sql<{ Status: string; n: number }>`SELECT Status, COUNT(*) AS n FROM scm.vDemandStatus GROUP BY Status`.execute(db)).rows;
console.log('STATUS', JSON.stringify(r), JSON.stringify(by));
await db.destroy();
