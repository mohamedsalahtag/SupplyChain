-- Demand-to-PO plan v5, Stage 4a: RFQs, supplier shortlist by origin, quotes, release (spec 18).

-- Supplier origins (decision 2026-09-24): SAP country + origins supplied to us (PO history) + added by hand.
CREATE TABLE scm.SupplierOrigin (
    SupplierCode nvarchar(20) NOT NULL,
    OriginCode   nvarchar(10) NOT NULL,
    Source       nvarchar(10) NOT NULL CONSTRAINT CK_SupplierOrigin_Source CHECK (Source IN ('COUNTRY', 'HISTORY', 'MANUAL')),
    AddedBy      int          NULL CONSTRAINT FK_SupplierOrigin_User REFERENCES app.[User] (UserId),
    AddedAt      datetime2(0) NOT NULL CONSTRAINT DF_SupplierOrigin_At DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_SupplierOrigin PRIMARY KEY (SupplierCode, OriginCode, Source)
);
CREATE INDEX IX_SupplierOrigin_Origin ON scm.SupplierOrigin (OriginCode, SupplierCode);

INSERT INTO scm.SupplierOrigin (SupplierCode, OriginCode, Source)
SELECT SupplierCode, Country, 'COUNTRY' FROM md.Supplier WHERE LEN(Country) = 2;
INSERT INTO scm.SupplierOrigin (SupplierCode, OriginCode, Source)
SELECT DISTINCT SupplierCode, OriginCode, 'HISTORY' FROM scm.PurchaseHistorySummary WHERE OriginCode <> '';

CREATE SEQUENCE scm.RfqNoSeq AS bigint START WITH 1 INCREMENT BY 1;

CREATE TABLE scm.Rfq (
    RfqId          bigint IDENTITY NOT NULL CONSTRAINT PK_Rfq PRIMARY KEY,
    RfqNo          nvarchar(20)   NOT NULL CONSTRAINT UQ_Rfq_No UNIQUE,            -- RFQ-000001
    DemandId       bigint         NOT NULL CONSTRAINT FK_Rfq_Demand REFERENCES scm.Demand (DemandId),
    CompanyCode    nvarchar(10)   NOT NULL,
    ManualStatus   nvarchar(10)   NOT NULL CONSTRAINT DF_Rfq_Status DEFAULT 'DRAFT'
                   CONSTRAINT CK_Rfq_Status CHECK (ManualStatus IN ('DRAFT', 'SENT', 'CANCELLED')),
    CreatedBy      int            NOT NULL CONSTRAINT FK_Rfq_CreatedBy REFERENCES app.[User] (UserId),
    CreatedAt      datetime2(0)   NOT NULL CONSTRAINT DF_Rfq_At DEFAULT SYSUTCDATETIME(),
    SentBy         int            NULL CONSTRAINT FK_Rfq_SentBy REFERENCES app.[User] (UserId),
    SentAt         datetime2(0)   NULL,
    CancelledBy    int            NULL CONSTRAINT FK_Rfq_CancelledBy REFERENCES app.[User] (UserId),
    CancelledAt    datetime2(0)   NULL,
    CancelReason   nvarchar(40)   NULL,
    CancelComment  nvarchar(2000) NULL,
    RowVer         rowversion     NOT NULL
);
CREATE INDEX IX_Rfq_Demand ON scm.Rfq (DemandId);

CREATE TABLE scm.RfqSupplier (
    RfqId           bigint        NOT NULL CONSTRAINT FK_RfqSupplier_Rfq REFERENCES scm.Rfq (RfqId),
    SupplierCode    nvarchar(20)  NOT NULL,
    OriginsAtInvite nvarchar(200) NOT NULL,     -- the supplier's origins when invited (audit of the shortlist rule)
    ShortlistRank   int           NULL,         -- rank shown when invited (NULL = no history)
    HintJson        nvarchar(max) NULL,         -- the history hint shown when invited
    InvitedBy       int           NOT NULL CONSTRAINT FK_RfqSupplier_User REFERENCES app.[User] (UserId),
    InvitedAt       datetime2(0)  NOT NULL CONSTRAINT DF_RfqSupplier_At DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_RfqSupplier PRIMARY KEY (RfqId, SupplierCode)
);

CREATE TABLE scm.RfqWeek (
    RfqId          bigint  NOT NULL CONSTRAINT FK_RfqWeek_Rfq REFERENCES scm.Rfq (RfqId),
    EtdWeek        char(8) NOT NULL,
    ContainerCount int     NOT NULL CONSTRAINT CK_RfqWeek_Count CHECK (ContainerCount >= 0),
    DefaultCount   int     NOT NULL,             -- the proposed default, to flag a difference
    RowVer         rowversion NOT NULL,
    CONSTRAINT PK_RfqWeek PRIMARY KEY (RfqId, EtdWeek)
);

