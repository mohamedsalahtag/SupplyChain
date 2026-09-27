/**
 * Configuration → Start over (2026-09-26): purge every workflow record so testing can begin again from a clean slate.
 *
 * Deleted: demands (weeks, lines, container groups, versions, the quantity ledger and its history), change requests and holds,
 * merges, RFQs and quotes, awards, acknowledgements, shipping terms, handoffs, PO drafts and SAP submissions (and the simulator's
 * POs), work items (except the system ones: sync failed, origins to map), domain events, comments, attachments (rows and files),
 * the notification outbox and the command log. The number sequences restart, so the next demand is D-000001 again —
 * except the PO draft number (POD-…): it is the reference SAP stores on each purchase order and the outbox looks POs up
 * by it, so a restarted POD-000001 would "find" the PO an earlier POD-000001 created in the SAP (test) system and mark a
 * new draft created. POD numbers therefore continue.
 *
 * Kept: users, roles, permissions, companies and user companies, reason codes, origins and supplier origins, shipping-term
 * lists, workflow and connection settings, and the SAP copies (materials, suppliers, purchase orders, purchase history).
 *
 * One transaction: everything goes or nothing does. The three history triggers (versions, comments, attachments are never
 * deleted in normal use) are switched off inside that transaction only.
 *
 * Refused on a production server, unless ALLOW_PURGE=true, while a PO is on its way to SAP (pending, in flight, unknown or
 * waiting for manual resolution: the record of what SAP may hold would be lost) and while a sync runs. The purge holds
 * the maintenance lock (sp_getapplock) for its whole transaction; the SAP outbox and the sync start stay out meanwhile.
 */
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { attachmentsRoot } from '../workflow/attachments.js';
import { liveRunSql } from '../sync/syncRun.js';
import { DomainError } from '../workflow/errors.js';
import type { Db, Tx } from '../workflow/tx.js';
import { takeMaintenanceLock } from './maintenance.js';

/** In delete order: children before parents. */
const TABLES = [
  'scm.SapSubmissionAttempt', 'scm.SapSubmission', 'scm.StubSapPo', 'scm.StubSapFault', 'scm.PoDraftItem', 'scm.PoDraft', 'scm.MasterDataRequest',
  'scm.MergeItem', 'scm.MergeWeek', 'scm.SliceHistory', 'scm.QtySlice', 'scm.MergeRecord', 'scm.LineHold', 'scm.WeekHold', 'scm.ChangeRequestItem',
  'scm.AwardContainerChange', 'scm.AwardContainer', 'scm.AwardItemChange', 'scm.AwardItemSku', 'scm.Handoff', 'scm.SalesAckHistory', 'scm.SalesAck',
  'scm.ShippingTerms', 'scm.AwardShipment', 'scm.AwardItem', 'scm.AwardBatch', 'scm.ChangeRequest', 'scm.SupplierQuoteWeek', 'scm.SupplierQuote',
  'scm.RfqSupplier', 'scm.RfqWeek', 'scm.RfqLine', 'scm.Rfq', 'scm.ContainerGroupItem', 'scm.ContainerGroup', 'scm.DemandLine', 'scm.DemandKeyUom',
  'scm.DemandVersion', 'scm.DemandWeek', 'scm.Demand', 'scm.ThreadEntry', 'scm.Thread', 'scm.DomainEvent', 'scm.NotificationOutbox', 'scm.CommandLog', 'scm.Attachment',
] as const;
/** Work items that belong to the system, not to the workflow: they stay. */
const SYSTEM_ITEMS = ['SYNC_FAILED', 'ORIGIN_UNMATCHED'];
/** Restarted at 1. Not scm.PoDraftNoSeq: POD numbers are the SAP reference and must never repeat (see above). */
const SEQUENCES = ['scm.DemandNoSeq', 'scm.RfqNoSeq', 'scm.HandoffNoSeq', 'scm.AwardNoSeq', 'scm.CrNoSeq', 'scm.MergeNoSeq'];
/** SAP submissions whose outcome is still open: SAP may hold (or be about to create) a PO the portal must not forget. */
const OPEN_SAP = ['PENDING', 'IN_FLIGHT', 'UNKNOWN', 'MANUAL'];
const TRIGGERS = [['scm.DemandVersion', 'TR_DemandVersion_Immutable'], ['scm.ThreadEntry', 'TR_ThreadEntry_Immutable'], ['scm.Attachment', 'TR_Attachment_NoDelete']];

