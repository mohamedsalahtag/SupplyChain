import { P } from '@supplychain/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { loadActor } from '../workflow/access.js';
import { auditTx } from '../../auth/audit.js';
import { endSessions } from '../../auth/authUser.js';
import { startSession } from '../../auth/cookie.js';
import { DirectoryConfigError, DirectoryUnreachableError, findDirectoryUser, searchDirectory, WrongCredentialsError } from '../../auth/ldap.js';
import { loadAdConnection, toAdSettings } from '../../settings/adConnection.js';
import { procedure, router, type Context } from '../../trpc/trpc.js';
import { setUserCompanies } from '../workflowSetup/companies.js';
import { assertMayGrant, assertRolesExist, listUsers, updateUser } from './usersService.js';
import { deletePreview, deleteUser } from './userDelete.js';

const open = procedure.meta({ permission: P.usersOpen });
const add = procedure.meta({ permission: P.usersAdd });
const edit = procedure.meta({ permission: P.usersEdit });

const roleIds = z.array(z.number().int().positive()).max(50);

/**
 * An administrator who changed their own roles or companies ended their own sessions too (SessionVersion): this browser
 * gets a fresh cookie so they stay signed in here; other devices are signed out.
 */
async function keepOwnSession(ctx: Context & { user: NonNullable<Context['user']> }, targetUserId: number) {
  if (!ctx.user.viewAs && targetUserId === ctx.user.id) await startSession(ctx, ctx.user.id);
}

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
  if (err instanceof DirectoryConfigError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message });
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

    // The new user and the audit row commit together.
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
      await auditTx(trx, { userId: ctx.user.id, action: 'user.add', target: person.username, details: { roleIds: input.roleIds } });
      return id;
    });
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
      // A changed data scope ends the user's sessions; the change and its audit row commit together.
      const { changed } = await setUserCompanies(ctx.db, input.userId, input.companyCodes, async (tx, changed) => {
        if (changed) await endSessions(tx, input.userId);
        await auditTx(tx, { userId: ctx.user.id, action: 'users.companies', target: String(input.userId), details: input });
      });
      if (changed) await keepOwnSession(ctx, input.userId);
      return { saved: true };
    }),

  update: edit
    .input(z.object({ userId: z.number().int().positive(), roleIds, isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertMayGrant(ctx.db, ctx.user, input.roleIds, input.userId);
      // Changed roles or a disabled account end the user's sessions (updateUser); the audit row commits with the change.
      const r = await updateUser(ctx.db, ctx.user.id, input, (trx) =>
        auditTx(trx, { userId: ctx.user.id, action: 'user.update', target: String(input.userId), details: input }));
      if (r.sessionsEnded) await keepOwnSession(ctx, input.userId);
      return { saved: true };
    }),

  /** What deleting this user would do: delete outright, or archive because their name is on records. */
  deletePreview: procedure.meta({ permission: P.usersDelete }).input(z.object({ userId: z.number().int().positive() }))
    .query(({ ctx, input }) => deletePreview(ctx.db, ctx.user, input.userId)),

  delete: procedure.meta({ permission: P.usersDelete }).input(z.object({ userId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const r = await deleteUser(ctx.db, ctx.user, input.userId, (trx, r) =>
      auditTx(trx, { userId: ctx.user.id, action: r.mode === 'delete' ? 'user.delete' : 'user.archive', target: r.username, details: { userId: input.userId, references: r.references } }));
    return { mode: r.mode, displayName: r.displayName };
  }),
});
