-- Default rows per page is now 50 (user request 2026-09-25). Saved preferences of 25 were mostly the old default
-- (written along with a column choice) or left by the automated tests: they become 50. 100 stays 100.
UPDATE app.UserPreference
SET PrefValue = REPLACE(PrefValue, '"pageSize":25', '"pageSize":50'), UpdatedAt = SYSUTCDATETIME()
WHERE PrefKey LIKE 'table:%' AND PrefValue LIKE '%"pageSize":25%';
