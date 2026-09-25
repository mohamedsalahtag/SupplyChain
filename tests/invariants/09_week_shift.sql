-- 9. Week shift (spec 19): while a shift waits for Sales the line remembers its old week and its quantity keeps it;
-- after approval, the quantity still in the RFQ line is approved for the new week.
SELECT 'pending week shift without the old week' AS problem, l.RfqLineId AS id, l.ProposedEtdWeek AS detail
FROM scm.RfqLine l JOIN scm.ChangeRequest c ON c.CrId = l.WeekShiftCrId
WHERE c.Status = 'SUBMITTED' AND l.PreviousEtdWeek IS NULL
UNION ALL
SELECT 'applied week shift: quantity not approved for the new week', s.SliceId, s.ApprovedEtdWeek + ' / ' + l.ProposedEtdWeek
FROM scm.RfqLine l JOIN scm.ChangeRequest c ON c.CrId = l.WeekShiftCrId JOIN scm.QtySlice s ON s.RfqLineId = l.RfqLineId
WHERE c.Status IN ('APPROVED', 'PARTIALLY_APPROVED') AND s.ExecState IN ('IN_RFQ', 'QUOTED', 'AWARDED') AND s.ApprovedEtdWeek <> l.ProposedEtdWeek;
