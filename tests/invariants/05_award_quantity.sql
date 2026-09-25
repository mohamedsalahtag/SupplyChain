-- 5. Award quantity: an award item's quantity = its awarded quantity (Awarded … PO created; cancelled excluded); inactive = 0.
SELECT 'award item quantity differs from its slices' AS problem, i.AwardItemId AS id, CAST(i.Qty AS nvarchar(30)) + ' / ' + CAST(ISNULL(x.Q, 0) AS nvarchar(30)) AS detail
FROM scm.AwardItem i
LEFT JOIN (SELECT AwardItemId, SUM(Qty) AS Q FROM scm.QtySlice WHERE ExecState IN ('AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED', 'PO_CREATED') GROUP BY AwardItemId) x
  ON x.AwardItemId = i.AwardItemId
WHERE i.Qty <> ISNULL(x.Q, 0) OR (i.IsActive = 0 AND i.Qty <> 0) OR (i.IsActive = 1 AND i.Qty = 0);
