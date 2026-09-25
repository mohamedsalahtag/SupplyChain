/**
 * Set-based slice moves for chatty paths (spec 20 performance): the same rules as takeQty + splitSlice +
 * transitionSlice, written as one T-SQL fragment so many moves go to the server in one round trip.
 *
 * takeTransitionSql(n, …) picks the line's slices in the given states (order: the order of `states`, then SliceId),
 * splits the last one if needed, moves the picked quantity with `trigger` and writes the same history rows
 * (SPLIT on both halves, TRANSITION per moved slice). A shortfall or a change hold THROWs (50001 / 50002);
 * runSliceBatch turns that into the usual DomainError. The fragment only declares variables suffixed with `n`,
 * so several fragments can share one batch.
 */
import { sql, type RawBuilder } from 'kysely';
import type { SliceState } from '../../db/schema.js';
import { DomainError } from './errors.js';
import { assertMilli, type Milli } from './qty.js';
import { TRANSITIONS, type SliceCtx, type Trigger } from './slices.js';
import type { Tx } from './tx.js';

const HOLD_BLOCKS: Trigger[] = ['AWARD', 'HANDOFF_SEND', 'PO_SUBMIT', 'MERGE_OUT']; // as slices.ts BLOCKED_BY_HOLD

export function takeTransitionSql(n: number, o: {
  lineId: string; qty: Milli; states: SliceState[]; where?: RawBuilder<unknown>; trigger: Trigger; ctx: SliceCtx; extraSet?: RawBuilder<unknown>;
}): RawBuilder<unknown> {
  assertMilli(o.qty);
  if (o.qty <= 0) throw new DomainError('BAD_QTY', 'A quantity above zero');
  const t = TRANSITIONS[o.trigger];
  for (const s of o.states) if (!t.from.includes(s)) throw new DomainError('INVALID_TRANSITION', `Cannot ${o.trigger} from ${s}`);
  const v = (name: string) => sql.raw(`@${name}${n}`);
  const order = sql.join(o.states.map((s, i) => sql`WHEN ${s} THEN ${i}`), sql` `);
  const c = o.ctx;
  return sql`
DECLARE ${v('need')} bigint = ${o.qty}, ${v('line')} bigint = ${o.lineId}, ${v('msg')} nvarchar(300);
DECLARE ${v('actor')} int = ${c.actorUserId}, ${v('reason')} nvarchar(40) = ${c.reasonCode ?? null}, ${v('docType')} nvarchar(40) = ${c.docType ?? null},
        ${v('docId')} nvarchar(40) = ${c.docId == null ? null : String(c.docId)}, ${v('comment')} nvarchar(2000) = ${c.comment ?? null};
DECLARE ${v('picked')} TABLE (SliceId bigint PRIMARY KEY, Qty bigint, ExecState nvarchar(20), Cum bigint);
DECLARE ${v('split')} TABLE (OldId bigint, NewId bigint, Take bigint, ExecState nvarchar(20));
DECLARE ${v('moved')} TABLE (SliceId bigint, Qty bigint, ExecState nvarchar(20));
INSERT ${v('picked')} (SliceId, Qty, ExecState, Cum)
  SELECT SliceId, Qty, ExecState, SUM(Qty) OVER (ORDER BY CASE ExecState ${order} END, SliceId ROWS UNBOUNDED PRECEDING)
  FROM scm.QtySlice WITH (UPDLOCK, ROWLOCK)
  WHERE LineId = ${v('line')} AND ExecState IN (${sql.join(o.states)}) ${o.where ? sql`AND ${o.where}` : sql``};
IF ISNULL((SELECT MAX(Cum) FROM ${v('picked')}), 0) < ${v('need')}
BEGIN
  SET ${v('msg')} = CONCAT(N'SLICE:INSUFFICIENT_QTY:', ${v('need')}, N':', ISNULL((SELECT MAX(Cum) FROM ${v('picked')}), 0));
  THROW 50001, ${v('msg')}, 1;
END;
${HOLD_BLOCKS.includes(o.trigger) ? sql`
IF EXISTS (SELECT 1 FROM scm.DemandLine WHERE LineId = ${v('line')} AND ChangeHoldCrId IS NOT NULL)
BEGIN
  SET ${v('msg')} = CONCAT(N'SLICE:CHANGE_HOLD:', (SELECT ChangeHoldCrId FROM scm.DemandLine WHERE LineId = ${v('line')}));
  THROW 50002, ${v('msg')}, 1;
END;` : sql``}
-- the slice that crosses the quantity is split: the original keeps the rest, a copy takes what is needed
INSERT ${v('split')} (OldId, Take, ExecState) SELECT SliceId, ${v('need')} - (Cum - Qty), ExecState FROM ${v('picked')} WHERE Cum > ${v('need')} AND Cum - Qty < ${v('need')};
IF EXISTS (SELECT 1 FROM ${v('split')})
BEGIN
  UPDATE q SET Qty = q.Qty - s.Take FROM scm.QtySlice q JOIN ${v('split')} s ON s.OldId = q.SliceId;
  INSERT INTO scm.QtySlice (LineId, Qty, ExecState, BusinessOrigin, ArrivedVia, OriginDemandId, OriginLineId, ApprovedEtdWeek,
      EffectiveSubmittedAt, SplitFromSliceId, MergedFromSliceId, MergedInBy, RfqLineId, AwardItemId, HandoffId)
    SELECT q.LineId, s.Take, q.ExecState, q.BusinessOrigin, q.ArrivedVia, q.OriginDemandId, q.OriginLineId, q.ApprovedEtdWeek,
      q.EffectiveSubmittedAt, q.SliceId, q.MergedFromSliceId, q.MergedInBy, q.RfqLineId, q.AwardItemId, q.HandoffId
    FROM scm.QtySlice q JOIN ${v('split')} s ON s.OldId = q.SliceId;
  UPDATE ${v('split')} SET NewId = SCOPE_IDENTITY();
  INSERT INTO scm.SliceHistory (SliceId, Action, TriggerName, FromState, ToState, Qty, RelatedSliceId, ReasonCode, DocType, DocId, Comment, ActorUserId)
    SELECT s.OldId, 'SPLIT', NULL, s.ExecState, s.ExecState, q.Qty, s.NewId, ${v('reason')}, ${v('docType')}, ${v('docId')}, ${v('comment')}, ${v('actor')}
      FROM ${v('split')} s JOIN scm.QtySlice q ON q.SliceId = s.OldId
    UNION ALL
    SELECT s.NewId, 'SPLIT', NULL, s.ExecState, s.ExecState, s.Take, s.OldId, ${v('reason')}, ${v('docType')}, ${v('docId')}, ${v('comment')}, ${v('actor')} FROM ${v('split')} s;
END;
INSERT ${v('moved')} (SliceId, Qty, ExecState) SELECT SliceId, Qty, ExecState FROM ${v('picked')} WHERE Cum <= ${v('need')}
  UNION ALL SELECT NewId, Take, ExecState FROM ${v('split')};
UPDATE q SET ExecState = ${t.to}${o.extraSet ? sql`, ${o.extraSet}` : sql``} FROM scm.QtySlice q JOIN ${v('moved')} f ON f.SliceId = q.SliceId;
INSERT INTO scm.SliceHistory (SliceId, Action, TriggerName, FromState, ToState, Qty, RelatedSliceId, ReasonCode, DocType, DocId, Comment, ActorUserId)
  SELECT f.SliceId, 'TRANSITION', ${o.trigger}, f.ExecState, ${t.to}, f.Qty, NULL, ${v('reason')}, ${v('docType')}, ${v('docId')}, ${v('comment')}, ${v('actor')} FROM ${v('moved')} f;
`;
}

