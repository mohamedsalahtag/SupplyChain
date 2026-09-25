/**
 * Deciding a change request and applying it (spec 14, plan v5 §2 rules 6–11).
 * The decision covers every item exactly once; approved items are applied in
 * the same transaction, all or nothing. The only accepted shortfall: quantity
 * that moved beyond cancellable (PO submitted) while the request waited.
 */
import { sql } from 'kysely';
import { composeGroup } from '../demand/compose.js';
import { incrementFor } from '../demand/content.js';
import { snapshotVersion } from '../demand/versions.js';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { queueNotification, recordEvent } from '../workflow/events.js';
import { closeInbox } from '../workflow/inbox.js';
import { formatQty, fromDb, parseQty, type Milli } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import { createSlice, takeQty, transitionSlice, type SliceCtx } from '../workflow/slices.js';
import type { SliceState } from '../../db/schema.js';
import { addThreadEntry } from '../workflow/threads.js';
import { updateWithRowVer, type Db, type Tx } from '../workflow/tx.js';
import { decidePermission, releaseHolds } from './crService.js';
import { effectOf, finalAfter, type DiffItem, type Effect, type GroupState } from './diff.js';
import { applyProcItem, PROC_KINDS, QTY_PARTIAL_KINDS, undoProcItem } from './procApply.js';
import { onAwardedCancelled } from '../award/awardService.js';
import { autoReturnForLine } from '../handoff/handoffService.js';

/** Least-progressed first (plan v5 §2 rule 9). PO submitted / created are never cancelled. */
export const CANCEL_ORDER: SliceState[] = ['OPEN', 'IN_RFQ', 'QUOTED', 'AWARDED', 'HANDED_OFF', 'PO_PREPARATION'];

export type ItemDecision = { crItemId: string; decision: 'APPROVE' | 'PARTIAL' | 'REJECT'; approvedCount?: number; approvedQty?: string };

type CrRow = { CrId: string; CrNo: string; DemandId: string; CompanyCode: string; CrType: string; RaisedByDept: 'SALES' | 'PROCUREMENT'; Status: string; RaisedBy: number; ReasonCode: string };
type ItemRow = { CrItemId: string; ItemNo: number; ItemKind: string; EtdWeek: string; ContainerGroupId: string | null; LineId: string | null; BeforeJson: string | null; AfterJson: string | null; EffectJson: string; RequestedCount: number | null; RequestedQty: string | null };

/** Cancels up to `qty` of a line, least-progressed first. Returns what was actually cancelled. */
async function cancelLineQty(tx: Tx, cr: CrRow, lineId: string, qty: Milli, origin: 'SALES' | 'PROCUREMENT', actorUserId: number, states: SliceState[]): Promise<Milli> {
  // Spec 22: if the cancellation reaches handed-off or accepted quantity, those handoffs come back first (automatically).
  if (states.includes('HANDED_OFF') || states.includes('PO_PREPARATION')) {
    const before = states.filter((s) => s !== 'HANDED_OFF' && s !== 'PO_PREPARATION');
    const free = fromDb((await sql<{ a: string }>`SELECT ISNULL(SUM(Qty), 0) AS a FROM scm.QtySlice WHERE LineId = ${lineId} AND ExecState IN (${sql.join(before)})`.execute(tx)).rows[0].a);
    if (qty > free) await autoReturnForLine(tx, lineId, cr.CrId, cr.CrNo, actorUserId);
  }
  const available = fromDb((await sql<{ a: string }>`
    SELECT ISNULL(SUM(Qty), 0) AS a FROM scm.QtySlice WITH (UPDLOCK) WHERE LineId = ${lineId} AND ExecState IN (${sql.join(states)})`.execute(tx)).rows[0].a);
  const take = Math.min(qty, available);
  if (take === 0) return 0;
  const ctx: SliceCtx = { actorUserId, reasonCode: cr.ReasonCode, docType: 'CR', docId: cr.CrId };
  const awarded: { awardItemId: string; qty: Milli }[] = [];
  for (const sliceId of await takeQty(tx, { lineId, qty: take, states, ctx })) {
    const s = await tx.selectFrom('scm.QtySlice').select(['AwardItemId', 'Qty', 'ExecState']).where('SliceId', '=', sliceId).executeTakeFirstOrThrow();
    await transitionSlice(tx, sliceId, 'CR_CANCEL', ctx, sql`CancelOrigin = ${origin}, CancelCrId = ${cr.CrId}`);
    if (s.AwardItemId) awarded.push({ awardItemId: String(s.AwardItemId), qty: fromDb(s.Qty) });
  }
  if (awarded.length) await onAwardedCancelled(tx, awarded, cr.CrId, cr.CrNo, actorUserId); // spec 20: the award shrinks, the supplier is told
  return take;
}

