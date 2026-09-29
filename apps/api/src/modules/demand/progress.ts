/**
 * Where a demand's quantity is and whose turn it is (demand progress, 2026-09-29, mockup docs/mockups/demand-progress.html).
 * One definition for the progress bar, the Demands list "Waiting on" column and filter, the demand header and the
 * "What's left" box — the server decides, the UI only shows it (hard rule 2).
 */
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { formatQty, fromDb } from '../workflow/qty.js';
import type { Db } from '../workflow/tx.js';

export const STAGES = ['onPo', 'onPoSimulated', 'poPrep', 'handedOff', 'awarded', 'inRfq', 'open', 'cancelled'] as const;
export type Stage = (typeof STAGES)[number];
export type Progress = Record<Stage, number>;
export const TEAMS = ['PROCUREMENT', 'PO_TEAM', 'SALES', 'NONE'] as const;
export type Team = (typeof TEAMS)[number];

const STATE_STAGE: Record<string, Stage> = {
  OPEN: 'open', IN_RFQ: 'inRfq', QUOTED: 'inRfq', AWARDED: 'awarded', HANDED_OFF: 'handedOff', PO_PREPARATION: 'poPrep',
  PO_SUBMITTED: 'onPo', PO_CREATED: 'onPo', CANCELLED: 'cancelled',
};
/** Who moves each stage on (on PO and cancelled: nobody). */
export const STAGE_TEAM: Partial<Record<Stage, Team>> = { open: 'PROCUREMENT', inRfq: 'PROCUREMENT', awarded: 'PROCUREMENT', handedOff: 'PO_TEAM', poPrep: 'PO_TEAM' };

// A slice on PO whose PO number came from the SAP simulator (the draft's reference is in scm.StubSapPo): not in SAP.
const SIM_APPLY = sql`OUTER APPLY (SELECT CASE WHEN s.ExecState IN ('PO_SUBMITTED', 'PO_CREATED') AND EXISTS (
    SELECT 1 FROM scm.PoDraft pd JOIN scm.StubSapPo x ON x.Reference = pd.PoDraftNo
    WHERE pd.HandoffId = s.HandoffId AND pd.Status IN ('SUBMITTED', 'UNKNOWN', 'CREATED')) THEN 1 ELSE 0 END AS Sim) f`;

/** Share of each demand's quantity per stage, in percent (one decimal); null for a demand without quantity. */
export async function progressFor(db: Db, demandIds: string[]): Promise<Map<string, Progress | null>> {
  const out = new Map<string, Progress | null>(demandIds.map((id) => [id, null]));
  if (!demandIds.length) return out;
  const rows = (await sql<{ DemandId: string; ExecState: string; Sim: number; Q: string }>`
    SELECT l.DemandId, s.ExecState, f.Sim, SUM(s.Qty) AS Q
    FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId ${SIM_APPLY}
    WHERE l.DemandId IN (${sql.join(demandIds)}) AND l.IsActive = 1 AND s.ExecState <> 'MERGED_OUT'
    GROUP BY l.DemandId, s.ExecState, f.Sim`.execute(db)).rows;
  for (const id of demandIds) out.set(id, progressOf(rows.filter((r) => String(r.DemandId) === id)));
  return out;
}

export function progressOf(rows: { ExecState: string; Sim?: number | boolean; Q: string }[]): Progress | null {
  const sum = Object.fromEntries(STAGES.map((s) => [s, 0])) as Progress;
  for (const r of rows) {
    const st = STATE_STAGE[r.ExecState];
    if (!st) continue;
    sum[st === 'onPo' && Number(r.Sim) === 1 ? 'onPoSimulated' : st] += Number(r.Q);
  }
  const total = STAGES.reduce((a, s) => a + sum[s], 0);
  if (!total) return null;
  return Object.fromEntries(STAGES.map((s) => [s, Math.round((sum[s] / total) * 1000) / 10])) as Progress;
}

