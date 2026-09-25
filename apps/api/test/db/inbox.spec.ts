/** My work (spec 10) against a real database. */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finishRun, startRun } from '../../src/modules/sync/syncRun.js';
import { closeInbox, escalateOverdue, ITEM_TYPES, listWork, openInbox, workTabs } from '../../src/modules/workflow/inbox.js';
import { loadWfSettings, saveWfSettings, wfSettingsVersion } from '../../src/modules/workflow/settings.js';
import { actor, count, db, uid } from './helpers.js';

// A task type only for these tests (real task types arrive with Stage 1).
ITEM_TYPES.TEST_TASK = { label: 'Test task', category: 'TASK', order: 100, action: 'Do it' };
const PERM = 'test.act';

beforeAll(async () => {
  const s = await loadWfSettings(db);
  await saveWfSettings(db, { ...s, dueHours: { ...s.dueHours, TEST_TASK: 48 } }, await wfSettingsVersion(db));
});
afterAll(() => db.destroy());

const open = (entityId: string, companyCode: string | null, extra: Partial<Parameters<typeof openInbox>[1]> = {}) =>
  openInbox(db, { itemType: 'TEST_TASK', permission: PERM, companyCode, entityType: 'TEST', entityId, number: entityId, title: `Item ${entityId}`, link: '/x', raisedBy: null, ...extra });

const ids = async (a: ReturnType<typeof actor>, q: string) => (await listWork(db, a, { q, page: 1, pageSize: 100 })).rows.map((r) => r.number);

describe('who sees an item', () => {
  it('needs the permission and the company; items without a company need only the permission', async () => {
    const tag = uid('vis');
    await open(`${tag}-ksa`, '1000');
    await open(`${tag}-sys`, null);
    const ksa = actor({ permissions: new Set([PERM]), companies: new Set(['1000']) });
    const uae = actor({ permissions: new Set([PERM]), companies: new Set(['2000']) });
    const noPerm = actor({ permissions: new Set(['other']), companies: new Set(['1000']) });
    const noCompany = actor({ permissions: new Set([PERM]) });
    expect((await ids(ksa, tag)).sort()).toEqual([`${tag}-ksa`, `${tag}-sys`]);
    expect(await ids(uae, tag)).toEqual([`${tag}-sys`]);
    expect(await ids(noPerm, tag)).toEqual([]);
    expect(await ids(noCompany, tag)).toEqual([`${tag}-sys`]);
    expect(await ids(actor({ isAdmin: true, companies: new Set(['1000']) }), tag)).toHaveLength(2);
  });
});

describe('opening, refreshing and closing', () => {
  it('opens once per object; opening again refreshes the text instead of duplicating', async () => {
    const e = uid('dup');
    await open(e, '1000', { title: 'first' });
    await open(e, '1000', { title: 'second', note: 'now missing X' });
    expect(await count('scm.InboxItem', sql`EntityId = ${e} AND IsOpen = 1`)).toBe(1);
    const [row] = (await listWork(db, actor({ isAdmin: true, companies: new Set(['1000']) }), { q: e, page: 1, pageSize: 25 })).rows;
    expect([row.title, row.note, row.action]).toEqual(['second', 'now missing X', { label: 'Do it', link: '/x' }]);
  });

  it('due time comes from the settings; close removes it from the list', async () => {
    const e = uid('due');
    await open(e, '1000');
    const item = await db.selectFrom('scm.InboxItem').select(sql<number>`DATEDIFF(minute, CreatedAt, DueAt)`.as('m')).where('EntityId', '=', e).executeTakeFirstOrThrow();
    expect(Number(item.m)).toBe(48 * 60);
    expect(await closeInbox(db, 'TEST_TASK', 'TEST', e, 1)).toBe(1);
    expect(await closeInbox(db, 'TEST_TASK', 'TEST', e, 1)).toBe(0);
    expect(await ids(actor({ isAdmin: true, companies: new Set(['1000']) }), e)).toEqual([]);
    await open(e, '1000'); // a closed item does not block a new one
    expect(await count('scm.InboxItem', sql`EntityId = ${e}`)).toBe(2);
  });

  it('refuses an unknown item type', async () => {
    await expect(openInbox(db, { itemType: 'NOPE', permission: PERM, companyCode: null, entityType: 'TEST', entityId: 'x', number: 'x', title: 'x', link: '/', raisedBy: null })).rejects.toThrow(/Unknown work item type/);
  });
});

describe('overdue and escalation', () => {
  it('sorts overdue first, filters by due, and escalates once with a logged event', async () => {
    const tag = uid('esc');
    await open(`${tag}-later`, '1000');
    await open(`${tag}-late`, '1000');
    await sql`UPDATE scm.InboxItem SET DueAt = DATEADD(hour, -2, SYSUTCDATETIME()) WHERE EntityId = ${`${tag}-late`}`.execute(db);
    const admin = actor({ isAdmin: true, companies: new Set(['1000']) });

    const list = await listWork(db, admin, { q: tag, page: 1, pageSize: 25 });
    expect(list.rows.map((r) => [r.number, r.overdue])).toEqual([[`${tag}-late`, true], [`${tag}-later`, false]]);
    expect((await listWork(db, admin, { q: tag, due: 'overdue', page: 1, pageSize: 25 })).rows.map((r) => r.number)).toEqual([`${tag}-late`]);

    expect(await escalateOverdue(db)).toBeGreaterThanOrEqual(1);
    expect(await escalateOverdue(db)).toBe(0);
    const late = (await listWork(db, admin, { q: `${tag}-late`, page: 1, pageSize: 25 })).rows[0];
    expect(late.escalated).toBe(true);
    const itemId = late.id;
    expect(await count('scm.DomainEvent', sql`EventType = 'WORK_ITEM_ESCALATED' AND EntityId = ${itemId}`)).toBe(1);
  });

  it('tabs: one per task type, exceptions together, with counts', async () => {
    const tag = uid('tab');
    await open(`${tag}-1`, '3000');
    const onlyTag = actor({ permissions: new Set([PERM]), companies: new Set(['3000']) });
    const { tabs } = await workTabs(db, onlyTag);
    const task = tabs.find((t) => t.key === 'TEST_TASK');
    expect(task?.label).toBe('Test task');
    expect(task!.count).toBeGreaterThanOrEqual(1);
  });
});

describe('sync failures become Exceptions (spec 10)', () => {
  it('a failed run opens SYNC_FAILED for the source; a successful run closes it', async () => {
    await sql`UPDATE integ.SyncRun SET Status = 'Failed' WHERE Status = 'Running'`.execute(db);
    const failed = await startRun(db, 'sap.suppliers', 'test');
    await finishRun(db, failed, 'Failed', {}, 'SAP answered 401');
    const admin = actor({ isAdmin: true });
    let rows = (await listWork(db, admin, { tab: 'EXCEPTIONS', page: 1, pageSize: 100 })).rows.filter((r) => r.itemType === 'SYNC_FAILED');
    expect(rows.map((r) => [r.title, r.note, r.action.link])).toContainEqual(['Suppliers sync failed', 'SAP answered 401', '/settings?tab=suppliers']);

    const ok = await startRun(db, 'sap.suppliers', 'test');
    await finishRun(db, ok, 'Succeeded', { read: 1 }, null);
    rows = (await listWork(db, admin, { tab: 'EXCEPTIONS', page: 1, pageSize: 100 })).rows.filter((r) => r.title === 'Suppliers sync failed');
    expect(rows).toEqual([]);
  });
});
