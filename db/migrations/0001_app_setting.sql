-- Baseline: application schema and a key/value settings table.
IF SCHEMA_ID('app') IS NULL EXEC('CREATE SCHEMA app');
GO

CREATE TABLE app.Setting (
    SettingKey   nvarchar(100)  NOT NULL CONSTRAINT PK_Setting PRIMARY KEY,
    SettingValue nvarchar(max)  NULL,
    UpdatedAt    datetime2(0)   NOT NULL CONSTRAINT DF_Setting_UpdatedAt DEFAULT SYSUTCDATETIME()
);