CREATE TABLE scm.RfqLine (
    RfqLineId        bigint IDENTITY NOT NULL CONSTRAINT PK_RfqLine PRIMARY KEY,
    RfqId            bigint        NOT NULL CONSTRAINT FK_RfqLine_Rfq REFERENCES scm.Rfq (RfqId),
    DemandLineId     bigint        NULL CONSTRAINT FK_RfqLine_Line REFERENCES scm.DemandLine (LineId),  -- NULL: Procurement-added (Stage 4b)
    Origin           nvarchar(12)  NOT NULL CONSTRAINT DF_RfqLine_Origin DEFAULT 'DEMAND'
                     CONSTRAINT CK_RfqLine_Origin CHECK (Origin IN ('DEMAND', 'PROCUREMENT')),
    MajorCategory    nvarchar(80)  NOT NULL,
    SubMajorCategory nvarchar(80)  NOT NULL,
    Size             nvarchar(40)  NOT NULL,
    MaterialClass    nvarchar(80)  NOT NULL,
    OriginCode       nvarchar(10)  NOT NULL,
    MaterialCode     nvarchar(40)  NULL,
    Unit             nvarchar(10)  NOT NULL,
    LineKey AS (CONCAT(MajorCategory, N'|', SubMajorCategory, N'|', Size, N'|', MaterialClass, N'|', OriginCode, N'|', ISNULL(MaterialCode, N''))) PERSISTED,
    ProposedEtdWeek  char(8)       NOT NULL,
    AskedQty         bigint        NOT NULL CONSTRAINT CK_RfqLine_Asked CHECK (AskedQty >= 0),   -- milli; what was asked (grows when more is added)
    IsCancelled      bit           NOT NULL CONSTRAINT DF_RfqLine_Cancelled DEFAULT 0,
    RowVer           rowversion    NOT NULL
);
CREATE UNIQUE INDEX UQ_RfqLine_Week ON scm.RfqLine (RfqId, DemandLineId, ProposedEtdWeek)
    WHERE DemandLineId IS NOT NULL AND Origin = 'DEMAND' AND IsCancelled = 0;
CREATE INDEX IX_RfqLine_Key ON scm.RfqLine (RfqId, ProposedEtdWeek, LineKey);
ALTER TABLE scm.QtySlice ADD CONSTRAINT FK_QtySlice_RfqLine FOREIGN KEY (RfqLineId) REFERENCES scm.RfqLine (RfqLineId);
CREATE INDEX IX_QtySlice_RfqLine ON scm.QtySlice (RfqLineId) WHERE RfqLineId IS NOT NULL;

CREATE TABLE scm.SupplierQuote (
    QuoteId           bigint IDENTITY NOT NULL CONSTRAINT PK_SupplierQuote PRIMARY KEY,
    RfqId             bigint         NOT NULL CONSTRAINT FK_SupplierQuote_Rfq REFERENCES scm.Rfq (RfqId),
    SupplierCode      nvarchar(20)   NOT NULL,
    EtdWeek           char(8)        NOT NULL,
    LineKey           nvarchar(400)  NOT NULL,
    OriginCode        nvarchar(10)   NOT NULL,
    Unit              nvarchar(10)   NOT NULL,         -- must equal the RFQ line unit
    QuotedSku         nvarchar(40)   NULL,
    UnitPrice         decimal(18, 4) NOT NULL CONSTRAINT CK_SupplierQuote_Price CHECK (UnitPrice > 0),
    Currency          char(3)        NOT NULL,
    AvailableQty      bigint         NOT NULL CONSTRAINT CK_SupplierQuote_Avail CHECK (AvailableQty >= 0),   -- milli
    ContainersOffered int            NULL,
    OriginsAtQuote    nvarchar(200)  NOT NULL,         -- the supplier's origins when recorded (invariant 23)
    IsCurrent         bit            NOT NULL CONSTRAINT DF_SupplierQuote_Current DEFAULT 1,  -- replaced → 0 (no expiry)
    SupersededBy      bigint         NULL CONSTRAINT FK_SupplierQuote_Superseded REFERENCES scm.SupplierQuote (QuoteId),
    RecordedBy        int            NOT NULL CONSTRAINT FK_SupplierQuote_User REFERENCES app.[User] (UserId),
    RecordedAt        datetime2(0)   NOT NULL CONSTRAINT DF_SupplierQuote_At DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_SupplierQuote_Supplier FOREIGN KEY (RfqId, SupplierCode) REFERENCES scm.RfqSupplier (RfqId, SupplierCode)
);
CREATE UNIQUE INDEX UQ_SupplierQuote_Current ON scm.SupplierQuote (RfqId, SupplierCode, EtdWeek, LineKey) WHERE IsCurrent = 1;
GO

-- Reasons (spec 18)
INSERT INTO scm.ReasonCode (ReasonCode, Context, Description, CountsAgainstProcurement)
SELECT v.c, v.x, v.d, 0 FROM (VALUES
    ('OTHER_RFQ',   'RELEASE',    'Asked for in another RFQ'),
    ('NO_OFFERS',   'RFQ_CANCEL', 'No supplier offered'),
    ('REDO_RFQ',    'RFQ_CANCEL', 'RFQ to be made again'),
    ('NOT_NEEDED',  'RFQ_CANCEL', 'Quantity not needed any more')) v (c, x, d)
WHERE NOT EXISTS (SELECT 1 FROM scm.ReasonCode r WHERE r.ReasonCode = v.c);

-- Permissions: Procurement sees and manages RFQs.
INSERT INTO app.RolePermission (RoleId, PermissionKey)
SELECT r.RoleId, p.k FROM app.Role r
JOIN (VALUES ('Procurement', 'rfqs.open'), ('Procurement', 'rfq.manage')) AS p(RoleName, k) ON p.RoleName = r.Name
WHERE NOT EXISTS (SELECT 1 FROM app.RolePermission x WHERE x.RoleId = r.RoleId AND x.PermissionKey = p.k);
