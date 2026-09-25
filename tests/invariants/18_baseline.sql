-- 18. Baseline: a submitted demand has BaselineVersion = 1 and a version 1 (unless marked NOT_AVAILABLE for migrated demands).
SELECT d.DemandId, d.BaselineVersion
FROM scm.Demand d
WHERE d.SubmittedAt IS NOT NULL AND d.BaselineStatus = 'AVAILABLE'
  AND (d.BaselineVersion IS NULL OR d.BaselineVersion <> 1
       OR NOT EXISTS (SELECT 1 FROM scm.DemandVersion v WHERE v.DemandId = d.DemandId AND v.VersionNo = 1));
