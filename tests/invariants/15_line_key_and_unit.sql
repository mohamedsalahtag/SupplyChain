-- 15. Line key and unit: no week has two active lines with the same key; one unit per key per demand.
SELECT 'duplicate key in week' AS problem, DemandWeekId AS id, LineKey FROM scm.DemandLine WHERE IsActive = 1
GROUP BY DemandWeekId, LineKey HAVING COUNT(*) > 1
UNION ALL
SELECT 'several units for one key', DemandId, LineKey FROM scm.DemandLine WHERE IsActive = 1
GROUP BY DemandId, LineKey HAVING COUNT(DISTINCT Unit) > 1;
