-- Demand-to-PO plan v5, Stage 5: award batches, shipments, un-award, SKU allocations, Sales acknowledgement (spec 20).
CREATE SEQUENCE scm.AwardNoSeq AS bigint START WITH 1 INCREMENT BY 1;

CREATE TABLE scm.AwardBatch (
    AwardBatchId bigint IDENTITY NOT NULL CONSTRAINT PK_AwardBatch PRIMARY KEY,
    AbNo         nvarchar(20)   NOT NULL CONSTRAINT UQ_AwardBatch_No UNIQUE,     -- AB-000001
    RfqId        bigint         NOT NULL CONSTRAINT FK_AwardBatch_Rfq REFERENCES scm.Rfq (RfqId),
    DemandId     bigint         NOT NULL CONSTRAINT FK_AwardBatch_Demand REFERENCES scm.Demand (DemandId),
    CompanyCode  nvarchar(10)   NOT NULL,
    Comment      nvarchar(2000) NOT NULL CONSTRAINT DF_AwardBatch_Comment DEFAULT '',
    CreatedBy    int            NOT NULL CONSTRAINT FK_AwardBatch_User REFERENCES app.[User] (UserId),
    CreatedAt    datetime2(0)   NOT NULL CONSTRAINT DF_AwardBatch_At DEFAULT SYSUTCDATETIME(),
    RowVer       rowversion     NOT NULL
);
CREATE INDEX IX_AwardBatch_Rfq ON scm.AwardBatch (RfqId);
CREATE INDEX IX_AwardBatch_Demand ON scm.AwardBatch (DemandId);

CREATE TABLE scm.AwardItem (
    AwardItemId    bigint IDENTITY NOT NULL CONSTRAINT PK_AwardItem PRIMARY KEY,
    AwardBatchId   bigint         NOT NULL CONSTRAINT FK_AwardItem_Batch REFERENCES scm.AwardBatch (AwardBatchId),
    RfqLineId      bigint         NOT NULL CONSTRAINT FK_AwardItem_RfqLine REFERENCES scm.RfqLine (RfqLineId),
    SupplierCode   nvarchar(20)   NOT NULL,
    EtdWeek        char(8)        NOT NULL,
    LineKey        nvarchar(400)  NOT NULL,
    Qty            bigint         NOT NULL CONSTRAINT CK_AwardItem_Qty CHECK (Qty >= 0),   -- milli; = its awarded quantity (invariant 5)
    Unit           nvarchar(10)   NOT NULL,
    QuoteId        bigint         NOT NULL CONSTRAINT FK_AwardItem_Quote REFERENCES scm.SupplierQuote (QuoteId),
    UnitPrice      decimal(18, 4) NOT NULL,       -- copied from the quote
    Currency       char(3)        NOT NULL,
    OverrideReason nvarchar(500)  NULL,           -- given when the award exceeds the quoted availability
    SkuStatus      nvarchar(20)   NOT NULL CONSTRAINT DF_AwardItem_Sku DEFAULT 'PENDING'
                   CONSTRAINT CK_AwardItem_Sku CHECK (SkuStatus IN ('RESOLVED_AT_DEMAND', 'RESOLVED_AT_RFQ', 'PENDING', 'RESOLVED_AT_PO', 'PENDING_MASTER_DATA')),
    IsActive       bit            NOT NULL CONSTRAINT DF_AwardItem_Active DEFAULT 1,
    RowVer         rowversion     NOT NULL,
    CONSTRAINT UQ_AwardItem UNIQUE (AwardBatchId, RfqLineId, SupplierCode)
);
ALTER TABLE scm.QtySlice ADD CONSTRAINT FK_QtySlice_AwardItem FOREIGN KEY (AwardItemId) REFERENCES scm.AwardItem (AwardItemId);
CREATE INDEX IX_QtySlice_AwardItem ON scm.QtySlice (AwardItemId) WHERE AwardItemId IS NOT NULL;

CREATE TABLE scm.AwardItemChange (
    ChangeId    bigint IDENTITY NOT NULL CONSTRAINT PK_AwardItemChange PRIMARY KEY,
    AwardItemId bigint        NOT NULL CONSTRAINT FK_AwardItemChange_Item REFERENCES scm.AwardItem (AwardItemId),
    ChangeType  nvarchar(24)  NOT NULL CONSTRAINT CK_AwardItemChange_Type CHECK (ChangeType IN ('UNAWARD_KEEP_QUOTES', 'UNAWARD_RELEASE', 'CANCELLED_BY_CR', 'SKU_CORRECTED')),
    Qty         bigint        NULL,
    ReasonCode  nvarchar(40)  NULL,
    DetailJson  nvarchar(max) NULL,
    CrId        bigint        NULL CONSTRAINT FK_AwardItemChange_Cr REFERENCES scm.ChangeRequest (CrId),
    ActorUserId int           NOT NULL CONSTRAINT FK_AwardItemChange_User REFERENCES app.[User] (UserId),
    ChangedAt   datetime2(0)  NOT NULL CONSTRAINT DF_AwardItemChange_At DEFAULT SYSUTCDATETIME()
);