export async function weekId(tx: Tx, demandId: string, etdWeek: string): Promise<string> {
  const w = await tx.selectFrom('scm.DemandWeek').select('DemandWeekId').where('DemandId', '=', demandId).where('EtdWeek', '=', etdWeek).executeTakeFirst();
  if (w) return String(w.DemandWeekId);
  const created = await tx.insertInto('scm.DemandWeek').values({ DemandId: demandId, EtdWeek: etdWeek, ContainerCount: 0 }).output('inserted.DemandWeekId').executeTakeFirstOrThrow();
  return String(created.DemandWeekId);
}

/** Adds quantity to the week's line for this key (creating the line when new): a new Open slice with its own clock and business origin. */
export async function addQty(tx: Tx, cr: Pick<CrRow, 'CrId' | 'CrNo' | 'DemandId'>, etdWeek: string, e: Effect, qty: Milli, actorUserId: number,
  origin: 'SALES' | 'PROCUREMENT' | 'CHANGE' = 'SALES'): Promise<{ lineId: string; sliceId: string }> {
  const wId = await weekId(tx, cr.DemandId, etdWeek);
  let line = await tx.selectFrom('scm.DemandLine').select('LineId').where('DemandWeekId', '=', wId).where('LineKey', '=', e.key).where('IsActive', '=', true).executeTakeFirst();
  if (!line) {
    const uom = await tx.selectFrom('scm.DemandKeyUom').select('Unit').where('DemandId', '=', cr.DemandId).where('LineKey', '=', e.key).executeTakeFirst();
    if (uom && uom.Unit !== e.unit) throw new DomainError('UOM_MISMATCH', `${e.subMajorCategory} is ordered in ${uom.Unit} on this demand, not ${e.unit}`);
    if (!uom) await tx.insertInto('scm.DemandKeyUom').values({ DemandId: cr.DemandId, LineKey: e.key, Unit: e.unit }).execute();
    const next = await tx.selectFrom('scm.DemandLine').select((eb) => eb.fn.max('LineNumber').as('n')).where('DemandId', '=', cr.DemandId).executeTakeFirst();
    line = await tx.insertInto('scm.DemandLine').values({
      DemandId: cr.DemandId, DemandWeekId: wId, LineNumber: Number(next?.n ?? 0) + 1, SpecMode: e.materialCode ? 'SKU' : 'SPEC', MajorCategory: e.majorCategory,
      SubMajorCategory: e.subMajorCategory, Size: e.size, MaterialClass: e.materialClass, OriginCode: e.originCode, MaterialCode: e.materialCode, Unit: e.unit,
      RequestedQty: qty, ChangeHoldCrId: null,
    }).output('inserted.LineId').executeTakeFirstOrThrow();
  } else {
    await sql`UPDATE scm.DemandLine SET RequestedQty = RequestedQty + ${qty} WHERE LineId = ${line.LineId}`.execute(tx);
  }
  const lineId = String(line.LineId);
  const sliceId = await createSlice(tx, { lineId, qty, businessOrigin: origin, originDemandId: cr.DemandId, originLineId: lineId, approvedWeek: etdWeek, clock: new Date() },
    { actorUserId, docType: 'CR', docId: cr.CrId, comment: `Added by ${cr.CrNo}` });
  return { lineId, sliceId };
}

