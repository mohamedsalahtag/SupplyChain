/**
 * Merge and unmerge (spec 17, plan v5 §3). Merge moves the Open quantity and the
 * container groups of source weeks into the same weeks of the target; unmerge
 * puts them back. Quantity keeps its business origin, original line and clock.
 */
import { sql } from 'kysely';
import { lockDemand } from '../demand/demandService.js';
import { snapshotVersion } from '../demand/versions.js';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { queueNotification, recordEvent } from '../workflow/events.js';
import { fromDb } from '../workflow/qty.js';
import { createSlice, transitionSlice, type SliceCtx } from '../workflow/slices.js';
import { addThreadEntry } from '../workflow/threads.js';
import { updateWithRowVer, type Db, type Tx } from '../workflow/tx.js';
import { planMerge, unmergeBlockers } from './mergeCheck.js';

export const P_MERGE = { merge: 'demand.merge', unmerge: 'demand.unmerge' } as const;

/** Both demands locked in id order (no deadlock between two opposite merges). */
async function lockPair(tx: Tx, actor: Actor, a: string, b: string) {
  const [first, second] = Number(a) < Number(b) ? [a, b] : [b, a];
  const x = await lockDemand(tx, actor, first);
  const y = await lockDemand(tx, actor, second);
  return x.DemandId === String(a) ? [x, y] : [y, x];
}

async function weekIdOf(tx: Tx, demandId: string, etdWeek: string): Promise<string> {
  const w = await tx.selectFrom('scm.DemandWeek').select('DemandWeekId').where('DemandId', '=', demandId).where('EtdWeek', '=', etdWeek).executeTakeFirst();
  if (w) return String(w.DemandWeekId);
  return String((await tx.insertInto('scm.DemandWeek').values({ DemandId: demandId, EtdWeek: etdWeek, ContainerCount: 0 }).output('inserted.DemandWeekId').executeTakeFirstOrThrow()).DemandWeekId);
}

/** Adds `qty` to the target's line for the source line's key in that week (created when new; the unit is registered for the key). */
async function addToTargetLine(tx: Tx, targetId: string, weekId: string, srcLineId: string, qty: number): Promise<string> {
  const src = await tx.selectFrom('scm.DemandLine').selectAll().where('LineId', '=', srcLineId).executeTakeFirstOrThrow();
  const found = await tx.selectFrom('scm.DemandLine').select('LineId').where('DemandWeekId', '=', weekId).where('LineKey', '=', src.LineKey).where('IsActive', '=', true).executeTakeFirst();
  if (found) {
    await sql`UPDATE scm.DemandLine SET RequestedQty = RequestedQty + ${qty} WHERE LineId = ${found.LineId}`.execute(tx);
    return String(found.LineId);
  }
  const uom = await tx.selectFrom('scm.DemandKeyUom').select('Unit').where('DemandId', '=', targetId).where('LineKey', '=', src.LineKey).executeTakeFirst();
  if (uom && uom.Unit !== src.Unit) throw new DomainError('UOM_MISMATCH', `${src.SubMajorCategory} is ordered in ${uom.Unit} on the target, not ${src.Unit}`);
  if (!uom) await tx.insertInto('scm.DemandKeyUom').values({ DemandId: targetId, LineKey: src.LineKey, Unit: src.Unit }).execute();
  const next = await tx.selectFrom('scm.DemandLine').select((eb) => eb.fn.max('LineNumber').as('n')).where('DemandId', '=', targetId).executeTakeFirst();
  return String((await tx.insertInto('scm.DemandLine').values({
    DemandId: targetId, DemandWeekId: weekId, LineNumber: Number(next?.n ?? 0) + 1, SpecMode: src.SpecMode, MajorCategory: src.MajorCategory, SubMajorCategory: src.SubMajorCategory,
    Size: src.Size, MaterialClass: src.MaterialClass, OriginCode: src.OriginCode, MaterialCode: src.MaterialCode, Unit: src.Unit, RequestedQty: qty, ChangeHoldCrId: null,
  }).output('inserted.LineId').executeTakeFirstOrThrow()).LineId);
}

