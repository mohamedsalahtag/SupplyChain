/**
 * RFQ progress (2026-09-29): the same stages and "whose turn" rules as the demands and awards (modules/demand/progress.ts),
 * for one RFQ's quantity — its lines from sending to quotes, award, handoff and PO.
 */
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type { Db } from '../workflow/tx.js';
import { progressOf, SIM_APPLY, type Progress, type Team, type Waiting } from '../demand/progress.js';

/** Share of each RFQ's quantity per stage (its lines' slices), in percent. */
export async function rfqProgressFor(db: Db, rfqIds: string[]): Promise<Map<string, Progress | null>> {
  const out = new Map<string, Progress | null>(rfqIds.map((id) => [id, null]));
  if (!rfqIds.length) return out;
  const rows = (await sql<{ RfqId: string; ExecState: string; Sim: number; Q: string }>`
    SELECT rl.RfqId, s.ExecState, f.Sim, SUM(s.Qty) AS Q
    FROM scm.QtySlice s JOIN scm.RfqLine rl ON rl.RfqLineId = s.RfqLineId ${SIM_APPLY}
    WHERE rl.RfqId IN (${sql.join(rfqIds)}) AND s.ExecState <> 'MERGED_OUT'
    GROUP BY rl.RfqId, s.ExecState, f.Sim`.execute(db)).rows;
  for (const id of rfqIds) out.set(id, progressOf(rows.filter((r) => String(r.RfqId) === id)));
  return out;
}

const rfqSlice = (states: string) => sql`EXISTS (SELECT 1 FROM scm.QtySlice s JOIN scm.RfqLine rl ON rl.RfqLineId = s.RfqLineId
  WHERE rl.RfqId = r.RfqId AND s.ExecState IN (${sql.raw(states)}))`;
const rfqAck = (status: string) => sql`EXISTS (SELECT 1 FROM scm.SalesAck a JOIN scm.AwardBatch b ON b.AwardBatchId = a.AwardBatchId
  WHERE b.RfqId = r.RfqId AND a.Status = ${status} AND EXISTS (SELECT 1 FROM scm.AwardItem i WHERE i.AwardBatchId = a.AwardBatchId AND i.IsActive = 1))`;
const rfqUnknownPo = sql`EXISTS (SELECT 1 FROM scm.PoDraft pd JOIN scm.Handoff h ON h.HandoffId = pd.HandoffId JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId
  WHERE b.RfqId = r.RfqId AND pd.Status = 'UNKNOWN')`;

/** SQL (on scm.Rfq as r) that is true when the RFQ waits on `team`. A cancelled RFQ waits on nobody. */
export function rfqWaitingSql(team: Team): RawBuilder<SqlBool> {
  const live = sql`r.ManualStatus <> 'CANCELLED'`;
  const proc = sql`(${live} AND (r.ManualStatus = 'DRAFT' OR ${rfqSlice("'IN_RFQ','QUOTED','AWARDED'")} OR ${rfqAck('QUERY_RAISED')}))`;
  const po = sql`(${rfqSlice("'HANDED_OFF','PO_PREPARATION'")} OR ${rfqUnknownPo})`;
  const sales = sql`(${rfqAck('PENDING')})`;
  if (team === 'PROCUREMENT') return sql<SqlBool>`${proc}`;
  if (team === 'PO_TEAM') return sql<SqlBool>`${po}`;
  if (team === 'SALES') return sql<SqlBool>`${sales}`;
  return sql<SqlBool>`(NOT ${proc} AND NOT ${po} AND NOT ${sales})`;
}

