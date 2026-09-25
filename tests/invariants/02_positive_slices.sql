-- 2. Positive slices in a valid state (the table CHECKs enforce it; this proves no bypass).
SELECT SliceId, Qty, ExecState FROM scm.QtySlice
WHERE Qty <= 0 OR ExecState NOT IN ('OPEN','IN_RFQ','QUOTED','AWARDED','HANDED_OFF','PO_PREPARATION','PO_SUBMITTED','PO_CREATED','CANCELLED','MERGED_OUT');
