/** Registered users and their roles. */
import { TRPCError } from '@trpc/server';
import { sql, type Kysely, type Transaction } from 'kysely';
import { endSessions } from '../../auth/authUser.js';
import type { Database } from '../../db/schema.js';

export type UserListRow = {
  UserId: number;
  Username: string;
  DisplayName: string;
  Email: string;
  Department: string;
  Title: string;
  IsActive: boolean;
  IsDemo: boolean;
  LastLoginAt: string | null;
  CreatedAt: string;
  roles: { RoleId: number; Name: string }[];
  companies: string[];
};

export async function listUsers(db: Kysely<Database>): Promise<UserListRow[]> {
  const [users, links, companies] = await Promise.all([
    db.selectFrom('app.User').selectAll().where('DeletedAt', 'is', null).orderBy('DisplayName').execute(), // archived (deleted) users are hidden
    db
      .selectFrom('app.UserRole as ur')
      .innerJoin('app.Role as r', 'r.RoleId', 'ur.RoleId')
      .select(['ur.UserId', 'r.RoleId', 'r.Name'])
      .execute(),
    db.selectFrom('scm.UserCompany').select(['UserId', 'CompanyCode']).orderBy('CompanyCode').execute(),
  ]);
  return users.map((u) => ({
    UserId: Number(u.UserId),
    Username: u.Username,
    DisplayName: u.DisplayName || u.Username,
    Email: u.Email,
    Department: u.Department,
    Title: u.Title,
    IsActive: u.IsActive,
    IsDemo: u.IsDemo,
    LastLoginAt: u.LastLoginAt ? u.LastLoginAt.toISOString() : null,
    CreatedAt: u.CreatedAt.toISOString(),
    roles: links
      .filter((l) => Number(l.UserId) === Number(u.UserId))
      .map((l) => ({ RoleId: Number(l.RoleId), Name: l.Name })),
    companies: companies.filter((c) => Number(c.UserId) === Number(u.UserId)).map((c) => c.CompanyCode),
  }));
}

/** Throws unless every id is an existing role. */
export async function assertRolesExist(db: Kysely<Database> | Transaction<Database>, roleIds: number[]): Promise<void> {
  if (roleIds.length === 0) return;
  const found = await db.selectFrom('app.Role').select('RoleId').where('RoleId', 'in', roleIds).execute();
  if (found.length !== new Set(roleIds).size) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown role' });
}

async function isAdminRoleSet(db: Transaction<Database>, roleIds: number[]): Promise<boolean> {
  if (roleIds.length === 0) return false;
  const r = await db.selectFrom('app.Role').select('RoleId').where('RoleId', 'in', roleIds).where('IsAdmin', '=', true).where('IsActive', '=', true).executeTakeFirst();
  return !!r;
}

type Granter = { id: number; isAdmin: boolean; permissions: ReadonlySet<string> };

/**
 * A holder of users.add / users.edit who is not an administrator may hand out only what they hold themselves:
 * never an administrator role, never a role with a key they lack, never to themselves or to an administrator
 * (security review 2026-09: otherwise the key is as strong as Administrator).
 */
export async function assertMayGrant(db: Kysely<Database>, actor: Granter, roleIds: number[], targetUserId: number | null): Promise<void> {
  if (actor.isAdmin) return;
  const deny = (message: string) => { throw new TRPCError({ code: 'FORBIDDEN', message }); };
  if (targetUserId === actor.id) deny('You cannot change your own roles — ask an administrator.');
  if (targetUserId !== null) {
    const admin = await db.selectFrom('app.UserRole as ur').innerJoin('app.Role as r', 'r.RoleId', 'ur.RoleId').select('r.RoleId')
      .where('ur.UserId', '=', targetUserId).where('r.IsAdmin', '=', true).executeTakeFirst();
    if (admin) deny('Only an administrator can change an administrator.');
  }
  if (!roleIds.length) return;
  const roles = await db.selectFrom('app.Role').select(['RoleId', 'Name', 'IsAdmin']).where('RoleId', 'in', roleIds).execute();
  const adminRole = roles.find((r) => r.IsAdmin);
  if (adminRole) deny(`Only an administrator can give the role ${adminRole.Name}.`);
  const keys = await db.selectFrom('app.RolePermission').select('PermissionKey').distinct().where('RoleId', 'in', roleIds).execute();
  const missing = keys.map((k) => k.PermissionKey).filter((k) => !actor.permissions.has(k));
  if (missing.length) deny(`You can only give roles whose permissions you hold yourself (missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}).`);
}