/** Why a purge is refused on this server (null = allowed): never in production, and only with ALLOW_PURGE=true. */
export function purgeRefusal(allowPurge: boolean, env = process.env.NODE_ENV): string | null {
  if (env === 'production') return 'This is a production server: purging is refused.';
  if (!allowPurge) return 'Purging is switched off on this server. An administrator sets ALLOW_PURGE=true in the server settings (.env) and restarts the app.';
  return null;
}

/** Why a purge must wait right now (null = it may run): a PO on its way to SAP, or a running sync. */
async function purgeBlocker(db: Db | Tx): Promise<{ code: string; message: string } | null> {
  const r = (await sql<{ sap: number; syncs: number }>`SELECT
    (SELECT COUNT(*) FROM scm.SapSubmission WHERE Status IN (${sql.join(OPEN_SAP)})) AS sap,
    (SELECT COUNT(*) FROM integ.SyncRun WHERE Status = 'Running' AND ${liveRunSql}) AS syncs`.execute(db)).rows[0];
  if (Number(r.sap)) {
    return { code: 'SAP_IN_PROGRESS', message: `${Number(r.sap)} purchase order(s) are still on their way to SAP or have an unknown SAP outcome. Wait for the SAP outbox, or resolve them on PO drafts, then purge.` };
  }
  if (Number(r.syncs)) return { code: 'SYNC_RUNNING', message: 'A SAP sync is running. Wait until it has finished, then purge.' };
  return null;
}

/** What a purge would delete, and what it keeps (shown before the confirmation). */
export async function purgePreview(db: Db, allowPurge: boolean) {
  const r = (await sql<Record<string, number>>`SELECT
    (SELECT COUNT(*) FROM scm.Demand) AS demands, (SELECT COUNT(*) FROM scm.ChangeRequest) AS changeRequests, (SELECT COUNT(*) FROM scm.MergeRecord) AS merges,
    (SELECT COUNT(*) FROM scm.Rfq) AS rfqs, (SELECT COUNT(*) FROM scm.SupplierQuote) AS quotes, (SELECT COUNT(*) FROM scm.AwardBatch) AS awards,
    (SELECT COUNT(*) FROM scm.Handoff) AS handoffs, (SELECT COUNT(*) FROM scm.PoDraft) AS poDrafts,
    (SELECT COUNT(*) FROM scm.InboxItem WHERE ItemType NOT IN (${sql.join(SYSTEM_ITEMS)})) AS workItems,
    (SELECT COUNT(*) FROM scm.ThreadEntry) AS comments, (SELECT COUNT(*) FROM scm.Attachment) AS attachments, (SELECT COUNT(*) FROM scm.DomainEvent) AS events,
    (SELECT COUNT(*) FROM app.[User] WHERE DeletedAt IS NULL) AS users, (SELECT COUNT(*) FROM md.Material) AS materials,
    (SELECT COUNT(*) FROM md.Supplier) AS suppliers, (SELECT COUNT(*) FROM md.PurchaseOrder) AS purchaseOrders`.execute(db)).rows[0];
  const n = (k: string) => Number(r[k] ?? 0);
  const refused = purgeRefusal(allowPurge);
  const blocked = refused ? null : await purgeBlocker(db);
  return {
    allowed: !refused && !blocked,
    /** Why the button is off (server setting, production, or something in progress); null when a purge may run. */
    refusedBecause: refused ?? blocked?.message ?? null,
    deletes: [
      { label: 'Demands', count: n('demands') }, { label: 'Change requests', count: n('changeRequests') }, { label: 'Merges', count: n('merges') },
      { label: 'RFQs', count: n('rfqs') }, { label: 'Supplier quotes', count: n('quotes') }, { label: 'Awards', count: n('awards') },
      { label: 'Handoffs', count: n('handoffs') }, { label: 'PO drafts', count: n('poDrafts') }, { label: 'Work items', count: n('workItems') },
      { label: 'Comments', count: n('comments') }, { label: 'Attachments', count: n('attachments') }, { label: 'History events', count: n('events') },
    ],
    keeps: [
      { label: 'Users', count: n('users') }, { label: 'Materials', count: n('materials') }, { label: 'Suppliers', count: n('suppliers') },
      { label: 'SAP purchase orders', count: n('purchaseOrders') },
    ],
  };
}

