-- Login with Active Directory, users, roles and permissions, audit log.
CREATE TABLE app.[User] (
    UserId       int IDENTITY   NOT NULL CONSTRAINT PK_User PRIMARY KEY,
    Username     nvarchar(100)  NOT NULL CONSTRAINT UQ_User_Username UNIQUE, -- AD sAMAccountName, lower case
    Upn          nvarchar(200)  NOT NULL CONSTRAINT DF_User_Upn DEFAULT '',
    DisplayName  nvarchar(200)  NOT NULL CONSTRAINT DF_User_DisplayName DEFAULT '',
    Email        nvarchar(200)  NOT NULL CONSTRAINT DF_User_Email DEFAULT '',
    Department   nvarchar(200)  NOT NULL CONSTRAINT DF_User_Department DEFAULT '',
    Title        nvarchar(200)  NOT NULL CONSTRAINT DF_User_Title DEFAULT '',
    IsActive     bit            NOT NULL CONSTRAINT DF_User_IsActive DEFAULT 1,
    CreatedAt    datetime2(0)   NOT NULL CONSTRAINT DF_User_CreatedAt DEFAULT SYSUTCDATETIME(),
    CreatedBy    nvarchar(100)  NOT NULL,
    LastLoginAt  datetime2(0)   NULL,
    RowVer       rowversion     NOT NULL
);
GO

CREATE TABLE app.Role (
    RoleId       int IDENTITY   NOT NULL CONSTRAINT PK_Role PRIMARY KEY,
    Name         nvarchar(100)  NOT NULL CONSTRAINT UQ_Role_Name UNIQUE,
    Description  nvarchar(400)  NOT NULL CONSTRAINT DF_Role_Description DEFAULT '',
    IsAdmin      bit            NOT NULL CONSTRAINT DF_Role_IsAdmin DEFAULT 0,   -- every permission, including future ones
    IsBuiltIn    bit            NOT NULL CONSTRAINT DF_Role_IsBuiltIn DEFAULT 0, -- cannot be edited or deleted
    IsActive     bit            NOT NULL CONSTRAINT DF_Role_IsActive DEFAULT 1,
    RowVer       rowversion     NOT NULL
);

CREATE TABLE app.RolePermission (
    RoleId        int           NOT NULL CONSTRAINT FK_RolePermission_Role REFERENCES app.Role (RoleId) ON DELETE CASCADE,
    PermissionKey nvarchar(100) NOT NULL,
    CONSTRAINT PK_RolePermission PRIMARY KEY (RoleId, PermissionKey)
);

CREATE TABLE app.UserRole (
    UserId int NOT NULL CONSTRAINT FK_UserRole_User REFERENCES app.[User] (UserId) ON DELETE CASCADE,
    RoleId int NOT NULL CONSTRAINT FK_UserRole_Role REFERENCES app.Role (RoleId) ON DELETE CASCADE,
    CONSTRAINT PK_UserRole PRIMARY KEY (UserId, RoleId)
);

CREATE TABLE app.AuditLog (
    AuditId  bigint IDENTITY NOT NULL CONSTRAINT PK_AuditLog PRIMARY KEY,
    At       datetime2(0)    NOT NULL CONSTRAINT DF_AuditLog_At DEFAULT SYSUTCDATETIME(),
    UserId   int             NULL,           -- who did it (null = not signed in, e.g. a failed login)
    Action   nvarchar(60)    NOT NULL,       -- e.g. login.success, user.add, role.permissions
    Target   nvarchar(200)   NOT NULL CONSTRAINT DF_AuditLog_Target DEFAULT '',
    Details  nvarchar(max)   NULL            -- JSON
);
CREATE INDEX IX_AuditLog_At ON app.AuditLog (At DESC);
GO

INSERT INTO app.Role (Name, Description, IsAdmin, IsBuiltIn)
VALUES ('Administrator', 'Full access to every screen and button, including ones added later.', 1, 1);
