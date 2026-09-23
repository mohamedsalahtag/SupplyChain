import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { loadConfig } from './config.js';
import { createDb } from './db/db.js';
import { appRouter } from './trpc/router.js';
import { DEV_USER, type Context } from './trpc/trpc.js';

const cfg = loadConfig();
const db = createDb(cfg);

const app = Fastify({
  logger: { level: cfg.LOG_LEVEL, transport: { target: 'pino-pretty' } },
});

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: (): Context => ({ db, user: DEV_USER, encKey: cfg.SETTINGS_ENCRYPTION_KEY, log: app.log }),
    onError: ({ path, error }: { path?: string; error: Error }) => {
      app.log.error({ path, err: error }, 'tRPC error');
    },
  },
});

app.addHook('onClose', async () => {
  await db.destroy();
});

await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