/** Writes a group as it ends up (a replaced group is kept inactive for history). */
async function writeGroup(tx: Tx, demandId: string, g: GroupState, increment: (u: string) => Milli): Promise<void> {
  const wId = await weekId(tx, demandId, g.etdWeek);
  const next = await tx.selectFrom('scm.ContainerGroup').select((eb) => eb.fn.max('GroupNumber').as('n')).where('DemandWeekId', '=', wId).executeTakeFirst();
  const grp = await tx.insertInto('scm.ContainerGroup')
    .values({ DemandId: demandId, DemandWeekId: wId, GroupNumber: Number(next?.n ?? 0) + 1, Name: g.name, ContainerCount: g.containerCount, CapacityQty: g.capacity, Unit: g.unit })
    .output('inserted.ContainerGroupId').executeTakeFirstOrThrow();
  const qty = composeGroup({ containerCount: g.containerCount, capacity: g.capacity, increment: increment(g.unit), sharesBp: g.items.map((i) => i.shareBp) });
  for (const [n, i] of g.items.entries()) {
    await tx.insertInto('scm.ContainerGroupItem').values({
      ContainerGroupId: String(grp.ContainerGroupId), SpecMode: i.materialCode ? 'SKU' : 'SPEC', MajorCategory: i.majorCategory, SubMajorCategory: i.subMajorCategory,
      Size: i.size, MaterialClass: i.materialClass, OriginCode: i.originCode, MaterialCode: i.materialCode, Unit: g.unit, ShareBp: i.shareBp, ComputedQty: qty[n],
    }).execute();
  }
}

export const adjustWeek = (tx: Tx, demandId: string, etdWeek: string, delta: number) =>
  sql`UPDATE scm.DemandWeek SET ContainerCount = CASE WHEN ContainerCount + ${delta} < 0 THEN 0 ELSE ContainerCount + ${delta} END
      WHERE DemandId = ${demandId} AND EtdWeek = ${etdWeek}`.execute(tx);

/** Applies one approved container item. Returns the shortfall message, if any. */
async function applyContainerItem(tx: Tx, cr: CrRow, it: ItemRow, d: ItemDecision, actorUserId: number, increment: (u: string) => Milli): Promise<{ applied: Milli; message: string | null }> {
  const before = it.BeforeJson ? (JSON.parse(it.BeforeJson) as GroupState) : null;
  const diff = { kind: it.ItemKind, etdWeek: it.EtdWeek, groupId: it.ContainerGroupId, before, after: it.AfterJson ? (JSON.parse(it.AfterJson) as GroupState) : null } as DiffItem;
  const after = finalAfter(diff, d.decision === 'PARTIAL' ? (d.approvedCount ?? 0) : null);
  const effect = effectOf(before, after && after.containerCount > 0 ? after : null, increment);

  let applied = 0;
  const short: string[] = [];
  for (const e of effect.filter((x) => x.delta < 0)) {
    const line = await tx.selectFrom('scm.DemandLine as l').innerJoin('scm.DemandWeek as w', 'w.DemandWeekId', 'l.DemandWeekId')
      .select('l.LineId').where('l.DemandId', '=', cr.DemandId).where('w.EtdWeek', '=', it.EtdWeek).where('l.LineKey', '=', e.key).where('l.IsActive', '=', true).executeTakeFirst();
    const want = -e.delta;
    const got = line ? await cancelLineQty(tx, cr, String(line.LineId), want, 'SALES', actorUserId, CANCEL_ORDER) : 0;
    applied += got;
    if (got < want) short.push(`${e.subMajorCategory} ${e.size}: only ${formatQty(got)} of ${formatQty(want)} was still cancellable`);
  }
  for (const e of effect.filter((x) => x.delta > 0)) {
    await addQty(tx, cr, it.EtdWeek, e, e.delta, actorUserId);
    applied += e.delta;
  }
  // The containers: the old group is kept inactive; the result (if any) is written as the current group.
  if (it.ContainerGroupId) await tx.updateTable('scm.ContainerGroup').set({ IsActive: false }).where('ContainerGroupId', '=', it.ContainerGroupId).execute();
  if (after && after.containerCount > 0) await writeGroup(tx, cr.DemandId, after, increment);
  await adjustWeek(tx, cr.DemandId, it.EtdWeek, (after?.containerCount ?? 0) - (before?.containerCount ?? 0));
  return { applied, message: short.length ? short.join('; ') : null };
}