/** Active users holding an active admin role. */
export async function countActiveAdmins(db: Kysely<Database> | Transaction<Database>): Promise<number> {
  const r = await db
    .selectFrom('app.User as u')
    .innerJoin('app.UserRole as ur', 'ur.UserId', 'u.UserId')
    .innerJoin('app.Role as r', 'r.RoleId', 'ur.RoleId')
    .select((eb) => eb.fn.count<number>('u.UserId').distinct().as('n'))
    .where('u.IsActive', '=', true)
    .where('r.IsAdmin', '=', true)
    .where('r.IsActive', '=', true)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/**
 * The user row, locked (UPDLOCK) until the transaction ends; an archived (deleted) user is "not found" — nothing about
 * them can be changed any more (security review 2026-09-26, F07a).
 */
export async function lockLiveUser(trx: Kysely<Database>, userId: number) {
  const u = (await sql<{ UserId: number; IsActive: boolean; IsDemo: boolean; DeletedAt: Date | null }>`
    SELECT UserId, IsActive, IsDemo, DeletedAt FROM app.[User] WITH (UPDLOCK, ROWLOCK) WHERE UserId = ${userId}`.execute(trx)).rows[0];
  if (!u || u.DeletedAt) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  return u;
}

/**
 * Sets a user's roles and active flag. Refuses changes that would lock people
 * out: disabling yourself, removing your own admin role, or leaving the app
 * without any active administrator. When the roles or the active flag change, every session of the user ends
 * (SessionVersion). `inTx` runs in the same transaction (the audit row).
 */
export async function updateUser(
  db: Kysely<Database>,
  actorId: number,
  input: { userId: number; roleIds: number[]; isActive: boolean },
  inTx?: (trx: Transaction<Database>) => Promise<void>,
): Promise<{ sessionsEnded: boolean }> {
  await assertRolesExist(db, input.roleIds);
  return db.transaction().execute(async (trx) => {
    const before = await lockLiveUser(trx, input.userId);
    const oldRoles = (await trx.selectFrom('app.UserRole').select('RoleId').where('UserId', '=', input.userId).execute()).map((r) => Number(r.RoleId));

    if (input.userId === actorId) {
      if (!input.isActive) throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot disable your own account.' });
      const wasAdmin = await isAdminRoleSet(trx, oldRoles);
      if (wasAdmin && !(await isAdminRoleSet(trx, input.roleIds))) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot remove your own Administrator role.' });
      }
    }

    await trx.updateTable('app.User').set({ IsActive: input.isActive }).where('UserId', '=', input.userId).execute();
    await trx.deleteFrom('app.UserRole').where('UserId', '=', input.userId).execute();
    if (input.roleIds.length) {
      await trx.insertInto('app.UserRole').values([...new Set(input.roleIds)].map((RoleId) => ({ UserId: input.userId, RoleId }))).execute();
    }

    if ((await countActiveAdmins(trx)) === 0) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'At least one active user must keep the Administrator role.' });
    }

    const newRoles = new Set(input.roleIds);
    const changed = Boolean(before.IsActive) !== input.isActive || oldRoles.length !== newRoles.size || oldRoles.some((r) => !newRoles.has(r));
    if (changed) await endSessions(trx, input.userId);
    await inTx?.(trx);
    return { sessionsEnded: changed };
  });
}
