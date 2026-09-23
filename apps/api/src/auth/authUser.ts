/** The signed-in user and what they may do, loaded fresh on every request. */
import { ALL_PERMISSION_KEYS } from '@supplychain/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

export type AuthUser = {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  /** Every granted permission key (all of them for an admin). */
  permissions: Set<string>;
};

/** null when the user doesn't exist or is disabled — the session is then worthless. */
export async function loadAuthUser(db: Kysely<Database>, userId: number): Promise<AuthUser | null> {
  const user = await db
    .selectFrom('app.User')
    .select(['UserId', 'Username', 'DisplayName', 'IsActive'])
    .where('UserId', '=', userId)
    .executeTakeFirst();
  if (!user || !user.IsActive) return null;

  const roles = await db
    .selectFrom('app.UserRole as ur')
    .innerJoin('app.Role as r', 'r.RoleId', 'ur.RoleId')
    .select(['r.RoleId', 'r.IsAdmin'])
    .where('ur.UserId', '=', userId)
    .where('r.IsActive', '=', true)
    .execute();
  const isAdmin = roles.some((r) => r.IsAdmin);

  let permissions: Set<string>;
  if (isAdmin) {
    permissions = new Set(ALL_PERMISSION_KEYS);
  } else if (roles.length === 0) {
    permissions = new Set();
  } else {
    const rows = await db
      .selectFrom('app.RolePermission')
      .select('PermissionKey')
      .distinct()
      .where('RoleId', 'in', roles.map((r) => Number(r.RoleId)))
      .execute();
    permissions = new Set(rows.map((r) => r.PermissionKey));
  }

  return {
    id: Number(user.UserId), // msnodesqlv8 returns IDENTITY values as strings
    username: user.Username,
    displayName: user.DisplayName || user.Username,
    isAdmin,
    permissions,
  };
}
