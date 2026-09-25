/**
 * My work (spec 10). Work items are opened by the service action that creates
 * the work and closed by the action that resolves it, always in that action's
 * transaction. Users never open or close items by hand.
 */
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { Database } from '../../db/schema.js';
import type { Actor } from './access.js';
import { recordEvent } from './events.js';
import { loadWfSettings } from './settings.js';
import type { Db, Tx } from './tx.js';

type Category = 'TASK' | 'EXCEPTION';

/**
 * Every item type, in business order. Tasks get a tab each; all exceptions
 * share the Exceptions tab. Later stages add their types here.
 */
export const ITEM_TYPES: Record<string, { label: string; category: Category; order: number; action: string }> = {
  DEMAND_RETURNED: { label: 'Fix and resubmit', category: 'TASK', order: 10, action: 'Fix and resubmit' },
  DEMAND_TO_ACCEPT: { label: 'Accept demand', category: 'TASK', order: 20, action: 'Review demand' },
  CR_TO_DECIDE: { label: 'Decide change request', category: 'TASK', order: 30, action: 'Decide' },
  RFQ_TO_QUOTE: { label: 'Record quotes', category: 'TASK', order: 40, action: 'Record quotes' },
  ACK_PENDING: { label: 'Acknowledge award', category: 'TASK', order: 50, action: 'Review award' },
  SUPPLIER_CHANGE: { label: 'Tell the supplier', category: 'TASK', order: 60, action: 'Open award' },
  HANDOFF_READY: { label: 'Hand off', category: 'TASK', order: 70, action: 'Hand off' },
  HANDOFF_TO_ACCEPT: { label: 'Accept handoff', category: 'TASK', order: 80, action: 'Open handoff' },
  PO_TO_PREPARE: { label: 'Prepare PO', category: 'TASK', order: 90, action: 'Prepare PO' },
  HANDOFF_RETURNED: { label: 'Handoff returned', category: 'EXCEPTION', order: 830, action: 'Fix' },
  MASTER_DATA_MISSING: { label: 'Material missing in SAP', category: 'EXCEPTION', order: 850, action: 'Open' },
  SAP_REJECTED: { label: 'PO rejected by SAP', category: 'EXCEPTION', order: 860, action: 'Fix' },
  SAP_UNKNOWN: { label: 'SAP outcome unknown', category: 'EXCEPTION', order: 870, action: 'Resolve' },
  HANDOFF_AUTO_RETURNED: { label: 'Handoff returned automatically', category: 'EXCEPTION', order: 840, action: 'Reconfirm' },
  ACK_QUERY: { label: 'Award query', category: 'EXCEPTION', order: 820, action: 'Answer' },
  OPEN_QTY_AGING: { label: 'Open quantity near ETD', category: 'EXCEPTION', order: 800, action: 'Create RFQ' },
  SUPPLIER_MISSING_ORIGIN: { label: 'Supplier missing for origin', category: 'EXCEPTION', order: 810, action: 'Supplier origins' },
  SYNC_FAILED: { label: 'Sync failed', category: 'EXCEPTION', order: 900, action: 'Open sync' },
  ORIGIN_UNMATCHED: { label: 'Origins to map', category: 'EXCEPTION', order: 910, action: 'Map origins' },
};
export const EXCEPTIONS_TAB = 'EXCEPTIONS';

export type OpenItem = {
  itemType: keyof typeof ITEM_TYPES | string;
  permission: string;
  companyCode: string | null;
  entityType: string;
  entityId: string | number;
  number: string;
  title: string;
  note?: string | null;
  link: string;
  raisedBy: number | null;
  /** Never shown to this user (e.g. the raiser of a change request). */
  excludeUserId?: number | null;
};

/**
 * Opens the item, or refreshes title/note/link if the same item is already open
 * (one open item per type and object). Due time comes from Configuration → Workflow.
 */
