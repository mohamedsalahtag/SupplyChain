-- Demand-to-PO plan v5, Stage 2: change requests with line and week holds (specs 14, 15).
CREATE SEQUENCE scm.CrNoSeq AS bigint START WITH 1 INCREMENT BY 1;

CREATE TABLE scm.ChangeRequest (
    CrId            bigint IDENTITY NOT NULL CONSTRAINT PK_ChangeRequest PRIMARY KEY,
    CrNo            nvarchar(20)   NOT NULL CONSTRAINT UQ_ChangeRequest_No UNIQUE,     -- CR-000012
    DemandId        bigint         NOT NULL CONSTRAINT FK_ChangeRequest_Demand REFERENCES scm.Demand (DemandId),
    CompanyCode     nvarchar(10)   NOT NULL,
    CrType          nvarchar(30)   NOT NULL CONSTRAINT CK_ChangeRequest_Type CHECK (CrType IN ('CHANGE_CONTAINERS', 'CANCEL_WEEK', 'CANCEL_DEMAND', 'NOT_SOURCED')),
    RaisedByDept    nvarchar(20)   NOT NULL CONSTRAINT CK_ChangeRequest_Dept CHECK (RaisedByDept IN ('SALES', 'PROCUREMENT')),
    Status          nvarchar(20)   NOT NULL CONSTRAINT CK_ChangeRequest_Status CHECK (Status IN ('SUBMITTED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'WITHDRAWN', 'BLOCKED')),
    ApplyStatus     nvarchar(20)   NOT NULL CONSTRAINT DF_ChangeRequest_Apply DEFAULT 'NOT_REQUIRED'
                    CONSTRAINT CK_ChangeRequest_Apply CHECK (ApplyStatus IN ('NOT_REQUIRED', 'APPLIED', 'PARTIALLY_APPLIED')),
    ReasonCode      nvarchar(40)   NOT NULL CONSTRAINT FK_ChangeRequest_Reason REFERENCES scm.ReasonCode (ReasonCode),
    Comment         nvarchar(2000) NOT NULL,
    BlockedReason   nvarchar(max)  NULL,
    RaisedBy        int            NOT NULL CONSTRAINT FK_ChangeRequest_RaisedBy REFERENCES app.[User] (UserId),
    SubmittedAt     datetime2(0)   NOT NULL CONSTRAINT DF_ChangeRequest_At DEFAULT SYSUTCDATETIME(),
    DecidedBy       int            NULL CONSTRAINT FK_ChangeRequest_DecidedBy REFERENCES app.[User] (UserId),
    DecidedAt       datetime2(0)   NULL,
    DecisionComment nvarchar(2000) NULL,
    AppliedAt       datetime2(0)   NULL,
    RowVer          rowversion     NOT NULL,
    -- Nobody decides a change request they raised (plan v5 D6).
    CONSTRAINT CK_ChangeRequest_NoSelfDecision CHECK (DecidedBy IS NULL OR DecidedBy <> RaisedBy)
);
CREATE INDEX IX_ChangeRequest_Demand ON scm.ChangeRequest (DemandId, Status);

-- One item per changed container group (Sales) or per line / week count (Procurement "not sourced").
CREATE TABLE scm.ChangeRequestItem (
    CrItemId         bigint IDENTITY NOT NULL CONSTRAINT PK_ChangeRequestItem PRIMARY KEY,
    CrId             bigint         NOT NULL CONSTRAINT FK_ChangeRequestItem_Cr REFERENCES scm.ChangeRequest (CrId),
    ItemNo           int            NOT NULL,
    ItemKind         nvarchar(20)   NOT NULL CONSTRAINT CK_ChangeRequestItem_Kind CHECK (ItemKind IN
                     ('GROUP_COUNT', 'GROUP_ADD', 'GROUP_REMOVE', 'GROUP_COMPOSITION', 'QTY_NOT_SOURCED', 'WEEK_CONTAINERS')),
    EtdWeek          char(8)        NOT NULL,
    ContainerGroupId bigint         NULL CONSTRAINT FK_ChangeRequestItem_Group REFERENCES scm.ContainerGroup (ContainerGroupId),
    LineId           bigint         NULL CONSTRAINT FK_ChangeRequestItem_Line REFERENCES scm.DemandLine (LineId),
    BeforeJson       nvarchar(max)  NULL,     -- the group (or count) before
    AfterJson        nvarchar(max)  NULL,     -- the group (or count) requested
    EffectJson       nvarchar(max)  NOT NULL, -- quantity change per material key
    RequestedCount   int            NULL,     -- containers requested (group count / add / week count)
    RequestedQty     bigint         NULL,     -- milli (not sourced)
    LedgerAtSubmit   nvarchar(max)  NULL,
    Decision         nvarchar(10)   NULL CONSTRAINT CK_ChangeRequestItem_Decision CHECK (Decision IN ('APPROVE', 'PARTIAL', 'REJECT')),
    ApprovedCount    int            NULL,
    ApprovedQty      bigint         NULL,
    AppliedQty       bigint         NULL,     -- milli actually cancelled or added
    ApplyMessage     nvarchar(1000) NULL,
    CONSTRAINT UQ_ChangeRequestItem UNIQUE (CrId, ItemNo)
);

-- Holds: at most one open change request per line and per demand week (invariant 6).
CREATE TABLE scm.LineHold (
    LineId bigint       NOT NULL CONSTRAINT PK_LineHold PRIMARY KEY CONSTRAINT FK_LineHold_Line REFERENCES scm.DemandLine (LineId),
    CrId   bigint       NOT NULL CONSTRAINT FK_LineHold_Cr REFERENCES scm.ChangeRequest (CrId),
    HeldAt datetime2(0) NOT NULL CONSTRAINT DF_LineHold_At DEFAULT SYSUTCDATETIME()
);
CREATE TABLE scm.WeekHold (
    DemandId bigint       NOT NULL CONSTRAINT FK_WeekHold_Demand REFERENCES scm.Demand (DemandId),
    EtdWeek  char(8)      NOT NULL,
    CrId     bigint       NOT NULL CONSTRAINT FK_WeekHold_Cr REFERENCES scm.ChangeRequest (CrId),
    HeldAt   datetime2(0) NOT NULL CONSTRAINT DF_WeekHold_At DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_WeekHold PRIMARY KEY (DemandId, EtdWeek)
);

ALTER TABLE scm.DemandLine ADD CONSTRAINT FK_DemandLine_Hold FOREIGN KEY (ChangeHoldCrId) REFERENCES scm.ChangeRequest (CrId);
ALTER TABLE scm.QtySlice ADD CONSTRAINT FK_QtySlice_CancelCr FOREIGN KEY (CancelCrId) REFERENCES scm.ChangeRequest (CrId);

-- A container group replaced or removed by a change request is kept (history), not deleted.
ALTER TABLE scm.ContainerGroup ADD IsActive bit NOT NULL CONSTRAINT DF_ContainerGroup_Active DEFAULT 1;

-- My work: an item can be hidden from one user (the raiser never decides their own request).
ALTER TABLE scm.InboxItem ADD ExcludeUserId int NULL;
GO

-- Permissions for the seeded roles (spec 14).
INSERT INTO app.RolePermission (RoleId, PermissionKey)
SELECT r.RoleId, p.k FROM app.Role r
JOIN (VALUES ('Sales', 'crs.open'), ('Sales', 'cr.raise.sales'), ('Sales', 'cr.decide.procurement'), ('Sales', 'cr.withdraw'),
             ('Procurement', 'crs.open'), ('Procurement', 'cr.raise.procurement'), ('Procurement', 'cr.decide.sales'), ('Procurement', 'cr.withdraw')) AS p(RoleName, k)
  ON p.RoleName = r.Name
WHERE NOT EXISTS (SELECT 1 FROM app.RolePermission x WHERE x.RoleId = r.RoleId AND x.PermissionKey = p.k);
