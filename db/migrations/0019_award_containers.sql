-- Spec 20 revision 1: award by containers. Procurement picks, per week and container group, how many
-- containers each supplier ships; the award items (per RFQ line x supplier, the ledger) are worked out from it.

-- The decision: n containers of a container group to a supplier, in one award batch.
CREATE TABLE scm.AwardContainer (
    AwardContainerId bigint IDENTITY NOT NULL CONSTRAINT PK_AwardContainer PRIMARY KEY,
    AwardBatchId     bigint       NOT NULL CONSTRAINT FK_AwardContainer_Batch REFERENCES scm.AwardBatch (AwardBatchId),
    ContainerGroupId bigint       NOT NULL CONSTRAINT FK_AwardContainer_Group REFERENCES scm.ContainerGroup (ContainerGroupId),
    SupplierCode     nvarchar(20) NOT NULL,
    EtdWeek          char(8)      NOT NULL,
    Containers       int          NOT NULL CONSTRAINT CK_AwardContainer_Count CHECK (Containers >= 0),   -- active containers (un-award lowers it)
    IsActive         bit          NOT NULL CONSTRAINT DF_AwardContainer_Active DEFAULT 1,
    CreatedAt        datetime2(0) NOT NULL CONSTRAINT DF_AwardContainer_At DEFAULT SYSUTCDATETIME(),
    RowVer           rowversion   NOT NULL,
    CONSTRAINT UQ_AwardContainer UNIQUE (AwardBatchId, ContainerGroupId, SupplierCode)
);
CREATE INDEX IX_AwardContainer_Group ON scm.AwardContainer (ContainerGroupId);

-- The container log of a batch: above the supplier's offer, containers added at award time, un-award by containers.
CREATE TABLE scm.AwardContainerChange (
    ChangeId         bigint IDENTITY NOT NULL CONSTRAINT PK_AwardContainerChange PRIMARY KEY,
    AwardBatchId     bigint        NOT NULL CONSTRAINT FK_AwardContainerChange_Batch REFERENCES scm.AwardBatch (AwardBatchId),
    AwardContainerId bigint        NULL CONSTRAINT FK_AwardContainerChange_Container REFERENCES scm.AwardContainer (AwardContainerId),
    ContainerGroupId bigint        NULL CONSTRAINT FK_AwardContainerChange_Group REFERENCES scm.ContainerGroup (ContainerGroupId),
    ChangeType       nvarchar(24)  NOT NULL CONSTRAINT CK_AwardContainerChange_Type CHECK (ChangeType IN ('ABOVE_OFFER', 'CONTAINERS_ADDED', 'UNAWARD_KEEP_QUOTES', 'UNAWARD_RELEASE')),
    SupplierCode     nvarchar(20)  NULL,
    EtdWeek          char(8)       NOT NULL,
    Containers       int           NOT NULL,       -- awarded (ABOVE_OFFER), added, or un-awarded
    Offered          int           NULL,           -- ABOVE_OFFER: what the supplier offered for the week
    Note             nvarchar(500) NOT NULL CONSTRAINT DF_AwardContainerChange_Note DEFAULT '',
    ReasonCode       nvarchar(40)  NULL,
    ActorUserId      int           NOT NULL CONSTRAINT FK_AwardContainerChange_User REFERENCES app.[User] (UserId),
    ChangedAt        datetime2(0)  NOT NULL CONSTRAINT DF_AwardContainerChange_At DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_AwardContainerChange_Batch ON scm.AwardContainerChange (AwardBatchId);

-- Items worked out from containers: the offered containers are the limit, not the quoted available quantity (invariant 19).
ALTER TABLE scm.AwardItem ADD ByContainers bit NOT NULL CONSTRAINT DF_AwardItem_ByContainers DEFAULT 0;
