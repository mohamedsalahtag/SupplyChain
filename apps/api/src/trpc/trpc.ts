import { initTRPC, TRPCError } from '@trpc/server';
import { SIGNED_IN } from '@supplychain/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { AuthUser } from '../auth/authUser.js';
import type { Config } from '../config.js';
import type { Database } from '../db/schema.js';
import { newErrorId } from './errorId.js';
import { DomainError, toTrpcError } from '../modules/workflow/errors.js';

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
// Workflow business-rule errors carry a stable code (and details) for the UI.
// An unexpected fault (a SQL error, a bug) never reaches the browser: the reply says "internal error" with an error id,
// and the full error is logged under that id (security review 2026-09-26). 4xx messages are written for the user and stay.
const t = initTRPC.context<Context>().meta<Meta>().create({
  isDev: false,
  errorFormatter: ({ shape, error, ctx, path }) => {
    const cause = error.cause;
    if (cause instanceof DomainError) return { ...shape, data: { ...shape.data, domainCode: cause.code, details: cause.details ?? null } };
    if (error.code !== 'INTERNAL_SERVER_ERROR') return shape;
    const log = (obj: object, msg: string) => (ctx ? ctx.log.error(obj, msg) : console.error(msg, obj));
    // A TRPCError thrown on purpose (no foreign cause) carries a message written for the user.
    if (!cause || cause instanceof TRPCError) {
      log({ path, err: error }, 'tRPC internal error');
      return shape;
    }
    const errorId = newErrorId();
    log({ errorId, path, err: cause }, 'Internal error');
    return { ...shape, message: `Internal error. Quote this reference to IT: ${errorId}`, data: { ...shape.data, errorId } };
  },
});

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

/** Turns a DomainError thrown by a service into the matching tRPC error (403 / 404 / 409 / 422). */
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof DomainError) throw toTrpcError(result.error.cause);
  return result;
});

export const router = t.router;
/** Requires a signed-in user with the declared permission. */
export const procedure = t.procedure.use(permissionGuard).use(domainErrors);
/** No sign-in needed. Only for sign-in itself and the health check. */
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
