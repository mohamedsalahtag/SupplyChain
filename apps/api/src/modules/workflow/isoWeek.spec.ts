import { describe, expect, it } from 'vitest';
import { assertIsoWeek, isoWeekMonday, isoWeekOf, weeksInIsoYear } from './isoWeek.js';

describe('ISO weeks (plan v5 §0.4)', () => {
  it('accepts real weeks and rejects the rest', () => {
    expect(assertIsoWeek('2026-W14')).toBe('2026-W14');
    expect(assertIsoWeek('2020-W53')).toBe('2020-W53');
    // Note: plan v5 §0.12 says 2026-W53 is rejected, but 1 Jan 2026 is a Thursday, so 2026 has 53 weeks.
    expect(assertIsoWeek('2026-W53')).toBe('2026-W53');
    expect(() => assertIsoWeek('2025-W53')).toThrow(/does not exist/);
    expect(() => assertIsoWeek('2026-W00')).toThrow(/does not exist/);
    expect(() => assertIsoWeek('2026-14')).toThrow(/YYYY-Www/);
    expect(() => assertIsoWeek('2026-W1')).toThrow(/YYYY-Www/);
  });

  it('knows which years have 53 weeks', () => {
    expect(weeksInIsoYear(2020)).toBe(53);
    expect(weeksInIsoYear(2026)).toBe(53);
    expect(weeksInIsoYear(2025)).toBe(52);
    expect(weeksInIsoYear(2015)).toBe(53);
  });

  it('finds the Monday across year boundaries', () => {
    expect(isoWeekMonday('2026-W01').toISOString().slice(0, 10)).toBe('2025-12-29');
    expect(isoWeekMonday('2026-W14').toISOString().slice(0, 10)).toBe('2026-03-30');
    expect(isoWeekMonday('2021-W01').toISOString().slice(0, 10)).toBe('2021-01-04');
  });

  it('maps dates to their week, and back', () => {
    expect(isoWeekOf(new Date(Date.UTC(2021, 0, 3)))).toBe('2020-W53');
    expect(isoWeekOf(new Date(Date.UTC(2025, 11, 29)))).toBe('2026-W01');
    for (const w of ['2026-W01', '2026-W14', '2026-W52', '2020-W53']) expect(isoWeekOf(isoWeekMonday(w))).toBe(w);
  });

  it('orders weeks correctly as strings (fixed width)', () => {
    expect(['2026-W10', '2025-W52', '2026-W02'].sort()).toEqual(['2025-W52', '2026-W02', '2026-W10']);
  });
});
