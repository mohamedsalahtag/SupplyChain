-- Spec 18 revision (2026-09-24): containers are offered per supplier × week, not per material —
-- one container can carry several sizes and grades. The latest entry per supplier × week counts.
CREATE TABLE scm.SupplierQuoteWeek (
    RfqId             bigint       NOT NULL CONSTRAINT FK_SupplierQuoteWeek_Rfq REFERENCES scm.Rfq (RfqId),
    SupplierCode      nvarchar(20) NOT NULL,
    EtdWeek           char(8)      NOT NULL,
    ContainersOffered int          NOT NULL CONSTRAINT CK_SupplierQuoteWeek_Containers CHECK (ContainersOffered >= 0),
    RecordedBy        int          NOT NULL CONSTRAINT FK_SupplierQuoteWeek_User REFERENCES app.[User] (UserId),
    RecordedAt        datetime2(0) NOT NULL CONSTRAINT DF_SupplierQuoteWeek_At DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_SupplierQuoteWeek PRIMARY KEY (RfqId, SupplierCode, EtdWeek),
    CONSTRAINT FK_SupplierQuoteWeek_Supplier FOREIGN KEY (RfqId, SupplierCode) REFERENCES scm.RfqSupplier (RfqId, SupplierCode)
);

-- Containers recorded per material row so far: the largest per supplier × week.
INSERT INTO scm.SupplierQuoteWeek (RfqId, SupplierCode, EtdWeek, ContainersOffered, RecordedBy, RecordedAt)
SELECT RfqId, SupplierCode, EtdWeek, MAX(ContainersOffered), MAX(RecordedBy), MAX(RecordedAt)
FROM scm.SupplierQuote WHERE IsCurrent = 1 AND ContainersOffered IS NOT NULL
GROUP BY RfqId, SupplierCode, EtdWeek;
