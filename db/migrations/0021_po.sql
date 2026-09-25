-- Demand-to-PO plan v5, Stage 7: PO preparation, SKU selection by the PO team, one PO draft per handoff,
-- SAP outbox with unknown-outcome handling (stub adapter until the real ZCON adapter, Stage 9) — spec 23.

-- A SKU missing in SAP: the PO team asks for it outside the portal and tracks it here.
CREATE TABLE scm.MasterDataRequest (
    MdrId        bigint IDENTITY NOT NULL CONSTRAINT PK_MasterDataRequest PRIMARY KEY,
    AwardItemId  bigint         NOT NULL CONSTRAINT FK_Mdr_Item REFERENCES scm.AwardItem (AwardItemId),
    Note         nvarchar(1000) NOT NULL,
    Status       nvarchar(10)   NOT NULL CONSTRAINT DF_Mdr_Status DEFAULT 'OPEN' CONSTRAINT CK_Mdr_Status CHECK (Status IN ('OPEN', 'DONE')),
    CreatedBy    int            NOT NULL CONSTRAINT FK_Mdr_User REFERENCES app.[User] (UserId),
    CreatedAt    datetime2(0)   NOT NULL CONSTRAINT DF_Mdr_At DEFAULT SYSUTCDATETIME(),
    ClosedBy     int            NULL CONSTRAINT FK_Mdr_Closer REFERENCES app.[User] (UserId),
    ClosedAt     datetime2(0)   NULL
);

CREATE SEQUENCE scm.PoDraftNoSeq AS bigint START WITH 1 INCREMENT BY 1;

-- One PO draft per handoff (= one supplier of one award), all weeks. POD-number = the portal reference written to the SAP PO.
CREATE TABLE scm.PoDraft (
    PoDraftId       bigint IDENTITY NOT NULL CONSTRAINT PK_PoDraft PRIMARY KEY,
    PoDraftNo       nvarchar(20)   NOT NULL CONSTRAINT UQ_PoDraft_No UNIQUE,
    HandoffId       bigint         NOT NULL CONSTRAINT FK_PoDraft_Handoff REFERENCES scm.Handoff (HandoffId),
    CompanyCode     nvarchar(10)   NOT NULL,
    SupplierCode    nvarchar(20)   NOT NULL,
    Plant           nvarchar(10)   NOT NULL,
    PurchasingOrg   nvarchar(10)   NOT NULL,
    PurchasingGroup nvarchar(10)   NOT NULL,
    Incoterm        nvarchar(10)   NOT NULL,
    PortOfLoading   nvarchar(100)  NOT NULL,
    PortOfDischarge nvarchar(100)  NOT NULL,
    PaymentTerms    nvarchar(10)   NOT NULL,
    Currency        char(3)        NOT NULL,
    ContainerCount  int            NOT NULL CONSTRAINT CK_PoDraft_Containers CHECK (ContainerCount >= 1),   -- total for the whole PO
    Status          nvarchar(12)   NOT NULL CONSTRAINT DF_PoDraft_Status DEFAULT 'DRAFT'
                    CONSTRAINT CK_PoDraft_Status CHECK (Status IN ('DRAFT', 'VALIDATED', 'SUBMITTED', 'UNKNOWN', 'CREATED', 'REJECTED', 'VOID')),
    SapPoNumber     nvarchar(20)   NULL,
    SapCreatedAt    datetime2(0)   NULL,
    Resolution      nvarchar(20)   NULL CONSTRAINT CK_PoDraft_Resolution CHECK (Resolution IN ('SAP_REPLY', 'RECONCILED', 'MANUAL_CREATED', 'MANUAL_NOT_CREATED')),
    LastError       nvarchar(max)  NULL,
    ValidatedAt     datetime2(0)   NULL,
    SubmittedBy     int            NULL CONSTRAINT FK_PoDraft_SubmittedBy REFERENCES app.[User] (UserId),
    SubmittedAt     datetime2(0)   NULL,
    CreatedBy       int            NOT NULL CONSTRAINT FK_PoDraft_User REFERENCES app.[User] (UserId),
    CreatedAt       datetime2(0)   NOT NULL CONSTRAINT DF_PoDraft_At DEFAULT SYSUTCDATETIME(),
    RowVer          rowversion     NOT NULL
);
CREATE UNIQUE INDEX UX_PoDraft_Live ON scm.PoDraft (HandoffId) WHERE Status IN ('DRAFT', 'VALIDATED', 'SUBMITTED', 'UNKNOWN', 'CREATED');   -- invariant 21 (a filtered index cannot use NOT IN)
CREATE INDEX IX_PoDraft_Status ON scm.PoDraft (Status, CompanyCode);

