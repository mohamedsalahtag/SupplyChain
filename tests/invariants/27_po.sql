-- 27. PO drafts (spec 23; plan invariants 11, 12, 13, 17, 20, 21).
-- 11 SKU allocation: an award item in a validated-or-later draft has active SKU allocations adding up to its quantity.
SELECT 'SKU allocations do not add up to the award item' AS problem, i.AwardItemId AS id, CAST(i.Qty AS nvarchar(30)) + ' / ' + CAST(ISNULL(a.Q, 0) AS nvarchar(30)) AS detail
FROM scm.AwardItem i
LEFT JOIN (SELECT AwardItemId, SUM(Qty) AS Q FROM scm.AwardItemSku WHERE IsActive = 1 GROUP BY AwardItemId) a ON a.AwardItemId = i.AwardItemId
WHERE i.IsActive = 1 AND EXISTS (SELECT 1 FROM scm.PoDraftItem x JOIN scm.PoDraft d ON d.PoDraftId = x.PoDraftId
                                 WHERE x.AwardItemId = i.AwardItemId AND d.Status IN ('VALIDATED', 'SUBMITTED', 'UNKNOWN', 'CREATED'))
  AND i.Qty <> ISNULL(a.Q, 0)
UNION ALL
-- 12 PO quantity: per live draft and award item, the items add up to the award item quantity.
SELECT 'PO draft quantity differs from the award item', d.PoDraftId, d.PoDraftNo + ' ' + CAST(x.AwardItemId AS nvarchar(20))
FROM scm.PoDraft d JOIN (SELECT PoDraftId, AwardItemId, SUM(Qty) AS Q FROM scm.PoDraftItem GROUP BY PoDraftId, AwardItemId) x ON x.PoDraftId = d.PoDraftId
JOIN scm.AwardItem i ON i.AwardItemId = x.AwardItemId
WHERE d.Status IN ('VALIDATED', 'SUBMITTED', 'UNKNOWN', 'CREATED') AND x.Q <> i.Qty
UNION ALL
-- 13 Post-PO lock: quantity submitted to SAP is never split or re-cut afterwards.
SELECT 'quantity changed after PO submit', s.SliceId, s.ExecState
FROM scm.QtySlice s
WHERE s.ExecState IN ('PO_SUBMITTED', 'PO_CREATED')
  AND EXISTS (SELECT 1 FROM scm.SliceHistory h WHERE h.SliceId = s.SliceId AND h.Action = 'SPLIT'
              AND h.HistoryId > (SELECT MIN(p.HistoryId) FROM scm.SliceHistory p WHERE p.SliceId = s.SliceId AND p.TriggerName = 'PO_SUBMIT'))
UNION ALL
-- 17 PO container total: a live draft's containers = its handoff's active shipments.
SELECT 'PO containers differ from the shipments', d.PoDraftId, CAST(d.ContainerCount AS nvarchar(10)) + ' / ' + CAST(ISNULL(sh.n, 0) AS nvarchar(10))
FROM scm.PoDraft d JOIN scm.Handoff h ON h.HandoffId = d.HandoffId
OUTER APPLY (SELECT SUM(x.ContainerCount) AS n FROM scm.AwardShipment x WHERE x.AwardBatchId = h.AwardBatchId AND x.SupplierCode = h.SupplierCode AND x.IsActive = 1) sh
WHERE d.Status IN ('VALIDATED', 'SUBMITTED', 'UNKNOWN', 'CREATED') AND d.ContainerCount <> ISNULL(sh.n, 0)
UNION ALL
-- 20 Unknown outcome: a draft submitted or unknown has all its quantity in PO submitted (never unlocked early).
SELECT 'submitted / unknown PO with quantity not in PO submitted', d.PoDraftId, s.ExecState
FROM scm.PoDraft d JOIN scm.QtySlice s ON s.HandoffId = d.HandoffId
WHERE d.Status IN ('SUBMITTED', 'UNKNOWN') AND s.ExecState NOT IN ('PO_SUBMITTED', 'CANCELLED')
UNION ALL
-- ... and a created PO has its quantity in PO created.
SELECT 'created PO with quantity not in PO created', d.PoDraftId, s.ExecState
FROM scm.PoDraft d JOIN scm.QtySlice s ON s.HandoffId = d.HandoffId
WHERE d.Status = 'CREATED' AND s.ExecState NOT IN ('PO_CREATED', 'CANCELLED')
UNION ALL
-- 21 One live PO per handoff (also a unique index).
SELECT 'more than one live PO draft for a handoff', HandoffId, CAST(COUNT(*) AS nvarchar(10))
FROM scm.PoDraft WHERE Status IN ('DRAFT', 'VALIDATED', 'SUBMITTED', 'UNKNOWN', 'CREATED') GROUP BY HandoffId HAVING COUNT(*) > 1
UNION ALL
-- A submission's frozen payload never changes, and exists only for submitted drafts.
SELECT 'SAP submission without a submitted draft', s.SubmissionId, d.Status
FROM scm.SapSubmission s JOIN scm.PoDraft d ON d.PoDraftId = s.PoDraftId WHERE d.Status IN ('DRAFT', 'VALIDATED', 'VOID');
