-- 4 (RFQ part). Link consistency: In RFQ / Quoted quantity has an RFQ line — of its own demand line and approved week;
-- Open and Merged-out quantity has none (Stage 5 adds the award links).
SELECT 'in RFQ / quoted without an RFQ line' AS problem, s.SliceId AS id, s.ExecState AS detail
FROM scm.QtySlice s WHERE s.ExecState IN ('IN_RFQ', 'QUOTED') AND s.RfqLineId IS NULL
UNION ALL
SELECT 'open or merged-out quantity still on an RFQ line', s.SliceId, s.ExecState
FROM scm.QtySlice s WHERE s.ExecState IN ('OPEN', 'MERGED_OUT') AND s.RfqLineId IS NOT NULL
UNION ALL
SELECT 'RFQ line of another demand line', s.SliceId, CAST(s.RfqLineId AS nvarchar(20))
FROM scm.QtySlice s JOIN scm.RfqLine l ON l.RfqLineId = s.RfqLineId WHERE l.DemandLineId IS NOT NULL AND l.DemandLineId <> s.LineId
UNION ALL
SELECT 'RFQ line of another week', s.SliceId, s.ApprovedEtdWeek + ' / ' + l.ProposedEtdWeek
FROM scm.QtySlice s JOIN scm.RfqLine l ON l.RfqLineId = s.RfqLineId LEFT JOIN scm.ChangeRequest c ON c.CrId = l.WeekShiftCrId
WHERE s.ExecState IN ('IN_RFQ', 'QUOTED') AND s.ApprovedEtdWeek <> l.ProposedEtdWeek
  AND NOT (c.Status = 'SUBMITTED' AND s.ApprovedEtdWeek = l.PreviousEtdWeek) -- a week shift waiting for Sales (spec 19)
UNION ALL
SELECT 'RFQ of another company than its demand', r.RfqId, r.CompanyCode + ' / ' + d.CompanyCode
FROM scm.Rfq r JOIN scm.Demand d ON d.DemandId = r.DemandId WHERE r.CompanyCode <> d.CompanyCode
UNION ALL
-- award part (Stage 5): Awarded … PO quantity has an award item, of its own RFQ line; nothing earlier has one.
SELECT 'awarded quantity without an award item', s.SliceId, s.ExecState
FROM scm.QtySlice s WHERE s.ExecState IN ('AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED', 'PO_CREATED') AND s.AwardItemId IS NULL
UNION ALL
SELECT 'award item of another RFQ line', s.SliceId, CAST(s.AwardItemId AS nvarchar(20))
FROM scm.QtySlice s JOIN scm.AwardItem i ON i.AwardItemId = s.AwardItemId WHERE s.RfqLineId IS NULL OR s.RfqLineId <> i.RfqLineId
UNION ALL
SELECT 'open / in RFQ / quoted quantity on an award item', s.SliceId, s.ExecState
FROM scm.QtySlice s WHERE s.ExecState IN ('OPEN', 'IN_RFQ', 'QUOTED') AND s.AwardItemId IS NOT NULL;
