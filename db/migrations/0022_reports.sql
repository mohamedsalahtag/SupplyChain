-- Demand-to-PO plan v5, Stage 8: reports and KPIs (spec 24). The reports read the ledger directly; this grants them.
INSERT INTO app.RolePermission (RoleId, PermissionKey)
SELECT r.RoleId, 'reports.open' FROM app.Role r
WHERE r.Name IN ('Sales', 'Procurement', 'PO team')
  AND NOT EXISTS (SELECT 1 FROM app.RolePermission x WHERE x.RoleId = r.RoleId AND x.PermissionKey = 'reports.open');