/** Deletes every workflow record in one transaction; then removes the attachment files. */
export async function purgeAll(db: Db, attachmentsDir: string, allowPurge: boolean) {
  const refused = purgeRefusal(allowPurge);
  if (refused) throw new DomainError('PURGE_REFUSED', refused, 403);
  const before = await purgePreview(db, allowPurge);
  const keys = (await sql<{ StorageKey: string }>`SELECT DISTINCT StorageKey FROM scm.Attachment`.execute(db)).rows.map((r) => r.StorageKey);
  await db.transaction().execute(async (tx) => {
    // The maintenance lock first (the outbox and the sync start test it), then the SAP table itself: no claim can slip in
    // between the check below and the deletes.
    if (!(await takeMaintenanceLock(tx))) throw new DomainError('PURGE_RUNNING', 'A purge is already running.', 409);
    await sql`SELECT TOP (1) SubmissionId FROM scm.SapSubmission WITH (TABLOCKX, HOLDLOCK)`.execute(tx);
    const blocked = await purgeBlocker(tx);
    if (blocked) throw new DomainError(blocked.code, blocked.message, 409);
    for (const [t, name] of TRIGGERS) await sql.raw(`DISABLE TRIGGER ${name} ON ${t}`).execute(tx);
    // Self- and cross-references first, so the deletes can go table by table.
    await sql`UPDATE scm.QtySlice SET SplitFromSliceId = NULL, MergedFromSliceId = NULL, MergedToSliceId = NULL, MergedInBy = NULL, MergedOutBy = NULL,
      CancelCrId = NULL, RfqLineId = NULL, AwardItemId = NULL, HandoffId = NULL`.execute(tx);
    await sql`UPDATE scm.DemandLine SET ChangeHoldCrId = NULL WHERE ChangeHoldCrId IS NOT NULL`.execute(tx);
    await sql`UPDATE scm.ContainerGroup SET SourceGroupId = NULL, MergedInBy = NULL, MergedOutBy = NULL`.execute(tx);
    await sql`UPDATE scm.RfqLine SET AddCrId = NULL, WeekShiftCrId = NULL`.execute(tx);
    await sql`UPDATE scm.Handoff SET ReturnCrId = NULL WHERE ReturnCrId IS NOT NULL`.execute(tx);
    await sql`UPDATE scm.SupplierQuote SET SupersededBy = NULL WHERE SupersededBy IS NOT NULL`.execute(tx);
    await sql`UPDATE scm.ThreadEntry SET CorrectsEntryId = NULL WHERE CorrectsEntryId IS NOT NULL`.execute(tx);
    await sql`UPDATE scm.Attachment SET SupersedesId = NULL WHERE SupersedesId IS NOT NULL`.execute(tx);
    await sql`DELETE FROM scm.InboxItem WHERE ItemType NOT IN (${sql.join(SYSTEM_ITEMS)})`.execute(tx);
    for (const t of TABLES) await sql.raw(`DELETE FROM ${t}`).execute(tx);
    for (const s of SEQUENCES) await sql.raw(`ALTER SEQUENCE ${s} RESTART WITH 1`).execute(tx);
    for (const [t, name] of TRIGGERS) await sql.raw(`ENABLE TRIGGER ${name} ON ${t}`).execute(tx);
  });
  // Files last, after the commit: a file left behind is harmless, a row pointing at a missing file is not.
  const root = attachmentsRoot(attachmentsDir);
  let filesRemoved = 0;
  for (const k of keys) await unlink(join(root, k)).then(() => { filesRemoved++; }, () => undefined);
  return { deleted: before.deletes, filesRemoved };
}
