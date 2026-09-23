-- Per-user preferences that must survive restarts and browser changes
-- (table rows-per-page, hidden columns). Keyed by the user's id; today every
-- request runs as the dev user, real users plug in with login.
CREATE TABLE app.UserPreference (
    UserId     nvarchar(100) NOT NULL,
    PrefKey    nvarchar(100) NOT NULL,
    PrefValue  nvarchar(max) NOT NULL,
    UpdatedAt  datetime2(0)  NOT NULL CONSTRAINT DF_UserPreference_UpdatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_UserPreference PRIMARY KEY (UserId, PrefKey)
);
GO

-- Default app font size is now 13 (2026-09-23): replace the earlier saved value.
UPDATE app.Setting SET SettingValue = '{"fontSize":13}', UpdatedAt = SYSUTCDATETIME() WHERE SettingKey = 'ui.appearance';
