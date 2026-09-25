-- 7. No award during a hold (historical): no AWARD on a line while a change request holding that line was open
-- (from its submission until its decision / withdrawal).
SELECT 'awarded while the line was held' AS problem, h.SliceId AS id, c.CrNo AS detail
FROM scm.SliceHistory h
JOIN scm.QtySlice s ON s.SliceId = h.SliceId
JOIN scm.ChangeRequestItem ci ON ci.LineId = s.LineId
JOIN scm.ChangeRequest c ON c.CrId = ci.CrId AND c.Status <> 'BLOCKED'
WHERE h.TriggerName = 'AWARD'
  AND h.ChangedAt > c.SubmittedAt
  AND h.ChangedAt < ISNULL(c.DecidedAt, (SELECT MAX(e.OccurredAt) FROM scm.DomainEvent e WHERE e.EntityType = 'CR' AND e.EntityId = CAST(c.CrId AS nvarchar(40)) AND e.EventType = 'CR_WITHDRAWN'));
