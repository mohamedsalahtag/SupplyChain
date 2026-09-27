/** The signed-in user and what they may do, loaded fresh on every request. */
import { ALL_PERMISSION_KEYS } from '@supplychain/shared';
import { sql, type Kysely } from 'kysely';
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

/**
 * null when the user doesn't exist, is disabled or archived (DeletedAt), or — when a session version is given — the
 * session was ended since (sign-out elsewhere, roles or companies changed): the session is then worthless.
 */
export async function loadAuthUser(db: Kysely<Database>, userId: number, sessionVersion?: number): Promise<AuthUser | null> {
  const user = await db
    .selectFrom('app.User')
    .select(['UserId', 'Username', 'DisplayName', 'IsActive', 'IsDemo', 'DeletedAt', 'SessionVersion'])
    .where('UserId', '=', userId)
    .executeTakeFirst();
  if (!user || !user.IsActive || user.DeletedAt) return null;
  if (sessionVersion !== undefined && Number(user.SessionVersion) !== sessionVersion) return null;

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
  // The session version belongs to the person who signed in: in View as, the administrator.
  if (!claims.viewAsBy) return loadAuthUser(db, claims.userId, claims.sessionVersion);
  const real = await loadAuthUser(db, claims.viewAsBy, claims.sessionVersion);
  if (!real?.isAdmin) return null;
  if (!cfg.ALLOW_VIEW_AS) return real;
  const demo = await loadAuthUser(db, claims.userId);
  return demo?.isDemo ? { ...demo, viewAs: { realUserId: real.id, realName: real.displayName } } : real;
}

/** Ends every session of the user (their cookies carry the old SessionVersion). Use inside the transaction of the change. */
export async function endSessions(db: Kysely<Database>, userId: number): Promise<void> {
  await sql`UPDATE app.[User] SET SessionVersion = SessionVersion + 1 WHERE UserId = ${userId}`.execute(db);
}

/** The SessionVersion a new cookie for this user must carry (0 when the user is gone — the cookie is then refused anyway). */
export async function sessionVersionOf(db: Kysely<Database>, userId: number): Promise<number> {
  const r = await db.selectFrom('app.User').select('SessionVersion').where('UserId', '=', userId).executeTakeFirst();
  return Number(r?.SessionVersion ?? 0);
}