/** Who each RFQ of a list page waits on and for what: a few set-based queries for the whole page. */
export async function rfqWaitingFor(db: Db, rfqIds: string[]): Promise<Map<string, Waiting[]>> {
  const out = new Map<string, Waiting[]>(rfqIds.map((id) => [id, []]));
  if (!rfqIds.length) return out;
  const ids = sql.join(rfqIds);
  const [flags, states, toHandOff, hos, drafts, acks] = await Promise.all([
    sql<{ RfqId: string; ManualStatus: string; P: number; O: number; S: number }>`SELECT r.RfqId, r.ManualStatus, CASE WHEN ${rfqWaitingSql('PROCUREMENT')} THEN 1 ELSE 0 END AS P,
      CASE WHEN ${rfqWaitingSql('PO_TEAM')} THEN 1 ELSE 0 END AS O, CASE WHEN ${rfqWaitingSql('SALES')} THEN 1 ELSE 0 END AS S FROM scm.Rfq r WHERE r.RfqId IN (${ids})`.execute(db),
    sql<{ RfqId: string; ExecState: string }>`SELECT DISTINCT rl.RfqId, s.ExecState FROM scm.QtySlice s JOIN scm.RfqLine rl ON rl.RfqLineId = s.RfqLineId
      WHERE rl.RfqId IN (${ids}) AND s.ExecState IN ('IN_RFQ', 'QUOTED')`.execute(db),
    sql<{ RfqId: string; Name: string }>`SELECT DISTINCT rl.RfqId, ISNULL(sp.Name, i.SupplierCode) AS Name FROM scm.QtySlice s JOIN scm.RfqLine rl ON rl.RfqLineId = s.RfqLineId
      JOIN scm.AwardItem i ON i.AwardItemId = s.AwardItemId LEFT JOIN md.Supplier sp ON sp.SupplierCode = i.SupplierCode WHERE rl.RfqId IN (${ids}) AND s.ExecState = 'AWARDED'`.execute(db),
    sql<{ RfqId: string; HoNo: string }>`SELECT b.RfqId, h.HoNo FROM scm.Handoff h JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId WHERE b.RfqId IN (${ids}) AND h.Status = 'HANDED_OFF' ORDER BY h.HoNo`.execute(db),
    sql<{ RfqId: string; PoDraftNo: string; Status: string }>`SELECT b.RfqId, pd.PoDraftNo, pd.Status FROM scm.PoDraft pd JOIN scm.Handoff h ON h.HandoffId = pd.HandoffId
      JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId WHERE b.RfqId IN (${ids}) AND pd.Status IN ('DRAFT', 'VALIDATED', 'UNKNOWN') ORDER BY pd.PoDraftNo`.execute(db),
    sql<{ RfqId: string; AbNo: string; Status: string }>`SELECT b.RfqId, b.AbNo, a.Status FROM scm.SalesAck a JOIN scm.AwardBatch b ON b.AwardBatchId = a.AwardBatchId
      WHERE b.RfqId IN (${ids}) AND a.Status IN ('PENDING', 'QUERY_RAISED') AND EXISTS (SELECT 1 FROM scm.AwardItem i WHERE i.AwardBatchId = a.AwardBatchId AND i.IsActive = 1)`.execute(db),
  ]);
  for (const f of flags.rows) {
    const id = String(f.RfqId);
    const of = <T extends { RfqId: string }>(rows: T[]) => rows.filter((r) => String(r.RfqId) === id);
    const has = (st: string) => of(states.rows).some((r) => r.ExecState === st);
    const list: Waiting[] = [];
    if (Number(f.P)) {
      const t: string[] = [];
      if (f.ManualStatus === 'DRAFT') t.push('send to the suppliers');
      else if (has('IN_RFQ')) t.push('record quotes');
      if (has('QUOTED')) t.push('compare and award');
      for (const s of of(toHandOff.rows)) t.push(`hand off ${s.Name}`);
      for (const a of of(acks.rows).filter((a) => a.Status === 'QUERY_RAISED')) t.push(`answer Sales' query on ${a.AbNo}`);
      list.push({ team: 'PROCUREMENT', text: [...new Set(t)].join(', ') || 'open the RFQ' });
    }
    if (Number(f.O)) {
      const t = [...of(hos.rows).map((h) => `accept ${h.HoNo}`), ...of(drafts.rows).map((d) => (d.Status === 'VALIDATED' ? `submit ${d.PoDraftNo}` : d.Status === 'UNKNOWN' ? `resolve ${d.PoDraftNo}` : `validate ${d.PoDraftNo}`))];
      list.push({ team: 'PO_TEAM', text: t.join(', ') || 'build the PO draft' });
    }
    if (Number(f.S)) list.push({ team: 'SALES', text: of(acks.rows).filter((a) => a.Status === 'PENDING').map((a) => `acknowledge ${a.AbNo} (optional)`).join(', ') });
    out.set(id, list.length ? list : [{ team: 'NONE', text: f.ManualStatus === 'CANCELLED' ? 'cancelled' : 'done' }]);
  }
  return out;
}
