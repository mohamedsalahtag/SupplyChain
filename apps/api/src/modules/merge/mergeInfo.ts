/** Merge details shown on the demand screen (spec 17); no dependency on the demand module. */
import { sql } from 'kysely';
import { fromDb } from '../workflow/qty.js';
import type { Db } from '../workflow/tx.js';
import { qtyText } from './mergeCheck.js';

/** Merge details for the demand screen: merged-in groups, merged-out weeks, merged-in quantity per line. */
export async function mergeInfo(db: Db, demandId: string) {
  const [groups, weeks, lines] = await Promise.all([
    db.selectFrom('scm.ContainerGroup as g').innerJoin('scm.MergeRecord as m', 'm.MergeId', 'g.MergedInBy').innerJoin('scm.Demand as s', 's.DemandId', 'm.SourceDemandId')
      .select(['g.ContainerGroupId', 'm.MergeNo', 's.DemandNo', 's.DemandId']).where('g.DemandId', '=', demandId).where('g.IsActive', '=', true).execute(),
    db.selectFrom('scm.MergeWeek as w').innerJoin('scm.MergeRecord as m', 'm.MergeId', 'w.MergeId').innerJoin('scm.DemandWeek as dw', 'dw.DemandWeekId', 'w.SourceWeekId')
      .innerJoin('scm.Demand as t', 't.DemandId', 'm.TargetDemandId')
      .select(['dw.EtdWeek', 'm.MergeNo', 't.DemandNo', 't.DemandId']).where('m.SourceDemandId', '=', demandId).where('m.Status', '=', 'EXECUTED').execute(),
    sql<{ LineId: string; MergeNo: string; SourceNo: string; BusinessOrigin: string; EffectiveSubmittedAt: Date; Unit: string; Qty: string }>`
      SELECT s.LineId, m.MergeNo, sd.DemandNo AS SourceNo, s.BusinessOrigin, s.EffectiveSubmittedAt, l.Unit, SUM(s.Qty) AS Qty
      FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId JOIN scm.MergeRecord m ON m.MergeId = s.MergedInBy
      JOIN scm.Demand sd ON sd.DemandId = m.SourceDemandId
      WHERE l.DemandId = ${demandId} AND s.ArrivedVia = 'MERGE' AND s.ExecState <> 'MERGED_OUT'
      GROUP BY s.LineId, m.MergeNo, sd.DemandNo, s.BusinessOrigin, s.EffectiveSubmittedAt, l.Unit`.execute(db).then((r) => r.rows),
  ]);
  const ORIGIN: Record<string, string> = { SALES: 'Sales', PROCUREMENT: 'Procurement', CHANGE: 'Change' };
  return {
    groupFrom: new Map(groups.map((g) => [String(g.ContainerGroupId), { mergeNo: g.MergeNo, demandNo: g.DemandNo, demandId: String(g.DemandId) }])),
    weekTo: (etdWeek: string) => weeks.filter((w) => w.EtdWeek === etdWeek).map((w) => ({ mergeNo: w.MergeNo, demandNo: w.DemandNo, demandId: String(w.DemandId) })),
    lineIn: (lineId: string) => lines.filter((l) => String(l.LineId) === lineId).map((l) =>
      `${qtyText(fromDb(l.Qty), l.Unit)} from ${l.SourceNo} via ${l.MergeNo} (origin: ${ORIGIN[l.BusinessOrigin] ?? l.BusinessOrigin}, requested ${l.EffectiveSubmittedAt.toISOString().slice(0, 10)})`),
  };
}
