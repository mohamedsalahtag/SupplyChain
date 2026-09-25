/**
 * What a merge would move and what blocks it (spec 17, plan v5 §3 rules 1–3).
 * Used read-only by the wizard and again, under locks, by the merge itself.
 */
import { sql } from 'kysely';
import { IN_PROGRESS_STATES } from '../workflow/ledger.js';
import { formatQty, fromDb, type Milli } from '../workflow/qty.js';
import type { Db, Tx } from '../workflow/tx.js';

export const qtyText = (q: Milli, unit: string) => `${Number(formatQty(q)).toLocaleString('en-GB')} ${unit}`;

type LineRow = {
  LineId: string; DemandWeekId: string; LineKey: string; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string;
  MaterialCode: string | null; Unit: string; ChangeHoldCrId: string | null; OpenQty: string; BusyQty: string;
};
export const lineLabel = (l: Pick<LineRow, 'SubMajorCategory' | 'Size' | 'MaterialClass' | 'OriginCode' | 'MaterialCode'>) =>
  [l.SubMajorCategory, l.Size || 'any size', l.MaterialClass || 'any class', l.OriginCode, l.MaterialCode].filter(Boolean).join(' ');

export type PlanLine = { key: string; label: string; unit: string; open: Milli; targetNow: Milli; newLine: boolean };
export type PlanGroup = { groupId: string; name: string; containerCount: number; capacity: string; unit: string };
export type PlanWeek = {
  weekId: string; etdWeek: string; containers: number; targetContainers: number; targetWeekExists: boolean;
  groups: PlanGroup[]; lines: PlanLine[]; blockers: string[];
};

/** Lines of a demand with their Open and in-progress quantity. */
async function linesOf(db: Db | Tx, demandId: string): Promise<LineRow[]> {
  const busy = sql.join(IN_PROGRESS_STATES);
  return (await sql<LineRow>`
    SELECT l.LineId, l.DemandWeekId, l.LineKey, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, l.Unit, l.ChangeHoldCrId,
      ISNULL(SUM(CASE WHEN s.ExecState = 'OPEN' THEN s.Qty END), 0) AS OpenQty,
      ISNULL(SUM(CASE WHEN s.ExecState IN (${busy}) THEN s.Qty END), 0) AS BusyQty
    FROM scm.DemandLine l LEFT JOIN scm.QtySlice s ON s.LineId = l.LineId
    WHERE l.DemandId = ${demandId} AND l.IsActive = 1
    GROUP BY l.LineId, l.DemandWeekId, l.LineKey, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, l.Unit, l.ChangeHoldCrId`.execute(db)).rows;
}

const crNos = async (db: Db | Tx, ids: string[]) =>
  ids.length ? new Map((await db.selectFrom('scm.ChangeRequest').select(['CrId', 'CrNo']).where('CrId', 'in', ids).execute()).map((c) => [String(c.CrId), c.CrNo])) : new Map<string, string>();

/** Every source week that still has Open quantity, what it would add to the target, and what blocks it. */
export async function planMerge(db: Db | Tx, sourceId: string, targetId: string): Promise<PlanWeek[]> {
  const [srcWeeks, tgtWeeks, srcLines, tgtLines, groups, weekHolds, keyUoms] = await Promise.all([
    db.selectFrom('scm.DemandWeek').select(['DemandWeekId', 'EtdWeek', 'ContainerCount']).where('DemandId', '=', sourceId).orderBy('EtdWeek').execute(),
    db.selectFrom('scm.DemandWeek').select(['DemandWeekId', 'EtdWeek', 'ContainerCount']).where('DemandId', '=', targetId).execute(),
    linesOf(db, sourceId),
    linesOf(db, targetId),
    db.selectFrom('scm.ContainerGroup').select(['ContainerGroupId', 'DemandWeekId', 'Name', 'ContainerCount', 'CapacityQty', 'Unit'])
      .where('DemandId', '=', sourceId).where('IsActive', '=', true).orderBy('GroupNumber').execute(),
    db.selectFrom('scm.WeekHold').select(['DemandId', 'EtdWeek', 'CrId']).where('DemandId', 'in', [sourceId, targetId]).execute(),
    db.selectFrom('scm.DemandKeyUom').select(['LineKey', 'Unit']).where('DemandId', '=', targetId).execute(),
  ]);
  const holdIds = [...weekHolds.map((h) => String(h.CrId)), ...[...srcLines, ...tgtLines].filter((l) => l.ChangeHoldCrId).map((l) => String(l.ChangeHoldCrId))];
  const cr = await crNos(db, [...new Set(holdIds)]);
  const uom = new Map(keyUoms.map((k) => [k.LineKey, k.Unit]));

  const out: PlanWeek[] = [];
  for (const w of srcWeeks) {
    const lines = srcLines.filter((l) => String(l.DemandWeekId) === String(w.DemandWeekId));
    if (!lines.some((l) => fromDb(l.OpenQty) > 0)) continue; // nothing left to move
    const tw = tgtWeeks.find((x) => x.EtdWeek === w.EtdWeek);
    const blockers: string[] = [];
    const sh = weekHolds.find((h) => String(h.DemandId) === String(sourceId) && h.EtdWeek === w.EtdWeek);
    if (sh) blockers.push(`On hold in ${cr.get(String(sh.CrId))}`);
    const th = weekHolds.find((h) => String(h.DemandId) === String(targetId) && h.EtdWeek === w.EtdWeek);
    if (th) blockers.push(`The target's ${w.EtdWeek} is on hold in ${cr.get(String(th.CrId))}`);
    const planLines: PlanLine[] = [];
    for (const l of lines) {
      const label = lineLabel(l);
      const busy = fromDb(l.BusyQty);
      if (busy > 0) blockers.push(`${label}: ${qtyText(busy, l.Unit)} is already in an RFQ or later; only Open quantity can be merged`);
      if (l.ChangeHoldCrId) blockers.push(`${label} is on hold in ${cr.get(String(l.ChangeHoldCrId))}`);
      const unit = uom.get(l.LineKey);
      if (unit && unit !== l.Unit) blockers.push(`${label} is ordered in ${unit} on the target, not ${l.Unit}`);
      const tl = tw ? tgtLines.find((x) => String(x.DemandWeekId) === String(tw.DemandWeekId) && x.LineKey === l.LineKey) : undefined;
      if (tl?.ChangeHoldCrId) blockers.push(`${label} on the target is on hold in ${cr.get(String(tl.ChangeHoldCrId))}`);
      const open = fromDb(l.OpenQty);
      if (open > 0) planLines.push({ key: l.LineKey, label, unit: l.Unit, open, targetNow: tl ? fromDb(tl.OpenQty) : 0, newLine: !tl });
    }
    out.push({
      weekId: String(w.DemandWeekId), etdWeek: w.EtdWeek, containers: Number(w.ContainerCount), targetContainers: Number(tw?.ContainerCount ?? 0), targetWeekExists: !!tw,
      groups: groups.filter((g) => String(g.DemandWeekId) === String(w.DemandWeekId)).map((g) => ({
        groupId: String(g.ContainerGroupId), name: g.Name, containerCount: Number(g.ContainerCount), capacity: formatQty(fromDb(g.CapacityQty)), unit: g.Unit,
      })),
      lines: planLines, blockers,
    });
  }
  return out;
}

