-- Database review 2026-09-25: the demand status (vDemandStatus) needs the sum of every slice of every line. Filtering or
-- paging the demands list by status therefore summed the whole ledger of the company (~140,000 page reads per call on
-- 20,000 demands). SQL Server now keeps those totals per demand itself (indexed views, maintained on every slice write),
-- so the status reads one small row per demand. Same rule as before; a DB test keeps it equal to deriveStatus.
CREATE VIEW scm.vDemandSliceTotals WITH SCHEMABINDING AS
SELECT l.DemandId,
  SUM(CASE WHEN s.ExecState = 'OPEN' THEN s.Qty ELSE 0 END) AS OpenQty,
  SUM(CASE WHEN s.ExecState IN ('IN_RFQ', 'QUOTED', 'AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED') THEN s.Qty ELSE 0 END) AS InProgress,
  SUM(CASE WHEN s.ExecState = 'PO_CREATED' THEN s.Qty ELSE 0 END) AS PoCreated,
  SUM(CASE WHEN s.ExecState = 'CANCELLED' THEN s.Qty ELSE 0 END) AS Cancelled,
  SUM(CASE WHEN s.ExecState = 'MERGED_OUT' THEN s.Qty ELSE 0 END) AS MergedOut,
  COUNT_BIG(*) AS Slices
FROM scm.DemandLine l JOIN scm.QtySlice s ON s.LineId = l.LineId
GROUP BY l.DemandId;
GO
CREATE UNIQUE CLUSTERED INDEX PK_vDemandSliceTotals ON scm.vDemandSliceTotals (DemandId);
GO
CREATE VIEW scm.vDemandRequested WITH SCHEMABINDING AS
SELECT l.DemandId, SUM(l.RequestedQty) AS Requested, COUNT_BIG(*) AS Lines FROM scm.DemandLine l GROUP BY l.DemandId;
GO
CREATE UNIQUE CLUSTERED INDEX PK_vDemandRequested ON scm.vDemandRequested (DemandId);
GO
CREATE OR ALTER VIEW scm.vDemandStatus AS
SELECT d.DemandId,
  CASE
    WHEN d.WorkflowStatus <> 'ACCEPTED' THEN d.WorkflowStatus
    WHEN r.Requested > 0 AND t.Final = r.Requested AND t.MergedOut = r.Requested THEN 'MERGED'
    WHEN r.Requested > 0 AND t.Final = r.Requested AND t.PoCreated > 0 AND t.Cancelled > 0 THEN 'CLOSED_PARTIALLY_EXECUTED'
    WHEN r.Requested > 0 AND t.Final = r.Requested AND t.PoCreated > 0 THEN 'CLOSED_FULLY_EXECUTED'
    WHEN r.Requested > 0 AND t.Final = r.Requested THEN 'CANCELLED'
    WHEN t.InProgress = 0 AND t.PoCreated = 0 THEN 'NOT_STARTED'
    WHEN t.OpenQty > 0 THEN 'PARTIALLY_IN_EXECUTION'
    ELSE 'FULLY_IN_EXECUTION'
  END AS Status
FROM scm.Demand d
OUTER APPLY (SELECT ISNULL(MAX(q.Requested), 0) AS Requested FROM scm.vDemandRequested q WITH (NOEXPAND) WHERE q.DemandId = d.DemandId) r
OUTER APPLY (
  SELECT ISNULL(MAX(v.OpenQty), 0) AS OpenQty, ISNULL(MAX(v.InProgress), 0) AS InProgress, ISNULL(MAX(v.PoCreated), 0) AS PoCreated,
         ISNULL(MAX(v.Cancelled), 0) AS Cancelled, ISNULL(MAX(v.MergedOut), 0) AS MergedOut,
         ISNULL(MAX(v.PoCreated + v.Cancelled + v.MergedOut), 0) AS Final
  FROM scm.vDemandSliceTotals v WITH (NOEXPAND) WHERE v.DemandId = d.DemandId
) t;
GO
