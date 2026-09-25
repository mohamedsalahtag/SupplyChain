-- Database review 2026-09-25 (continued), measured on 20,000 demands.

-- My work: only open items are ever listed; closed ones pile up with time (200,000 in the test). Index the open ones only.
CREATE INDEX IX_InboxItem_OpenItems ON scm.InboxItem (Permission, CompanyCode)
  INCLUDE (ItemType, Category, DueAt, CreatedAt, ExcludeUserId, RaisedBy, IsOpen) WHERE IsOpen = 1; -- IsOpen included: without it SQL Server looks rows up anyway
-- Opening/closing an item finds it by its object (with IsOpen = 1 written as a literal in the code, so the filtered
-- unique index UX_InboxItem_OneOpen is usable; this one covers any other lookup by object).
CREATE INDEX IX_InboxItem_Entity ON scm.InboxItem (EntityType, EntityId, ItemType) INCLUDE (IsOpen);
GO

-- Demand status: the same rule as before (deriveStatus in TypeScript; a DB test keeps them equal), but summed straight
-- from the lines and slices of the demand. It went through vLineLedger, which also grouped by the computed line key
-- and joined the weeks — work the status never uses (140,000–220,000 page reads per demands-list call on 20,000 demands).
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
