-- View as (spec 16): demo accounts an administrator can switch into to test the app
-- as another department. They cannot sign in with a password; only "View as" enters them,
-- and only where ALLOW_VIEW_AS=true. Their roles and companies can be edited on Users.
ALTER TABLE app.[User] ADD IsDemo bit NOT NULL CONSTRAINT DF_User_IsDemo DEFAULT 0;
GO

INSERT INTO app.[User] (Username, Upn, DisplayName, Email, Department, Title, IsActive, CreatedBy, IsDemo)
SELECT v.Username, '', v.DisplayName, '', v.Department, 'Demo account for testing', 1, 'migration 0013', 1
FROM (VALUES ('demo.sales', 'Demo Sales', 'Sales'),
             ('demo.procurement', 'Demo Procurement', 'Procurement'),
             ('demo.both', 'Demo Sales + Procurement', 'Sales, Procurement')) v (Username, DisplayName, Department)
WHERE NOT EXISTS (SELECT 1 FROM app.[User] u WHERE u.Username = v.Username);

INSERT INTO app.UserRole (UserId, RoleId)
SELECT u.UserId, r.RoleId
FROM app.[User] u
JOIN (VALUES ('demo.sales', 'Sales'), ('demo.procurement', 'Procurement'),
             ('demo.both', 'Sales'), ('demo.both', 'Procurement')) m (Username, RoleName) ON m.Username = u.Username
JOIN app.Role r ON r.Name = m.RoleName
WHERE NOT EXISTS (SELECT 1 FROM app.UserRole x WHERE x.UserId = u.UserId AND x.RoleId = r.RoleId);

INSERT INTO scm.UserCompany (UserId, CompanyCode)
SELECT u.UserId, c.CompanyCode
FROM app.[User] u CROSS JOIN scm.Company c
WHERE u.IsDemo = 1
  AND NOT EXISTS (SELECT 1 FROM scm.UserCompany x WHERE x.UserId = u.UserId AND x.CompanyCode = c.CompanyCode);
