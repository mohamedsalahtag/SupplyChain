-- Database review 2026-09-26, reverting 0027: keeping aggregate indexed views up to date takes key-range locks
-- (LCK_M_RS_U) when a demand's first line or slice is written, so demands submitted or accepted at the same time queued
-- behind each other for the whole transaction (4 parallel submits: 4.6 → 10.7 s). The demands list now computes the
-- status for its page only, so the simpler view of 0026 (summed from the lines and slices, covered by
-- IX_DemandLine_Demand and IX_QtySlice_LineState) is enough; only a status filter sums every demand (~0.2 s at 20,000).
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
OUTER APPLY (SELECT ISNULL(SUM(l.RequestedQty), 0) AS Requested FROM scm.DemandLine l WHERE l.DemandId = d.DemandId) r
OUTER APPLY (
  SELECT ISNULL(SUM(CASE WHEN s.ExecState = 'OPEN' THEN s.Qty END), 0) AS OpenQty,
         ISNULL(SUM(CASE WHEN s.ExecState IN ('IN_RFQ', 'QUOTED', 'AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED') THEN s.Qty END), 0) AS InProgress,
         ISNULL(SUM(CASE WHEN s.ExecState = 'PO_CREATED' THEN s.Qty END), 0) AS PoCreated,
         ISNULL(SUM(CASE WHEN s.ExecState = 'CANCELLED' THEN s.Qty END), 0) AS Cancelled,
         ISNULL(SUM(CASE WHEN s.ExecState = 'MERGED_OUT' THEN s.Qty END), 0) AS MergedOut,
         ISNULL(SUM(CASE WHEN s.ExecState IN ('PO_CREATED', 'CANCELLED', 'MERGED_OUT') THEN s.Qty END), 0) AS Final
  FROM scm.DemandLine l JOIN scm.QtySlice s ON s.LineId = l.LineId WHERE l.DemandId = d.DemandId
) t;
GO
DROP VIEW scm.vDemandSliceTotals;
DROP VIEW scm.vDemandRequested;
GO
