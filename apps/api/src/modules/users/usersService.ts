/** Registered users and their roles. */
import { TRPCError } from '@trpc/server';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';

export type UserListRow = {
  UserId: number;
  Username: string;
  DisplayName: string;
  Email: string;
  Department: string;
  Title: string;
  IsActive: boolean;
  LastLoginAt: string | null;
  CreatedAt: string;
  roles: { RoleId: number; Name: string }[];
};

export async function listUsers(db: Kysely<Database>): Promise<UserListRow[]> {
  const [users, links] = await Promise.all([
    db.selectFrom('app.User').selectAll().orderBy('DisplayName').execute(),
    db
      .selectFrom('app.UserRole as ur')
      .innerJoin('app.Role as r', 'r.RoleId', 'ur.RoleId')
      .select(['ur.UserId', 'r.RoleId', 'r.Name'])
      .execute(),
  ]);
  return users.map((u) => ({
    UserId: Number(u.UserId),
    Username: u.Username,
    DisplayName: u.DisplayName || u.Username,
    Email: u.Email,
    Department: u.Department,
    Title: u.Title,
    IsActive: u.IsActive,
    LastLoginAt: u.LastLoginAt ? u.LastLoginAt.toISOString() : null,
    CreatedAt: u.CreatedAt.toISOString(),
    roles: links
      .filter((l) => Number(l.UserId) === Number(u.UserId))
      .map((l) => ({ RoleId: Number(l.RoleId), Name: l.Name })),
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
 * Sets a user's roles and active flag. Refuses changes that would lock people
 * out: disabling yourself, removing your own admin role, or leaving the app
 * without any active administrator.
 */
export async function updateUser(
  db: Kysely<Database>,
  actorId: number,
  input: { userId: number; roleIds: number[]; isActive: boolean },
): Promise<void> {
  await assertRolesExist(db, input.roleIds);
  await db.transaction().execute(async (trx) => {
    const exists = await trx.selectFrom('app.User').select('UserId').where('UserId', '=', input.userId).executeTakeFirst();
    if (!exists) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });

    if (input.userId === actorId) {
      if (!input.isActive) throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot disable your own account.' });
      const wasAdmin = await isAdminRoleSet(
        trx,
        (await trx.selectFrom('app.UserRole').select('RoleId').where('UserId', '=', actorId).execute()).map((r) => Number(r.RoleId)),
      );
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
  });
}
