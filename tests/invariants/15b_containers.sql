-- 15b. Containers (spec 12): before acceptance, a week's container count = the sum of its groups' counts,
-- and each line's quantity = the sum of the computed quantities of its key in that week's groups.
SELECT 'week containers' AS problem, w.DemandWeekId AS id, CAST(w.ContainerCount AS bigint) AS stored, CAST(g.n AS bigint) AS expected
FROM scm.DemandWeek w
JOIN scm.Demand d ON d.DemandId = w.DemandId
CROSS APPLY (SELECT SUM(ContainerCount) AS n, COUNT(*) AS groups FROM scm.ContainerGroup WHERE DemandWeekId = w.DemandWeekId) g
WHERE d.WorkflowStatus <> 'ACCEPTED' AND g.groups > 0 AND w.ContainerCount <> g.n
UNION ALL
SELECT 'line quantity', COALESCE(l.LineId, 0), ISNULL(l.RequestedQty, 0), ISNULL(c.q, 0)
FROM (SELECT g.DemandWeekId, i.LineKey, SUM(i.ComputedQty) AS q
      FROM scm.ContainerGroupItem i JOIN scm.ContainerGroup g ON g.ContainerGroupId = i.ContainerGroupId
      GROUP BY g.DemandWeekId, i.LineKey) c
FULL JOIN (SELECT l.* FROM scm.DemandLine l JOIN scm.Demand d ON d.DemandId = l.DemandId
           WHERE d.WorkflowStatus <> 'ACCEPTED' AND l.IsActive = 1
             AND EXISTS (SELECT 1 FROM scm.ContainerGroup g WHERE g.DemandWeekId = l.DemandWeekId)) l
  ON l.DemandWeekId = c.DemandWeekId AND l.LineKey = c.LineKey
WHERE ISNULL(l.RequestedQty, 0) <> ISNULL(c.q, 0)
  AND NOT EXISTS (SELECT 1 FROM scm.DemandWeek w JOIN scm.Demand d ON d.DemandId = w.DemandId
                  WHERE w.DemandWeekId = c.DemandWeekId AND d.WorkflowStatus = 'ACCEPTED');
