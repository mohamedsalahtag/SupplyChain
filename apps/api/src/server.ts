import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { fastifyTRPCPlugin, type CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { resolveSessionUser } from './auth/authUser.js';
import { ensureBootstrapAdmin } from './auth/bootstrap.js';
import { SESSION_COOKIE } from './auth/session.js';
import { loadConfig, productionProblems } from './config.js';
import { createDb } from './db/db.js';
import { registerFileRoutes } from './modules/workflow/filesRoute.js';
import { escalateOverdue } from './modules/workflow/inbox.js';
import { refreshAging } from './modules/rfq/aging.js';
import { runOutbox } from './modules/po/outbox.js';
import { workerId } from './modules/po/router.js';
import { poAdapter } from './modules/po/sapAdapter.js';
import { appRouter } from './trpc/router.js';
import type { Context } from './trpc/trpc.js';

const cfg = loadConfig();
const unsafe = productionProblems(cfg);
if (unsafe.length) throw new Error(`Refusing to start in production:\n  ${unsafe.join('\n  ')}`);
const db = createDb(cfg);

/** HTTPS straight from the API when a certificate is configured (docs/operations/production-setup.md). */
const https = cfg.TLS_PFX_FILE
  ? { pfx: readFileSync(cfg.TLS_PFX_FILE), passphrase: cfg.TLS_PFX_PASSPHRASE || undefined }
  : cfg.TLS_CERT_FILE && cfg.TLS_KEY_FILE ? { cert: readFileSync(cfg.TLS_CERT_FILE), key: readFileSync(cfg.TLS_KEY_FILE) } : null;

const app = Fastify({
  ...(https ? { https } : {}),
  trustProxy: cfg.TRUST_PROXY,
  logger: { level: cfg.LOG_LEVEL, ...(process.env.NODE_ENV === 'production' ? {} : { transport: { target: 'pino-pretty' } }) },
  // tRPC batches calls into one path (/trpc/a,b,c…); Fastify's default limit of 100 characters
  // rejected longer batches with 414, so a page failed depending on which queries were batched.
  maxParamLength: 5000,
});

// Each ODBC call holds a Node worker thread; a transaction must always find a free one (see .env.example).
const threads = Number(process.env.UV_THREADPOOL_SIZE ?? 4);
if (threads <= cfg.DB_POOL_MAX) app.log.warn({ threads, pool: cfg.DB_POOL_MAX }, 'UV_THREADPOOL_SIZE should be above DB_POOL_MAX, or blocked reads can stall transactions');
if (cfg.ALLOW_TEST_LOGIN) app.log.warn('ALLOW_TEST_LOGIN is on — for local testing only, never on a server');

await app.register(cookie);
// Basic security headers on every reply (the web app is served by the same origin through the proxy).
app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  if (https || cfg.TRUST_PROXY) reply.header('Strict-Transport-Security', 'max-age=31536000');
});
await registerFileRoutes(app, db, cfg);
await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: async ({ req, res }: CreateFastifyContextOptions): Promise<Context> => {
      const user = await resolveSessionUser(db, cfg, req.cookies[SESSION_COOKIE]);
      return { db, cfg, user, encKey: cfg.SETTINGS_ENCRYPTION_KEY, log: app.log, req, res };
    },
    onError: ({ path, error }: { path?: string; error: { code: string } & Error }) => {
      if (['UNAUTHORIZED', 'FORBIDDEN', 'TOO_MANY_REQUESTS', 'NOT_FOUND', 'CONFLICT', 'UNPROCESSABLE_CONTENT', 'BAD_REQUEST'].includes(error.code)) return; // expected, not a fault
      app.log.error({ path, err: error }, 'tRPC error');
    },
  },
});

app.addHook('onClose', async () => {
  await db.destroy();
});

// Production: the built web app is served by the API itself (one process, one port); /trpc and /files stay API routes.
if (cfg.SERVE_WEB) {
  const dist = resolve(cfg.WEB_DIST || join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'));
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`SERVE_WEB is on but ${dist} has no index.html — run "npm run build" first`);
  // Hashed build files (/assets/…) never change: cached for a year; index.html is re-checked so an update shows at once.
  await app.register(fastifyStatic, { root: dist, wildcard: false, cacheControl: false,
    setHeaders: (res, path) => res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache') });
  app.setNotFoundHandler((req, reply) => (req.method === 'GET' && !req.url.startsWith('/trpc') && !req.url.startsWith('/files')
    ? reply.header('Cache-Control', 'no-cache').sendFile('index.html') // client-side routes (/demands/12 …)
    : reply.code(404).send({ message: 'Not found' })));
}

await ensureBootstrapAdmin(db, cfg, app.log);

// Hourly job (spec 10): overdue work items are marked escalated once, and each is logged as a domain event.
const escalate = () =>
  escalateOverdue(db).then(
    (n) => n > 0 && app.log.info({ escalated: n }, 'Overdue work items escalated'),
    (err: unknown) => app.log.error({ err }, 'Escalation job failed'),
  );
// Hourly too (spec 18): Open quantity near ETD, and origins that now have a supplier.
const aging = () => refreshAging(db).then((r) => r.opened + r.closed > 0 && app.log.info(r, 'Near-ETD exceptions refreshed'), (err: unknown) => app.log.error({ err }, 'Near-ETD check failed'));
const escalationTimer = setInterval(() => { void escalate(); void aging(); }, 60 * 60 * 1000);
app.addHook('onClose', async () => clearInterval(escalationTimer));
// Every 30 seconds (spec 23): the SAP outbox — send due submissions, reconcile unknown outcomes.
// runOutbox runs one pass at a time (a tick during a run, or "Process now", joins it).
const outbox = async () => {
  try { const r = await runOutbox(db, poAdapter(db, cfg.SETTINGS_ENCRYPTION_KEY), workerId()); if (r.sent + r.checked > 0) app.log.info(r, 'SAP outbox run'); }
  catch (err: unknown) { app.log.error({ err }, 'SAP outbox run failed'); }
};
const outboxTimer = setInterval(() => { void outbox(); }, 30 * 1000);
app.addHook('onClose', async () => clearInterval(outboxTimer));

await app.listen({ port: cfg.API_PORT, host: cfg.HOST });
void aging(); // once at start, then hourly
