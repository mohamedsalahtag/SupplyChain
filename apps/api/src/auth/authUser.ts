/** The signed-in user and what they may do, loaded fresh on every request. */
import { ALL_PERMISSION_KEYS } from '@supplychain/shared';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Database } from '../db/schema.js';
import { readSession } from './session.js';

export type AuthUser = {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  /** A demo account (spec 16): entered only through View as. */
  isDemo: boolean;
  /** Set while an administrator is viewing the app as this demo user. */
  viewAs: { realUserId: number; realName: string } | null;
  /** Every granted permission key (all of them for an admin). */
  permissions: Set<string>;
};

/** null when the user doesn't exist or is disabled — the session is then worthless. */
export async function loadAuthUser(db: Kysely<Database>, userId: number): Promise<AuthUser | null> {
  const user = await db
    .selectFrom('app.User')
    .select(['UserId', 'Username', 'DisplayName', 'IsActive', 'IsDemo'])
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
    isDemo: user.IsDemo,
    viewAs: null,
    permissions,
  };
}

/**
 * The user behind a session cookie. In View as, the demo user — but only while
 * View as is allowed, the administrator is still an active admin and the target
 * is still an active demo account; otherwise the administrator themself.
 */
export async function resolveSessionUser(db: Kysely<Database>, cfg: Pick<Config, 'SESSION_SECRET' | 'ALLOW_VIEW_AS'>, token: string | undefined): Promise<AuthUser | null> {
  const claims = await readSession(token, cfg.SESSION_SECRET);
  if (!claims) return null;
  if (!claims.viewAsBy) return loadAuthUser(db, claims.userId);
  const real = await loadAuthUser(db, claims.viewAsBy);
  if (!real?.isAdmin) return null;
  if (!cfg.ALLOW_VIEW_AS) return real;
  const demo = await loadAuthUser(db, claims.userId);
  return demo?.isDemo ? { ...demo, viewAs: { realUserId: real.id, realName: real.displayName } } : real;
}
