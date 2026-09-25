import { describe, expect, it } from 'vitest';
import type { SliceState } from '../../db/schema.js';
import { buildLedger, deriveStatus, isBalanced } from './ledger.js';
import { nextState, TRANSITIONS, type Trigger } from './slices.js';

const L = (requested: number, parts: [SliceState, number][]) => buildLedger(requested, parts.map(([state, qty]) => ({ state, qty })));

describe('derived status (plan v5 §4.2): one test per row', () => {
  it('workflow status until accepted', () => {
    for (const w of ['DRAFT', 'SUBMITTED', 'RETURNED'] as const) expect(deriveStatus(w, L(10, [['OPEN', 10]]))).toBe(w);
  });
  const cases: [string, [SliceState, number][], string][] = [
    ['nothing in progress, nothing ordered', [['OPEN', 10]], 'NOT_STARTED'],
    ['open and in progress', [['OPEN', 4], ['IN_RFQ', 6]], 'PARTIALLY_IN_EXECUTION'],
    ['open and some PO created', [['OPEN', 4], ['PO_CREATED', 6]], 'PARTIALLY_IN_EXECUTION'],
    ['nothing open, some in progress', [['AWARDED', 4], ['PO_CREATED', 6]], 'FULLY_IN_EXECUTION'],
    ['all final, ordered, nothing cancelled', [['PO_CREATED', 7], ['MERGED_OUT', 3]], 'CLOSED_FULLY_EXECUTED'],
    ['all final, ordered and cancelled', [['PO_CREATED', 7], ['CANCELLED', 3]], 'CLOSED_PARTIALLY_EXECUTED'],
    ['all final, nothing ordered, cancelled', [['CANCELLED', 7], ['MERGED_OUT', 3]], 'CANCELLED'],
    ['all merged out', [['MERGED_OUT', 10]], 'MERGED'],
    ['open and merged out only', [['OPEN', 5], ['MERGED_OUT', 5]], 'NOT_STARTED'],
  ];
  it.each(cases)('%s', (_n, parts, expected) => {
    expect(deriveStatus('ACCEPTED', L(10, parts))).toBe(expected);
  });
  it('balance: requested = sum of every state', () => {
    expect(isBalanced(L(10, [['OPEN', 4], ['CANCELLED', 6]]))).toBe(true);
    expect(isBalanced(L(10, [['OPEN', 4]]))).toBe(false);
  });
});

describe('slice state machine (plan v5 §4.4)', () => {
  const ALL: SliceState[] = ['OPEN', 'IN_RFQ', 'QUOTED', 'AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED', 'PO_CREATED', 'CANCELLED', 'MERGED_OUT'];
  const rows = Object.entries(TRANSITIONS) as [Trigger, { from: SliceState[]; to: SliceState }][];

  it.each(rows)('%s: allowed from its states, rejected from every other', (trigger, t) => {
    for (const s of ALL) {
      if (t.from.includes(s)) expect(nextState(s, trigger)).toBe(t.to);
      else expect(() => nextState(s, trigger)).toThrow(/Cannot/);
    }
  });

  it('final states can only leave through unmerge', () => {
    const exits = rows.filter(([, t]) => t.from.some((s) => ['PO_CREATED', 'CANCELLED', 'MERGED_OUT'].includes(s)));
    expect(exits.map(([k]) => k)).toEqual(['UNMERGE_RESTORE']);
  });

  it('an unknown SAP outcome cannot unlock quantity: only a confirmed rejection leaves PO_SUBMITTED backwards', () => {
    const fromSubmitted = rows.filter(([, t]) => t.from.includes('PO_SUBMITTED')).map(([k, t]) => [k, t.to]);
    expect(fromSubmitted).toEqual([['SAP_CONFIRMED', 'PO_CREATED'], ['SAP_REJECTED', 'PO_PREPARATION']]);
  });
});