function normalizeDecision(it: ItemRow, d: ItemDecision): ItemDecision {
  if (d.decision === 'PARTIAL') {
    if (it.ItemKind === 'WEEK_SHIFT') throw new DomainError('BAD_DECISION', `Item ${it.ItemNo}: a week shift is approved or rejected, not partly`);
    if (it.ItemKind === 'ADD_CONTAINERS') {
      const n = d.approvedCount ?? -1;
      if (!Number.isInteger(n) || n < 1 || n >= (it.RequestedCount ?? 0)) throw new DomainError('BAD_DECISION', `Item ${it.ItemNo}: approve between 1 and ${(it.RequestedCount ?? 0) - 1} extra containers, or approve it fully`);
      return d;
    }
    if (it.ItemKind === 'QTY_NOT_SOURCED' || QTY_PARTIAL_KINDS.includes(it.ItemKind)) {
      const q = parseQty(d.approvedQty ?? '', 1000);
      if (q >= fromDb(it.RequestedQty)) throw new DomainError('BAD_DECISION', `Item ${it.ItemNo}: approve less than requested, or approve it fully`);
      return d;
    }
    const before = it.BeforeJson ? (JSON.parse(it.BeforeJson) as GroupState).containerCount : 0;
    const requested = it.RequestedCount ?? 0;
    const n = d.approvedCount ?? -1;
    const adds = it.ItemKind === 'GROUP_ADD' || (it.ItemKind === 'GROUP_COUNT' && requested > before);
    if (!adds || !Number.isInteger(n) || n <= before || n >= requested) {
      throw new DomainError('BAD_DECISION', `Item ${it.ItemNo}: fewer containers can only be approved for extra containers (between ${before + 1} and ${requested - 1})`);
    }
  }
  return d;
}

