-- Materials whose code starts with a digit are never shown (decided 2026-09-23).
-- The sync rule now skips them; remove the ones the first syncs copied. Safe to
-- delete: no other table references md.Material yet.
DELETE FROM md.Material WHERE MaterialCode LIKE '[0-9]%';
