-- 10 (count part). Shipments: every supplier × week with active awarded quantity in a batch has an active shipment
-- with at least 1 container; an active shipment has active awarded quantity.
SELECT 'awarded supplier × week without a shipment' AS problem, i.AwardBatchId AS id, i.SupplierCode + ' ' + i.EtdWeek AS detail
FROM scm.AwardItem i
WHERE i.IsActive = 1 AND NOT EXISTS (SELECT 1 FROM scm.AwardShipment s WHERE s.AwardBatchId = i.AwardBatchId AND s.SupplierCode = i.SupplierCode
  AND s.EtdWeek = i.EtdWeek AND s.IsActive = 1 AND s.ContainerCount >= 1)
UNION ALL
SELECT 'active shipment with nothing awarded', s.ShipmentId, s.SupplierCode + ' ' + s.EtdWeek
FROM scm.AwardShipment s
WHERE s.IsActive = 1 AND NOT EXISTS (SELECT 1 FROM scm.AwardItem i WHERE i.AwardBatchId = s.AwardBatchId AND i.SupplierCode = s.SupplierCode AND i.EtdWeek = s.EtdWeek AND i.IsActive = 1);
