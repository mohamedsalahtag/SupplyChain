import { P } from '@supplychain/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { loadActor } from '../workflow/access.js';
import { audit } from '../../auth/audit.js';
import { DirectoryUnreachableError, findDirectoryUser, searchDirectory, WrongCredentialsError } from '../../auth/ldap.js';
import { loadAdConnection, toAdSettings } from '../../settings/adConnection.js';
import { procedure, router, type Context } from '../../trpc/trpc.js';
import { setUserCompanies } from '../workflowSetup/companies.js';
import { assertMayGrant, assertRolesExist, listUsers, updateUser } from './usersService.js';

const open = procedure.meta({ permission: P.usersOpen });
const add = procedure.meta({ permission: P.usersAdd });
const edit = procedure.meta({ permission: P.usersEdit });

const roleIds = z.array(z.number().int().positive()).max(50);

/** The saved AD settings with a search account, or a clear error. */
async function directory(ctx: Context) {
  const ad = await loadAdConnection(ctx.db, ctx.cfg);
  if (!ad.searchUser || !ad.searchPassword) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'No Active Directory search account is saved. Add it in Configuration → Active Directory.',
    });
  }
  return ad;
}

const directoryError = (err: unknown): never => {
  if (err instanceof WrongCredentialsError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The Active Directory search account password is wrong. Update it in Configuration → Active Directory.' });
  }
  if (err instanceof DirectoryUnreachableError) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: err.message });
  throw err;
};

export const usersRouter = router({
  list: open.query(({ ctx }) => listUsers(ctx.db)),

  /** Roles to choose from when adding or editing a user. */
  roleOptions: open.query(async ({ ctx }) =>
    (await ctx.db.selectFrom('app.Role').select(['RoleId', 'Name', 'IsAdmin', 'IsActive']).orderBy('IsBuiltIn', 'desc').orderBy('Name').execute()).map(
      (r) => ({ ...r, RoleId: Number(r.RoleId) }),
    ),
  ),

  /** People in AD whose name, username or email starts with the text; marks who is registered already. */
  searchDirectory: add.input(z.object({ q: z.string().trim().min(2).max(100) })).query(async ({ ctx, input }) => {
    const ad = await directory(ctx);
    const found = await searchDirectory(toAdSettings(ad), ad.searchUser, ad.searchPassword, input.q).catch(directoryError);
    const registered = new Set(
      found.length
        ? (await ctx.db.selectFrom('app.User').select('Username').where('Username', 'in', found.map((f) => f.username)).execute()).map((r) => r.Username)
        : [],
    );
    return found.map((f) => ({ ...f, registered: registered.has(f.username) }));
  }),

  /** Registers an AD user. Details are read from AD again here, never taken from the browser. */
  add: add.input(z.object({ username: z.string().trim().min(1).max(100), roleIds: roleIds.min(1, 'Choose at least one role') })).mutation(async ({ ctx, input }) => {
    await assertRolesExist(ctx.db, input.roleIds);
    await assertMayGrant(ctx.db, ctx.user, input.roleIds, null);
    const ad = await directory(ctx);
    const person = await findDirectoryUser(toAdSettings(ad), ad.searchUser, ad.searchPassword, input.username).catch(directoryError);
    if (!person) throw new TRPCError({ code: 'NOT_FOUND', message: 'That user was not found in Active Directory.' });

    const exists = await ctx.db.selectFrom('app.User').select('UserId').where('Username', '=', person.username).executeTakeFirst();
    if (exists) throw new TRPCError({ code: 'CONFLICT', message: `${person.displayName || person.username} is already registered.` });

    const userId = await ctx.db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('app.User')
        .values({
          Username: person.username,
          Upn: person.upn,
          DisplayName: person.displayName,
          Email: person.email,
          Department: person.department,
          Title: person.title,
          IsActive: true,
          CreatedBy: ctx.user.username,
          LastLoginAt: null,
        })
        .output('inserted.UserId')
        .executeTakeFirstOrThrow();
      const id = Number(created.UserId);
      await trx.insertInto('app.UserRole').values([...new Set(input.roleIds)].map((RoleId) => ({ UserId: id, RoleId }))).execute();
      return id;
    });
    await audit(ctx.db, { userId: ctx.user.id, action: 'user.add', target: person.username, details: { roleIds: input.roleIds } }, ctx.log);
    return { userId };
  }),

  /** Which companies the user works for (spec 11): the data scope of the workflow. */
  setCompanies: procedure
    .meta({ permission: P.usersCompaniesEdit })
    .input(z.object({ userId: z.number().int().positive(), companyCodes: z.array(z.string().max(10)).max(20) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user.isAdmin) { // a non-administrator never widens anyone's data scope beyond their own, nor their own
        if (input.userId === ctx.user.id) throw new TRPCError({ code: 'FORBIDDEN', message: 'You cannot change your own companies — ask an administrator.' });
        const mine = (await loadActor(ctx.db, ctx.user)).companies;
        const outside = input.companyCodes.filter((c) => !mine.has(c));
        if (outside.length) throw new TRPCError({ code: 'FORBIDDEN', message: `You can only give companies you work for yourself (not ${outside.join(', ')}).` });
      }
      await setUserCompanies(ctx.db, input.userId, input.companyCodes);
      await audit(ctx.db, { userId: ctx.user.id, action: 'users.companies', target: String(input.userId), details: input }, ctx.log);
      return { saved: true };
    }),

  update: edit
    .input(z.object({ userId: z.number().int().positive(), roleIds, isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertMayGrant(ctx.db, ctx.user, input.roleIds, input.userId);
      await updateUser(ctx.db, ctx.user.id, input);
      await audit(ctx.db, { userId: ctx.user.id, action: 'user.update', target: String(input.userId), details: input }, ctx.log);
      return { saved: true };
    }),
});