CREATE TABLE scm.PoDraftItem (
    PoDraftItemId  bigint IDENTITY NOT NULL CONSTRAINT PK_PoDraftItem PRIMARY KEY,
    PoDraftId      bigint         NOT NULL CONSTRAINT FK_PoDraftItem_Draft REFERENCES scm.PoDraft (PoDraftId),
    ItemNo         int            NOT NULL,
    AwardItemId    bigint         NOT NULL CONSTRAINT FK_PoDraftItem_Award REFERENCES scm.AwardItem (AwardItemId),
    AllocId        bigint         NOT NULL CONSTRAINT FK_PoDraftItem_Alloc REFERENCES scm.AwardItemSku (AllocId),
    DemandId       bigint         NOT NULL CONSTRAINT FK_PoDraftItem_Demand REFERENCES scm.Demand (DemandId),
    DemandLineId   bigint         NOT NULL CONSTRAINT FK_PoDraftItem_Line REFERENCES scm.DemandLine (LineId),
    MaterialCode   nvarchar(40)   NOT NULL,
    Qty            bigint         NOT NULL CONSTRAINT CK_PoDraftItem_Qty CHECK (Qty > 0),   -- milli
    Unit           nvarchar(10)   NOT NULL,
    UnitPrice      decimal(18, 4) NOT NULL CONSTRAINT CK_PoDraftItem_Price CHECK (UnitPrice > 0),
    Currency       char(3)        NOT NULL,
    EtdWeek        char(8)        NOT NULL,
    ConfirmedEtd   date           NOT NULL,
    SapItemNo      nvarchar(10)   NULL,
    CONSTRAINT UQ_PoDraftItem UNIQUE (PoDraftId, ItemNo)
);

