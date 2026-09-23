import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { fastifyTRPCPlugin, type CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { loadAuthUser } from './auth/authUser.js';
import { ensureBootstrapAdmin } from './auth/bootstrap.js';
import { SESSION_COOKIE, verifySession } from './auth/session.js';
import { loadConfig } from './config.js';
import { createDb } from './db/db.js';
import { appRouter } from './trpc/router.js';
import type { Context } from './trpc/trpc.js';

const cfg = loadConfig();
const db = createDb(cfg);

const app = Fastify({
  logger: { level: cfg.LOG_LEVEL, transport: { target: 'pino-pretty' } },
});

if (cfg.ALLOW_TEST_LOGIN) app.log.warn('ALLOW_TEST_LOGIN is on — for local testing only, never on a server');

await app.register(cookie);
await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: async ({ req, res }: CreateFastifyContextOptions): Promise<Context> => {
      const userId = await verifySession(req.cookies[SESSION_COOKIE], cfg.SESSION_SECRET);
      const user = userId ? await loadAuthUser(db, userId) : null;
      return { db, cfg, user, encKey: cfg.SETTINGS_ENCRYPTION_KEY, log: app.log, req, res };
    },
    onError: ({ path, error }: { path?: string; error: { code: string } & Error }) => {
      if (['UNAUTHORIZED', 'FORBIDDEN', 'TOO_MANY_REQUESTS'].includes(error.code)) return; // expected, not a fault
      app.log.error({ path, err: error }, 'tRPC error');
    },
  },
});

app.addHook('onClose', async () => {
  await db.destroy();
});

await ensureBootstrapAdmin(db, cfg, app.log);
await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
