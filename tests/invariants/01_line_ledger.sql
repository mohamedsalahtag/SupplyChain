-- 1. Line ledger: for every line of an ACCEPTED demand, RequestedQty = SUM(slice qty) over all its slices.
SELECT g.LineId, g.RequestedQty, g.SliceTotal
FROM scm.vLineLedger g
JOIN scm.Demand d ON d.DemandId = g.DemandId
WHERE d.WorkflowStatus = 'ACCEPTED' AND g.IsActive = 1 AND g.RequestedQty <> g.SliceTotal;
