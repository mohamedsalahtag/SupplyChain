import type { Generated } from 'kysely';

/**
 * Kysely table types. Keep in step with db/migrations — one entry per table,
 * keyed as '<schema>.<table>'.
 */
export interface Database {
  'app.Setting': {
    SettingKey: string;
    SettingValue: string | null;
    UpdatedAt: Date;
  };
  'app.UserPreference': {
    UserId: string;
    PrefKey: string;
    PrefValue: string;
    UpdatedAt: Date;
  };
  'app.User': {
    UserId: Generated<number>;
    Username: string;
    Upn: string;
    DisplayName: string;
    Email: string;
    Department: string;
    Title: string;
    IsActive: boolean;
    CreatedAt: Generated<Date>;
    CreatedBy: string;
    LastLoginAt: Date | null;
  };
  'app.Role': {
    RoleId: Generated<number>;
    Name: string;
    Description: string;
    IsAdmin: Generated<boolean>;
    IsBuiltIn: Generated<boolean>;
    IsActive: Generated<boolean>;
  };
  'app.RolePermission': { RoleId: number; PermissionKey: string };
  'app.UserRole': { UserId: number; RoleId: number };
  'app.AuditLog': {
    AuditId: Generated<number>;
    At: Generated<Date>;
    UserId: number | null;
    Action: string;
    Target: string;
    Details: string | null;
  };
  'md.Material': {
    MaterialCode: string;
    Description: string;
    MajorCategoryCode: string;
    MajorCategory: string;
    SubMajorCategory: string;
    MaterialGroupCode: string;
    MaterialGroup: string;
    MaterialType: string;
    BaseUnit: string;
    BaseUnitName: string;
    Origin: string;
    Variety: string;
    Size: string;
    Weight: number | null;
    WeightUnit: string;
    MaterialClassCode: string;
    MaterialClass: string;
    InSap: boolean;
    SapChangedAt: Date;
  };
  'integ.SyncRun': {
    SyncRunId: Generated<number>;
    Source: string;
    Status: 'Running' | 'Succeeded' | 'Failed';
    StartedAt: Generated<Date>;
    StartedBy: string;
    FinishedAt: Date | null;
    RowsRead: number | null;
    RowsInserted: number | null;
    RowsUpdated: number | null;
    RowsMarkedMissing: number | null;
    Message: string | null;
  };
}