-- A shipment = what was won from one supplier for one week in one batch.
CREATE TABLE scm.AwardShipment (
    ShipmentId     bigint IDENTITY NOT NULL CONSTRAINT PK_AwardShipment PRIMARY KEY,
    AwardBatchId   bigint       NOT NULL CONSTRAINT FK_AwardShipment_Batch REFERENCES scm.AwardBatch (AwardBatchId),
    SupplierCode   nvarchar(20) NOT NULL,
    EtdWeek        char(8)      NOT NULL,
    ContainerCount int          NOT NULL CONSTRAINT CK_AwardShipment_Count CHECK (ContainerCount >= 1),
    ConfirmedEtd   date         NULL,        -- required before handoff (Stage 6)
    IsActive       bit          NOT NULL CONSTRAINT DF_AwardShipment_Active DEFAULT 1,
    UpdatedBy      int          NOT NULL CONSTRAINT FK_AwardShipment_User REFERENCES app.[User] (UserId),
    UpdatedAt      datetime2(0) NOT NULL CONSTRAINT DF_AwardShipment_At DEFAULT SYSUTCDATETIME(),
    RowVer         rowversion   NOT NULL,
    CONSTRAINT UQ_AwardShipment UNIQUE (AwardBatchId, SupplierCode, EtdWeek)
);

CREATE TABLE scm.AwardItemSku (
    AllocId      bigint IDENTITY NOT NULL CONSTRAINT PK_AwardItemSku PRIMARY KEY,
    AwardItemId  bigint        NOT NULL CONSTRAINT FK_AwardItemSku_Item REFERENCES scm.AwardItem (AwardItemId),
    MaterialCode nvarchar(40)  NOT NULL,
    Qty          bigint        NOT NULL CONSTRAINT CK_AwardItemSku_Qty CHECK (Qty > 0),
    SetStage     nvarchar(10)  NOT NULL CONSTRAINT CK_AwardItemSku_Stage CHECK (SetStage IN ('DEMAND', 'RFQ', 'PO')),
    IsActive     bit           NOT NULL CONSTRAINT DF_AwardItemSku_Active DEFAULT 1,
    ChangeReason nvarchar(500) NULL,
    SetBy        int           NOT NULL CONSTRAINT FK_AwardItemSku_User REFERENCES app.[User] (UserId),
    SetAt        datetime2(0)  NOT NULL CONSTRAINT DF_AwardItemSku_At DEFAULT SYSUTCDATETIME()
);

CREATE TABLE scm.SalesAck (
    AckId               bigint IDENTITY NOT NULL CONSTRAINT PK_SalesAck PRIMARY KEY,
    AwardBatchId        bigint         NOT NULL CONSTRAINT UQ_SalesAck_Batch UNIQUE CONSTRAINT FK_SalesAck_Batch REFERENCES scm.AwardBatch (AwardBatchId),
    DemandId            bigint         NOT NULL CONSTRAINT FK_SalesAck_Demand REFERENCES scm.Demand (DemandId),
    Status              nvarchar(20)   NOT NULL CONSTRAINT DF_SalesAck_Status DEFAULT 'PENDING'
                        CONSTRAINT CK_SalesAck_Status CHECK (Status IN ('PENDING', 'ACKNOWLEDGED', 'QUERY_RAISED', 'ACKNOWLEDGED_LATE')),
    Revision            int            NOT NULL CONSTRAINT DF_SalesAck_Revision DEFAULT 1,
    HandedOffWithoutAck bit            NOT NULL CONSTRAINT DF_SalesAck_NoAck DEFAULT 0,
    RespondedBy         int            NULL CONSTRAINT FK_SalesAck_User REFERENCES app.[User] (UserId),
    RespondedAt         datetime2(0)   NULL,
    Comment             nvarchar(2000) NULL,
    RowVer              rowversion     NOT NULL
);

CREATE TABLE scm.SalesAckHistory (
    AckHistoryId      bigint IDENTITY NOT NULL CONSTRAINT PK_SalesAckHistory PRIMARY KEY,
    AckId             bigint        NOT NULL CONSTRAINT FK_SalesAckHistory_Ack REFERENCES scm.SalesAck (AckId),
    Revision          int           NOT NULL,
    FromStatus        nvarchar(20)  NULL,
    ToStatus          nvarchar(20)  NOT NULL,
    Cause             nvarchar(40)  NOT NULL,   -- CREATED, ACKNOWLEDGED, QUERY, ANSWERED, RESET_UNAWARD, RESET_CANCEL, RESET_SKU, RESET_SHIPMENT, LATE
    AwardSnapshotJson nvarchar(max) NULL,       -- the award items + shipments that were acknowledged
    Comment           nvarchar(2000) NULL,
    ActorUserId       int           NULL CONSTRAINT FK_SalesAckHistory_User REFERENCES app.[User] (UserId),
    ChangedAt         datetime2(0)  NOT NULL CONSTRAINT DF_SalesAckHistory_At DEFAULT SYSUTCDATETIME()
);
GO

INSERT INTO app.RolePermission (RoleId, PermissionKey)
SELECT r.RoleId, p.k FROM app.Role r
JOIN (VALUES ('Procurement', 'awards.open'), ('Procurement', 'award.manage'), ('Sales', 'awards.open'), ('Sales', 'ack.respond')) AS p(RoleName, k) ON p.RoleName = r.Name
WHERE NOT EXISTS (SELECT 1 FROM app.RolePermission x WHERE x.RoleId = r.RoleId AND x.PermissionKey = p.k);
