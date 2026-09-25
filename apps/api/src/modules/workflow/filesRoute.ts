/**
 * Attachment upload and download over plain HTTP (raw bytes; tRPC carries JSON
 * only). Same session cookie as the rest of the app; access follows the parent
 * object (entityAccess). Upload: PUT /files/attachments?entityType&entityId&fileName[&supersedesId].
 */
import type { FastifyInstance } from 'fastify';
import { resolveSessionUser } from '../../auth/authUser.js';
import { SESSION_COOKIE } from '../../auth/session.js';
import type { Config } from '../../config.js';
import { loadActor } from './access.js';
import { attachmentsRoot, readAttachment, saveAttachment } from './attachments.js';
import { assertEntityAccess } from './entityAccess.js';
import { DomainError } from './errors.js';
import { loadWfSettings } from './settings.js';
import { withTx, type Db } from './tx.js';

const MAX_BODY = 100 * 1_048_576; // the configured limit (spec 11, max 100 MB) is checked per upload

export async function registerFileRoutes(app: FastifyInstance, db: Db, cfg: Config): Promise<void> {
  const root = attachmentsRoot(cfg.ATTACHMENTS_DIR);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));

  const actorOf = async (cookie: string | undefined) => {
    const user = await resolveSessionUser(db, cfg, cookie);
    return user ? loadActor(db, user) : null;
  };
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ code: err.code, message: err.message });
    throw err;
  };

  app.put<{ Querystring: { entityType?: string; entityId?: string; fileName?: string; supersedesId?: string } }>(
    '/files/attachments',
    { bodyLimit: MAX_BODY },
    async (req, reply) => {
      const actor = await actorOf(req.cookies[SESSION_COOKIE]);
      if (!actor) return reply.code(401).send({ message: 'Please sign in' });
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

  app.get<{ Params: { id: string } }>('/files/attachments/:id', async (req, reply) => {
    const actor = await actorOf(req.cookies[SESSION_COOKIE]);
    if (!actor) return reply.code(401).send({ message: 'Please sign in' });
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
}
