/**
 * The slice state machine and slice utilities (plan v5 §1.2, §1.3, §4.4).
 * transitionSlice is the ONLY code that changes QtySlice.ExecState, and
 * splitSlice the only code that changes QtySlice.Qty; both write history in
 * the caller's transaction.
 */
import { sql, type RawBuilder } from 'kysely';
import type { SliceState } from '../../db/schema.js';
import { DomainError, NotFoundError } from './errors.js';
import { assertMilli, formatQty, fromDb, type Milli } from './qty.js';
import type { Tx } from './tx.js';

export type Trigger =
  | 'ADD_TO_RFQ' | 'MERGE_OUT' | 'UNMERGE_RESTORE' | 'CR_CANCEL'
  | 'QUOTE_RECORDED' | 'RELEASE' | 'AWARD' | 'UNAWARD_KEEP_QUOTES' | 'UNAWARD_RELEASE'
  | 'HANDOFF_SEND' | 'HANDOFF_RETURN' | 'HANDOFF_ACCEPT'
  | 'PO_SUBMIT' | 'SAP_CONFIRMED' | 'SAP_REJECTED';

/** Every allowed transition (plan v5 §4.4). Anything else is rejected. */
export const TRANSITIONS: Record<Trigger, { from: SliceState[]; to: SliceState }> = {
  ADD_TO_RFQ: { from: ['OPEN'], to: 'IN_RFQ' },
  MERGE_OUT: { from: ['OPEN'], to: 'MERGED_OUT' },
  UNMERGE_RESTORE: { from: ['MERGED_OUT'], to: 'OPEN' },
  CR_CANCEL: { from: ['OPEN', 'IN_RFQ', 'QUOTED', 'AWARDED', 'HANDED_OFF', 'PO_PREPARATION'], to: 'CANCELLED' },
  QUOTE_RECORDED: { from: ['IN_RFQ'], to: 'QUOTED' },
  RELEASE: { from: ['IN_RFQ', 'QUOTED'], to: 'OPEN' },
  AWARD: { from: ['QUOTED'], to: 'AWARDED' },
  UNAWARD_KEEP_QUOTES: { from: ['AWARDED'], to: 'QUOTED' },
  UNAWARD_RELEASE: { from: ['AWARDED'], to: 'OPEN' },
  HANDOFF_SEND: { from: ['AWARDED'], to: 'HANDED_OFF' },
  HANDOFF_RETURN: { from: ['HANDED_OFF', 'PO_PREPARATION'], to: 'AWARDED' },
  HANDOFF_ACCEPT: { from: ['HANDED_OFF'], to: 'PO_PREPARATION' },
  PO_SUBMIT: { from: ['PO_PREPARATION'], to: 'PO_SUBMITTED' },
  SAP_CONFIRMED: { from: ['PO_SUBMITTED'], to: 'PO_CREATED' },
  SAP_REJECTED: { from: ['PO_SUBMITTED'], to: 'PO_PREPARATION' }, // only on a CONFIRMED rejection, never on a timeout
};

/** Blocked while the slice's line is held by an open change request (Stage 2). */
const BLOCKED_BY_HOLD: Trigger[] = ['AWARD', 'HANDOFF_SEND', 'PO_SUBMIT', 'MERGE_OUT'];

export function nextState(current: SliceState, trigger: Trigger): SliceState {
  const t = TRANSITIONS[trigger];
  if (!t.from.includes(current)) throw new DomainError('INVALID_TRANSITION', `Cannot ${trigger} from ${current}`);
  return t.to;
}

export type SliceCtx = { actorUserId: number | null; reasonCode?: string; docType?: string; docId?: string | number; comment?: string };

export async function writeHistory(
  tx: Tx,
  sliceId: string,
  action: 'CREATE' | 'TRANSITION' | 'SPLIT',
  from: SliceState | null,
  to: SliceState,
  qty: Milli,
  related: string | null,
  ctx: SliceCtx,
  trigger: Trigger | null = null,
): Promise<void> {
  await tx
    .insertInto('scm.SliceHistory')
    .values({
      SliceId: sliceId, Action: action, TriggerName: trigger, FromState: from, ToState: to, Qty: qty, RelatedSliceId: related,
      ReasonCode: ctx.reasonCode ?? null, DocType: ctx.docType ?? null, DocId: ctx.docId == null ? null : String(ctx.docId),
      Comment: ctx.comment ?? null, ActorUserId: ctx.actorUserId,
    })
    .execute();
}

/**
 * Moves one slice through the state machine. `extraSet` sets link columns in
 * the same UPDATE (e.g. RfqLineId = …); it is built by code, never from input.
 */
export async function transitionSlice(tx: Tx, sliceId: string, trigger: Trigger, ctx: SliceCtx, extraSet?: RawBuilder<unknown>): Promise<SliceState> {
  const cur = (await sql<{ ExecState: SliceState; Qty: string; ChangeHoldCrId: string | null }>`
    SELECT s.ExecState, s.Qty, l.ChangeHoldCrId FROM scm.QtySlice s WITH (UPDLOCK, ROWLOCK)
    JOIN scm.DemandLine l ON l.LineId = s.LineId WHERE s.SliceId = ${sliceId}`.execute(tx)).rows[0];
  if (!cur) throw new NotFoundError(`Slice ${sliceId}`);
  if (cur.ChangeHoldCrId && BLOCKED_BY_HOLD.includes(trigger)) {
    throw new DomainError('CHANGE_HOLD', `The line is on hold by change request ${cur.ChangeHoldCrId}`);
  }
  const to = nextState(cur.ExecState, trigger);
  await sql`UPDATE scm.QtySlice SET ExecState = ${to}${extraSet ? sql`, ${extraSet}` : sql``} WHERE SliceId = ${sliceId}`.execute(tx);
  await writeHistory(tx, sliceId, 'TRANSITION', cur.ExecState, to, fromDb(cur.Qty), null, ctx, trigger);
  return to;
}