/** Copies a source group into the target week, labelled with the merge; the source group is kept inactive. */
async function moveGroup(tx: Tx, groupId: string, targetId: string, targetWeekId: string, mergeId: string): Promise<void> {
  const g = await tx.selectFrom('scm.ContainerGroup').selectAll().where('ContainerGroupId', '=', groupId).executeTakeFirstOrThrow();
  const next = await tx.selectFrom('scm.ContainerGroup').select((eb) => eb.fn.max('GroupNumber').as('n')).where('DemandWeekId', '=', targetWeekId).executeTakeFirst();
  const copy = String((await tx.insertInto('scm.ContainerGroup').values({
    DemandId: targetId, DemandWeekId: targetWeekId, GroupNumber: Number(next?.n ?? 0) + 1, Name: g.Name, ContainerCount: g.ContainerCount, CapacityQty: g.CapacityQty, Unit: g.Unit,
    MergedInBy: mergeId, SourceGroupId: groupId,
  }).output('inserted.ContainerGroupId').executeTakeFirstOrThrow()).ContainerGroupId);
  await sql`INSERT INTO scm.ContainerGroupItem (ContainerGroupId, SpecMode, MajorCategory, SubMajorCategory, Size, MaterialClass, OriginCode, MaterialCode, Unit, ShareBp, ComputedQty)
    SELECT ${copy}, SpecMode, MajorCategory, SubMajorCategory, Size, MaterialClass, OriginCode, MaterialCode, Unit, ShareBp, ComputedQty
    FROM scm.ContainerGroupItem WHERE ContainerGroupId = ${groupId}`.execute(tx);
  await tx.updateTable('scm.ContainerGroup').set({ IsActive: false, MergedOutBy: mergeId }).where('ContainerGroupId', '=', groupId).execute();
}

export type MergeInput = { targetDemandId: string; targetRowVer: string; sourceDemandId: string; weeks: string[] | 'ALL'; comment: string };

