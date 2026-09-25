-- 23 (invite / quote part). Supplier origin: every invited supplier could supply at least one origin of its RFQ,
-- and every current quote concerns an origin the supplier could supply — as stored when it was recorded.
SELECT 'invited supplier supplies none of the RFQ origins' AS problem, s.RfqId AS id, s.SupplierCode + ': ' + s.OriginsAtInvite AS detail
FROM scm.RfqSupplier s
WHERE NOT EXISTS (SELECT 1 FROM scm.RfqLine l WHERE l.RfqId = s.RfqId AND CHARINDEX(',' + l.OriginCode + ',', ',' + s.OriginsAtInvite + ',') > 0)
UNION ALL
SELECT 'current quote for an origin the supplier did not supply', q.QuoteId, q.SupplierCode + ': ' + q.OriginCode + ' not in ' + q.OriginsAtQuote
FROM scm.SupplierQuote q
WHERE q.IsCurrent = 1 AND CHARINDEX(',' + q.OriginCode + ',', ',' + q.OriginsAtQuote + ',') = 0;
