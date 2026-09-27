import { describe, expect, it } from 'vitest';
import { assertPeriod, headlineOf, isCalendarDate, milliOf, trendMonths, type ExecLike, type Milestone } from './pure.js';

const row = (demandId: string, unit: string, committed: string, executed: string, rest: Partial<ExecLike> = {}): ExecLike => ({
  demandId, unit, committed, executed, notSourced: '0.000', outstanding: '0.000', procApproved: '0.000', procOrdered: '0.000', ...rest,
});
const at = (iso: string) => new Date(iso);
const ms = (demandId: string, unit: string, qty: string, start: string, po: string, etd: string | null): Milestone => ({
  DemandId: demandId, Unit: unit, Qty: qty, ClockStart: at(start), AcceptedAt: at(start), InRfq: null, Quoted: null, Awarded: null, HandedOff: null, HandoffAccepted: null,
  PoCreated: at(po), ConfirmedEtd: etd ? at(etd) : null,
});

describe('headlineOf: exact sums per unit (F01)', () => {
  it('sums integer quantities to the absolute total', () => {
    const [ct] = headlineOf([row('1', 'CT', '2000.000', '2000.000')], [], 14);
    expect([ct.unit, ct.committed, ct.executed, ct.outstanding, ct.executionRate, ct.executionN]).toEqual(['CT', '2000.000', '2000.000', '0.000', 100, 1]);
  });

  it('keeps fractional quantities exact (was 1000× too small / BAD_QTY)', () => {
    const [kg] = headlineOf([row('1', 'KG', '1000.125', '500.063', { outstanding: '500.062' })], [], 14);
    expect([kg.committed, kg.executed, kg.outstanding]).toEqual(['1000.125', '500.063', '500.062']);
    expect(kg.executionRate).toBe(50);
  });

  it('adds 0.1 + 0.2 to exactly 0.300 (no floating point)', () => {
    const [u] = headlineOf([row('1', 'KG', '0.100', '0.100'), row('2', 'KG', '0.200', '0.000')], [], 14);
    expect([u.committed, u.executed, u.executionRate, u.executionN]).toEqual(['0.300', '0.100', 33.3, 2]);
  });

  it('sums many rows per unit and never across units', () => {
    const rows = [row('1', 'CT', '1500.000', '1000.000', { notSourced: '500.000' }), row('2', 'CT', '2500.500', '2500.500'), row('3', 'KG', '10.250', '0.000', { outstanding: '10.250' })];
    const h = headlineOf(rows, [], 14);
    expect(h.map((u) => [u.unit, u.committed, u.executed, u.outstanding])).toEqual([['CT', '4000.500', '3500.500', '0.000'], ['KG', '10.250', '0.000', '10.250']]);
    expect(h[0].notSourcedRate).toBe(12.5);
    expect(h[1].executionRate).toBe(0);
  });

  it('is N/A with n = 0 when nothing is committed', () => {
    const [u] = headlineOf([row('1', 'CT', '0.000', '0.000')], [], 14);
    expect([u.executionRate, u.executionN, u.onTimeRate, u.onTimeN, u.endToEndHours, u.endToEndN]).toEqual([null, 0, null, 0, null, 0]);
  });

  it('weights times and on-time by quantity and counts the demands measured', () => {
    const m = [ms('1', 'CT', '1000', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-02-01T00:00:00Z'), ms('2', 'CT', '3000', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z', '2026-01-05T00:00:00Z')];
    const [u] = headlineOf([], m, 14);
    expect(u.endToEndHours).toBe(42); // (1000 × 24 + 3000 × 48) / 4000
    expect([u.endToEndN, u.onTimeRate, u.onTimeN]).toEqual([2, 25, 2]); // only demand 1 (31 days ahead) is on time: 1000 of 4000
  });
});

describe('milliOf', () => {
  it('parses API decimals exactly, including zero and a sign', () => {
    expect([milliOf('0.000'), milliOf('1000.125'), milliOf('3'), milliOf('-2.5')]).toEqual([0, 1_000_125, 3000, -2500]);
    for (const bad of ['1.2345', 'abc', '', '1e3']) expect(() => milliOf(bad), bad).toThrow(/decimal quantity/);
  });
});

describe('trendMonths (F12)', () => {
  const today = new Date('2026-09-26T10:00:00Z');

  it('is the last 12 whole months when no dates are picked', () => {
    const { months, truncated } = trendMonths({}, today);
    expect(months.length).toBe(12);
    expect(months[0]).toEqual({ month: '2025-10', from: '2025-10-01', to: '2025-10-31' });
    expect(months[11].month).toBe('2026-09');
    expect(truncated).toBe(false);
  });

  it('clamps the first and last month to the exact dates (partial months)', () => {
    const { months } = trendMonths({ from: '2026-01-15', to: '2026-03-10' }, today);
    expect(months).toEqual([
      { month: '2026-01', from: '2026-01-15', to: '2026-01-31' },
      { month: '2026-02', from: '2026-02-01', to: '2026-02-28' },
      { month: '2026-03', from: '2026-03-01', to: '2026-03-10' },
    ]);
    expect(trendMonths({ from: '2026-05-10', to: '2026-05-20' }, today).months).toEqual([{ month: '2026-05', from: '2026-05-10', to: '2026-05-20' }]);
  });

  it('keeps the latest 24 months, ending at To, and says it did', () => {
    const { months, truncated } = trendMonths({ from: '2020-03-15', to: '2026-06-10' }, today);
    expect(truncated).toBe(true);
    expect(months.length).toBe(24);
    expect(months[0]).toEqual({ month: '2024-07', from: '2024-07-01', to: '2024-07-31' });
    expect(months[23]).toEqual({ month: '2026-06', from: '2026-06-01', to: '2026-06-10' });
  });

  it('rejects impossible dates and From after To', () => {
    expect(() => trendMonths({ from: '2026-02-30' }, today)).toThrow(/not a date/);
    expect(() => trendMonths({ to: '2026-13-01' }, today)).toThrow(/not a date/);
    expect(() => trendMonths({ from: '2026-05-02', to: '2026-05-01' }, today)).toThrow(/after To/);
    expect(() => assertPeriod({ from: '2026-05-01', to: '2026-05-01' })).not.toThrow();
  });

  it('isCalendarDate knows leap years', () => {
    expect([isCalendarDate('2024-02-29'), isCalendarDate('2026-02-29'), isCalendarDate('2026-9-01'), isCalendarDate('2026-09-26')]).toEqual([true, false, false, true]);
  });
});
