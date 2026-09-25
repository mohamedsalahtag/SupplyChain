/**
 * The quantity ledger and derived status (plan v5 §3.2, §4.2). Works for a
 * line, a week or a demand. Must stay in step with the view scm.vDemandStatus
 * (a database test compares them).
 */
import type { DemandWorkflowStatus, SliceState } from '../../db/schema.js';
import type { Milli } from './qty.js';

export const SLICE_STATES: SliceState[] = [
  'OPEN', 'IN_RFQ', 'QUOTED', 'AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED', 'PO_CREATED', 'CANCELLED', 'MERGED_OUT',
];
export const FINAL_STATES: SliceState[] = ['PO_CREATED', 'CANCELLED', 'MERGED_OUT'];
export const IN_PROGRESS_STATES: SliceState[] = ['IN_RFQ', 'QUOTED', 'AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED'];

export type DemandExecutionStatus =
  | DemandWorkflowStatus
  | 'NOT_STARTED' | 'PARTIALLY_IN_EXECUTION' | 'FULLY_IN_EXECUTION'
  | 'CLOSED_FULLY_EXECUTED' | 'CLOSED_PARTIALLY_EXECUTED' | 'CANCELLED' | 'MERGED';

export type QtyLedger = Record<SliceState, Milli> & { requested: Milli };

export function buildLedger(requested: Milli, slices: { state: SliceState; qty: Milli }[]): QtyLedger {
  const l = Object.fromEntries(SLICE_STATES.map((s) => [s, 0])) as Record<SliceState, Milli>;
  for (const s of slices) l[s.state] += s.qty;
  return { ...l, requested };
}

const sum = (l: QtyLedger, states: SliceState[]) => states.reduce((a, s) => a + l[s], 0);
export const inProgress = (l: QtyLedger) => sum(l, IN_PROGRESS_STATES);
export const isBalanced = (l: QtyLedger) => sum(l, SLICE_STATES) === l.requested;

export function deriveStatus(workflow: DemandWorkflowStatus, l: QtyLedger): DemandExecutionStatus {
  if (workflow !== 'ACCEPTED') return workflow;
  const finals = sum(l, FINAL_STATES);
  if (l.requested > 0 && finals === l.requested) {
    if (l.MERGED_OUT === l.requested) return 'MERGED';
    if (l.PO_CREATED > 0) return l.CANCELLED > 0 ? 'CLOSED_PARTIALLY_EXECUTED' : 'CLOSED_FULLY_EXECUTED';
    return 'CANCELLED';
  }
  if (inProgress(l) === 0 && l.PO_CREATED === 0) return 'NOT_STARTED';
  if (l.OPEN > 0) return 'PARTIALLY_IN_EXECUTION';
  return 'FULLY_IN_EXECUTION';
}

/** Sum of two ledgers (week = its lines, demand = its weeks). Only for status: units are never shown added together. */
export function addLedgers(a: QtyLedger, b: QtyLedger): QtyLedger {
  const out = { ...a };
  for (const s of SLICE_STATES) out[s] += b[s];
  out.requested += b.requested;
  return out;
}
export const emptyLedger = (): QtyLedger => buildLedger(0, []);