-- The logical SAP submission: one per draft, payload frozen at submit (hash), one idempotency key.
CREATE TABLE scm.SapSubmission (
    SubmissionId    bigint IDENTITY NOT NULL CONSTRAINT PK_SapSubmission PRIMARY KEY,
    PoDraftId       bigint           NOT NULL CONSTRAINT UQ_SapSubmission_Draft UNIQUE CONSTRAINT FK_SapSubmission_Draft REFERENCES scm.PoDraft (PoDraftId),
    IdempotencyKey  uniqueidentifier NOT NULL CONSTRAINT UQ_SapSubmission_Key UNIQUE,
    Reference       nvarchar(20)     NOT NULL CONSTRAINT UQ_SapSubmission_Ref UNIQUE,
    PayloadJson     nvarchar(max)    NOT NULL,
    PayloadSha256   char(64)         NOT NULL,
    Status          nvarchar(12)     NOT NULL CONSTRAINT DF_SapSubmission_Status DEFAULT 'PENDING'
                    CONSTRAINT CK_SapSubmission_Status CHECK (Status IN ('PENDING', 'IN_FLIGHT', 'CREATED', 'REJECTED', 'UNKNOWN', 'MANUAL')),
    Attempts        int              NOT NULL CONSTRAINT DF_SapSubmission_Attempts DEFAULT 0,
    ReconcileChecks int              NOT NULL CONSTRAINT DF_SapSubmission_Checks DEFAULT 0,
    ClaimedBy       nvarchar(100)    NULL,
    LeaseUntil      datetime2(0)     NULL,
    NextActionAt    datetime2(0)     NOT NULL CONSTRAINT DF_SapSubmission_Next DEFAULT SYSUTCDATETIME(),
    CreatedAt       datetime2(0)     NOT NULL CONSTRAINT DF_SapSubmission_At DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_SapSubmission_Due ON scm.SapSubmission (Status, NextActionAt);

CREATE TABLE scm.SapSubmissionAttempt (
    AttemptId     bigint IDENTITY NOT NULL CONSTRAINT PK_SapSubmissionAttempt PRIMARY KEY,
    SubmissionId  bigint        NOT NULL CONSTRAINT FK_SapAttempt_Submission REFERENCES scm.SapSubmission (SubmissionId),
    Kind          nvarchar(10)  NOT NULL CONSTRAINT CK_SapAttempt_Kind CHECK (Kind IN ('CREATE', 'LOOKUP')),
    StartedAt     datetime2(3)  NOT NULL,
    FinishedAt    datetime2(3)  NULL,
    Outcome       nvarchar(12)  NULL CONSTRAINT CK_SapAttempt_Outcome CHECK (Outcome IN ('CREATED', 'REJECTED', 'FOUND', 'NOT_FOUND', 'UNKNOWN')),
    Detail        nvarchar(2000) NULL,
    WorkerId      nvarchar(100) NOT NULL
);

-- The durable stub standing in for SAP (Stage 9 replaces it with the ZCON adapter): POs it "created", and injected faults.
CREATE TABLE scm.StubSapPo (
    StubPoId        bigint IDENTITY NOT NULL CONSTRAINT PK_StubSapPo PRIMARY KEY,
    PoNumber        nvarchar(20)     NOT NULL CONSTRAINT UQ_StubSapPo_No UNIQUE,
    IdempotencyKey  uniqueidentifier NOT NULL CONSTRAINT UQ_StubSapPo_Key UNIQUE,
    Reference       nvarchar(20)     NOT NULL CONSTRAINT UQ_StubSapPo_Ref UNIQUE,
    PayloadSha256   char(64)         NOT NULL,
    CreatedAt       datetime2(0)     NOT NULL CONSTRAINT DF_StubSapPo_At DEFAULT SYSUTCDATETIME()
);
CREATE TABLE scm.StubSapFault (
    FaultId    bigint IDENTITY NOT NULL CONSTRAINT PK_StubSapFault PRIMARY KEY,
    Reference  nvarchar(20)  NOT NULL,   -- a POD-number, or '*' for the next submission of any draft
    Mode       nvarchar(30)  NOT NULL CONSTRAINT CK_StubSapFault_Mode CHECK (Mode IN ('reject', 'timeout-before-create', 'timeout-after-create', 'lookup-unknown')),
    Remaining  int           NOT NULL CONSTRAINT DF_StubSapFault_Rem DEFAULT 1,
    CreatedBy  int           NULL,
    CreatedAt  datetime2(0)  NOT NULL CONSTRAINT DF_StubSapFault_At DEFAULT SYSUTCDATETIME()
);
GO

-- Permissions: the PO team prepares and submits; Procurement and Sales can look.
INSERT INTO app.RolePermission (RoleId, PermissionKey)
SELECT r.RoleId, p.k FROM app.Role r
JOIN (VALUES ('PO team', 'po.open'), ('PO team', 'po.manage'), ('Procurement', 'po.open'), ('Sales', 'po.open')) AS p(RoleName, k) ON p.RoleName = r.Name
WHERE NOT EXISTS (SELECT 1 FROM app.RolePermission x WHERE x.RoleId = r.RoleId AND x.PermissionKey = p.k);
