-- Demand-to-PO plan v5, Stage 1: demands, weeks, lines, the quantity ledger (slices), versions (specs 12, 13).
CREATE SEQUENCE scm.DemandNoSeq AS bigint START WITH 1 INCREMENT BY 1;

CREATE TABLE scm.Demand (
    DemandId        bigint IDENTITY NOT NULL CONSTRAINT PK_Demand PRIMARY KEY,
    DemandNo        nvarchar(20)  NOT NULL CONSTRAINT UQ_Demand_No UNIQUE,          -- D-000101
    CompanyCode     nvarchar(10)  NOT NULL CONSTRAINT FK_Demand_Company REFERENCES scm.Company (CompanyCode),
    WorkflowStatus  nvarchar(20)  NOT NULL CONSTRAINT DF_Demand_Status DEFAULT 'DRAFT'
                    CONSTRAINT CK_Demand_Status CHECK (WorkflowStatus IN ('DRAFT', 'SUBMITTED', 'RETURNED', 'ACCEPTED')),
    CurrentVersion  int           NOT NULL CONSTRAINT DF_Demand_Version DEFAULT 0,
    BaselineVersion int           NULL,                -- = 1: the demand as Sales first submitted it (KPI baseline)
    BaselineStatus  nvarchar(15)  NOT NULL CONSTRAINT DF_Demand_Baseline DEFAULT 'AVAILABLE'
                    CONSTRAINT CK_Demand_Baseline CHECK (BaselineStatus IN ('AVAILABLE', 'NOT_AVAILABLE')),
    Notes           nvarchar(2000) NOT NULL CONSTRAINT DF_Demand_Notes DEFAULT '',
    CreatedBy       int           NOT NULL CONSTRAINT FK_Demand_CreatedBy REFERENCES app.[User] (UserId),
    CreatedAt       datetime2(0)  NOT NULL CONSTRAINT DF_Demand_CreatedAt DEFAULT SYSUTCDATETIME(),
    SubmittedAt     datetime2(0)  NULL,                -- first submission: KPI clock start
    AcceptedAt      datetime2(0)  NULL,
    AcceptedBy      int           NULL CONSTRAINT FK_Demand_AcceptedBy REFERENCES app.[User] (UserId),
    RowVer          rowversion    NOT NULL
);
CREATE INDEX IX_Demand_Company ON scm.Demand (CompanyCode, WorkflowStatus);

CREATE TABLE scm.DemandWeek (
    DemandWeekId   bigint IDENTITY NOT NULL CONSTRAINT PK_DemandWeek PRIMARY KEY,
    DemandId       bigint  NOT NULL CONSTRAINT FK_DemandWeek_Demand REFERENCES scm.Demand (DemandId),
    EtdWeek        char(8) NOT NULL CONSTRAINT CK_DemandWeek_Week CHECK (EtdWeek LIKE '[12][0-9][0-9][0-9]-W[0-5][0-9]'),
    ContainerCount int     NOT NULL CONSTRAINT CK_DemandWeek_Containers CHECK (ContainerCount >= 0),   -- a count only
    RowVer         rowversion NOT NULL,
    CONSTRAINT UQ_DemandWeek UNIQUE (DemandId, EtdWeek)
);

