-- Stage 1 revision (spec 12): demands are entered as container groups with a composition.
-- Lines (the plan's week × material key ledger) are worked out from the groups on every save.
-- The material key gains the material class: category | sub-category | size | class | origin | SKU.

DROP INDEX UX_DemandLine_Key ON scm.DemandLine;
ALTER TABLE scm.DemandLine DROP COLUMN LineKey;
ALTER TABLE scm.DemandLine ADD MaterialClass nvarchar(80) NOT NULL CONSTRAINT DF_DemandLine_Class DEFAULT '';
GO
ALTER TABLE scm.DemandLine ADD LineKey AS
    (CONCAT(MajorCategory, N'|', SubMajorCategory, N'|', Size, N'|', MaterialClass, N'|', OriginCode, N'|', ISNULL(MaterialCode, N''))) PERSISTED;
GO
CREATE UNIQUE INDEX UX_DemandLine_Key ON scm.DemandLine (DemandWeekId, LineKey) WHERE IsActive = 1;
EXEC sp_refreshview 'scm.vLineLedger';
EXEC sp_refreshview 'scm.vDemandStatus';

-- One unit per key per demand: rebuild the keys in the new format.
DELETE FROM scm.DemandKeyUom;
INSERT INTO scm.DemandKeyUom (DemandId, LineKey, Unit)
SELECT DemandId, LineKey, MIN(Unit) FROM scm.DemandLine WHERE IsActive = 1 GROUP BY DemandId, LineKey;
GO

-- N identical containers with one capacity (in one unit) and one composition.
CREATE TABLE scm.ContainerGroup (
    ContainerGroupId bigint IDENTITY NOT NULL CONSTRAINT PK_ContainerGroup PRIMARY KEY,
    DemandId         bigint       NOT NULL CONSTRAINT FK_ContainerGroup_Demand REFERENCES scm.Demand (DemandId),
    DemandWeekId     bigint       NOT NULL CONSTRAINT FK_ContainerGroup_Week REFERENCES scm.DemandWeek (DemandWeekId),
    GroupNumber      int          NOT NULL,
    ContainerCount   int          NOT NULL CONSTRAINT CK_ContainerGroup_Count CHECK (ContainerCount >= 1),
    CapacityQty      bigint       NOT NULL CONSTRAINT CK_ContainerGroup_Capacity CHECK (CapacityQty > 0),   -- milli-units per container
    Unit             nvarchar(10) NOT NULL,
    RowVer           rowversion   NOT NULL
);
CREATE INDEX IX_ContainerGroup_Week ON scm.ContainerGroup (DemandWeekId);

-- One material (size × class combination, or SKU) in a group, with its share of each container.
CREATE TABLE scm.ContainerGroupItem (
    ContainerGroupItemId bigint IDENTITY NOT NULL CONSTRAINT PK_ContainerGroupItem PRIMARY KEY,
    ContainerGroupId     bigint        NOT NULL CONSTRAINT FK_ContainerGroupItem_Group REFERENCES scm.ContainerGroup (ContainerGroupId),
    SpecMode             nvarchar(4)   NOT NULL CONSTRAINT CK_ContainerGroupItem_Mode CHECK (SpecMode IN ('SPEC', 'SKU')),
    MajorCategory        nvarchar(80)  NOT NULL,
    SubMajorCategory     nvarchar(80)  NOT NULL,
    Size                 nvarchar(80)  NOT NULL,
    MaterialClass        nvarchar(80)  NOT NULL,
    OriginCode           nvarchar(3)   NOT NULL,
    MaterialCode         nvarchar(40)  NULL,
    Unit                 nvarchar(10)  NOT NULL,
    ShareBp              int           NOT NULL CONSTRAINT CK_ContainerGroupItem_Share CHECK (ShareBp BETWEEN 1 AND 10000),  -- 1/100 of a percent
    ComputedQty          bigint        NOT NULL CONSTRAINT CK_ContainerGroupItem_Qty CHECK (ComputedQty >= 0),              -- milli, whole group
    LineKey AS (CONCAT(MajorCategory, N'|', SubMajorCategory, N'|', Size, N'|', MaterialClass, N'|', OriginCode, N'|', ISNULL(MaterialCode, N''))) PERSISTED,
    CONSTRAINT CK_ContainerGroupItem_Sku CHECK (SpecMode = 'SPEC' OR MaterialCode IS NOT NULL)
);
CREATE UNIQUE INDEX UX_ContainerGroupItem_Key ON scm.ContainerGroupItem (ContainerGroupId, LineKey);
