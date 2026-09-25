/**
 * Attachments (plan v5 §0.7): quote evidence, emails, price lists… Files are
 * stored on disk by content hash; rows are never deleted — a new version
 * supersedes the old one. Access follows the parent object (checked by the
 * caller); every download is logged as a domain event.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { DomainError, NotFoundError } from './errors.js';
import { recordEvent } from './events.js';
import type { Db, Tx } from './tx.js';

/** File types allowed, by extension. */
export const ALLOWED_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.msg': 'application/vnd.ms-outlook',
  '.eml': 'message/rfc822',
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const attachmentsRoot = (configured: string) => (configured ? resolve(configured) : join(REPO_ROOT, 'data', 'attachments'));

/** Content type for a file name, or a clear error for a type that is not allowed. */
export function contentTypeFor(fileName: string): string {
  const type = ALLOWED_TYPES[extname(fileName).toLowerCase()];
  if (!type) throw new DomainError('FILE_TYPE', `File type not allowed: ${fileName}. Allowed: ${Object.keys(ALLOWED_TYPES).join(' ')}`);
  return type;
}

export type NewAttachment = {
  root: string;
  maxBytes: number;
  entityType: string;
  entityId: string | number;
  companyCode: string | null;
  fileName: string;
  data: Buffer;
  userId: number;
  /** Upload as a new version of this attachment (same object). */
  supersedesId?: string | null;
};

export async function saveAttachment(tx: Tx, a: NewAttachment): Promise<{ attachmentId: string; versionNo: number }> {
  const fileName = a.fileName.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 260);
  if (!fileName) throw new DomainError('FILE_NAME', 'File name is empty');
  const contentType = contentTypeFor(fileName);
  if (a.data.length === 0) throw new DomainError('FILE_EMPTY', 'The file is empty');
  if (a.data.length > a.maxBytes) throw new DomainError('FILE_TOO_LARGE', `The file is larger than ${Math.round(a.maxBytes / 1_048_576)} MB`);

  let versionNo = 1;
  if (a.supersedesId) {
    const old = (await sql<{ EntityType: string; EntityId: string; VersionNo: number; IsCurrent: boolean }>`
      SELECT EntityType, EntityId, VersionNo, IsCurrent FROM scm.Attachment WITH (UPDLOCK) WHERE AttachmentId = ${a.supersedesId}`.execute(tx)).rows[0];
    if (!old || old.EntityType !== a.entityType || old.EntityId !== String(a.entityId)) throw new NotFoundError(`Attachment ${a.supersedesId}`);
    if (!old.IsCurrent) throw new DomainError('NOT_CURRENT', 'Only the current version can be replaced', 409);
    versionNo = Number(old.VersionNo) + 1;
    await tx.updateTable('scm.Attachment').set({ IsCurrent: false }).where('AttachmentId', '=', a.supersedesId).execute();
  }

  // Stored by content hash: the same file uploaded twice is stored once; an orphan file after a rollback is harmless.
  const sha256 = createHash('sha256').update(a.data).digest('hex');
  const storageKey = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  const path = join(a.root, storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, a.data, { flag: 'w' });

  const row = await tx
    .insertInto('scm.Attachment')
    .values({
      EntityType: a.entityType,
      EntityId: String(a.entityId),
      CompanyCode: a.companyCode,
      FileName: fileName,
      ContentType: contentType,
      SizeBytes: a.data.length,
      Sha256: sha256,
      StorageKey: storageKey,
      VersionNo: versionNo,
      SupersedesId: a.supersedesId ?? null,
      UploadedBy: a.userId,
    })
    .output('inserted.AttachmentId')
    .executeTakeFirstOrThrow();
  const attachmentId = String(row.AttachmentId);
  await recordEvent(tx, { type: 'ATTACHMENT_UPLOADED', entityType: a.entityType, entityId: a.entityId, payload: { attachmentId, fileName, versionNo }, actorUserId: a.userId });
  return { attachmentId, versionNo };
}

export async function listAttachments(db: Db | Tx, entityType: string, entityId: string | number, includeOld = false) {
  let q = db
    .selectFrom('scm.Attachment as a')
    .leftJoin('app.User as u', 'u.UserId', 'a.UploadedBy')
    .select(['a.AttachmentId', 'a.FileName', 'a.ContentType', 'a.SizeBytes', 'a.VersionNo', 'a.IsCurrent', 'a.SupersedesId', 'a.UploadedAt', 'u.DisplayName'])
    .where('a.EntityType', '=', entityType)
    .where('a.EntityId', '=', String(entityId));
  if (!includeOld) q = q.where('a.IsCurrent', '=', true);
  const rows = await q.orderBy('a.UploadedAt', 'desc').execute();
  return rows.map((r) => ({
    attachmentId: String(r.AttachmentId),
    fileName: r.FileName,
    contentType: r.ContentType,
    sizeBytes: Number(r.SizeBytes),
    versionNo: Number(r.VersionNo),
    isCurrent: r.IsCurrent,
    supersedesId: r.SupersedesId ? String(r.SupersedesId) : null,
    uploadedBy: r.DisplayName ?? '',
    uploadedAt: r.UploadedAt.toISOString(),
  }));
}

/** Reads the file (after the caller checked access to the parent object) and logs the download. */
export async function readAttachment(db: Db, root: string, attachmentId: string, userId: number) {
  const a = await db.selectFrom('scm.Attachment').selectAll().where('AttachmentId', '=', attachmentId).executeTakeFirst();
  if (!a) throw new NotFoundError(`Attachment ${attachmentId}`);
  const data = await readFile(join(root, a.StorageKey));
  if (createHash('sha256').update(data).digest('hex') !== a.Sha256) throw new DomainError('FILE_CORRUPT', 'The stored file does not match its checksum', 409);
  await recordEvent(db, { type: 'ATTACHMENT_DOWNLOADED', entityType: a.EntityType, entityId: a.EntityId, payload: { attachmentId }, actorUserId: userId });
  return { fileName: a.FileName, contentType: a.ContentType, data, entityType: a.EntityType, entityId: a.EntityId, companyCode: a.CompanyCode };
}
