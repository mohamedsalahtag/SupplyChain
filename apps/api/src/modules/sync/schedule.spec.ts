import { describe, expect, it } from 'vitest';
import { dueSlot, nextRun, scheduleSchema, type ScheduleEntry } from './schedule.js';

// Saudi time = UTC+3. 2026-09-27 is a Sunday.
const utc = (s: string) => new Date(`${s}Z`);
const e = (days: number[], hours: number[], enabled = true): ScheduleEntry => ({ enabled, days, hours });

describe('sync schedule', () => {
  it('is due in a chosen Saudi day and hour, from the top of that hour', () => {
    // Sunday 05:20 Saudi = Sunday 02:20 UTC
    expect(dueSlot(e([0], [5]), utc('2026-09-27T02:20:00'))?.toISOString()).toBe('2026-09-27T02:00:00.000Z');
    expect(dueSlot(e([0], [5]), utc('2026-09-27T03:00:00'))).toBeNull(); // 06:00 Saudi
    expect(dueSlot(e([1], [5]), utc('2026-09-27T02:20:00'))).toBeNull(); // Monday only
    expect(dueSlot(e([0], [5], false), utc('2026-09-27T02:20:00'))).toBeNull(); // off
  });

  it('uses the Saudi day across UTC midnight', () => {
    // Monday 01:30 Saudi = Sunday 22:30 UTC
    expect(dueSlot(e([1], [1]), utc('2026-09-27T22:30:00'))?.toISOString()).toBe('2026-09-27T22:00:00.000Z');
    expect(dueSlot(e([0], [1]), utc('2026-09-27T22:30:00'))).toBeNull();
  });

  it('finds the next run after now, never the current hour', () => {
    // Sunday 05:20 Saudi, runs Sun–Thu at 05:00 and 17:00 → next is Sunday 17:00 Saudi = 14:00 UTC
    expect(nextRun(e([0, 1, 2, 3, 4], [5, 17]), utc('2026-09-27T02:20:00'))?.toISOString()).toBe('2026-09-27T14:00:00.000Z');
    // Thursday 18:00 Saudi → next is Sunday 05:00 Saudi (skips Friday and Saturday)
    expect(nextRun(e([0, 1, 2, 3, 4], [5, 17]), utc('2026-10-01T15:00:00'))?.toISOString()).toBe('2026-10-04T02:00:00.000Z');
    expect(nextRun(e([0], [5], false), utc('2026-09-27T02:20:00'))).toBeNull();
  });

  it('refuses a schedule that is on without days or hours, and tidies the lists', () => {
    const base = { 'sap.materials': e([], [5]), 'sap.suppliers': e([0], [5], false), 'sap.purchaseOrders': e([0], [5], false) };
    expect(scheduleSchema.safeParse(base).success).toBe(false);
    const ok = scheduleSchema.parse({ ...base, 'sap.materials': e([3, 1, 1], [17, 5]) });
    expect(ok['sap.materials']).toEqual({ enabled: true, days: [1, 3], hours: [5, 17] });
    expect(scheduleSchema.safeParse({ ...base, 'sap.materials': e([7], [5]) }).success).toBe(false);
  });
});