// ─── Waiting on: one SQL definition per team (the list filter and the column use the same fragments) ───
const activeSlice = (states: string) => sql`EXISTS (SELECT 1 FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId
  WHERE l.DemandId = d.DemandId AND l.IsActive = 1 AND s.ExecState IN (${sql.raw(states)}))`;
const openCr = (raisedBy: 'SALES' | 'PROCUREMENT') => sql`EXISTS (SELECT 1 FROM scm.ChangeRequest c WHERE c.DemandId = d.DemandId AND c.Status = 'SUBMITTED' AND c.RaisedByDept = ${raisedBy})`;
const ack = (status: string) => sql`EXISTS (SELECT 1 FROM scm.SalesAck a WHERE a.DemandId = d.DemandId AND a.Status = ${status}
  AND EXISTS (SELECT 1 FROM scm.AwardItem i WHERE i.AwardBatchId = a.AwardBatchId AND i.IsActive = 1))`;
const unknownPo = sql`EXISTS (SELECT 1 FROM scm.PoDraft pd JOIN scm.Handoff h ON h.HandoffId = pd.HandoffId JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId
  WHERE b.DemandId = d.DemandId AND pd.Status = 'UNKNOWN')`;

/** SQL (on scm.Demand as d) that is true when the demand waits on `team`. */
export function waitingSql(team: Team): RawBuilder<SqlBool> {
  const proc = sql`(d.WorkflowStatus = 'SUBMITTED' OR (d.WorkflowStatus = 'ACCEPTED' AND ${activeSlice("'OPEN','IN_RFQ','QUOTED','AWARDED'")}) OR ${ack('QUERY_RAISED')} OR ${openCr('SALES')})`;
  const po = sql`(d.WorkflowStatus = 'ACCEPTED' AND (${activeSlice("'HANDED_OFF','PO_PREPARATION'")} OR ${unknownPo}))`;
  const sales = sql`(d.WorkflowStatus IN ('DRAFT', 'RETURNED') OR ${ack('PENDING')} OR ${openCr('PROCUREMENT')})`;
  if (team === 'PROCUREMENT') return sql<SqlBool>`${proc}`;
  if (team === 'PO_TEAM') return sql<SqlBool>`${po}`;
  if (team === 'SALES') return sql<SqlBool>`${sales}`;
  return sql<SqlBool>`(d.WorkflowStatus = 'ACCEPTED' AND NOT ${proc} AND NOT ${po} AND NOT ${sales})`;
}

export type Waiting = { team: Team; text: string };

const q3 = (m: number) => Number(formatQty(m)).toLocaleString('en-GB', { maximumFractionDigits: 3 });
const perUnit = (rows: { Unit: string; Q: string }[]) => {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.Unit, (by.get(r.Unit) ?? 0) + fromDb(r.Q));
  return [...by].filter(([, v]) => v > 0).map(([u, v]) => `${q3(v)} ${u}`).join(' + ');
};

