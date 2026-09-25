-- 16. Company code: a merge never mixes company codes (RFQ and PO parts come with Stages 4 and 7).
SELECT 'merge across companies' AS problem, m.MergeId AS id, s.CompanyCode + ' / ' + t.CompanyCode AS detail
FROM scm.MergeRecord m JOIN scm.Demand s ON s.DemandId = m.SourceDemandId JOIN scm.Demand t ON t.DemandId = m.TargetDemandId
WHERE s.CompanyCode <> t.CompanyCode OR m.CompanyCode <> t.CompanyCode;
