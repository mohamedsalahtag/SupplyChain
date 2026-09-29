-- Delete a draft demand that was never accepted (2026-09-29): Sales, who create drafts, may delete their own.
-- (Administrators hold every permission.)
INSERT INTO app.RolePermission (RoleId, PermissionKey)
SELECT r.RoleId, 'demand.delete' FROM app.Role r
WHERE r.Name = 'Sales'
  AND NOT EXISTS (SELECT 1 FROM app.RolePermission x WHERE x.RoleId = r.RoleId AND x.PermissionKey = 'demand.delete');