export async function executeMerge(db: Db, actor: Actor, commandId: string, input: MergeInput): Promise<{ mergeId: string; mergeNo: string }> {
  return runCommand(db, actor.id, commandId, 'demand.merge', async (tx) => {
    const [src, tgt] = await lockPair(tx, actor, input.sourceDemandId, input.targetDemandId);
    if (src.DemandId === tgt.DemandId) throw new DomainError('SAME_DEMAND', 'A demand cannot be merged into itself');
    assertCan(actor, P_MERGE.merge, tgt.CompanyCode);
    assertCan(actor, P_MERGE.merge, src.CompanyCode);
    if (src.CompanyCode !== tgt.CompanyCode) throw new DomainError('COMPANY_MISMATCH', `${src.DemandNo} and ${tgt.DemandNo} belong to different companies`);
    if (src.WorkflowStatus !== 'ACCEPTED' || tgt.WorkflowStatus !== 'ACCEPTED') throw new DomainError('BAD_STATE', 'Both demands must be accepted', 409);
    await updateWithRowVer(tx, 'scm.Demand', 'DemandId', tgt.DemandId, input.targetRowVer, sql`Notes = Notes`); // the user saw the current target

    const plan = await planMerge(tx, src.DemandId, tgt.DemandId);
    const unknown = input.weeks === 'ALL' ? [] : input.weeks.filter((w) => !plan.some((p) => p.etdWeek === w));
    if (unknown.length) throw new DomainError('NOT_MERGEABLE', `Nothing to merge in ${unknown.join(', ')}`, 422, { problems: unknown.map((w) => `${w}: nothing Open to merge`) });
    const weeks = input.weeks === 'ALL' ? plan : plan.filter((p) => (input.weeks as string[]).includes(p.etdWeek));
    if (!weeks.length) throw new DomainError('NOTHING_TO_MERGE', 'Choose at least one week');
    const problems = weeks.flatMap((w) => w.blockers.map((b) => `${w.etdWeek}: ${b}`));
    if (problems.length) throw new DomainError('NOT_MERGEABLE', 'The merge is blocked', 422, { problems });

    const seq = (await sql<{ n: string }>`SELECT NEXT VALUE FOR scm.MergeNoSeq AS n`.execute(tx)).rows[0].n;
    const mergeNo = `MG-${String(seq).padStart(6, '0')}`;
    const mergeId = String((await tx.insertInto('scm.MergeRecord').values({
      MergeNo: mergeNo, SourceDemandId: src.DemandId, TargetDemandId: tgt.DemandId, CompanyCode: tgt.CompanyCode,
      Scope: input.weeks === 'ALL' ? 'DEMAND' : 'WEEKS', Comment: input.comment.trim(), ExecutedBy: actor.id, UnmergedBy: null, UnmergedAt: null, UnmergeReason: null,
    }).output('inserted.MergeId').executeTakeFirstOrThrow()).MergeId);
    const ctx: SliceCtx = { actorUserId: actor.id, docType: 'MERGE', docId: mergeId };

    for (const w of weeks) {
      const targetWeekId = await weekIdOf(tx, tgt.DemandId, w.etdWeek);
      await sql`UPDATE scm.DemandWeek SET ContainerCount = ContainerCount + ${w.containers} WHERE DemandWeekId = ${targetWeekId}`.execute(tx);
      await tx.updateTable('scm.DemandWeek').set({ ContainerCount: 0 }).where('DemandWeekId', '=', w.weekId).execute();
      await tx.insertInto('scm.MergeWeek').values({ MergeId: mergeId, SourceWeekId: w.weekId, TargetWeekId: targetWeekId, ContainersMoved: w.containers }).execute();
      for (const g of w.groups) await moveGroup(tx, g.groupId, tgt.DemandId, targetWeekId, mergeId);

      const open = (await sql<{ SliceId: string; LineId: string; Qty: string; BusinessOrigin: 'SALES' | 'PROCUREMENT' | 'CHANGE'; OriginDemandId: string; OriginLineId: string; ApprovedEtdWeek: string; EffectiveSubmittedAt: Date }>`
        SELECT s.SliceId, s.LineId, s.Qty, s.BusinessOrigin, s.OriginDemandId, s.OriginLineId, s.ApprovedEtdWeek, s.EffectiveSubmittedAt
        FROM scm.QtySlice s WITH (UPDLOCK) JOIN scm.DemandLine l ON l.LineId = s.LineId
        WHERE l.DemandWeekId = ${w.weekId} AND l.IsActive = 1 AND s.ExecState = 'OPEN' ORDER BY s.SliceId`.execute(tx)).rows;
      for (const s of open) {
        const qty = fromDb(s.Qty);
        const lineId = await addToTargetLine(tx, tgt.DemandId, targetWeekId, String(s.LineId), qty);
        const newSlice = await createSlice(tx, {
          lineId, qty, businessOrigin: s.BusinessOrigin, arrivedVia: 'MERGE', originDemandId: String(s.OriginDemandId), originLineId: String(s.OriginLineId),
          approvedWeek: s.ApprovedEtdWeek, clock: s.EffectiveSubmittedAt, mergedFrom: String(s.SliceId), mergedInBy: mergeId,
        }, { ...ctx, comment: `Merged in from ${src.DemandNo}` });
        await transitionSlice(tx, String(s.SliceId), 'MERGE_OUT', { ...ctx, comment: `Merged into ${tgt.DemandNo}` }, sql`MergedToSliceId = ${newSlice}, MergedOutBy = ${mergeId}`);
        await tx.insertInto('scm.MergeItem').values({ MergeId: mergeId, SourceSliceId: String(s.SliceId), TargetSliceId: newSlice, SourceLineId: String(s.LineId), TargetLineId: lineId, Qty: qty }).execute();
      }
    }

    await snapshotVersion(tx, src.DemandId, 'MERGE_OUT', mergeNo, actor.id);
    await snapshotVersion(tx, tgt.DemandId, 'MERGE_IN', mergeNo, actor.id);
    const list = weeks.map((w) => w.etdWeek).join(', ');
    const eventId = await recordEvent(tx, { type: 'MERGE_EXECUTED', entityType: 'MERGE', entityId: mergeId, demandId: tgt.DemandId, payload: { source: src.DemandNo, target: tgt.DemandNo, weeks: list }, actorUserId: actor.id });
    for (const d of [src, tgt]) {
      await addThreadEntry(tx, { entityType: 'DEMAND', entityId: d.DemandId, kind: 'SYSTEM', eventId, authorUserId: actor.id,
        body: `${mergeNo}: ${list} merged from ${src.DemandNo} into ${tgt.DemandNo}${input.comment.trim() ? ` — ${input.comment.trim()}` : ''}` });
      await queueNotification(tx, { type: 'MERGE_EXECUTED', userId: Number(d.CreatedBy), entityType: 'MERGE', entityId: mergeId });
    }
    return { mergeId, mergeNo };
  });
}

