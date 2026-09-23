-- Material class from SAP (ClassID + Class_Name), filled by the next sync.
ALTER TABLE md.Material ADD
    MaterialClassCode nvarchar(20) NOT NULL CONSTRAINT DF_Material_ClassCode DEFAULT '',
    MaterialClass     nvarchar(80) NOT NULL CONSTRAINT DF_Material_Class DEFAULT '';
GO

-- The Materials table has new default columns (UoM and Group hidden, Class
-- added). Drop the saved column choices so everyone starts from the new defaults.
DELETE FROM app.UserPreference WHERE PrefKey = 'table:materials';
