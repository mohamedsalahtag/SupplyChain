-- 25. Award by containers (spec 20 revision 1): a container group never has more active awarded containers than it has
-- containers, and an active award container has containers and belongs to a group of the batch's demand.
SELECT 'more containers awarded than the group has' AS problem, g.ContainerGroupId AS id, CAST(SUM(c.Containers) AS nvarchar(10)) + ' > ' + CAST(MAX(g.ContainerCount) AS nvarchar(10)) AS detail
FROM scm.AwardContainer c JOIN scm.ContainerGroup g ON g.ContainerGroupId = c.ContainerGroupId
WHERE c.IsActive = 1
GROUP BY g.ContainerGroupId
HAVING SUM(c.Containers) > MAX(g.ContainerCount)
UNION ALL
SELECT 'active award container without containers', c.AwardContainerId, c.SupplierCode
FROM scm.AwardContainer c WHERE c.IsActive = 1 AND c.Containers = 0
UNION ALL
SELECT 'award container of another demand', c.AwardContainerId, CAST(g.DemandId AS nvarchar(20)) + ' / ' + CAST(b.DemandId AS nvarchar(20))
FROM scm.AwardContainer c JOIN scm.ContainerGroup g ON g.ContainerGroupId = c.ContainerGroupId JOIN scm.AwardBatch b ON b.AwardBatchId = c.AwardBatchId
WHERE g.DemandId <> b.DemandId;