/** Who each demand waits on and for what (the page of the Demands list, or one demand). */
export async function waitingFor(db: Db, demandIds: string[]): Promise<Map<string, Waiting[]>> {
  const out = new Map<string, Waiting[]>(demandIds.map((id) => [id, []]));
  if (!demandIds.length) return out;
  const ids = sql.join(demandIds);
  const [flags, states, hos, drafts, acks, crs] = await Promise.all([
    sql<{ DemandId: string; WorkflowStatus: string; P: number; O: number; S: number }>`
      SELECT d.DemandId, d.WorkflowStatus, CASE WHEN ${waitingSql('PROCUREMENT')} THEN 1 ELSE 0 END AS P,
        CASE WHEN ${waitingSql('PO_TEAM')} THEN 1 ELSE 0 END AS O, CASE WHEN ${waitingSql('SALES')} THEN 1 ELSE 0 END AS S
      FROM scm.Demand d WHERE d.DemandId IN (${ids})`.execute(db),
    sql<{ DemandId: string; ExecState: string }>`SELECT DISTINCT l.DemandId, s.ExecState FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId
      WHERE l.DemandId IN (${ids}) AND l.IsActive = 1 AND s.Qty > 0`.execute(db),
    sql<{ DemandId: string; HoNo: string }>`SELECT b.DemandId, h.HoNo FROM scm.Handoff h JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId
      WHERE b.DemandId IN (${ids}) AND h.Status = 'HANDED_OFF' ORDER BY h.HoNo`.execute(db),
    sql<{ DemandId: string; PoDraftNo: string; Status: string }>`SELECT b.DemandId, pd.PoDraftNo, pd.Status FROM scm.PoDraft pd JOIN scm.Handoff h ON h.HandoffId = pd.HandoffId
      JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId WHERE b.DemandId IN (${ids}) AND pd.Status IN ('DRAFT', 'VALIDATED', 'UNKNOWN') ORDER BY pd.PoDraftNo`.execute(db),
    sql<{ DemandId: string; AbNo: string; Status: string }>`SELECT a.DemandId, b.AbNo, a.Status FROM scm.SalesAck a JOIN scm.AwardBatch b ON b.AwardBatchId = a.AwardBatchId
      WHERE a.DemandId IN (${ids}) AND a.Status IN ('PENDING', 'QUERY_RAISED') AND EXISTS (SELECT 1 FROM scm.AwardItem i WHERE i.AwardBatchId = a.AwardBatchId AND i.IsActive = 1)`.execute(db),
    sql<{ DemandId: string; CrNo: string; RaisedByDept: string }>`SELECT DemandId, CrNo, RaisedByDept FROM scm.ChangeRequest WHERE DemandId IN (${ids}) AND Status = 'SUBMITTED'`.execute(db),
  ]);
  for (const f of flags.rows) {
    const id = String(f.DemandId);
    const has = (st: string) => states.rows.some((r) => String(r.DemandId) === id && r.ExecState === st);
    const of = <T extends { DemandId: string }>(rows: T[]) => rows.filter((r) => String(r.DemandId) === id);
    const list: Waiting[] = [];
    if (Number(f.P)) {
      const t: string[] = [];
      if (f.WorkflowStatus === 'SUBMITTED') t.push('review and accept');
      if (f.WorkflowStatus === 'ACCEPTED' && has('OPEN')) t.push('put the open part in an RFQ');
      if (f.WorkflowStatus === 'ACCEPTED' && (has('IN_RFQ') || has('QUOTED'))) t.push('record quotes and award');
      if (f.WorkflowStatus === 'ACCEPTED' && has('AWARDED')) t.push('hand off');
      for (const a of of(acks.rows).filter((a) => a.Status === 'QUERY_RAISED')) t.push(`answer Sales' query on ${a.AbNo}`);
      for (const c of of(crs.rows).filter((c) => c.RaisedByDept === 'SALES')) t.push(`decide ${c.CrNo}`);
      list.push({ team: 'PROCUREMENT', text: t.join(', ') || 'open the demand' });
    }
    if (Number(f.O)) {
      const t: string[] = [];
      const hoNos = of(hos.rows).map((h) => h.HoNo);
      if (hoNos.length) t.push(`accept ${hoNos.join(', ')}`);
      for (const d of of(drafts.rows)) t.push(d.Status === 'VALIDATED' ? `submit ${d.PoDraftNo}` : d.Status === 'UNKNOWN' ? `resolve ${d.PoDraftNo} (SAP outcome unknown)` : `validate ${d.PoDraftNo}`);
      if (has('PO_PREPARATION') && !of(drafts.rows).length) t.push('build the PO draft');
      list.push({ team: 'PO_TEAM', text: t.join(', ') || 'open the handoffs' });
    }
    if (Number(f.S)) {
      const t: string[] = [];
      if (f.WorkflowStatus === 'DRAFT') t.push('prepare and submit');
      if (f.WorkflowStatus === 'RETURNED') t.push('fix and resubmit');
      for (const c of of(crs.rows).filter((c) => c.RaisedByDept === 'PROCUREMENT')) t.push(`decide ${c.CrNo}`);
      for (const a of of(acks.rows).filter((a) => a.Status === 'PENDING')) t.push(`acknowledge ${a.AbNo} (optional)`);
      list.push({ team: 'SALES', text: t.join(', ') || 'open the demand' });
    }
    if (!list.length && f.WorkflowStatus === 'ACCEPTED') list.push({ team: 'NONE', text: 'done' });
    out.set(id, list);
  }
  return out;
}

