import { TRPCError } from '@trpc/server';
import { P } from '@supplychain/shared';
import { z } from 'zod';
import { audit } from '../auth/audit.js';
import { DirectoryUnreachableError, signInToDirectory, testDirectory, WrongCredentialsError } from '../auth/ldap.js';
import { procedure, router } from '../trpc/trpc.js';
import { adConnectionSchema, loadAdConnection, saveAdConnection, toAdSettings } from './adConnection.js';

const adEdit = procedure.meta({ permission: P.configAdEdit });

const message = (err: unknown) =>
  err instanceof WrongCredentialsError
    ? 'The search account username or password is wrong.'
    : err instanceof DirectoryUnreachableError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);

/** Configuration → Active Directory. */
export const adRouter = router({
  /** The password never leaves the server. */
  get: adEdit.query(async ({ ctx }) => {
    const { searchPassword, ...rest } = await loadAdConnection(ctx.db, ctx.cfg);
    return { ...rest, hasSearchPassword: searchPassword.length > 0 };
  }),

  /** An empty search password keeps the saved one. */
  save: adEdit.input(adConnectionSchema).mutation(async ({ ctx, input }) => {
    const current = await loadAdConnection(ctx.db, ctx.cfg);
    // The saved password is only reused for the same server and account: it is never sent to a new address.
    if (!input.searchPassword && current.searchPassword && (input.url !== current.url || input.searchUser !== current.searchUser)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'The server or account changed: enter the search password again.' });
    }
    const searchPassword = input.searchPassword || current.searchPassword;
    await saveAdConnection(ctx.db, ctx.encKey, { ...input, searchPassword });
    await audit(ctx.db, { userId: ctx.user.id, action: 'config.ad.save', details: { url: input.url, baseDn: input.baseDn, searchUser: input.searchUser } }, ctx.log);
    return { saved: true };
  }),

  /** Uses the saved settings: signs in with the search account and counts people under the Base DN. */
  test: adEdit.mutation(async ({ ctx }) => {
    const ad = await loadAdConnection(ctx.db, ctx.cfg);
    if (!ad.searchUser || !ad.searchPassword) {
      return { ok: false as const, message: 'Save a search account (username and password) first.' };
    }
    try {
      const r = await testDirectory(toAdSettings(ad), ad.searchUser, ad.searchPassword);
      return { ok: true as const, ...r };
    } catch (err) {
      return { ok: false as const, message: message(err) };
    }
  }),

  /** Checks a username and password against AD without storing them, and says whether the user is registered here. */
  testLogin: adEdit
    .input(z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(256) }))
    .mutation(async ({ ctx, input }) => {
      const ad = await loadAdConnection(ctx.db, ctx.cfg);
      try {
        const user = await signInToDirectory(toAdSettings(ad), input.username, input.password);
        const registered = await ctx.db.selectFrom('app.User').select('IsActive').where('Username', '=', user.username).executeTakeFirst();
        return { ok: true as const, user, registered: !!registered, active: !!registered?.IsActive };
      } catch (err) {
        return { ok: false as const, message: err instanceof WrongCredentialsError ? 'Wrong username or password.' : message(err) };
      }
    }),
});
