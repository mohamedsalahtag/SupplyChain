-- 6. Holds: at most one open change request per line and per week (the keys enforce it); every hold belongs to a
-- Submitted CR, and the line's hold flag matches its hold row.
SELECT 'hold of a CR that is not open' AS problem, h.LineId AS id, c.Status
FROM scm.LineHold h JOIN scm.ChangeRequest c ON c.CrId = h.CrId WHERE c.Status <> 'SUBMITTED'
UNION ALL
SELECT 'week hold of a CR that is not open', h.DemandId, c.Status
FROM scm.WeekHold h JOIN scm.ChangeRequest c ON c.CrId = h.CrId WHERE c.Status <> 'SUBMITTED'
UNION ALL
SELECT 'line flag without hold row', l.LineId, CAST(l.ChangeHoldCrId AS nvarchar(20))
FROM scm.DemandLine l LEFT JOIN scm.LineHold h ON h.LineId = l.LineId AND h.CrId = l.ChangeHoldCrId
WHERE l.ChangeHoldCrId IS NOT NULL AND h.LineId IS NULL
UNION ALL
SELECT 'hold row without line flag', h.LineId, CAST(h.CrId AS nvarchar(20))
FROM scm.LineHold h JOIN scm.DemandLine l ON l.LineId = h.LineId WHERE ISNULL(l.ChangeHoldCrId, 0) <> h.CrId;