// ─── What's left (the demand page) ───
export type LeftRow = {
  key: string; what: string; supplier: string | null; award: string | null; quantity: string;
  stages: { stage: Stage; quantity: string }[]; where: string; team: Team; next: string; link: { label: string; to: string } | null;
};

/** One row per part of the demand that is not finished: not awarded (per RFQ), per award × supplier, acknowledgements, change requests. */
export async function whatsLeft(db: Db, demandId: string): Promise<{ rows: LeftRow[]; procurementDone: boolean }> {
  const slices = (await sql<{ ExecState: string; Sim: number; Unit: string; Q: string; RfqId: string | null; RfqNo: string | null; AwardBatchId: string | null; AbNo: string | null;
    SupplierCode: string | null; SupplierName: string | null; EtdWeek: string | null }>`
    SELECT s.ExecState, f.Sim, l.Unit, SUM(s.Qty) AS Q, r.RfqId, r.RfqNo, b.AwardBatchId, b.AbNo, i.SupplierCode, sp.Name AS SupplierName, MIN(i.EtdWeek) AS EtdWeek
    FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId ${SIM_APPLY}
    LEFT JOIN scm.RfqLine rl ON rl.RfqLineId = s.RfqLineId LEFT JOIN scm.Rfq r ON r.RfqId = rl.RfqId
    LEFT JOIN scm.AwardItem i ON i.AwardItemId = s.AwardItemId LEFT JOIN scm.AwardBatch b ON b.AwardBatchId = i.AwardBatchId
    LEFT JOIN md.Supplier sp ON sp.SupplierCode = i.SupplierCode
    WHERE l.DemandId = ${demandId} AND l.IsActive = 1 AND s.ExecState NOT IN ('MERGED_OUT', 'CANCELLED') AND s.Qty > 0
    GROUP BY s.ExecState, f.Sim, l.Unit, r.RfqId, r.RfqNo, b.AwardBatchId, b.AbNo, i.SupplierCode, sp.Name`.execute(db)).rows;
  const [handoffs, drafts, acks, crs] = await Promise.all([
    sql<{ HandoffId: string; HoNo: string; Status: string; AwardBatchId: string; SupplierCode: string; SentAt: Date }>`
      SELECT h.HandoffId, h.HoNo, h.Status, h.AwardBatchId, h.SupplierCode, h.SentAt FROM scm.Handoff h JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId
      WHERE b.DemandId = ${demandId} ORDER BY h.HandoffId DESC`.execute(db).then((r) => r.rows),
    sql<{ PoDraftId: string; PoDraftNo: string; Status: string; HandoffId: string; SapPoNumber: string | null; Sim: number }>`
      SELECT pd.PoDraftId, pd.PoDraftNo, pd.Status, pd.HandoffId, pd.SapPoNumber,
        CASE WHEN EXISTS (SELECT 1 FROM scm.StubSapPo x WHERE x.Reference = pd.PoDraftNo) THEN 1 ELSE 0 END AS Sim
      FROM scm.PoDraft pd JOIN scm.Handoff h ON h.HandoffId = pd.HandoffId JOIN scm.AwardBatch b ON b.AwardBatchId = h.AwardBatchId
      WHERE b.DemandId = ${demandId} AND pd.Status NOT IN ('VOID') ORDER BY pd.PoDraftId DESC`.execute(db).then((r) => r.rows),
    sql<{ AwardBatchId: string; AbNo: string; Status: string }>`SELECT a.AwardBatchId, b.AbNo, a.Status FROM scm.SalesAck a JOIN scm.AwardBatch b ON b.AwardBatchId = a.AwardBatchId
      WHERE a.DemandId = ${demandId} AND a.Status IN ('PENDING', 'QUERY_RAISED') AND EXISTS (SELECT 1 FROM scm.AwardItem i WHERE i.AwardBatchId = a.AwardBatchId AND i.IsActive = 1)`.execute(db).then((r) => r.rows),
    sql<{ CrId: string; CrNo: string; RaisedByDept: string }>`SELECT CrId, CrNo, RaisedByDept FROM scm.ChangeRequest WHERE DemandId = ${demandId} AND Status = 'SUBMITTED'`.execute(db).then((r) => r.rows),
  ]);
  const rows: LeftRow[] = [];
  const stagesOf = (part: typeof slices) => STAGES.map((st) => ({ stage: st, quantity: perUnit(part.filter((s) => (STATE_STAGE[s.ExecState] === 'onPo' && Number(s.Sim) === 1 ? 'onPoSimulated' : STATE_STAGE[s.ExecState]) === st)) }))
    .filter((x) => x.quantity);

  // Not awarded yet: open (no RFQ), and per RFQ.
  const open = slices.filter((s) => s.ExecState === 'OPEN');
  if (open.length) rows.push({ key: 'open', what: 'Not in an RFQ yet', supplier: null, award: null, quantity: perUnit(open), stages: stagesOf(open), where: 'Open — no supplier asked yet',
    team: 'PROCUREMENT', next: 'put it in an RFQ', link: { label: 'Create RFQ', to: `/rfqs/new?demand=${demandId}` } });
  const inRfq = slices.filter((s) => s.ExecState === 'IN_RFQ' || s.ExecState === 'QUOTED');
  for (const rfqId of [...new Set(inRfq.map((s) => String(s.RfqId)))]) {
    const part = inRfq.filter((s) => String(s.RfqId) === rfqId);
    rows.push({ key: `rfq-${rfqId}`, what: `In ${part[0].RfqNo ?? 'an RFQ'}`, supplier: null, award: null, quantity: perUnit(part), stages: stagesOf(part),
      where: part.some((s) => s.ExecState === 'QUOTED') ? 'Quotes recorded, not awarded' : 'Waiting for quotes', team: 'PROCUREMENT', next: 'record quotes and award',
      link: rfqId !== 'null' ? { label: `Open ${part[0].RfqNo}`, to: `/rfqs/${rfqId}` } : null });
  }
  // Per award × supplier.
  const awarded = slices.filter((s) => s.AwardBatchId && s.SupplierCode);
  for (const k of [...new Set(awarded.map((s) => `${s.AwardBatchId}|${s.SupplierCode}`))]) {
    const [batchId, supplier] = k.split('|');
    const part = awarded.filter((s) => String(s.AwardBatchId) === batchId && s.SupplierCode === supplier);
    const has = (st: string) => part.some((s) => s.ExecState === st);
    const hs = handoffs.filter((h) => String(h.AwardBatchId) === batchId && h.SupplierCode === supplier);
    const live = hs.find((h) => h.Status !== 'RETURNED');
    const returned = !live ? hs.find((h) => h.Status === 'RETURNED') : undefined;
    const draft = live ? drafts.find((d) => String(d.HandoffId) === String(live.HandoffId)) : undefined;
    const base = { key: `ab-${k}`, what: part[0].AbNo ?? '', supplier: `${part[0].SupplierName ?? supplier} (${supplier})`, award: `${part[0].AbNo} · ${part[0].EtdWeek ?? ''}`,
      quantity: perUnit(part), stages: stagesOf(part) };
    if (has('AWARDED')) {
      rows.push({ ...base, where: returned ? `Awarded — ${returned.HoNo} was returned` : 'Awarded, not handed off', team: 'PROCUREMENT',
        next: returned ? 'fix and hand off again' : 'complete the shipping terms and hand off', link: { label: `Open ${part[0].AbNo}`, to: `/awards/${batchId}` } });
    } else if (has('HANDED_OFF')) {
      rows.push({ ...base, where: `Handed off — ${live?.HoNo ?? ''}, sent ${live ? live.SentAt.toISOString().slice(0, 10) : ''}, not accepted yet`, team: 'PO_TEAM',
        next: 'accept, then build and submit the PO', link: live ? { label: `Open ${live.HoNo}`, to: `/handoffs/${live.HandoffId}` } : null });
    } else if (has('PO_PREPARATION')) {
      const next = !draft ? 'build the PO draft' : draft.Status === 'VALIDATED' ? `submit ${draft.PoDraftNo} to SAP` : draft.Status === 'UNKNOWN' ? `resolve ${draft.PoDraftNo}`
        : draft.Status === 'REJECTED' ? `fix ${draft.PoDraftNo} (rejected by SAP) and build a new draft` : `validate ${draft.PoDraftNo}`;
      rows.push({ ...base, where: `PO preparation — ${live?.HoNo ?? ''} accepted${draft ? `, ${draft.PoDraftNo} ${draft.Status.toLowerCase()}` : ', no PO draft yet'}`, team: 'PO_TEAM', next,
        link: draft ? { label: `Open ${draft.PoDraftNo}`, to: `/po-drafts/${draft.PoDraftId}` } : live ? { label: `Open ${live.HoNo}`, to: `/handoffs/${live.HandoffId}` } : null });
    } else {
      const sim = part.some((s) => Number(s.Sim) === 1);
      const po = draft?.SapPoNumber ? ` → ${draft.SapPoNumber}` : '';
      rows.push({ ...base, where: `On PO — ${live?.HoNo ?? ''}${draft ? ` → ${draft.PoDraftNo}${po}` : ''}${sim ? ' (simulated, not in SAP)' : ''}`, team: 'NONE',
        next: sim ? 'done in the simulator — nothing was created in SAP' : 'done', link: draft ? { label: `Open ${draft.PoDraftNo}`, to: `/po-drafts/${draft.PoDraftId}` } : null });
    }
  }
  for (const a of acks) {
    rows.push({ key: `ack-${a.AwardBatchId}`, what: `Sales acknowledgement of ${a.AbNo}`, supplier: null, award: a.AbNo, quantity: '', stages: [],
      where: a.Status === 'QUERY_RAISED' ? 'Sales raised a query' : 'Not acknowledged — a heads-up, never blocks', team: a.Status === 'QUERY_RAISED' ? 'PROCUREMENT' : 'SALES',
      next: a.Status === 'QUERY_RAISED' ? "answer Sales' query" : 'acknowledge (optional)', link: { label: `Open ${a.AbNo}`, to: `/awards/${a.AwardBatchId}` } });
  }
  for (const c of crs) {
    rows.push({ key: `cr-${c.CrId}`, what: `Change request ${c.CrNo}`, supplier: null, award: null, quantity: '', stages: [], where: `Raised by ${c.RaisedByDept === 'SALES' ? 'Sales' : 'Procurement'}, waiting for a decision`,
      team: c.RaisedByDept === 'SALES' ? 'PROCUREMENT' : 'SALES', next: 'decide', link: { label: `Open ${c.CrNo}`, to: `/change-requests/${c.CrId}` } });
  }
  return { rows, procurementDone: !rows.some((r) => r.team === 'PROCUREMENT') };
}
