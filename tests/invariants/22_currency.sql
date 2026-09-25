-- 22. Currency: the active items of one supplier in one award batch share one currency, the currency of their quotes.
SELECT 'several currencies for one supplier in a batch' AS problem, AwardBatchId AS id, SupplierCode AS detail
FROM scm.AwardItem WHERE IsActive = 1 GROUP BY AwardBatchId, SupplierCode HAVING COUNT(DISTINCT Currency) > 1
UNION ALL
SELECT 'award currency differs from its quote', i.AwardItemId, i.Currency + ' / ' + q.Currency
FROM scm.AwardItem i JOIN scm.SupplierQuote q ON q.QuoteId = i.QuoteId WHERE i.Currency <> q.Currency;
