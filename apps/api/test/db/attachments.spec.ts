/** Attachments (plan v5 §0.7) against a real database and a temporary folder. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAttachments, readAttachment, saveAttachment } from '../../src/modules/workflow/attachments.js';
import { withTx } from '../../src/modules/workflow/tx.js';
import { count, db, makeUser, uid } from './helpers.js';

let root = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'scm-att-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await db.destroy();
});

const base = (entityId: string, userId: number) => ({ root, maxBytes: 1024, entityType: 'QUOTE', entityId, companyCode: '1000', userId });

describe('attachments', () => {
  it('stores, lists, supersedes with a new version, and reads back with a logged download', async () => {
    const user = await makeUser();
    const e = uid('Q');
    const v1 = await withTx(db, (tx) => saveAttachment(tx, { ...base(e, user), fileName: 'quote.pdf', data: Buffer.from('%PDF-1 first') }));
    const v2 = await withTx(db, (tx) => saveAttachment(tx, { ...base(e, user), fileName: 'quote-rev.pdf', data: Buffer.from('%PDF-1 second'), supersedesId: v1.attachmentId }));
    expect(v2.versionNo).toBe(2);

    const current = await listAttachments(db, 'QUOTE', e);
    expect(current.map((a) => [a.fileName, a.versionNo, a.supersedesId])).toEqual([['quote-rev.pdf', 2, v1.attachmentId]]);
    expect(await listAttachments(db, 'QUOTE', e, true)).toHaveLength(2);

    const file = await readAttachment(db, root, v2.attachmentId, user);
    expect(file.data.toString()).toBe('%PDF-1 second');
    expect(await count('scm.DomainEvent', sql`EventType = 'ATTACHMENT_DOWNLOADED' AND EntityId = ${e}`)).toBe(1);

    // An old version cannot be superseded again.
    await expect(withTx(db, (tx) => saveAttachment(tx, { ...base(e, user), fileName: 'x.pdf', data: Buffer.from('x'), supersedesId: v1.attachmentId }))).rejects.toMatchObject({ code: 'NOT_CURRENT' });
  });

  it('refuses bad types, empty and oversized files, and deletes', async () => {
    const user = await makeUser();
    const e = uid('Q');
    await expect(withTx(db, (tx) => saveAttachment(tx, { ...base(e, user), fileName: 'virus.exe', data: Buffer.from('x') }))).rejects.toMatchObject({ code: 'FILE_TYPE' });
    await expect(withTx(db, (tx) => saveAttachment(tx, { ...base(e, user), fileName: 'a.pdf', data: Buffer.alloc(0) }))).rejects.toMatchObject({ code: 'FILE_EMPTY' });
    await expect(withTx(db, (tx) => saveAttachment(tx, { ...base(e, user), fileName: 'a.pdf', data: Buffer.alloc(2048, 1) }))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    const ok = await withTx(db, (tx) => saveAttachment(tx, { ...base(e, user), fileName: 'mail.msg', data: Buffer.from('mail') }));
    await expect(sql`DELETE FROM scm.Attachment WHERE AttachmentId = ${ok.attachmentId}`.execute(db)).rejects.toThrow(/cannot be deleted/);
  });

  it('an attachment of another object cannot be superseded', async () => {
    const user = await makeUser();
    const a = await withTx(db, (tx) => saveAttachment(tx, { ...base(uid('Q'), user), fileName: 'a.pdf', data: Buffer.from('a') }));
    await expect(withTx(db, (tx) => saveAttachment(tx, { ...base(uid('Q'), user), fileName: 'b.pdf', data: Buffer.from('b'), supersedesId: a.attachmentId }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