CREATE TABLE scm.DemandLine (
    LineId           bigint IDENTITY NOT NULL CONSTRAINT PK_DemandLine PRIMARY KEY,
    DemandId         bigint        NOT NULL CONSTRAINT FK_DemandLine_Demand REFERENCES scm.Demand (DemandId),
    DemandWeekId     bigint        NOT NULL CONSTRAINT FK_DemandLine_Week REFERENCES scm.DemandWeek (DemandWeekId),
    LineNumber       int           NOT NULL,
    SpecMode         nvarchar(4)   NOT NULL CONSTRAINT CK_DemandLine_Mode CHECK (SpecMode IN ('SPEC', 'SKU')),
    MajorCategory    nvarchar(80)  NOT NULL,
    SubMajorCategory nvarchar(80)  NOT NULL,
    Size             nvarchar(80)  NOT NULL,          -- '' = any size (SPEC mode)
    OriginCode       nvarchar(3)   NOT NULL,          -- ISO country (spec 11)
    MaterialCode     nvarchar(40)  NULL,              -- required in SKU mode
    Unit             nvarchar(10)  NOT NULL,
    RequestedQty     bigint        NOT NULL CONSTRAINT CK_DemandLine_Qty CHECK (RequestedQty > 0),   -- milli-units; cumulative after acceptance
    LineKey AS (CONCAT(MajorCategory, N'|', SubMajorCategory, N'|', Size, N'|', OriginCode, N'|', ISNULL(MaterialCode, N''))) PERSISTED,
    IsActive         bit           NOT NULL CONSTRAINT DF_DemandLine_Active DEFAULT 1,
    ChangeHoldCrId   bigint        NULL,              -- FK in Stage 2
    RowVer           rowversion    NOT NULL,
    CONSTRAINT CK_DemandLine_Sku CHECK (SpecMode = 'SPEC' OR MaterialCode IS NOT NULL)
);
CREATE UNIQUE INDEX UX_DemandLine_Key ON scm.DemandLine (DemandWeekId, LineKey) WHERE IsActive = 1;
CREATE INDEX IX_DemandLine_Demand ON scm.DemandLine (DemandId);

-- One unit of measure per material key per demand (invariant 15).
CREATE TABLE scm.DemandKeyUom (
    DemandId bigint        NOT NULL CONSTRAINT FK_DemandKeyUom_Demand REFERENCES scm.Demand (DemandId),
    LineKey  nvarchar(300) NOT NULL,
    Unit     nvarchar(10)  NOT NULL,
    CONSTRAINT PK_DemandKeyUom PRIMARY KEY (DemandId, LineKey)
);

-- The quantity ledger: a line's quantity in execution states (plan v5 §3.2).
CREATE TABLE scm.QtySlice (
    SliceId              bigint IDENTITY NOT NULL CONSTRAINT PK_QtySlice PRIMARY KEY,
    LineId               bigint       NOT NULL CONSTRAINT FK_QtySlice_Line REFERENCES scm.DemandLine (LineId),
    Qty                  bigint       NOT NULL CONSTRAINT CK_QtySlice_Qty CHECK (Qty > 0),
    ExecState            nvarchar(20) NOT NULL CONSTRAINT DF_QtySlice_State DEFAULT 'OPEN'
                         CONSTRAINT CK_QtySlice_State CHECK (ExecState IN ('OPEN', 'IN_RFQ', 'QUOTED', 'AWARDED', 'HANDED_OFF',
                                                                          'PO_PREPARATION', 'PO_SUBMITTED', 'PO_CREATED', 'CANCELLED', 'MERGED_OUT')),
    BusinessOrigin       nvarchar(12) NOT NULL CONSTRAINT CK_QtySlice_Origin CHECK (BusinessOrigin IN ('SALES', 'PROCUREMENT', 'CHANGE')),
    ArrivedVia           nvarchar(8)  NOT NULL CONSTRAINT DF_QtySlice_Arrived DEFAULT 'DIRECT' CONSTRAINT CK_QtySlice_Arrived CHECK (ArrivedVia IN ('DIRECT', 'MERGE')),
    OriginDemandId       bigint       NOT NULL CONSTRAINT FK_QtySlice_OriginDemand REFERENCES scm.Demand (DemandId),
    OriginLineId         bigint       NOT NULL CONSTRAINT FK_QtySlice_OriginLine REFERENCES scm.DemandLine (LineId),
    ApprovedEtdWeek      char(8)      NOT NULL,
    EffectiveSubmittedAt datetime2(0) NOT NULL,     -- the clock; kept through merges
    SplitFromSliceId     bigint NULL CONSTRAINT FK_QtySlice_Split REFERENCES scm.QtySlice (SliceId),
    MergedFromSliceId    bigint NULL CONSTRAINT FK_QtySlice_MergedFrom REFERENCES scm.QtySlice (SliceId),
    MergedInBy           bigint NULL,               -- FK Stage 3
    MergedOutBy          bigint NULL,               -- FK Stage 3
    MergedToSliceId      bigint NULL CONSTRAINT FK_QtySlice_MergedTo REFERENCES scm.QtySlice (SliceId),
    CancelOrigin         nvarchar(12) NULL CONSTRAINT CK_QtySlice_Cancel CHECK (CancelOrigin IN ('SALES', 'PROCUREMENT', 'CHANGE')),
    CancelCrId           bigint NULL,               -- FK Stage 2
    RfqLineId            bigint NULL,               -- FK Stage 4
    AwardItemId          bigint NULL,               -- FK Stage 5
    HandoffId            bigint NULL,               -- FK Stage 6
    RowVer               rowversion NOT NULL
);
CREATE INDEX IX_QtySlice_LineState ON scm.QtySlice (LineId, ExecState);

