-- Container capacity (spec 32, 2026-09-29): the maximum payload per container for each product. A new demand's
-- "Capacity per container" starts from it. A row applies to a major category, optionally narrowed to a sub-major and
-- then a size; NULL = any. The most specific active row wins; a mixed container takes the smallest of its products.
-- Lengths follow md.Material (category and size names are copied from it). Grants: none (administrators hold every
-- permission; 'configuration.workflow.capacity.edit' is given to roles on the Security page).
CREATE TABLE scm.ContainerCapacity (
    CapacityId       int            IDENTITY(1,1) NOT NULL CONSTRAINT PK_ContainerCapacity PRIMARY KEY,
    MajorCategory    nvarchar(80)   NOT NULL,
    SubMajorCategory nvarchar(80)   NULL,   -- NULL = any sub-major of the major
    Size             nvarchar(80)   NULL,   -- NULL = any size (only with a sub-major)
    Unit             nvarchar(10)   NOT NULL,
    Capacity         int            NOT NULL CONSTRAINT CK_ContainerCapacity_Capacity CHECK (Capacity > 0),
    IsActive         bit            NOT NULL CONSTRAINT DF_ContainerCapacity_IsActive DEFAULT 1,
    UpdatedBy        int            NULL CONSTRAINT FK_ContainerCapacity_User REFERENCES app.[User] (UserId),
    UpdatedAt        datetime2(0)   NOT NULL CONSTRAINT DF_ContainerCapacity_UpdatedAt DEFAULT SYSUTCDATETIME(),
    RowVer           rowversion     NOT NULL,
    CONSTRAINT CK_ContainerCapacity_SizeNeedsSub CHECK (Size IS NULL OR SubMajorCategory IS NOT NULL),
    CONSTRAINT CK_ContainerCapacity_NotBlank CHECK (LEN(MajorCategory) > 0 AND (SubMajorCategory IS NULL OR LEN(SubMajorCategory) > 0)
                                                    AND (Size IS NULL OR LEN(Size) > 0) AND LEN(Unit) > 0),
    -- A UNIQUE constraint treats NULLs as equal: (Apples, NULL, NULL) can exist only once, as intended.
    CONSTRAINT UQ_ContainerCapacity_Key UNIQUE (MajorCategory, SubMajorCategory, Size)
);
GO
CREATE INDEX IX_ContainerCapacity_UpdatedBy ON scm.ContainerCapacity (UpdatedBy);
