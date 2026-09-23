-- Screen 01/02: materials copied from SAP, and a log of every sync run.
IF SCHEMA_ID('md') IS NULL EXEC('CREATE SCHEMA md');
GO
IF SCHEMA_ID('integ') IS NULL EXEC('CREATE SCHEMA integ');
GO

CREATE TABLE md.Material (
    MaterialCode      nvarchar(40)   NOT NULL CONSTRAINT PK_Material PRIMARY KEY,
    Description       nvarchar(200)  NOT NULL,
    MajorCategoryCode nvarchar(10)   NOT NULL,
    MajorCategory     nvarchar(80)   NOT NULL,
    SubMajorCategory  nvarchar(80)   NOT NULL,
    MaterialGroupCode nvarchar(20)   NOT NULL,
    MaterialGroup     nvarchar(80)   NOT NULL,
    MaterialType      nvarchar(10)   NOT NULL,
    BaseUnit          nvarchar(10)   NOT NULL,
    BaseUnitName      nvarchar(40)   NOT NULL,
    Origin            nvarchar(80)   NOT NULL,
    Variety           nvarchar(80)   NOT NULL,
    Size              nvarchar(80)   NOT NULL,
    Weight            decimal(18, 3) NULL,
    WeightUnit        nvarchar(10)   NOT NULL,
    InSap             bit            NOT NULL CONSTRAINT DF_Material_InSap DEFAULT 1,
    -- When the last sync inserted or changed this row.
    SapChangedAt      datetime2(0)   NOT NULL CONSTRAINT DF_Material_SapChangedAt DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Material_Category ON md.Material (MajorCategory, SubMajorCategory);
GO

CREATE TABLE integ.SyncRun (
    SyncRunId          int IDENTITY   NOT NULL CONSTRAINT PK_SyncRun PRIMARY KEY,
    Source             nvarchar(50)   NOT NULL,
    Status             nvarchar(20)   NOT NULL CONSTRAINT CK_SyncRun_Status CHECK (Status IN ('Running', 'Succeeded', 'Failed')),
    StartedAt          datetime2(0)   NOT NULL CONSTRAINT DF_SyncRun_StartedAt DEFAULT SYSUTCDATETIME(),
    StartedBy          nvarchar(100)  NOT NULL,
    FinishedAt         datetime2(0)   NULL,
    RowsRead           int            NULL,
    RowsInserted       int            NULL,
    RowsUpdated        int            NULL,
    RowsMarkedMissing  int            NULL,
    Message            nvarchar(max)  NULL
);
-- At most one running sync per source: a second start fails on this index.
CREATE UNIQUE INDEX UX_SyncRun_OneRunning ON integ.SyncRun (Source) WHERE Status = 'Running';
