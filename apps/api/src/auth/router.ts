import type {} from '@fastify/cookie'; // adds setCookie / clearCookie to the reply type
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { loadAdConnection, toAdSettings } from '../settings/adConnection.js';
import { publicProcedure, router, type Context } from '../trpc/trpc.js';
import { audit } from './audit.js';
import { DirectoryUnreachableError, signInToDirectory, WrongCredentialsError } from './ldap.js';
import { SESSION_COOKIE, SESSION_HOURS, signSession } from './session.js';

/** At most 10 sign-in attempts per minute from one address. */
const attempts = new Map<string, number[]>();
function limitAttempts(ip: string): void {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  attempts.set(ip, recent);
  if (recent.length > 10) {
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many sign-in attempts. Wait a minute and try again.' });
  }
}

async function startSession(ctx: Context, userId: number): Promise<void> {
  ctx.res.setCookie(SESSION_COOKIE, await signSession(userId, ctx.cfg.SESSION_SECRET), {
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.req.protocol === 'https',
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  });
}

const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export const authRouter = router({
  /** The signed-in user and their permission keys, or null. */
  me: publicProcedure.query(({ ctx }) =>
    ctx.user
      ? {
          id: ctx.user.id,
          username: ctx.user.username,
          displayName: ctx.user.displayName,
          isAdmin: ctx.user.isAdmin,
          permissions: [...ctx.user.permissions],
        }
      : null,
  ),

  login: publicProcedure
    .input(z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(256) }))
    .mutation(async ({ ctx, input }) => {
      limitAttempts(ctx.req.ip);
      const ad = await loadAdConnection(ctx.db, ctx.cfg);

      let dir;
      try {
        dir = await signInToDirectory(toAdSettings(ad), input.username, input.password);
      } catch (err) {
        if (err instanceof WrongCredentialsError) {
          await audit(ctx.db, { userId: null, action: 'login.failed', target: input.username, details: { ip: ctx.req.ip } }, ctx.log);
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Wrong username or password' });
        }
        if (err instanceof DirectoryUnreachableError) {
          ctx.log.error({ err }, 'Active Directory unreachable');
          throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Cannot reach Active Directory. Try again later or contact IT.' });
        }
        throw err;
      }

      const user = await ctx.db
        .selectFrom('app.User')
        .select(['UserId', 'IsActive'])
        .where('Username', '=', dir.username)
        .executeTakeFirst();
      if (!user) {
        await audit(ctx.db, { userId: null, action: 'login.notRegistered', target: dir.username, details: { ip: ctx.req.ip } }, ctx.log);
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not registered in this app. Ask an administrator to add you.' });
      }
      const userId = Number(user.UserId);
      if (!user.IsActive) {
        await audit(ctx.db, { userId, action: 'login.disabled', target: dir.username }, ctx.log);
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Your account in this app is disabled. Ask an administrator.' });
      }

      // Keep the directory details current.
      await ctx.db
        .updateTable('app.User')
        .set({
          Upn: dir.upn,
          ...(dir.displayName ? { DisplayName: dir.displayName } : {}),
          ...(dir.email ? { Email: dir.email } : {}),
          Department: dir.department,
          Title: dir.title,
          LastLoginAt: new Date(),
        })
        .where('UserId', '=', userId)
        .execute();
      await startSession(ctx, userId);
      await audit(ctx.db, { userId, action: 'login.success', target: dir.username, details: { ip: ctx.req.ip } }, ctx.log);
      return { ok: true };
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    ctx.res.clearCookie(SESSION_COOKIE, { path: '/' });
    if (ctx.user) await audit(ctx.db, { userId: ctx.user.id, action: 'logout', target: ctx.user.username }, ctx.log);
    return { ok: true };
  }),

  /**
   * Local test runs only (ALLOW_TEST_LOGIN=true, from this machine): sign in
   * as a registered user without a password. Answers "not found" otherwise.
   */
  testLogin: publicProcedure.input(z.object({ username: z.string().trim().min(1) })).mutation(async ({ ctx, input }) => {
    if (!ctx.cfg.ALLOW_TEST_LOGIN || !isLoopback(ctx.req.ip)) throw new TRPCError({ code: 'NOT_FOUND' });
    const user = await ctx.db
      .selectFrom('app.User')
      .select(['UserId', 'IsActive'])
      .where('Username', '=', input.username.toLowerCase())
      .executeTakeFirst();
    if (!user?.IsActive) throw new TRPCError({ code: 'FORBIDDEN', message: 'No active registered user with that username' });
    await startSession(ctx, Number(user.UserId));
    ctx.log.warn({ username: input.username }, 'TEST LOGIN used (ALLOW_TEST_LOGIN is on)');
    return { ok: true };
  }),
});
