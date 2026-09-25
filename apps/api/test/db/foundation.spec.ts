/** Stage 0 foundations against a real database: commands, versions, ownership, threads, companies, settings. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { assertBelongs, parentBy, registerParent } from '../../src/modules/workflow/belongs.js';
import { runCommand } from '../../src/modules/workflow/command.js';
import { recordEvent } from '../../src/modules/workflow/events.js';
import { addThreadEntry, listThread } from '../../src/modules/workflow/threads.js';
import { loadWfSettings, saveWfSettings, wfSettingsVersion } from '../../src/modules/workflow/settings.js';
import { withTx } from '../../src/modules/workflow/tx.js';
import { listCompanies, saveCompany, setUserCompanies } from '../../src/modules/workflowSetup/companies.js';
import { userCompanies } from '../../src/modules/workflow/access.js';
import { count, db, makeUser, uid } from './helpers.js';

afterAll(() => db.destroy());

const eventsFor = (entityId: string) => count('scm.DomainEvent', sql`EntityId = ${entityId}`);

describe('runCommand: duplicate-safe (plan v5 §0.6)', () => {
  it('runs once; a repeat returns the stored result and changes nothing', async () => {
    const user = await makeUser();
    const commandId = randomUUID();
    const entity = uid('cmd');
    const work = (tx: Parameters<Parameters<typeof withTx>[1]>[0]) =>
      recordEvent(tx, { type: 'TEST', entityType: 'TEST', entityId: entity, actorUserId: user }).then((eventId) => ({ eventId }));
    const first = await runCommand(db, user, commandId, 'test', work);
    const second = await runCommand(db, user, commandId, 'test', work);
    expect(second).toEqual(first);
    expect(await eventsFor(entity)).toBe(1);
  });

  it('two identical commands at the same moment make one change', async () => {
    const user = await makeUser();
    const commandId = randomUUID();
    const entity = uid('race');
    const work = (tx: Parameters<Parameters<typeof withTx>[1]>[0]) => recordEvent(tx, { type: 'TEST', entityType: 'TEST', entityId: entity, actorUserId: user });
    const [a, b] = await Promise.all([runCommand(db, user, commandId, 'test', work), runCommand(db, user, commandId, 'test', work)]);
    expect(a).toBe(b);
    expect(await eventsFor(entity)).toBe(1);
  });

  it('refuses another user reusing the id, and non-UUID ids', async () => {
    const [u1, u2] = [await makeUser(), await makeUser()];
    const commandId = randomUUID();
    await runCommand(db, u1, commandId, 'test', async () => 1);
    await expect(runCommand(db, u2, commandId, 'test', async () => 2)).rejects.toMatchObject({ code: 'BAD_COMMAND' });
    await expect(runCommand(db, u1, 'not-a-uuid', 'test', async () => 3)).rejects.toMatchObject({ code: 'BAD_COMMAND' });
  });

  it('a failing command leaves nothing behind and can be retried', async () => {
    const user = await makeUser();
    const commandId = randomUUID();
    const entity = uid('fail');
    await expect(
      runCommand(db, user, commandId, 'test', async (tx) => {
        await recordEvent(tx, { type: 'TEST', entityType: 'TEST', entityId: entity, actorUserId: user });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await eventsFor(entity)).toBe(0);
    await runCommand(db, user, commandId, 'test', (tx) => recordEvent(tx, { type: 'TEST', entityType: 'TEST', entityId: entity, actorUserId: user }));
    expect(await eventsFor(entity)).toBe(1);
  });
});

describe('optimistic concurrency on companies (RowVer)', () => {
  it('saves with the current version; a stale version gets STALE_WRITE', async () => {
    const code = uid('C').slice(0, 10);
    await saveCompany(db, { companyCode: code, name: 'Test', country: 'SA', timeZone: 'Asia/Riyadh', defaultPlant: 'HO01', purchasingOrg: '', purchasingGroup: '', isActive: true, rowVer: null });
    const v1 = (await listCompanies(db)).find((c) => c.CompanyCode === code)!.RowVer;
    const edit = { companyCode: code, name: 'Renamed', country: 'SA', timeZone: 'Asia/Riyadh', defaultPlant: 'HO01', purchasingOrg: '2000', purchasingGroup: 'Z04', isActive: true };
    await saveCompany(db, { ...edit, rowVer: v1 });
    await expect(saveCompany(db, { ...edit, name: 'Again', rowVer: v1 })).rejects.toMatchObject({ code: 'STALE_WRITE', status: 409 });
    expect((await listCompanies(db)).find((c) => c.CompanyCode === code)!.Name).toBe('Renamed');
  });

  it('refuses a duplicate new company', async () => {
    await expect(saveCompany(db, { companyCode: '1000', name: 'x', country: 'SA', timeZone: 'Asia/Riyadh', defaultPlant: 'HO01', purchasingOrg: '', purchasingGroup: '', isActive: true, rowVer: null })).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('the seeded companies exist with plant HO01', async () => {
    const seeded = (await listCompanies(db)).filter((c) => ['1000', '2000', '3000'].includes(c.CompanyCode));
    expect(seeded.map((c) => [c.CompanyCode, c.Name, c.DefaultPlant])).toEqual([['1000', 'KSA', 'HO01'], ['2000', 'UAE', 'HO01'], ['3000', 'Bahrain', 'HO01']]);
  });
});

describe('user companies (data scope)', () => {
  it('replaces the set; refuses unknown companies', async () => {
    const user = await makeUser();
    await setUserCompanies(db, user, ['1000', '3000']);
    expect([...(await userCompanies(db, user))].sort()).toEqual(['1000', '3000']);
    await setUserCompanies(db, user, ['2000']);
    expect([...(await userCompanies(db, user))]).toEqual(['2000']);
    await expect(setUserCompanies(db, user, ['9999'])).rejects.toMatchObject({ code: 'BAD_COMPANY' });
    expect([...(await userCompanies(db, user))]).toEqual(['2000']);
  });
});

describe('assertBelongs (plan v5 §0.5)', () => {
  registerParent('TEST_ENTRY', parentBy('scm.ThreadEntry', 'EntryId', 'ThreadId'));

  it('passes for own children and answers NOT_FOUND for others', async () => {
    const [a, b] = [uid('A'), uid('B')];
    const ea = await withTx(db, (tx) => addThreadEntry(tx, { entityType: 'TEST', entityId: a, kind: 'COMMENT', body: 'a', authorUserId: null }));
    const eb = await withTx(db, (tx) => addThreadEntry(tx, { entityType: 'TEST', entityId: b, kind: 'COMMENT', body: 'b', authorUserId: null }));
    const threadA = (await db.selectFrom('scm.Thread').select('ThreadId').where('EntityId', '=', a).executeTakeFirstOrThrow()).ThreadId;
    await withTx(db, (tx) => assertBelongs(tx, 'TEST_ENTRY', [ea], String(threadA)));
    await expect(withTx(db, (tx) => assertBelongs(tx, 'TEST_ENTRY', [ea, eb], String(threadA)))).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(withTx(db, (tx) => assertBelongs(tx, 'TEST_ENTRY', ['999999999'], String(threadA)))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('threads (immutable timeline)', () => {
  it('keeps entries in order; corrections are new entries; update and delete are refused', async () => {
    const entity = uid('T');
    const user = await makeUser();
    const first = await withTx(db, (tx) => addThreadEntry(tx, { entityType: 'TEST', entityId: entity, kind: 'COMMENT', body: 'price 12.40', authorUserId: user }));
    await withTx(db, (tx) => addThreadEntry(tx, { entityType: 'TEST', entityId: entity, kind: 'COMMENT', body: 'price 12.50', authorUserId: user, correctsEntryId: first }));
    const thread = await listThread(db, 'TEST', entity);
    expect(thread.map((e) => [e.body, e.correctsEntryId])).toEqual([['price 12.40', null], ['price 12.50', first]]);
    await expect(sql`UPDATE scm.ThreadEntry SET Body = 'x' WHERE EntryId = ${first}`.execute(db)).rejects.toThrow(/cannot be changed/);
    await expect(sql`DELETE FROM scm.ThreadEntry WHERE EntryId = ${first}`.execute(db)).rejects.toThrow(/cannot be changed/);
  });
});

describe('workflow settings', () => {
  it('saves with the current version and refuses a stale one', async () => {
    const version = await wfSettingsVersion(db);
    const settings = { ...(await loadWfSettings(db)), attachmentMaxMb: 15 };
    await saveWfSettings(db, settings, version);
    expect((await loadWfSettings(db)).attachmentMaxMb).toBe(15);
    await expect(saveWfSettings(db, { ...settings, attachmentMaxMb: 10 }, version)).rejects.toMatchObject({ code: 'STALE_WRITE' });
  });
});
