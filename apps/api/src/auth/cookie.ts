import type {} from '@fastify/cookie'; // adds setCookie / clearCookie to the reply type
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Database } from '../db/schema.js';
import { sessionVersionOf } from './authUser.js';
import { SESSION_COOKIE, SESSION_HOURS, signSession } from './session.js';

type CookieCtx = { db: Kysely<Database>; cfg: Pick<Config, 'SESSION_SECRET'>; req: FastifyRequest; res: FastifyReply };

/** Issues the session cookie; it carries the current SessionVersion of the person signing in (the administrator in View as). */
export async function startSession(ctx: CookieCtx, userId: number, viewAsBy?: number): Promise<void> {
  const sv = await sessionVersionOf(ctx.db, viewAsBy ?? userId);
  ctx.res.setCookie(SESSION_COOKIE, await signSession(userId, ctx.cfg.SESSION_SECRET, viewAsBy, sv), {
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.req.protocol === 'https',
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  });
}