export async function openInbox(db: Db | Tx, item: OpenItem): Promise<void> {
  const type = ITEM_TYPES[item.itemType];
  if (!type) throw new Error(`Unknown work item type ${item.itemType}`);
  const entityId = String(item.entityId);
  const refreshed = await db
    .updateTable('scm.InboxItem')
    .set({ Title: item.title, Note: item.note ?? null, Link: item.link, Number: item.number })
    .where('ItemType', '=', item.itemType)
    .where('EntityType', '=', item.entityType)
    .where('EntityId', '=', entityId)
    .where(sql<SqlBool>`IsOpen = 1`) // literal: the one-open-item index (filtered on IsOpen = 1) is then usable
    .executeTakeFirst();
  if (Number(refreshed.numUpdatedRows) > 0) return;

  const hours = (await loadWfSettings(db)).dueHours[item.itemType] ?? null;
  await db
    .insertInto('scm.InboxItem')
    .values({
      ItemType: item.itemType,
      Category: type.category,
      Permission: item.permission,
      CompanyCode: item.companyCode,
      EntityType: item.entityType,
      EntityId: entityId,
      Number: item.number,
      Title: item.title,
      Note: item.note ?? null,
      Link: item.link,
      RaisedBy: item.raisedBy,
      ExcludeUserId: item.excludeUserId ?? null,
      DueAt: hours == null ? null : sql<Date>`DATEADD(hour, ${hours}, SYSUTCDATETIME())`,
      EscalatedAt: null,
      ClosedAt: null,
      ClosedBy: null,
    })
    .execute();
}

