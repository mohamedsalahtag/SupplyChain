/** The upload route's scope (F10): no body is read before sign-in, and no other route accepts a raw upload. */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, describe, expect, it } from 'vitest';
import type { Config } from '../../config.js';
import { registerFileRoutes } from './filesRoute.js';
import type { Db } from './tx.js';

const app = Fastify();
await app.register(cookie);
// No database is needed: without a valid session cookie the hook answers before any query.
await registerFileRoutes(app, {} as Db, { SESSION_SECRET: 'x'.repeat(40), ALLOW_VIEW_AS: false, ATTACHMENTS_DIR: '' } as Config);
app.post('/trpc/x', async () => ({ ok: true }));
afterAll(() => app.close());

describe('attachment routes', () => {
  it('refuse an upload without a session before reading its body', async () => {
    const r = await app.inject({ method: 'PUT', url: '/files/attachments?entityType=QUOTE&entityId=1&fileName=a.pdf', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('%PDF-1') });
    expect(r.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/files/attachments/1' })).statusCode).toBe(401);
  });
  it('other routes do not accept a raw octet-stream body at all', async () => {
    const r = await app.inject({ method: 'POST', url: '/trpc/x', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(10) });
    expect(r.statusCode).toBe(415);
  });
});
