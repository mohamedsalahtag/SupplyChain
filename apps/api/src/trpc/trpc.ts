import { initTRPC, TRPCError } from '@trpc/server';
import { SIGNED_IN } from '@supplychain/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { AuthUser } from '../auth/authUser.js';
import type { Config } from '../config.js';
import type { Database } from '../db/schema.js';

export type Context = {
  db: Kysely<Database>;
  cfg: Config;
  /** null when nobody is signed in. */
  user: AuthUser | null;
  /** Key for secrets stored in app.Setting. */
  encKey: string;
  log: Pick<Logger, 'info' | 'error' | 'warn'>;
  req: FastifyRequest;
  res: FastifyReply;
};

type Meta = { permission: string };

// isDev false: error replies never include server stack traces (they stay in the log).
const t = initTRPC.context<Context>().meta<Meta>().create({ isDev: false });

/**
 * The single security gate. Every procedure declares a permission from the
 * catalogue (packages/shared/src/permissions.ts) or SIGNED_IN. Nobody signed
 * in → UNAUTHORIZED; signed in without the permission → FORBIDDEN.
 * Administrators hold every permission.
 */
const permissionGuard = t.middleware(({ ctx, meta, path, next }) => {
  if (!meta?.permission) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Procedure "${path}" does not declare a permission` });
  }
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in' });
  if (meta.permission !== SIGNED_IN && !ctx.user.isAdmin && !ctx.user.permissions.has(meta.permission)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to do this' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const router = t.router;
/** Requires a signed-in user with the declared permission. */
export const procedure = t.procedure.use(permissionGuard);
/** No sign-in needed. Only for sign-in itself and the health check. */
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
