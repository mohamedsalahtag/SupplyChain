/**
 * RFQ commands (spec 18, plan v5 §4.3): create from one accepted demand, send,
 * release quantity, cancel. Quantity moves only through the slice state machine.
 */
import { defaultRfqContainers } from '@supplychain/shared';
import { sql } from 'kysely';
import { incrementFor } from '../demand/content.js';
import { lockDemand } from '../demand/demandService.js';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { recordEvent } from '../workflow/events.js';
import { closeInbox, openInbox } from '../workflow/inbox.js';
import { assertIsoWeek } from '../workflow/isoWeek.js';
import { assertVendorUsable } from '../workflow/masterData.js';
import { formatQty, fromDb, parseQty, type Milli } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import { takeQty, transitionSlice, type SliceCtx } from '../workflow/slices.js';
import { addThreadEntry } from '../workflow/threads.js';
import { updateWithRowVer, rowVerHex, type Db, type Tx } from '../workflow/tx.js';
import { supplierShortlist, type ShortLine } from './shortlist.js';

export const P_RFQ = { open: 'rfqs.open', manage: 'rfq.manage' } as const;
const link = (rfqId: string) => `/rfqs/${rfqId}`;

export type RfqRow = { RfqId: string; RfqNo: string; DemandId: string; CompanyCode: string; ManualStatus: 'DRAFT' | 'SENT' | 'CANCELLED'; RowVer: string };

/** Loads and locks the RFQ; 404 unless the actor works for its company. */
export async function lockRfq(tx: Tx, actor: Actor, rfqId: string): Promise<RfqRow> {
  const r = (await sql<RfqRow>`
    SELECT RfqId, RfqNo, DemandId, CompanyCode, ManualStatus, ${rowVerHex()} AS RowVer FROM scm.Rfq WITH (UPDLOCK, ROWLOCK) WHERE RfqId = ${rfqId}`.execute(tx)).rows[0];
  if (!r || !actor.companies.has(r.CompanyCode)) throw new NotFoundError(`RFQ ${rfqId}`);
  assertCan(actor, P_RFQ.manage, r.CompanyCode);
  return { ...r, RfqId: String(r.RfqId), DemandId: String(r.DemandId) };
}

async function assertReason(tx: Tx, code: string, context: string) {
  const r = await tx.selectFrom('scm.ReasonCode').select('ReasonCode').where('ReasonCode', '=', code).where('Context', '=', context).where('IsActive', '=', true).executeTakeFirst();
  if (!r) throw new DomainError('BAD_REASON', `Choose a reason for this action (${context})`);
}

/** Live quantity of an RFQ (for statuses and closing its My work item). */
export async function rfqLive(db: Db | Tx, rfqId: string): Promise<{ inRfq: Milli; quoted: Milli }> {
  const r = (await sql<{ i: string; q: string }>`
    SELECT ISNULL(SUM(CASE WHEN s.ExecState = 'IN_RFQ' THEN s.Qty END), 0) AS i, ISNULL(SUM(CASE WHEN s.ExecState = 'QUOTED' THEN s.Qty END), 0) AS q
    FROM scm.RfqLine l JOIN scm.QtySlice s ON s.RfqLineId = l.RfqLineId WHERE l.RfqId = ${rfqId}`.execute(db)).rows[0];
  return { inRfq: fromDb(r.i), quoted: fromDb(r.q) };
}

