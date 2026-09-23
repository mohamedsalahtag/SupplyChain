import { initTRPC, TRPCError } from '@trpc/server';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '../db/schema.js';

export type User = { id: string; name: string };

export type Context = {
  db: Kysely<Database>;
  user: User;
  /** Key for secrets stored in app.Setting. */
  encKey: string;
  log: Pick<Logger, 'info' | 'error'>;
};

/** Until login exists every request runs as this user. */
export const DEV_USER: User = { id: 'dev', name: 'Developer' };

type Meta = { permission: string };

const t = initTRPC.context<Context>().meta<Meta>().create();

/**
 * Single security gate. Every procedure must declare a permission; today all
 * declared permissions are granted. Roles are checked here later — no route
 * changes needed when that happens.
 */
const permissionGuard = t.middleware(({ meta, path, next }) => {
  if (!meta?.permission) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Procedure "${path}" does not declare a permission`,
    });
  }
  return next();
});

export const router = t.router;
export const procedure = t.procedure.use(permissionGuard);
export const createCallerFactory = t.createCallerFactory;
