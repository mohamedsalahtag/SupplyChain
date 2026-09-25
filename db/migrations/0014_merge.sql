-- Demand-to-PO plan v5, Stage 3: merge (weeks or a whole demand) and unmerge (spec 17).
CREATE SEQUENCE scm.MergeNoSeq AS bigint START WITH 1 INCREMENT BY 1;

CREATE TABLE scm.MergeRecord (
    MergeId         bigint IDENTITY NOT NULL CONSTRAINT PK_MergeRecord PRIMARY KEY,
    MergeNo         nvarchar(20)   NOT NULL CONSTRAINT UQ_MergeRecord_No UNIQUE,       -- MG-000001
    SourceDemandId  bigint         NOT NULL CONSTRAINT FK_MergeRecord_Source REFERENCES scm.Demand (DemandId),
    TargetDemandId  bigint         NOT NULL CONSTRAINT FK_MergeRecord_Target REFERENCES scm.Demand (DemandId),
    CompanyCode     nvarchar(10)   NOT NULL,
    Scope           nvarchar(10)   NOT NULL CONSTRAINT CK_MergeRecord_Scope CHECK (Scope IN ('WEEKS', 'DEMAND')),
    Status          nvarchar(10)   NOT NULL CONSTRAINT DF_MergeRecord_Status DEFAULT 'EXECUTED'
                    CONSTRAINT CK_MergeRecord_Status CHECK (Status IN ('EXECUTED', 'UNMERGED')),
    Comment         nvarchar(2000) NOT NULL CONSTRAINT DF_MergeRecord_Comment DEFAULT '',
    ExecutedBy      int            NOT NULL CONSTRAINT FK_MergeRecord_ExecutedBy REFERENCES app.[User] (UserId),
    ExecutedAt      datetime2(0)   NOT NULL CONSTRAINT DF_MergeRecord_At DEFAULT SYSUTCDATETIME(),
    UnmergedBy      int            NULL CONSTRAINT FK_MergeRecord_UnmergedBy REFERENCES app.[User] (UserId),
    UnmergedAt      datetime2(0)   NULL,
    UnmergeReason   nvarchar(2000) NULL,
    RowVer          rowversion     NOT NULL,
    CONSTRAINT CK_MergeRecord_Distinct CHECK (SourceDemandId <> TargetDemandId)
);
CREATE INDEX IX_MergeRecord_Source ON scm.MergeRecord (SourceDemandId);
CREATE INDEX IX_MergeRecord_Target ON scm.MergeRecord (TargetDemandId);

CREATE TABLE scm.MergeWeek (
    MergeId          bigint NOT NULL CONSTRAINT FK_MergeWeek_Merge REFERENCES scm.MergeRecord (MergeId),
    SourceWeekId     bigint NOT NULL CONSTRAINT FK_MergeWeek_Source REFERENCES scm.DemandWeek (DemandWeekId),
    TargetWeekId     bigint NOT NULL CONSTRAINT FK_MergeWeek_Target REFERENCES scm.DemandWeek (DemandWeekId),
    ContainersMoved  int    NOT NULL CONSTRAINT CK_MergeWeek_Moved CHECK (ContainersMoved >= 0),
    CONSTRAINT PK_MergeWeek PRIMARY KEY (MergeId, SourceWeekId)
);

CREATE TABLE scm.MergeItem (
    MergeId        bigint NOT NULL CONSTRAINT FK_MergeItem_Merge REFERENCES scm.MergeRecord (MergeId),
    SourceSliceId  bigint NOT NULL CONSTRAINT FK_MergeItem_SourceSlice REFERENCES scm.QtySlice (SliceId),
    TargetSliceId  bigint NOT NULL CONSTRAINT FK_MergeItem_TargetSlice REFERENCES scm.QtySlice (SliceId),
    SourceLineId   bigint NOT NULL CONSTRAINT FK_MergeItem_SourceLine REFERENCES scm.DemandLine (LineId),
    TargetLineId   bigint NOT NULL CONSTRAINT FK_MergeItem_TargetLine REFERENCES scm.DemandLine (LineId),
    Qty            bigint NOT NULL CONSTRAINT CK_MergeItem_Qty CHECK (Qty > 0),
    CONSTRAINT PK_MergeItem PRIMARY KEY (MergeId, SourceSliceId)
);

ALTER TABLE scm.QtySlice ADD CONSTRAINT FK_QtySlice_MergedIn FOREIGN KEY (MergedInBy) REFERENCES scm.MergeRecord (MergeId);
ALTER TABLE scm.QtySlice ADD CONSTRAINT FK_QtySlice_MergedOut FOREIGN KEY (MergedOutBy) REFERENCES scm.MergeRecord (MergeId);

-- Container groups move with a merge: the source group is kept inactive (MergedOutBy),
-- a copy is written in the target week (MergedInBy, SourceGroupId). Unmerge flips them back.
ALTER TABLE scm.ContainerGroup ADD
    MergedInBy    bigint NULL CONSTRAINT FK_ContainerGroup_MergedIn REFERENCES scm.MergeRecord (MergeId),
    MergedOutBy   bigint NULL CONSTRAINT FK_ContainerGroup_MergedOut REFERENCES scm.MergeRecord (MergeId),
    SourceGroupId bigint NULL CONSTRAINT FK_ContainerGroup_Source REFERENCES scm.ContainerGroup (ContainerGroupId);
GO

-- Permissions (spec 17): Procurement merges and unmerges.
INSERT INTO app.RolePermission (RoleId, PermissionKey)
SELECT r.RoleId, p.k FROM app.Role r
JOIN (VALUES ('Procurement', 'demand.merge'), ('Procurement', 'demand.unmerge')) AS p(RoleName, k) ON p.RoleName = r.Name
WHERE NOT EXISTS (SELECT 1 FROM app.RolePermission x WHERE x.RoleId = r.RoleId AND x.PermissionKey = p.k);
