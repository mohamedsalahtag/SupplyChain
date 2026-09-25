-- RFQ to a supplier outside the shortlist (spec 18 addition, 2026-09-25): a new supplier's first contact is often the RFQ.
-- Inviting one records that it supplies the RFQ's origin(s) (Source 'RFQ', who and when), and the invite is marked.
ALTER TABLE scm.SupplierOrigin DROP CONSTRAINT CK_SupplierOrigin_Source;
ALTER TABLE scm.SupplierOrigin ADD CONSTRAINT CK_SupplierOrigin_Source CHECK (Source IN ('COUNTRY', 'HISTORY', 'MANUAL', 'RFQ'));
ALTER TABLE scm.RfqSupplier ADD OutsideShortlist bit NOT NULL CONSTRAINT DF_RfqSupplier_Outside DEFAULT 0;