/** Runs a batch of fragments (SET NOCOUNT ON first); a THROW from takeTransitionSql becomes the usual DomainError. */
export async function runSliceBatch<T = unknown>(tx: Tx, parts: RawBuilder<unknown>[], tail: RawBuilder<unknown> = sql``): Promise<T[]> {
  try {
    return (await sql<T>`SET NOCOUNT ON;
${sql.join(parts, sql`
`)}
${tail}`.execute(tx)).rows;
  } catch (e) {
    const m = /SLICE:(INSUFFICIENT_QTY|CHANGE_HOLD):([^\s:]*)(?::(\d+))?/.exec(e instanceof Error ? e.message : String(e));
    if (m?.[1] === 'INSUFFICIENT_QTY') {
      const fmt = (x: string) => (Number(x) / 1000).toFixed(3);
      throw new DomainError('INSUFFICIENT_QTY', `Requested ${fmt(m[2])}, available ${fmt(m[3] ?? '0')}`, 422, { available: fmt(m[3] ?? '0') });
    }
    if (m?.[1] === 'CHANGE_HOLD') throw new DomainError('CHANGE_HOLD', `The line is on hold by change request ${m[2]}`);
    throw e;
  }
}

/**
 * Moves EVERY slice that matches `where` (alias `s`) and is in `states` with `trigger` — no quantity, no split
 * (a handoff sends, accepts or returns all of a supplier's slices at once). Same checks and history as transitionSlice.
 */
