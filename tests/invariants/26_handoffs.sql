-- 26. Handoffs (spec 22; plan invariants 4 handoff part and 10 ETD part): handed-off / PO-preparation quantity belongs to an
-- open handoff of its own award and supplier, in the matching state; quantity before or after that is not linked to one;
-- an open handoff's shipments all have a confirmed ETD.
SELECT 'handed-off quantity without an open handoff' AS problem, s.SliceId AS id, s.ExecState AS detail
FROM scm.QtySlice s LEFT JOIN scm.Handoff h ON h.HandoffId = s.HandoffId
WHERE s.ExecState IN ('HANDED_OFF', 'PO_PREPARATION') AND (h.HandoffId IS NULL OR h.Status NOT IN ('HANDED_OFF', 'ACCEPTED'))
UNION ALL
SELECT 'handed-off quantity in the wrong state for its handoff', s.SliceId, s.ExecState + ' / ' + h.Status
FROM scm.QtySlice s JOIN scm.Handoff h ON h.HandoffId = s.HandoffId
WHERE (s.ExecState = 'HANDED_OFF' AND h.Status <> 'HANDED_OFF') OR (s.ExecState = 'PO_PREPARATION' AND h.Status <> 'ACCEPTED')
UNION ALL
SELECT 'handoff of another award or supplier', s.SliceId, h.HoNo
FROM scm.QtySlice s JOIN scm.Handoff h ON h.HandoffId = s.HandoffId JOIN scm.AwardItem i ON i.AwardItemId = s.AwardItemId
WHERE i.AwardBatchId <> h.AwardBatchId OR i.SupplierCode <> h.SupplierCode
UNION ALL
SELECT 'quantity before handoff still linked to a handoff', s.SliceId, CAST(s.HandoffId AS nvarchar(20))
FROM scm.QtySlice s WHERE s.ExecState IN ('OPEN', 'IN_RFQ', 'QUOTED', 'AWARDED', 'CANCELLED') AND s.HandoffId IS NOT NULL
UNION ALL
SELECT 'open handoff with a shipment lacking the confirmed ETD', h.HandoffId, sh.EtdWeek
FROM scm.Handoff h JOIN scm.AwardShipment sh ON sh.AwardBatchId = h.AwardBatchId AND sh.SupplierCode = h.SupplierCode AND sh.IsActive = 1
WHERE h.Status IN ('HANDED_OFF', 'ACCEPTED') AND sh.ConfirmedEtd IS NULL;