CREATE TABLE scm.SliceHistory (
    HistoryId      bigint IDENTITY NOT NULL CONSTRAINT PK_SliceHistory PRIMARY KEY,
    SliceId        bigint        NOT NULL CONSTRAINT FK_SliceHistory_Slice REFERENCES scm.QtySlice (SliceId),
    Action         nvarchar(12)  NOT NULL CONSTRAINT CK_SliceHistory_Action CHECK (Action IN ('CREATE', 'TRANSITION', 'SPLIT')),
    TriggerName    nvarchar(30)  NULL,
    FromState      nvarchar(20)  NULL,
    ToState        nvarchar(20)  NOT NULL,
    Qty            bigint        NOT NULL,
    RelatedSliceId bigint        NULL,
    ReasonCode     nvarchar(40)  NULL,
    DocType        nvarchar(20)  NULL,
    DocId          bigint        NULL,
    Comment        nvarchar(1000) NULL,
    ActorUserId    int           NULL,
    ChangedAt      datetime2(3)  NOT NULL CONSTRAINT DF_SliceHistory_At DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_SliceHistory_Slice ON scm.SliceHistory (SliceId, HistoryId);

CREATE TABLE scm.DemandVersion (
    DemandId     bigint        NOT NULL CONSTRAINT FK_DemandVersion_Demand REFERENCES scm.Demand (DemandId),
    VersionNo    int           NOT NULL,
    Reason       nvarchar(40)  NOT NULL,     -- SUBMIT, RESUBMIT, ACCEPT, CR_APPLIED, MERGE_IN, MERGE_OUT, UNMERGE, ADD_TO_DEMAND
    SourceRef    nvarchar(40)  NULL,
    SnapshotJson nvarchar(max) NOT NULL,
    CreatedBy    int           NOT NULL,
    CreatedAt    datetime2(0)  NOT NULL CONSTRAINT DF_DemandVersion_At DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_DemandVersion PRIMARY KEY (DemandId, VersionNo)
);
GO

-- Versions are immutable: the baseline (version 1) never changes (invariant 18).
CREATE TRIGGER scm.TR_DemandVersion_Immutable ON scm.DemandVersion INSTEAD OF UPDATE, DELETE AS
BEGIN
    THROW 51003, 'Demand versions cannot be changed or deleted.', 1;
END;
GO

-- Ledger per line: requested vs the quantity in every state (milli-units).
CREATE VIEW scm.vLineLedger AS
SELECT l.LineId, l.DemandId, l.DemandWeekId, w.EtdWeek, l.LineKey, l.Unit, l.RequestedQty, l.IsActive,
  ISNULL(SUM(CASE WHEN s.ExecState = 'OPEN'           THEN s.Qty END), 0) AS OpenQty,
  ISNULL(SUM(CASE WHEN s.ExecState = 'IN_RFQ'         THEN s.Qty END), 0) AS InRfqQty,
  ISNULL(SUM(CASE WHEN s.ExecState = 'QUOTED'         THEN s.Qty END), 0) AS QuotedQty,
  ISNULL(SUM(CASE WHEN s.ExecState = 'AWARDED'        THEN s.Qty END), 0) AS AwardedQty,
  ISNULL(SUM(CASE WHEN s.ExecState = 'HANDED_OFF'     THEN s.Qty END), 0) AS HandedOffQty,
  ISNULL(SUM(CASE WHEN s.ExecState = 'PO_PREPARATION' THEN s.Qty END), 0) AS PoPrepQty,
  ISNULL(SUM(CASE WHEN s.ExecState = 'PO_SUBMITTED'   THEN s.Qty END), 0) AS PoSubmittedQty,
  ISNULL(SUM(CASE WHEN s.ExecState = 'PO_CREATED'     THEN s.Qty END), 0) AS PoCreatedQty,
  ISNULL(SUM(CASE WHEN s.ExecState = 'CANCELLED'      THEN s.Qty END), 0) AS CancelledQty,
  ISNULL(SUM(CASE WHEN s.ExecState = 'MERGED_OUT'     THEN s.Qty END), 0) AS MergedOutQty,
  ISNULL(SUM(s.Qty), 0) AS SliceTotal
FROM scm.DemandLine l
JOIN scm.DemandWeek w ON w.DemandWeekId = l.DemandWeekId
LEFT JOIN scm.QtySlice s ON s.LineId = l.LineId
GROUP BY l.LineId, l.DemandId, l.DemandWeekId, w.EtdWeek, l.LineKey, l.Unit, l.RequestedQty, l.IsActive;
GO

-- Status of a demand (plan v5 §4.2): workflow status until accepted, then derived from the quantities.
-- Must stay in step with deriveStatus() in apps/api/src/modules/workflow/ledger.ts (a test compares them).
CREATE VIEW scm.vDemandStatus AS
SELECT d.DemandId,
  CASE
    WHEN d.WorkflowStatus <> 'ACCEPTED' THEN d.WorkflowStatus
    WHEN t.Requested > 0 AND t.Final = t.Requested AND t.MergedOut = t.Requested THEN 'MERGED'
    WHEN t.Requested > 0 AND t.Final = t.Requested AND t.PoCreated > 0 AND t.Cancelled > 0 THEN 'CLOSED_PARTIALLY_EXECUTED'
    WHEN t.Requested > 0 AND t.Final = t.Requested AND t.PoCreated > 0 THEN 'CLOSED_FULLY_EXECUTED'
    WHEN t.Requested > 0 AND t.Final = t.Requested THEN 'CANCELLED'
    WHEN t.InProgress = 0 AND t.PoCreated = 0 THEN 'NOT_STARTED'
    WHEN t.OpenQty > 0 THEN 'PARTIALLY_IN_EXECUTION'
    ELSE 'FULLY_IN_EXECUTION'
  END AS Status
FROM scm.Demand d
OUTER APPLY (
  SELECT ISNULL(SUM(RequestedQty), 0) AS Requested,
         ISNULL(SUM(OpenQty), 0) AS OpenQty,
         ISNULL(SUM(InRfqQty + QuotedQty + AwardedQty + HandedOffQty + PoPrepQty + PoSubmittedQty), 0) AS InProgress,
         ISNULL(SUM(PoCreatedQty), 0) AS PoCreated,
         ISNULL(SUM(CancelledQty), 0) AS Cancelled,
         ISNULL(SUM(MergedOutQty), 0) AS MergedOut,
         ISNULL(SUM(PoCreatedQty + CancelledQty + MergedOutQty), 0) AS Final
  FROM scm.vLineLedger WHERE DemandId = d.DemandId
) t;
GO

-- Two editable starter roles (spec 12). Users still need a company (spec 11).
INSERT INTO app.Role (Name, Description) VALUES
    ('Sales', 'Creates and submits demands.'),
    ('Procurement', 'Accepts or returns demands.');
INSERT INTO app.RolePermission (RoleId, PermissionKey)
SELECT r.RoleId, p.k FROM app.Role r
JOIN (VALUES ('Sales', 'work.open'), ('Sales', 'demands.open'), ('Sales', 'demand.create'), ('Sales', 'demand.submit'),
             ('Sales', 'demand.comment'), ('Sales', 'demand.attach'), ('Sales', 'materials.open'),
             ('Procurement', 'work.open'), ('Procurement', 'demands.open'), ('Procurement', 'demand.accept'), ('Procurement', 'demand.return'),
             ('Procurement', 'demand.comment'), ('Procurement', 'demand.attach'), ('Procurement', 'materials.open'),
             ('Procurement', 'suppliers.open'), ('Procurement', 'purchaseOrders.open')) AS p(RoleName, k)
  ON p.RoleName = r.Name
WHERE r.Name IN ('Sales', 'Procurement') AND NOT EXISTS (SELECT 1 FROM app.RolePermission x WHERE x.RoleId = r.RoleId AND x.PermissionKey = p.k);