export function moveSlicesSql(n: number, o: { from: RawBuilder<unknown>; where: RawBuilder<unknown>; states: SliceState[]; trigger: Trigger; ctx: SliceCtx; extraSet?: RawBuilder<unknown> }): RawBuilder<unknown> {
  const t = TRANSITIONS[o.trigger];
  for (const s of o.states) if (!t.from.includes(s)) throw new DomainError('INVALID_TRANSITION', `Cannot ${o.trigger} from ${s}`);
  const v = (name: string) => sql.raw(`@${name}${n}`);
  const c = o.ctx;
  return sql`
DECLARE ${v('mv')} TABLE (SliceId bigint PRIMARY KEY, Qty bigint, ExecState nvarchar(20));
DECLARE ${v('mmsg')} nvarchar(300);
INSERT ${v('mv')} (SliceId, Qty, ExecState)
  SELECT s.SliceId, s.Qty, s.ExecState ${o.from} WHERE s.ExecState IN (${sql.join(o.states)}) AND ${o.where};
${HOLD_BLOCKS.includes(o.trigger) ? sql`
IF EXISTS (SELECT 1 FROM ${v('mv')} m JOIN scm.QtySlice q ON q.SliceId = m.SliceId JOIN scm.DemandLine l ON l.LineId = q.LineId WHERE l.ChangeHoldCrId IS NOT NULL)
BEGIN
  SET ${v('mmsg')} = CONCAT(N'SLICE:CHANGE_HOLD:', (SELECT TOP 1 l.ChangeHoldCrId FROM ${v('mv')} m JOIN scm.QtySlice q ON q.SliceId = m.SliceId JOIN scm.DemandLine l ON l.LineId = q.LineId WHERE l.ChangeHoldCrId IS NOT NULL));
  THROW 50002, ${v('mmsg')}, 1;
END;` : sql``}
UPDATE q SET ExecState = ${t.to}${o.extraSet ? sql`, ${o.extraSet}` : sql``} FROM scm.QtySlice q JOIN ${v('mv')} m ON m.SliceId = q.SliceId;
INSERT INTO scm.SliceHistory (SliceId, Action, TriggerName, FromState, ToState, Qty, RelatedSliceId, ReasonCode, DocType, DocId, Comment, ActorUserId)
  SELECT m.SliceId, 'TRANSITION', ${o.trigger}, m.ExecState, ${t.to}, m.Qty, NULL, ${c.reasonCode ?? null}, ${c.docType ?? null}, ${c.docId == null ? null : String(c.docId)}, ${c.comment ?? null}, ${c.actorUserId} FROM ${v('mv')} m;
`;
}
