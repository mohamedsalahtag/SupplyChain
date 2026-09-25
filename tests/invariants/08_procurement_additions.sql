-- 8. Procurement additions (spec 19): a Procurement-proposed RFQ line has its Add-to-demand request; while the request
-- waits it holds no quantity; once decided it is either linked to its demand line (approved) or cancelled.
-- (Stage 5 adds: no award on it before the request is applied.)
SELECT 'Procurement RFQ line without its request' AS problem, l.RfqLineId AS id, CAST(l.RfqId AS nvarchar(20)) AS detail
FROM scm.RfqLine l WHERE l.Origin = 'PROCUREMENT' AND l.AddCrId IS NULL
UNION ALL
SELECT 'quantity on a Procurement line before Sales decided', l.RfqLineId, c.Status
FROM scm.RfqLine l JOIN scm.ChangeRequest c ON c.CrId = l.AddCrId
WHERE l.Origin = 'PROCUREMENT' AND c.Status = 'SUBMITTED' AND EXISTS (SELECT 1 FROM scm.QtySlice s WHERE s.RfqLineId = l.RfqLineId)
UNION ALL
SELECT 'decided Procurement line neither linked nor cancelled', l.RfqLineId, c.Status
FROM scm.RfqLine l JOIN scm.ChangeRequest c ON c.CrId = l.AddCrId
WHERE l.Origin = 'PROCUREMENT' AND c.Status NOT IN ('SUBMITTED', 'BLOCKED') AND l.DemandLineId IS NULL AND l.IsCancelled = 0;
