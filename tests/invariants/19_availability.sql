-- 19. Availability. By quantity: per RFQ × supplier × week × material, the active awarded quantity is within what the
-- supplier quoted available — unless every item gives an override reason. By containers (spec 20 revision 1): the limit is
-- the containers the supplier offered for the week; going above is allowed but must be logged (ABOVE_OFFER).
SELECT 'awarded above the quoted availability without a reason' AS problem, b.RfqId AS id,
       i.SupplierCode + ' ' + i.EtdWeek + ' ' + CAST(SUM(i.Qty) AS nvarchar(30)) + ' > ' + CAST(MAX(q.AvailableQty) AS nvarchar(30)) AS detail
FROM scm.AwardItem i JOIN scm.AwardBatch b ON b.AwardBatchId = i.AwardBatchId JOIN scm.SupplierQuote q ON q.QuoteId = i.QuoteId
WHERE i.IsActive = 1 AND i.ByContainers = 0
GROUP BY b.RfqId, i.SupplierCode, i.EtdWeek, i.LineKey
HAVING SUM(i.Qty) > MAX(q.AvailableQty) AND SUM(CASE WHEN i.OverrideReason IS NULL OR i.OverrideReason = '' THEN 1 ELSE 0 END) > 0
UNION ALL
SELECT 'batch awards more containers than offered, not logged', c.AwardBatchId, c.SupplierCode + ' ' + c.EtdWeek + ' ' + CAST(SUM(c.Containers) AS nvarchar(10)) + ' > ' + CAST(MAX(w.ContainersOffered) AS nvarchar(10))
FROM scm.AwardContainer c JOIN scm.AwardBatch b ON b.AwardBatchId = c.AwardBatchId
LEFT JOIN scm.SupplierQuoteWeek w ON w.RfqId = b.RfqId AND w.SupplierCode = c.SupplierCode AND w.EtdWeek = c.EtdWeek
WHERE c.IsActive = 1
GROUP BY c.AwardBatchId, c.SupplierCode, c.EtdWeek
HAVING SUM(c.Containers) > ISNULL(MAX(w.ContainersOffered), 0)
   AND NOT EXISTS (SELECT 1 FROM scm.AwardContainerChange x WHERE x.AwardBatchId = c.AwardBatchId AND x.SupplierCode = c.SupplierCode AND x.EtdWeek = c.EtdWeek AND x.ChangeType = 'ABOVE_OFFER');
