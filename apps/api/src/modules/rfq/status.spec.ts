import { describe, expect, it } from 'vitest';
import { defaultRfqContainers } from '@supplychain/shared';
import { rfqLineStatus, rfqStatus } from './status.js';

const q = (inRfq: number, quoted: number, awarded = 0) => ({ inRfq, quoted, awarded });

describe('RFQ statuses (spec 18)', () => {
  it('header', () => {
    expect(rfqStatus('DRAFT', q(5, 0))).toBe('DRAFT');
    expect(rfqStatus('SENT', q(5, 0))).toBe('SENT');
    expect(rfqStatus('SENT', q(2, 3))).toBe('QUOTING');
    expect(rfqStatus('SENT', q(0, 0))).toBe('CLOSED'); // everything released
    expect(rfqStatus('DRAFT', q(0, 0))).toBe('CLOSED');
    expect(rfqStatus('CANCELLED', q(5, 0))).toBe('CANCELLED');
    expect(rfqStatus('SENT', q(0, 2, 3))).toBe('PARTIALLY_AWARDED');
    expect(rfqStatus('SENT', q(0, 0, 3))).toBe('FULLY_AWARDED');
  });
  it('line', () => {
    expect(rfqLineStatus(false, q(5, 0))).toBe('PENDING_QUOTE');
    expect(rfqLineStatus(false, q(1, 4))).toBe('QUOTED');
    expect(rfqLineStatus(false, q(0, 0))).toBe('RELEASED');
    expect(rfqLineStatus(true, q(5, 0))).toBe('CANCELLED');
  });
  it('default containers: the share of the week asked for, rounded up, never more than the week', () => {
    expect(defaultRfqContainers(10, 10_000, 10_000)).toBe(10);
    expect(defaultRfqContainers(2, 1_000, 2_000)).toBe(1);
    expect(defaultRfqContainers(3, 1_000, 3_000)).toBe(1); // exact thirds do not round up to 2
    expect(defaultRfqContainers(3, 1_001, 3_000)).toBe(2);
    expect(defaultRfqContainers(0, 1_000, 3_000)).toBe(0);
  });
});
