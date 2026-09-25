-- 24 (award part). SKU origin: every active SKU allocation's material has the origin (and unit) of its line.
SELECT 'SKU of another origin or unit' AS problem, k.AllocId AS id, k.MaterialCode + ': ' + ISNULL(o.CountryCode, '?') + ' / ' + l.OriginCode AS detail
FROM scm.AwardItemSku k JOIN scm.AwardItem i ON i.AwardItemId = k.AwardItemId JOIN scm.RfqLine l ON l.RfqLineId = i.RfqLineId
JOIN md.Material m ON m.MaterialCode = k.MaterialCode LEFT JOIN scm.RefOrigin o ON o.OriginName = m.Origin
WHERE k.IsActive = 1 AND (ISNULL(o.CountryCode, '') <> l.OriginCode OR m.BaseUnit <> l.Unit);