export async function decideCr(db: Db, actor: Actor, commandId: string, crId: string, rowVer: string, decisions: ItemDecision[], decisionComment: string) {
  if (!decisionComment.trim()) throw new DomainError('COMMENT_REQUIRED', 'A decision comment is required');
  return runCommand(db, actor.id, commandId, 'cr.decide', async (tx) => {
    const cr = (await sql<CrRow>`SELECT CrId, CrNo, DemandId, CompanyCode, CrType, RaisedByDept, Status, RaisedBy, ReasonCode FROM scm.ChangeRequest WITH (UPDLOCK) WHERE CrId = ${crId}`.execute(tx)).rows[0];
    if (!cr || !actor.companies.has(cr.CompanyCode)) throw new NotFoundError(`Change request ${crId}`);
    cr.CrId = String(cr.CrId);
    cr.DemandId = String(cr.DemandId);
    assertCan(actor, decidePermission(cr.RaisedByDept), cr.CompanyCode);
    if (Number(cr.RaisedBy) === actor.id) throw new DomainError('SELF_DECISION', 'You cannot decide a change request you raised', 403);
    if (cr.Status !== 'SUBMITTED') throw new DomainError('BAD_STATE', `${cr.CrNo} is ${cr.Status.toLowerCase()}; it cannot be decided`, 409);

    const items = (await tx.selectFrom('scm.ChangeRequestItem').selectAll().where('CrId', '=', crId).orderBy('ItemNo').execute())
      .map((i) => ({ ...i, CrItemId: String(i.CrItemId), ContainerGroupId: i.ContainerGroupId ? String(i.ContainerGroupId) : null, LineId: i.LineId ? String(i.LineId) : null, RequestedQty: i.RequestedQty == null ? null : String(i.RequestedQty) })) as ItemRow[];
    const ids = decisions.map((d) => d.crItemId);
    if (new Set(ids).size !== ids.length || ids.length !== items.length || !items.every((i) => ids.includes(i.CrItemId))) {
      throw new DomainError('BAD_DECISION', 'Decide every item of this change request exactly once');
    }
    const byId = new Map(decisions.map((d) => [d.crItemId, d]));
    items.forEach((i) => normalizeDecision(i, byId.get(i.CrItemId)!));
    const kinds = decisions.map((d) => d.decision);
    const status = kinds.every((k) => k === 'REJECT') ? 'REJECTED' : kinds.every((k) => k === 'APPROVE') ? 'APPROVED' : 'PARTIALLY_APPROVED';
    await updateWithRowVer(tx, 'scm.ChangeRequest', 'CrId', crId, rowVer,
      sql`Status = ${status}, DecidedBy = ${actor.id}, DecidedAt = SYSUTCDATETIME(), DecisionComment = ${decisionComment.trim()}`);

    // Apply: reductions before additions (items are stored in that order), all in this transaction.
    const settings = await loadWfSettings(tx);
    const increment = (u: string) => incrementFor(settings, u);
    let partial = false;
    for (const it of items) {
      const d = byId.get(it.CrItemId)!;
      let applied: Milli | null = null;
      let message: string | null = null;
      if (d.decision !== 'REJECT') {
        if (it.ItemKind === 'QTY_NOT_SOURCED') {
          const want = d.decision === 'PARTIAL' ? parseQty(d.approvedQty!, 1000) : fromDb(it.RequestedQty);
          applied = await cancelLineQty(tx, cr, it.LineId!, want, 'PROCUREMENT', actor.id, ['OPEN']);
          if (applied < want) message = `Only ${formatQty(applied)} of ${formatQty(want)} was still Open`;
        } else if (PROC_KINDS.includes(it.ItemKind)) {
          ({ applied, message } = await applyProcItem(tx, cr, it, d, actor.id));
        } else if (it.ItemKind === 'WEEK_CONTAINERS') {
          await tx.updateTable('scm.DemandWeek').set({ ContainerCount: it.RequestedCount ?? 0 }).where('DemandId', '=', cr.DemandId).where('EtdWeek', '=', it.EtdWeek).execute();
        } else {
          ({ applied, message } = await applyContainerItem(tx, cr, it, d, actor.id, increment));
        }
      }
      else if (PROC_KINDS.includes(it.ItemKind)) await undoProcItem(tx, it); // rejected: the proposal leaves no trace
      if (message) partial = true;
      await tx.updateTable('scm.ChangeRequestItem').set({
        Decision: d.decision, ApprovedCount: d.decision === 'PARTIAL' ? (d.approvedCount ?? null) : null,
        ApprovedQty: d.decision === 'PARTIAL' && d.approvedQty ? parseQty(d.approvedQty, 1000) : null, AppliedQty: applied, ApplyMessage: message,
      }).where('CrItemId', '=', it.CrItemId).execute();
    }
    if (status !== 'REJECTED') {
      await snapshotVersion(tx, cr.DemandId, 'CR_APPLIED', cr.CrNo, actor.id);
      await tx.updateTable('scm.ChangeRequest').set({ ApplyStatus: partial ? 'PARTIALLY_APPLIED' : 'APPLIED', AppliedAt: sql<Date>`SYSUTCDATETIME()` }).where('CrId', '=', crId).execute();
    }
    await releaseHolds(tx, crId);
    await closeInbox(tx, 'CR_TO_DECIDE', 'CR', crId, actor.id);
    const eventId = await recordEvent(tx, { type: 'CR_DECIDED', entityType: 'CR', entityId: crId, demandId: cr.DemandId, payload: { status, partial }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'CR', entityId: crId, kind: 'DECISION', body: `${status.replace('_', ' ').toLowerCase()}: ${decisionComment.trim()}`, authorUserId: actor.id, eventId });
    await addThreadEntry(tx, { entityType: 'DEMAND', entityId: cr.DemandId, kind: 'SYSTEM', body: `${cr.CrNo} ${status.replace('_', ' ').toLowerCase()}${partial ? ' (partially applied)' : ''}`, authorUserId: actor.id, eventId });
    await queueNotification(tx, { type: 'CR_DECIDED', userId: Number(cr.RaisedBy), entityType: 'CR', entityId: crId, payload: { status } });
    return { status, applyStatus: status === 'REJECTED' ? 'NOT_REQUIRED' : partial ? 'PARTIALLY_APPLIED' : 'APPLIED' };
  });
}