export type NewSlice = {
  lineId: string;
  qty: Milli;
  state?: SliceState;
  businessOrigin: 'SALES' | 'PROCUREMENT' | 'CHANGE';
  arrivedVia?: 'DIRECT' | 'MERGE';
  originDemandId: string;
  originLineId: string;
  approvedWeek: string;
  clock: Date;
  mergedFrom?: string;
  mergedInBy?: string;
  rfqLineId?: string;
};

export async function createSlice(tx: Tx, s: NewSlice, ctx: SliceCtx): Promise<string> {
  assertMilli(s.qty);
  if (s.qty <= 0) throw new DomainError('BAD_QTY', 'A slice needs a quantity above zero');
  const row = await tx
    .insertInto('scm.QtySlice')
    .values({
      LineId: s.lineId, Qty: s.qty, ExecState: s.state ?? 'OPEN', BusinessOrigin: s.businessOrigin, ArrivedVia: s.arrivedVia ?? 'DIRECT',
      OriginDemandId: s.originDemandId, OriginLineId: s.originLineId, ApprovedEtdWeek: s.approvedWeek, EffectiveSubmittedAt: s.clock,
      SplitFromSliceId: null, MergedFromSliceId: s.mergedFrom ?? null, MergedInBy: s.mergedInBy ?? null, MergedOutBy: null,
      MergedToSliceId: null, CancelOrigin: null, CancelCrId: null, RfqLineId: s.rfqLineId ?? null, AwardItemId: null, HandoffId: null,
    })
    .output('inserted.SliceId')
    .executeTakeFirstOrThrow();
  const id = String(row.SliceId);
  await writeHistory(tx, id, 'CREATE', null, s.state ?? 'OPEN', s.qty, null, ctx);
  return id;
}

/** The original keeps (qty − take); a new slice gets `take` with the same state, origin, clock and links. */
export async function splitSlice(tx: Tx, sliceId: string, take: Milli, ctx: SliceCtx): Promise<string> {
  const s = (await sql<{ ExecState: SliceState; Qty: string }>`
    SELECT ExecState, Qty FROM scm.QtySlice WITH (UPDLOCK, ROWLOCK) WHERE SliceId = ${sliceId}`.execute(tx)).rows[0];
  if (!s) throw new NotFoundError(`Slice ${sliceId}`);
  const total = fromDb(s.Qty);
  assertMilli(take);
  if (!(take > 0 && take < total)) throw new DomainError('BAD_SPLIT', `Cannot split ${formatQty(take)} from ${formatQty(total)}`);
  await sql`UPDATE scm.QtySlice SET Qty = Qty - ${take} WHERE SliceId = ${sliceId}`.execute(tx);
  const created = (await sql<{ SliceId: string }>`
    INSERT INTO scm.QtySlice (LineId, Qty, ExecState, BusinessOrigin, ArrivedVia, OriginDemandId, OriginLineId, ApprovedEtdWeek,
      EffectiveSubmittedAt, SplitFromSliceId, MergedFromSliceId, MergedInBy, RfqLineId, AwardItemId, HandoffId)
    OUTPUT inserted.SliceId
    SELECT LineId, ${take}, ExecState, BusinessOrigin, ArrivedVia, OriginDemandId, OriginLineId, ApprovedEtdWeek,
      EffectiveSubmittedAt, SliceId, MergedFromSliceId, MergedInBy, RfqLineId, AwardItemId, HandoffId
    FROM scm.QtySlice WHERE SliceId = ${sliceId}`.execute(tx)).rows[0];
  const newId = String(created.SliceId);
  await writeHistory(tx, sliceId, 'SPLIT', s.ExecState, s.ExecState, total - take, newId, ctx);
  await writeHistory(tx, newId, 'SPLIT', s.ExecState, s.ExecState, take, sliceId, ctx);
  return newId;
}

/**
 * Picks slices of a line in the given states totalling exactly `qty`, splitting
 * the last one. Order: the order of `states`, then SliceId — a technical order
 * only; there is no business priority between original and merged quantity.
 */
export async function takeQty(
  tx: Tx,
  opts: { lineId: string; qty: Milli; states: SliceState[]; where?: RawBuilder<unknown>; ctx: SliceCtx },
): Promise<string[]> {
  assertMilli(opts.qty);
  const order = sql.join(opts.states.map((s, i) => sql`WHEN ${s} THEN ${i}`), sql` `);
  const slices = (await sql<{ SliceId: string; Qty: string }>`
    SELECT SliceId, Qty FROM scm.QtySlice WITH (UPDLOCK, ROWLOCK)
    WHERE LineId = ${opts.lineId} AND ExecState IN (${sql.join(opts.states)}) ${opts.where ? sql`AND ${opts.where}` : sql``}
    ORDER BY CASE ExecState ${order} END, SliceId`.execute(tx)).rows;
  const available = slices.reduce((a, s) => a + fromDb(s.Qty), 0);
  if (opts.qty > available) {
    throw new DomainError('INSUFFICIENT_QTY', `Requested ${formatQty(opts.qty)}, available ${formatQty(available)}`, 422, { available: formatQty(available) });
  }
  const picked: string[] = [];
  let remaining = opts.qty;
  for (const s of slices) {
    if (remaining === 0) break;
    const q = fromDb(s.Qty);
    if (q <= remaining) {
      picked.push(String(s.SliceId));
      remaining -= q;
    } else {
      picked.push(await splitSlice(tx, String(s.SliceId), remaining, opts.ctx));
      remaining = 0;
    }
  }
  return picked;
}
