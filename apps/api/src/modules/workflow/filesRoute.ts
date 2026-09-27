/**
 * Attachment upload and download over plain HTTP (raw bytes; tRPC carries JSON
 * only). Same session cookie as the rest of the app; access follows the parent
 * object (entityAccess). Upload: PUT /files/attachments?entityType&entityId&fileName[&supersedesId].
 *
 * The routes live in their own Fastify scope (security review 2026-09-26, F10): only they accept a raw body, up to
 * 100 MB, and the session is checked — and the declared size compared with the limit — before a single byte of the body
 * is read. Every other route (/trpc …) keeps Fastify's default 1 MB JSON limit.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveSessionUser } from '../../auth/authUser.js';
import { SESSION_COOKIE } from '../../auth/session.js';
import type { Config } from '../../config.js';
import { loadActor, type Actor } from './access.js';
import { attachmentsRoot, readAttachment, saveAttachment } from './attachments.js';
import { assertEntityAccess } from './entityAccess.js';
import { DomainError } from './errors.js';
import { loadWfSettings } from './settings.js';
import { withTx, type Db } from './tx.js';

const MAX_BODY = 100 * 1_048_576; // the configured limit (spec 11, max 100 MB) is checked per upload

export async function registerFileRoutes(app: FastifyInstance, db: Db, cfg: Config): Promise<void> {
  const root = attachmentsRoot(cfg.ATTACHMENTS_DIR);
  const actors = new WeakMap<FastifyRequest, Actor>();
  const actorOf = (req: FastifyRequest) => actors.get(req)!; // set by the onRequest hook, which refuses anyone else

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ code: err.code, message: err.message });
    throw err; // the app's error handler logs it and answers with an error id only
  };

  await app.register(async (files) => {
    files.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));

    // onRequest runs before the body is read: a stranger, or a declared size over the limit, never gets to upload.
    files.addHook('onRequest', async (req, reply) => {
      const user = await resolveSessionUser(db, cfg, req.cookies[SESSION_COOKIE]);
      if (!user) return reply.code(401).send({ message: 'Please sign in' });
      actors.set(req, await loadActor(db, user));
      if (req.method === 'PUT') {
        const length = Number(req.headers['content-length']);
        if (!Number.isFinite(length) || length < 0) return reply.code(411).send({ message: 'The upload must state its size (Content-Length).' });
        const maxBytes = Math.min(MAX_BODY, (await loadWfSettings(db)).attachmentMaxMb * 1_048_576);
        if (length > maxBytes) return reply.code(413).send({ code: 'FILE_TOO_LARGE', message: `The file is larger than ${Math.round(maxBytes / 1_048_576)} MB` });
      }
    });

    files.put<{ Querystring: { entityType?: string; entityId?: string; fileName?: string; supersedesId?: string } }>(
      '/files/attachments',
      { bodyLimit: MAX_BODY },
      async (req, reply) => {
        const actor = actorOf(req);
        const { entityType = '', entityId = '', fileName = '', supersedesId } = req.query;
        try {
          const { companyCode } = await assertEntityAccess(db, actor, entityType, entityId, true);
          const settings = await loadWfSettings(db);
          const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
          const saved = await withTx(db, (tx) =>
            saveAttachment(tx, { root, maxBytes: settings.attachmentMaxMb * 1_048_576, entityType, entityId, companyCode, fileName, data, userId: actor.id, supersedesId: supersedesId || null }),
          );
          return reply.send(saved);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    files.get<{ Params: { id: string } }>('/files/attachments/:id', async (req, reply) => {
      const actor = actorOf(req);
      if (!/^\d{1,18}$/.test(req.params.id)) return reply.code(404).send({ message: 'Attachment not found' });
      try {
        const row = await db.selectFrom('scm.Attachment').select(['EntityType', 'EntityId']).where('AttachmentId', '=', req.params.id).executeTakeFirst();
        if (!row) throw new DomainError('NOT_FOUND', 'Attachment not found', 404);
        await assertEntityAccess(db, actor, row.EntityType, row.EntityId, false);
        const file = await readAttachment(db, root, req.params.id, actor.id);
        return reply
          .header('Content-Type', file.contentType)
          .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
          .header('X-Content-Type-Options', 'nosniff')
          .send(file.data);
      } catch (err) {
        return fail(reply, err);
      }
    });
  });
}