/** Why a merge cannot be undone now (empty = it can). Plan v5 §3 rule 8. */
export async function unmergeBlockers(db: Db | Tx, mergeId: string): Promise<string[]> {
  const [slices, groups, weeks, weekHolds] = await Promise.all([
    sql<{ SliceId: string; ExecState: string; MergedOutBy: string | null; OnwardNo: string | null; ChangeHoldCrId: string | null; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string; MaterialCode: string | null; Qty: string; Unit: string }>`
      SELECT s.SliceId, s.ExecState, s.MergedOutBy, o.MergeNo AS OnwardNo, l.ChangeHoldCrId, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, s.Qty, l.Unit
      FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId LEFT JOIN scm.MergeRecord o ON o.MergeId = s.MergedOutBy
      WHERE s.MergedInBy = ${mergeId}`.execute(db).then((r) => r.rows),
    db.selectFrom('scm.ContainerGroup as g').innerJoin('scm.DemandWeek as w', 'w.DemandWeekId', 'g.DemandWeekId')
      .select(['g.Name', 'g.IsActive', 'g.MergedOutBy', 'w.EtdWeek']).where('g.MergedInBy', '=', mergeId).execute(),
    db.selectFrom('scm.MergeWeek as m').innerJoin('scm.DemandWeek as t', 't.DemandWeekId', 'm.TargetWeekId')
      .select(['t.DemandId', 't.EtdWeek', 't.ContainerCount', 'm.ContainersMoved']).where('m.MergeId', '=', mergeId).execute(),
    sql<{ EtdWeek: string; CrNo: string }>`
      SELECT h.EtdWeek, c.CrNo FROM scm.WeekHold h JOIN scm.ChangeRequest c ON c.CrId = h.CrId
      JOIN scm.MergeWeek m ON m.MergeId = ${mergeId} JOIN scm.DemandWeek t ON t.DemandWeekId = m.TargetWeekId
      WHERE h.DemandId = t.DemandId AND h.EtdWeek = t.EtdWeek`.execute(db).then((r) => r.rows),
  ]);
  const problems: string[] = [];
  const onward = [...new Set(slices.filter((s) => s.ExecState === 'MERGED_OUT' && s.OnwardNo && String(s.MergedOutBy) !== String(mergeId)).map((s) => s.OnwardNo!))];
  // Merged onward: that merge must be undone first; everything else is judged again afterwards.
  if (onward.length) return onward.map((no) => `Part of it was merged onward in ${no}: undo ${no} first`);
  // Quantity in an RFQ is released first (plan §3 rule 8); anything further along blocks.
  const movable = ['OPEN', 'IN_RFQ', 'QUOTED', 'MERGED_OUT'];
  for (const s of slices.filter((x) => !movable.includes(x.ExecState))) {
    problems.push(`${lineLabel(s)}: ${qtyText(fromDb(s.Qty), s.Unit)} is ${s.ExecState.toLowerCase().replace('_', ' ')}; only Open quantity or quantity still in an RFQ can be moved back`);
  }
  const held = [...new Set(slices.filter((s) => s.ChangeHoldCrId && s.ExecState !== 'MERGED_OUT').map((s) => lineLabel(s)))];
  for (const l of held) problems.push(`${l} is on hold by a change request`);
  for (const h of weekHolds) problems.push(`${h.EtdWeek} is on hold in ${h.CrNo}`);
  for (const g of groups.filter((x) => !x.IsActive && !x.MergedOutBy)) problems.push(`Group ${g.Name || '(no name)'} in ${g.EtdWeek} was changed by a change request since the merge`);
  for (const w of weeks.filter((x) => Number(x.ContainerCount) < Number(x.ContainersMoved))) {
    problems.push(`${w.EtdWeek} now has ${w.ContainerCount} containers, fewer than the ${w.ContainersMoved} merged in`);
  }
  return [...new Set(problems)];
}