/** "Record quotes" stays on My work while a supplier has no quote and something is left to quote. */
export async function refreshQuoteTask(tx: Tx, rfq: RfqRow, actorId: number): Promise<void> {
  const live = await rfqLive(tx, rfq.RfqId);
  const waiting = (await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM scm.RfqSupplier s WHERE s.RfqId = ${rfq.RfqId}
      AND NOT EXISTS (SELECT 1 FROM scm.SupplierQuote q WHERE q.RfqId = s.RfqId AND q.SupplierCode = s.SupplierCode AND q.IsCurrent = 1)`.execute(tx)).rows[0].n;
  if (rfq.ManualStatus !== 'SENT' || live.inRfq + live.quoted === 0 || Number(waiting) === 0) await closeInbox(tx, 'RFQ_TO_QUOTE', 'RFQ', rfq.RfqId, actorId);
}

export type CreateRfqInput = {
  demandId: string;
  lines: { lineId: string; week: string; qty: string }[];
  weeks: { etdWeek: string; containerCount: number }[];
  suppliers: string[];
};

export async function createRfq(db: Db, actor: Actor, commandId: string, input: CreateRfqInput): Promise<{ rfqId: string; rfqNo: string }> {
  return runCommand(db, actor.id, commandId, 'rfq.create', async (tx) => {
    const d = await lockDemand(tx, actor, input.demandId);
    assertCan(actor, P_RFQ.manage, d.CompanyCode);
    if (d.WorkflowStatus !== 'ACCEPTED') throw new DomainError('BAD_STATE', `${d.DemandNo} is not accepted; only accepted demands can be sourced`, 409);
    if (!input.lines.length) throw new DomainError('NOTHING_TO_ASK', 'Choose at least one line');
    if (!input.suppliers.length) throw new DomainError('NO_SUPPLIER', 'Choose at least one supplier');

    const ids = [...new Set(input.lines.map((l) => l.lineId))];
    const lines = await tx.selectFrom('scm.DemandLine as l').innerJoin('scm.DemandWeek as w', 'w.DemandWeekId', 'l.DemandWeekId')
      .select(['l.LineId', 'l.MajorCategory', 'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.OriginCode', 'l.MaterialCode', 'l.Unit', 'w.EtdWeek'])
      .where('l.DemandId', '=', d.DemandId).where('l.LineId', 'in', ids).where('l.IsActive', '=', true).execute();
    if (lines.length !== ids.length) throw new NotFoundError('Demand line');
    const byId = new Map(lines.map((l) => [String(l.LineId), l]));

    // Suppliers: usable, and on the shortlist of at least one chosen origin (plan §4.4 rule 1).
    const shortLines: ShortLine[] = lines.map((l) => ({ lineId: String(l.LineId), majorCategory: l.MajorCategory, subMajorCategory: l.SubMajorCategory, size: l.Size, originCode: l.OriginCode, materialCode: l.MaterialCode, unit: l.Unit }));
    const shortlist = await supplierShortlist(tx, d.CompanyCode, shortLines);
    const suppliers = [...new Set(input.suppliers)];
    for (const s of suppliers) {
      await assertVendorUsable(tx, s, d.CompanyCode);
      if (!shortlist.some((g) => g.entries.some((e) => e.supplierCode === s))) {
        throw new DomainError('SUPPLIER_ORIGIN_MISMATCH', `Supplier ${s} cannot supply ${shortlist.map((g) => g.originCode).join(', ')}`);
      }
    }

    const settings = await loadWfSettings(tx);
    // One RFQ line per demand line × week; the same pair twice is added up.
    const asks = new Map<string, { lineId: string; week: string; qty: Milli }>();
    for (const l of input.lines) {
      const week = assertIsoWeek(l.week);
      const unit = byId.get(l.lineId)!.Unit;
      const qty = parseQty(l.qty, incrementFor(settings, unit));
      if (qty <= 0) throw new DomainError('BAD_QTY', 'Ask for a quantity above zero');
      const k = `${l.lineId}|${week}`;
      asks.set(k, { lineId: l.lineId, week, qty: (asks.get(k)?.qty ?? 0) + qty });
    }

    // Container defaults, from the week's live quantity before anything is taken.
    const weeks = [...new Set([...asks.values()].map((a) => a.week))].sort();
    const defaults = new Map<string, number>();
    for (const w of weeks) {
      const row = (await sql<{ c: number | null; live: string }>`
        SELECT MAX(dw.ContainerCount) AS c, ISNULL(SUM(CASE WHEN s.ExecState NOT IN ('CANCELLED', 'MERGED_OUT') THEN s.Qty END), 0) AS live
        FROM scm.DemandWeek dw LEFT JOIN scm.DemandLine l ON l.DemandWeekId = dw.DemandWeekId AND l.IsActive = 1 LEFT JOIN scm.QtySlice s ON s.LineId = l.LineId
        WHERE dw.DemandId = ${d.DemandId} AND dw.EtdWeek = ${w}`.execute(tx)).rows[0];
      const asked = [...asks.values()].filter((a) => a.week === w).reduce((s, a) => s + a.qty, 0);
      defaults.set(w, defaultRfqContainers(Number(row?.c ?? 0), asked, fromDb(row?.live ?? 0)));
    }

    const seq = (await sql<{ n: string }>`SELECT NEXT VALUE FOR scm.RfqNoSeq AS n`.execute(tx)).rows[0].n;
    const rfqNo = `RFQ-${String(seq).padStart(6, '0')}`;
    const rfqId = String((await tx.insertInto('scm.Rfq').values({
      RfqNo: rfqNo, DemandId: d.DemandId, CompanyCode: d.CompanyCode, CreatedBy: actor.id, SentBy: null, SentAt: null,
      CancelledBy: null, CancelledAt: null, CancelReason: null, CancelComment: null,
    }).output('inserted.RfqId').executeTakeFirstOrThrow()).RfqId);
    const ctx: SliceCtx = { actorUserId: actor.id, docType: 'RFQ', docId: rfqId };

    for (const s of suppliers) { // stores what the buyer saw when inviting (plan §4.4 rule 5)
      const seen = shortlist.flatMap((g) => g.entries.filter((e) => e.supplierCode === s).map((e) => ({ origin: g.originCode, rank: e.rank, hint: e.hint, origins: e.origins })));
      const ranks = seen.map((x) => x.rank).filter((r): r is number => r != null);
      await tx.insertInto('scm.RfqSupplier').values({
        RfqId: rfqId, SupplierCode: s, OriginsAtInvite: seen[0].origins.join(','), ShortlistRank: ranks.length ? Math.min(...ranks) : null,
        HintJson: JSON.stringify(Object.fromEntries(seen.map((x) => [x.origin, x.hint]))), InvitedBy: actor.id,
      }).execute();
    }
    for (const a of asks.values()) {
      const l = byId.get(a.lineId)!;
      const rl = String((await tx.insertInto('scm.RfqLine').values({
        RfqId: rfqId, DemandLineId: a.lineId, MajorCategory: l.MajorCategory, SubMajorCategory: l.SubMajorCategory, Size: l.Size, MaterialClass: l.MaterialClass,
        OriginCode: l.OriginCode, MaterialCode: l.MaterialCode, Unit: l.Unit, ProposedEtdWeek: a.week, AskedQty: a.qty,
      }).output('inserted.RfqLineId').executeTakeFirstOrThrow()).RfqLineId);
      // Open quantity is chosen by line AND approved week (plan §4 rule 2).
      for (const sliceId of await takeQty(tx, { lineId: a.lineId, qty: a.qty, states: ['OPEN'], where: sql`ApprovedEtdWeek = ${a.week}`, ctx })) {
        await transitionSlice(tx, sliceId, 'ADD_TO_RFQ', ctx, sql`RfqLineId = ${rl}`);
      }
    }
    for (const w of weeks) {
      const chosen = input.weeks.find((x) => x.etdWeek === w)?.containerCount;
      if (chosen != null && (!Number.isInteger(chosen) || chosen < 0)) throw new DomainError('BAD_CONTAINERS', `Containers for ${w} must be a whole number`);
      await tx.insertInto('scm.RfqWeek').values({ RfqId: rfqId, EtdWeek: w, ContainerCount: chosen ?? defaults.get(w)!, DefaultCount: defaults.get(w)! }).execute();
    }

    const eventId = await recordEvent(tx, { type: 'RFQ_CREATED', entityType: 'RFQ', entityId: rfqId, demandId: d.DemandId, payload: { rfqNo, lines: asks.size, suppliers: suppliers.length }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'RFQ', entityId: rfqId, kind: 'SYSTEM', body: `Created from ${d.DemandNo}: ${asks.size} line(s), ${suppliers.length} supplier(s)`, authorUserId: actor.id, eventId });
    await addThreadEntry(tx, { entityType: 'DEMAND', entityId: d.DemandId, kind: 'SYSTEM', body: `${rfqNo} created (${weeks.join(', ')})`, authorUserId: actor.id, eventId });
    for (const a of asks.values()) await closeInbox(tx, 'OPEN_QTY_AGING', 'LINE', a.lineId, actor.id);
    return { rfqId, rfqNo };
  });
}

export async function sendRfq(db: Db, actor: Actor, commandId: string, rfqId: string, rowVer: string): Promise<{ sent: true }> {
  return runCommand(db, actor.id, commandId, 'rfq.send', async (tx) => {
    const r = await lockRfq(tx, actor, rfqId);
    if (r.ManualStatus !== 'DRAFT') throw new DomainError('BAD_STATE', `${r.RfqNo} was already sent or cancelled`, 409);
    const live = await rfqLive(tx, rfqId);
    if (live.inRfq + live.quoted === 0) throw new DomainError('BAD_STATE', `${r.RfqNo} has nothing left to ask for`, 409);
    await updateWithRowVer(tx, 'scm.Rfq', 'RfqId', rfqId, rowVer, sql`ManualStatus = 'SENT', SentBy = ${actor.id}, SentAt = SYSUTCDATETIME()`);
    const d = await tx.selectFrom('scm.Demand').select('DemandNo').where('DemandId', '=', r.DemandId).executeTakeFirstOrThrow();
    const n = (await tx.selectFrom('scm.RfqSupplier').select((eb) => eb.fn.countAll<number>().as('n')).where('RfqId', '=', rfqId).executeTakeFirstOrThrow()).n;
    const eventId = await recordEvent(tx, { type: 'RFQ_SENT', entityType: 'RFQ', entityId: rfqId, demandId: r.DemandId, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'RFQ', entityId: rfqId, kind: 'SYSTEM', body: 'Sent to suppliers', authorUserId: actor.id, eventId });
    await openInbox(tx, {
      itemType: 'RFQ_TO_QUOTE', permission: P_RFQ.manage, companyCode: r.CompanyCode, entityType: 'RFQ', entityId: rfqId,
      number: r.RfqNo, title: `${d.DemandNo} · ${n} supplier(s)`, link: link(rfqId), raisedBy: actor.id,
    });
    return { sent: true as const };
  });
}

export async function releaseQty(db: Db, actor: Actor, commandId: string, rfqLineId: string, qty: string, reasonCode: string, comment: string) {
  return runCommand(db, actor.id, commandId, 'rfq.release', async (tx) => {
    const rl = await tx.selectFrom('scm.RfqLine').select(['RfqId', 'DemandLineId', 'Unit']).where('RfqLineId', '=', rfqLineId).executeTakeFirst();
    if (!rl || !rl.DemandLineId) throw new NotFoundError(`RFQ line ${rfqLineId}`);
    const r = await lockRfq(tx, actor, String(rl.RfqId));
    if (r.ManualStatus === 'CANCELLED') throw new DomainError('BAD_STATE', `${r.RfqNo} is cancelled`, 409);
    await assertReason(tx, reasonCode, 'RELEASE');
    const q = parseQty(qty, incrementFor(await loadWfSettings(tx), rl.Unit));
    const ctx: SliceCtx = { actorUserId: actor.id, reasonCode, docType: 'RFQ', docId: r.RfqId, comment };
    for (const sliceId of await takeQty(tx, { lineId: String(rl.DemandLineId), qty: q, states: ['QUOTED', 'IN_RFQ'], where: sql`RfqLineId = ${rfqLineId}`, ctx })) {
      await transitionSlice(tx, sliceId, 'RELEASE', ctx, sql`RfqLineId = NULL`);
    }
    const eventId = await recordEvent(tx, { type: 'RFQ_RELEASED', entityType: 'RFQ', entityId: r.RfqId, demandId: r.DemandId, payload: { rfqLineId, qty: formatQty(q), reasonCode }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'RFQ', entityId: r.RfqId, kind: 'SYSTEM', body: `Released ${formatQty(q)} ${rl.Unit} back to Open (${reasonCode})${comment ? ` — ${comment}` : ''}`, authorUserId: actor.id, eventId });
    await refreshQuoteTask(tx, r, actor.id);
    return { released: formatQty(q) };
  });
}

export async function cancelRfq(db: Db, actor: Actor, commandId: string, rfqId: string, rowVer: string, reasonCode: string, comment: string) {
  return runCommand(db, actor.id, commandId, 'rfq.cancel', async (tx) => {
    const r = await lockRfq(tx, actor, rfqId);
    if (r.ManualStatus === 'CANCELLED') throw new DomainError('BAD_STATE', `${r.RfqNo} is already cancelled`, 409);
    await assertReason(tx, reasonCode, 'RFQ_CANCEL');
    const busy = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM scm.RfqLine l JOIN scm.QtySlice s ON s.RfqLineId = l.RfqLineId
      WHERE l.RfqId = ${rfqId} AND s.ExecState IN ('AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED', 'PO_CREATED')`.execute(tx);
    if (Number(busy.rows[0].n) > 0) throw new DomainError('BAD_STATE', 'Part of this RFQ is awarded: un-award it first', 409);
    await updateWithRowVer(tx, 'scm.Rfq', 'RfqId', rfqId, rowVer,
      sql`ManualStatus = 'CANCELLED', CancelledBy = ${actor.id}, CancelledAt = SYSUTCDATETIME(), CancelReason = ${reasonCode}, CancelComment = ${comment}`);
    const ctx: SliceCtx = { actorUserId: actor.id, reasonCode, docType: 'RFQ', docId: rfqId, comment };
    const slices = await sql<{ SliceId: string }>`SELECT s.SliceId FROM scm.RfqLine l JOIN scm.QtySlice s WITH (UPDLOCK) ON s.RfqLineId = l.RfqLineId
      WHERE l.RfqId = ${rfqId} AND s.ExecState IN ('IN_RFQ', 'QUOTED') ORDER BY s.SliceId`.execute(tx);
    for (const s of slices.rows) await transitionSlice(tx, String(s.SliceId), 'RELEASE', ctx, sql`RfqLineId = NULL`);
    await closeInbox(tx, 'RFQ_TO_QUOTE', 'RFQ', rfqId, actor.id);
    const eventId = await recordEvent(tx, { type: 'RFQ_CANCELLED', entityType: 'RFQ', entityId: rfqId, demandId: r.DemandId, payload: { reasonCode }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'RFQ', entityId: rfqId, kind: 'SYSTEM', body: `Cancelled (${reasonCode})${comment ? ` — ${comment}` : ''}; all its quantity is Open again`, authorUserId: actor.id, eventId });
    await addThreadEntry(tx, { entityType: 'DEMAND', entityId: r.DemandId, kind: 'SYSTEM', body: `${r.RfqNo} cancelled; its quantity is Open again`, authorUserId: actor.id, eventId });
    return { cancelled: true as const };
  });
}
