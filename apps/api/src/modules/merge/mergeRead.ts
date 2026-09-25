/** Reading merges (spec 17): candidates for the wizard, a demand's merges, and merge details on the demand screen. */
import { sql } from 'kysely';
import { getDemand } from '../demand/demandRead.js';
import { hasPermission, type Actor } from '../workflow/access.js';
import { DomainError } from '../workflow/errors.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { rowVerHex, type Db } from '../workflow/tx.js';
import { planMerge, qtyText, unmergeBlockers } from './mergeCheck.js';
import { P_MERGE } from './mergeService.js';

const perUnit = (rows: { Unit: string; Qty: string | number }[]) => {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.Unit, (by.get(r.Unit) ?? 0) + fromDb(r.Qty));
  return [...by].map(([u, q]) => qtyText(q, u)).join(' · ');
};

/** The target, checked: accepted, visible, and the actor may merge in its company. */
async function target(db: Db, actor: Actor, targetId: string) {
  const t = await getDemand(db, actor, targetId);
  if (!t.actions.merge) throw new DomainError('BAD_STATE', `${t.demandNo} cannot receive a merge (accepted demands only, Procurement)`, 409);
  return t;
}

/** Step 1: other accepted demands of the same company that still have Open quantity. */
export async function mergeCandidates(db: Db, actor: Actor, targetId: string) {
  const t = await target(db, actor, targetId);
  const rows = (await sql<{ DemandId: string; DemandNo: string; CreatedByName: string | null; SubmittedAt: Date | null; EtdWeek: string; ContainerCount: number; Unit: string; Qty: string }>`
    SELECT d.DemandId, d.DemandNo, u.DisplayName AS CreatedByName, d.SubmittedAt, w.EtdWeek, w.ContainerCount, l.Unit, SUM(s.Qty) AS Qty
    FROM scm.Demand d JOIN scm.DemandWeek w ON w.DemandId = d.DemandId JOIN scm.DemandLine l ON l.DemandWeekId = w.DemandWeekId AND l.IsActive = 1
    JOIN scm.QtySlice s ON s.LineId = l.LineId AND s.ExecState = 'OPEN' LEFT JOIN app.[User] u ON u.UserId = d.CreatedBy
    WHERE d.CompanyCode = ${t.companyCode} AND d.WorkflowStatus = 'ACCEPTED' AND d.DemandId <> ${targetId}
    GROUP BY d.DemandId, d.DemandNo, u.DisplayName, d.SubmittedAt, w.EtdWeek, w.ContainerCount, l.Unit
    ORDER BY d.DemandNo DESC`.execute(db)).rows;
  const ids = [...new Set(rows.map((r) => String(r.DemandId)))];
  return ids.map((id) => {
    const rs = rows.filter((r) => String(r.DemandId) === id);
    const weeks = [...new Set(rs.map((r) => r.EtdWeek))].sort();
    return {
      demandId: id, demandNo: rs[0].DemandNo, createdBy: rs[0].CreatedByName ?? '', submittedAt: rs[0].SubmittedAt?.toISOString() ?? null, weeks,
      containers: weeks.reduce((n, w) => n + Number(rs.find((r) => r.EtdWeek === w)!.ContainerCount), 0), open: perUnit(rs),
    };
  });
}

/** Step 2: the source's weeks, what each adds to the target, and what blocks it. */
export async function mergePlanView(db: Db, actor: Actor, targetId: string, sourceId: string) {
  const t = await target(db, actor, targetId);
  const s = await getDemand(db, actor, sourceId);
  if (s.companyCode !== t.companyCode || s.workflowStatus !== 'ACCEPTED' || s.demandId === t.demandId) throw new DomainError('BAD_STATE', `${s.demandNo} cannot be merged into ${t.demandNo}`, 409);
  const weeks = await planMerge(db, sourceId, targetId);
  return {
    target: { demandId: t.demandId, demandNo: t.demandNo, rowVer: t.rowVer }, source: { demandId: s.demandId, demandNo: s.demandNo },
    weeks: weeks.map((w) => ({
      ...w,
      lines: w.lines.map((l) => ({ label: l.label, unit: l.unit, newLine: l.newLine, now: formatQty(l.targetNow), adds: formatQty(l.open), after: formatQty(l.targetNow + l.open) })),
    })),
  };
}

/** Merges in and out of a demand, newest first, with whether each can be undone now. */
export async function listMerges(db: Db, actor: Actor, demandId: string) {
  const d = await getDemand(db, actor, demandId); // access
  const recs = await db.selectFrom('scm.MergeRecord as m')
    .innerJoin('scm.Demand as s', 's.DemandId', 'm.SourceDemandId').innerJoin('scm.Demand as t', 't.DemandId', 'm.TargetDemandId')
    .leftJoin('app.User as eu', 'eu.UserId', 'm.ExecutedBy').leftJoin('app.User as uu', 'uu.UserId', 'm.UnmergedBy')
    .select(['m.MergeId', 'm.MergeNo', 'm.SourceDemandId', 'm.TargetDemandId', 's.DemandNo as SourceNo', 't.DemandNo as TargetNo', 'm.Status', 'm.Comment', 'm.ExecutedAt',
      'm.UnmergedAt', 'm.UnmergeReason', 'eu.DisplayName as ExecutedByName', 'uu.DisplayName as UnmergedByName', rowVerHex('m.RowVer').as('RowVer')])
    .where((eb) => eb.or([eb('m.SourceDemandId', '=', demandId), eb('m.TargetDemandId', '=', demandId)]))
    .orderBy('m.MergeId', 'desc').execute();
  const canUnmerge = hasPermission(actor, P_MERGE.unmerge);
  return Promise.all(recs.map(async (m) => {
    const id = String(m.MergeId);
    const [weeks, qty] = await Promise.all([
      db.selectFrom('scm.MergeWeek as w').innerJoin('scm.DemandWeek as dw', 'dw.DemandWeekId', 'w.SourceWeekId').select(['dw.EtdWeek', 'w.ContainersMoved']).where('w.MergeId', '=', id).execute(),
      db.selectFrom('scm.MergeItem as i').innerJoin('scm.DemandLine as l', 'l.LineId', 'i.SourceLineId').select(['l.Unit', 'i.Qty']).where('i.MergeId', '=', id).execute(),
    ]);
    const incoming = String(m.TargetDemandId) === d.demandId;
    const blockers = m.Status === 'EXECUTED' && canUnmerge ? await unmergeBlockers(db, id) : [];
    return {
      mergeId: id, mergeNo: m.MergeNo, direction: incoming ? ('IN' as const) : ('OUT' as const),
      other: incoming ? { demandId: String(m.SourceDemandId), demandNo: m.SourceNo } : { demandId: String(m.TargetDemandId), demandNo: m.TargetNo },
      weeks: weeks.map((w) => w.EtdWeek).sort(), containers: weeks.reduce((n, w) => n + Number(w.ContainersMoved), 0), quantity: perUnit(qty),
      executedBy: m.ExecutedByName ?? '', executedAt: m.ExecutedAt.toISOString(), comment: m.Comment, status: m.Status,
      unmergedBy: m.UnmergedByName ?? null, unmergedAt: m.UnmergedAt?.toISOString() ?? null, unmergeReason: m.UnmergeReason,
      rowVer: m.RowVer, unmerge: { allowed: m.Status === 'EXECUTED' && canUnmerge && blockers.length === 0, blockers },
    };
  }));
}
