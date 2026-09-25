-- 14. Merge lineage: every quantity that arrived by merge points to the quantity it came from, with the SAME
-- business origin and original line/clock, and to its merge. While it is live (not merged out again), its source
-- is Merged out (after an unmerge the source is Open again and the merged-in quantity is Merged out: neutral).
SELECT 'merged-in slice without source or merge' AS problem, s.SliceId AS id, s.ExecState AS detail
FROM scm.QtySlice s WHERE s.ArrivedVia = 'MERGE' AND (s.MergedFromSliceId IS NULL OR s.MergedInBy IS NULL)
UNION ALL
SELECT 'merged-in slice changed its business origin / original line / clock', s.SliceId, s.BusinessOrigin
FROM scm.QtySlice s JOIN scm.QtySlice f ON f.SliceId = s.MergedFromSliceId
WHERE s.ArrivedVia = 'MERGE'
  AND (f.BusinessOrigin <> s.BusinessOrigin OR f.OriginDemandId <> s.OriginDemandId OR f.OriginLineId <> s.OriginLineId OR f.EffectiveSubmittedAt <> s.EffectiveSubmittedAt)
UNION ALL
SELECT 'live merged-in slice whose source is not merged out', s.SliceId, f.ExecState
FROM scm.QtySlice s JOIN scm.QtySlice f ON f.SliceId = s.MergedFromSliceId
WHERE s.ArrivedVia = 'MERGE' AND s.ExecState <> 'MERGED_OUT' AND f.ExecState <> 'MERGED_OUT'
UNION ALL
SELECT 'merge item quantity differs from its slices', i.SourceSliceId, CAST(i.Qty AS nvarchar(30))
FROM scm.MergeItem i JOIN scm.QtySlice s ON s.SliceId = i.SourceSliceId
WHERE s.Qty <> i.Qty;
