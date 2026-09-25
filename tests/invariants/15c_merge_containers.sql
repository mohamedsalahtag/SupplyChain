-- 15c. Merge containers (spec 17): the containers a merge moved equal the containers of the groups it copied,
-- and an executed merge's copies and originals are never both active.
SELECT 'moved containers differ from the moved groups' AS problem, w.MergeId AS id, CAST(w.Moved AS nvarchar(20)) + ' / ' + CAST(ISNULL(g.N, 0) AS nvarchar(20)) AS detail
FROM (SELECT MergeId, SUM(ContainersMoved) AS Moved FROM scm.MergeWeek GROUP BY MergeId) w
LEFT JOIN (SELECT MergedInBy, SUM(ContainerCount) AS N FROM scm.ContainerGroup WHERE MergedInBy IS NOT NULL GROUP BY MergedInBy) g ON g.MergedInBy = w.MergeId
WHERE g.N IS NOT NULL AND w.Moved <> g.N -- demands from before container groups have none to compare
UNION ALL
SELECT 'group active on both sides of a merge', c.ContainerGroupId, CAST(c.MergedInBy AS nvarchar(20))
FROM scm.ContainerGroup c JOIN scm.ContainerGroup o ON o.ContainerGroupId = c.SourceGroupId
WHERE c.IsActive = 1 AND o.IsActive = 1;