export async function unmerge(db: Db, actor: Actor, commandId: string, mergeId: string, rowVer: string, reason: string): Promise<{ unmerged: true }> {
  if (!reason.trim()) throw new DomainError('COMMENT_REQUIRED', 'A reason is required to undo a merge');
  return runCommand(db, actor.id, commandId, 'demand.unmerge', async (tx) => {
    const m = await tx.selectFrom('scm.MergeRecord').select(['MergeId', 'MergeNo', 'SourceDemandId', 'TargetDemandId', 'CompanyCode', 'Status']).where('MergeId', '=', mergeId).executeTakeFirst();
    if (!m || !actor.companies.has(m.CompanyCode)) throw new NotFoundError(`Merge ${mergeId}`);
    assertCan(actor, P_MERGE.unmerge, m.CompanyCode);
    const [src, tgt] = await lockPair(tx, actor, String(m.SourceDemandId), String(m.TargetDemandId));
    if (m.Status !== 'EXECUTED') throw new DomainError('BAD_STATE', `${m.MergeNo} was already undone`, 409);
    await updateWithRowVer(tx, 'scm.MergeRecord', 'MergeId', mergeId, rowVer,
      sql`Status = 'UNMERGED', UnmergedBy = ${actor.id}, UnmergedAt = SYSUTCDATETIME(), UnmergeReason = ${reason.trim()}`);
    const problems = await unmergeBlockers(tx, mergeId);
    if (problems.length) throw new DomainError('UNMERGE_BLOCKED', `${m.MergeNo} cannot be undone now`, 422, { problems });

    const ctx: SliceCtx = { actorUserId: actor.id, docType: 'MERGE', docId: mergeId, reasonCode: 'UNMERGE', comment: reason.trim() };
    // Merged-in quantity (and anything split from it) becomes neutral; the source quantity is Open again.
    const cands = await tx.selectFrom('scm.QtySlice').select(['SliceId', 'ExecState']).where('MergedInBy', '=', mergeId).where('ExecState', 'in', ['OPEN', 'IN_RFQ', 'QUOTED']).orderBy('SliceId').execute();
    for (const s of cands) {
      if (s.ExecState !== 'OPEN') await transitionSlice(tx, String(s.SliceId), 'RELEASE', ctx, sql`RfqLineId = NULL`); // out of its RFQ first
      await transitionSlice(tx, String(s.SliceId), 'MERGE_OUT', ctx, sql`MergedOutBy = ${mergeId}`);
    }
    const sources = await tx.selectFrom('scm.MergeItem').select('SourceSliceId').where('MergeId', '=', mergeId).execute();
    for (const s of sources) await transitionSlice(tx, String(s.SourceSliceId), 'UNMERGE_RESTORE', ctx, sql`MergedToSliceId = NULL, MergedOutBy = NULL`);
    for (const w of await tx.selectFrom('scm.MergeWeek').selectAll().where('MergeId', '=', mergeId).execute()) {
      await sql`UPDATE scm.DemandWeek SET ContainerCount = ContainerCount - ${w.ContainersMoved} WHERE DemandWeekId = ${w.TargetWeekId}`.execute(tx);
      await sql`UPDATE scm.DemandWeek SET ContainerCount = ContainerCount + ${w.ContainersMoved} WHERE DemandWeekId = ${w.SourceWeekId}`.execute(tx);
    }
    await tx.updateTable('scm.ContainerGroup').set({ IsActive: false }).where('MergedInBy', '=', mergeId).execute();
    await tx.updateTable('scm.ContainerGroup').set({ IsActive: true, MergedOutBy: null }).where('MergedOutBy', '=', mergeId).execute();

    await snapshotVersion(tx, src.DemandId, 'UNMERGE', m.MergeNo, actor.id);
    await snapshotVersion(tx, tgt.DemandId, 'UNMERGE', m.MergeNo, actor.id);
    const eventId = await recordEvent(tx, { type: 'MERGE_UNDONE', entityType: 'MERGE', entityId: mergeId, demandId: tgt.DemandId, payload: { reason: reason.trim() }, actorUserId: actor.id });
    for (const d of [src, tgt]) {
      await addThreadEntry(tx, { entityType: 'DEMAND', entityId: d.DemandId, kind: 'SYSTEM', eventId, authorUserId: actor.id,
        body: `${m.MergeNo} undone: ${src.DemandNo}'s quantity and containers are back on ${src.DemandNo} — ${reason.trim()}` });
      await queueNotification(tx, { type: 'MERGE_UNDONE', userId: Number(d.CreatedBy), entityType: 'MERGE', entityId: mergeId });
    }
    return { unmerged: true as const };
  });
}