/** Closes the open item of this type for the object, if any. */
export async function closeInbox(db: Db | Tx, itemType: string, entityType: string, entityId: string | number, closedBy: number | null): Promise<number> {
  const r = await db
    .updateTable('scm.InboxItem')
    .set({ IsOpen: false, ClosedAt: sql<Date>`SYSUTCDATETIME()`, ClosedBy: closedBy })
    .where('ItemType', '=', itemType)
    .where('EntityType', '=', entityType)
    .where('EntityId', '=', String(entityId))
    .where(sql<SqlBool>`IsOpen = 1`) // literal: the one-open-item index (filtered on IsOpen = 1) is then usable
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

type Eb = ExpressionBuilder<Database & { i: Database['scm.InboxItem'] }, 'i'>;

/** Open items this actor may act on: their permissions, and their companies or no company. */
function visibleTo(actor: Actor) {
  return (eb: Eb) => {
    // A literal (not a parameter), so SQL Server can use the index of open items only (IX_InboxItem_OpenItems).
    const parts: Expression<SqlBool>[] = [sql<SqlBool>`i.IsOpen = 1`, eb.or([eb('i.ExcludeUserId', 'is', null), eb('i.ExcludeUserId', '<>', actor.id)])];
    if (!actor.isAdmin) {
      const perms = [...actor.permissions];
      parts.push(perms.length ? eb('i.Permission', 'in', perms) : sql<SqlBool>`1 = 0`);
    }
    const companies = [...actor.companies];
    parts.push(companies.length ? eb.or([eb('i.CompanyCode', 'is', null), eb('i.CompanyCode', 'in', companies)]) : eb('i.CompanyCode', 'is', null));
    return eb.and(parts);
  };
}

const tabOf = (itemType: string) => (ITEM_TYPES[itemType]?.category === 'TASK' ? itemType : EXCEPTIONS_TAB);

/** Tabs with open items, in business order, each with its count and overdue count. */
export async function workTabs(db: Db, actor: Actor) {
  const rows = await db
    .selectFrom('scm.InboxItem as i')
    .where(visibleTo(actor))
    .select(['i.ItemType'])
    .select((eb) => [
      eb.fn.countAll<number>().as('n'),
      eb.fn.sum<number>(sql`CASE WHEN i.DueAt < SYSUTCDATETIME() THEN 1 ELSE 0 END`).as('overdue'),
    ])
    .groupBy('i.ItemType')
    .execute();
  const tabs = new Map<string, { key: string; label: string; order: number; count: number; overdue: number }>();
  for (const r of rows) {
    const key = tabOf(r.ItemType);
    const type = ITEM_TYPES[r.ItemType];
    const tab = tabs.get(key) ?? { key, label: key === EXCEPTIONS_TAB ? 'Exceptions' : (type?.label ?? r.ItemType), order: key === EXCEPTIONS_TAB ? 10_000 : (type?.order ?? 5_000), count: 0, overdue: 0 };
    tab.count += Number(r.n);
    tab.overdue += Number(r.overdue ?? 0);
    tabs.set(key, tab);
  }
  const list = [...tabs.values()].sort((a, b) => a.order - b.order).map(({ order: _o, ...t }) => t);
  return { tabs: list, total: list.reduce((s, t) => s + t.count, 0) };
}

export type WorkFilter = {
  tab?: string;
  q?: string;
  company?: string[];
  due?: 'overdue' | 'today' | 'later' | 'none';
  page: number;
  pageSize: number;
};

export async function listWork(db: Db, actor: Actor, f: WorkFilter) {
  let q = db.selectFrom('scm.InboxItem as i').leftJoin('app.User as u', 'u.UserId', 'i.RaisedBy').where(visibleTo(actor));
  if (f.tab === EXCEPTIONS_TAB) {
    const exceptionTypes = Object.entries(ITEM_TYPES).filter(([, t]) => t.category === 'EXCEPTION').map(([k]) => k);
    q = q.where((eb) => eb.or([eb('i.Category', '=', 'EXCEPTION'), eb('i.ItemType', 'in', exceptionTypes)]));
  } else if (f.tab) {
    q = q.where('i.ItemType', '=', f.tab);
  }
  if (f.q) {
    const p = `%${f.q.replace(/[[%_]/g, '[$&]')}%`;
    q = q.where((eb) => eb.or([eb('i.Number', 'like', p), eb('i.Title', 'like', p), eb('i.Note', 'like', p)]));
  }
  if (f.company?.length) q = q.where('i.CompanyCode', 'in', f.company);
  if (f.due === 'overdue') q = q.where(sql<SqlBool>`i.DueAt < SYSUTCDATETIME()`);
  if (f.due === 'today') q = q.where(sql<SqlBool>`i.DueAt >= SYSUTCDATETIME() AND i.DueAt < DATEADD(day, 1, CAST(CAST(SYSUTCDATETIME() AS date) AS datetime2))`);
  if (f.due === 'later') q = q.where(sql<SqlBool>`i.DueAt >= DATEADD(day, 1, CAST(CAST(SYSUTCDATETIME() AS date) AS datetime2))`);
  if (f.due === 'none') q = q.where('i.DueAt', 'is', null);

  const [rows, count] = await Promise.all([
    q
      .select([
        'i.InboxItemId', 'i.ItemType', 'i.Category', 'i.CompanyCode', 'i.Number', 'i.Title', 'i.Note', 'i.Link',
        'i.CreatedAt', 'i.DueAt', 'i.EscalatedAt', 'u.DisplayName as RaisedByName',
      ])
      .select(sql<number>`CASE WHEN i.DueAt < SYSUTCDATETIME() THEN 1 ELSE 0 END`.as('Overdue'))
      .orderBy(sql`CASE WHEN i.DueAt < SYSUTCDATETIME() THEN 0 ELSE 1 END`)
      .orderBy(sql`CASE WHEN i.DueAt IS NULL THEN 1 ELSE 0 END`)
      .orderBy('i.DueAt')
      .orderBy('i.CreatedAt')
      .orderBy('i.InboxItemId')
      .offset((f.page - 1) * f.pageSize)
      .fetch(f.pageSize)
      .execute(),
    q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  return {
    total: Number(count.n),
    rows: rows.map((r) => ({
      id: String(r.InboxItemId),
      itemType: r.ItemType,
      typeLabel: ITEM_TYPES[r.ItemType]?.label ?? r.ItemType,
      category: r.Category,
      companyCode: r.CompanyCode,
      number: r.Number,
      title: r.Title,
      note: r.Note,
      /** The next step: the one action the row offers (hard rule 2: decided by the server). */
      action: { label: ITEM_TYPES[r.ItemType]?.action ?? 'Open', link: r.Link },
      raisedBy: r.RaisedByName ?? 'System',
      createdAt: r.CreatedAt.toISOString(),
      dueAt: r.DueAt ? r.DueAt.toISOString() : null,
      overdue: Number(r.Overdue) === 1,
      escalated: !!r.EscalatedAt,
    })),
  };
}

/** Hourly job: marks overdue items escalated (once) and logs each one. Returns how many. */
export async function escalateOverdue(db: Db): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const due = (await sql<{ InboxItemId: string; ItemType: string; Number: string }>`
      UPDATE scm.InboxItem SET EscalatedAt = SYSUTCDATETIME()
      OUTPUT inserted.InboxItemId, inserted.ItemType, inserted.Number
      WHERE IsOpen = 1 AND EscalatedAt IS NULL AND DueAt < SYSUTCDATETIME()`.execute(tx)).rows;
    for (const r of due) {
      await recordEvent(tx, { type: 'WORK_ITEM_ESCALATED', entityType: 'INBOX_ITEM', entityId: r.InboxItemId, payload: { itemType: r.ItemType, number: r.Number }, actorUserId: null });
    }
    return due.length;
  });
}

