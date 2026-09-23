import { ALL_PERMISSION_KEYS, P, PERMISSION_CATALOG } from '@supplychain/shared';
import { TRPCError } from '@trpc/server';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { audit } from '../../auth/audit.js';
import type { Database } from '../../db/schema.js';
import { procedure, router } from '../../trpc/trpc.js';

const open = procedure.meta({ permission: P.securityOpen });
const edit = procedure.meta({ permission: P.securityRolesEdit });

const roleId = z.number().int().positive();
const details = z.object({
  name: z.string().trim().min(2, 'Enter a role name').max(100),
  description: z.string().trim().max(400),
});

/** A role that may be changed: exists and is not built in. */
async function editableRole(db: Kysely<Database>, id: number) {
  const role = await db.selectFrom('app.Role').select(['RoleId', 'Name', 'IsBuiltIn']).where('RoleId', '=', id).executeTakeFirst();
  if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: 'Role not found' });
  if (role.IsBuiltIn) throw new TRPCError({ code: 'BAD_REQUEST', message: `${role.Name} is built in and cannot be changed.` });
  return role;
}

const duplicateName = (err: unknown) => {
  if (String(err).includes('UQ_Role_Name')) throw new TRPCError({ code: 'CONFLICT', message: 'A role with that name already exists.' });
  throw err;
};

export const securityRouter = router({
  /** Every screen and button that can be granted (packages/shared/src/permissions.ts). */
  catalog: open.query(() => PERMISSION_CATALOG),

  roles: open.query(async ({ ctx }) => {
    const [roles, users, perms] = await Promise.all([
      ctx.db.selectFrom('app.Role').selectAll().orderBy('IsBuiltIn', 'desc').orderBy('Name').execute(),
      ctx.db.selectFrom('app.UserRole').select((eb) => ['RoleId', eb.fn.countAll<number>().as('n')]).groupBy('RoleId').execute(),
      ctx.db.selectFrom('app.RolePermission').select((eb) => ['RoleId', eb.fn.countAll<number>().as('n')]).groupBy('RoleId').execute(),
    ]);
    const count = (rows: { RoleId: number; n: number }[], id: number) => Number(rows.find((r) => Number(r.RoleId) === id)?.n ?? 0);
    return roles.map((r) => {
      const id = Number(r.RoleId);
      return {
        RoleId: id,
        Name: r.Name,
        Description: r.Description,
        IsAdmin: r.IsAdmin,
        IsBuiltIn: r.IsBuiltIn,
        IsActive: r.IsActive,
        userCount: count(users, id),
        permissionCount: r.IsAdmin ? ALL_PERMISSION_KEYS.length : count(perms, id),
      };
    });
  }),

  /** One role's granted keys and its users. An admin role holds every key. */
  role: open.input(z.object({ roleId })).query(async ({ ctx, input }) => {
    const role = await ctx.db.selectFrom('app.Role').select(['RoleId', 'IsAdmin']).where('RoleId', '=', input.roleId).executeTakeFirst();
    if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: 'Role not found' });
    const [perms, users] = await Promise.all([
      ctx.db.selectFrom('app.RolePermission').select('PermissionKey').where('RoleId', '=', input.roleId).execute(),
      ctx.db
        .selectFrom('app.UserRole as ur')
        .innerJoin('app.User as u', 'u.UserId', 'ur.UserId')
        .select(['u.UserId', 'u.Username', 'u.DisplayName', 'u.Email', 'u.IsActive'])
        .where('ur.RoleId', '=', input.roleId)
        .orderBy('u.DisplayName')
        .execute(),
    ]);
    return {
      permissionKeys: role.IsAdmin ? ALL_PERMISSION_KEYS : perms.map((p) => p.PermissionKey).filter((k) => ALL_PERMISSION_KEYS.includes(k)),
      users: users.map((u) => ({ ...u, UserId: Number(u.UserId), DisplayName: u.DisplayName || u.Username })),
    };
  }),

  createRole: edit.input(details).mutation(async ({ ctx, input }) => {
    const created = await ctx.db
      .insertInto('app.Role')
      .values({ Name: input.name, Description: input.description })
      .output('inserted.RoleId')
      .executeTakeFirstOrThrow()
      .catch(duplicateName);
    const id = Number(created.RoleId);
    await audit(ctx.db, { userId: ctx.user.id, action: 'role.create', target: input.name }, ctx.log);
    return { roleId: id };
  }),

  updateRole: edit.input(details.extend({ roleId, isActive: z.boolean() })).mutation(async ({ ctx, input }) => {
    await editableRole(ctx.db, input.roleId);
    await ctx.db
      .updateTable('app.Role')
      .set({ Name: input.name, Description: input.description, IsActive: input.isActive })
      .where('RoleId', '=', input.roleId)
      .execute()
      .catch(duplicateName);
    await audit(ctx.db, { userId: ctx.user.id, action: 'role.update', target: input.name, details: input }, ctx.log);
    return { saved: true };
  }),

  /** Replaces the role's granted keys. Only keys from the catalogue are accepted. */
  setPermissions: edit
    .input(z.object({ roleId, permissionKeys: z.array(z.string()).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const role = await editableRole(ctx.db, input.roleId);
      const unknown = input.permissionKeys.filter((k) => !ALL_PERMISSION_KEYS.includes(k));
      if (unknown.length) throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown permission: ${unknown.join(', ')}` });
      const keys = [...new Set(input.permissionKeys)];
      await ctx.db.transaction().execute(async (trx) => {
        await trx.deleteFrom('app.RolePermission').where('RoleId', '=', input.roleId).execute();
        if (keys.length) await trx.insertInto('app.RolePermission').values(keys.map((PermissionKey) => ({ RoleId: input.roleId, PermissionKey }))).execute();
      });
      await audit(ctx.db, { userId: ctx.user.id, action: 'role.permissions', target: role.Name, details: { permissionKeys: keys } }, ctx.log);
      return { saved: true, count: keys.length };
    }),

  /** Only a role nobody holds can be deleted. */
  deleteRole: edit.input(z.object({ roleId })).mutation(async ({ ctx, input }) => {
    const role = await editableRole(ctx.db, input.roleId);
    const holder = await ctx.db.selectFrom('app.UserRole').select('UserId').where('RoleId', '=', input.roleId).executeTakeFirst();
    if (holder) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Remove this role from its users before deleting it.' });
    await ctx.db.deleteFrom('app.Role').where('RoleId', '=', input.roleId).execute();
    await audit(ctx.db, { userId: ctx.user.id, action: 'role.delete', target: role.Name }, ctx.log);
    return { deleted: true };
  }),
});
