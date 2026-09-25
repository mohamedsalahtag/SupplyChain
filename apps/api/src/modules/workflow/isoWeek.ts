/** ISO weeks as CHAR(8) "YYYY-Www" (plan v5 §0.4). Fixed width, so string comparison orders them. */
import { DomainError } from './errors.js';

/** 53 when 1 January is a Thursday, or a Wednesday in a leap year. */
export function weeksInIsoYear(y: number): 52 | 53 {
  const jan1 = new Date(Date.UTC(y, 0, 1)).getUTCDay();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return jan1 === 4 || (leap && jan1 === 3) ? 53 : 52;
}

export function assertIsoWeek(w: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(w);
  if (!m) throw new DomainError('BAD_WEEK', `Week must be YYYY-Www, got "${w}"`);
  const y = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || n > weeksInIsoYear(y)) throw new DomainError('BAD_WEEK', `${w} does not exist`);
  return w;
}

/** Monday of the ISO week (UTC midnight). */
export function isoWeekMonday(w: string): Date {
  assertIsoWeek(w);
  const y = Number(w.slice(0, 4));
  const n = Number(w.slice(6, 8));
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday1 = new Date(jan4);
  monday1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const d = new Date(monday1);
  d.setUTCDate(monday1.getUTCDate() + (n - 1) * 7);
  return d;
}

/** The ISO week containing a date. */
export function isoWeekOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday decides the year
  const year = d.getUTCFullYear();
  const week = 1 + Math.round((d.getTime() - isoWeekMonday(`${year}-W01`).getTime() - 3 * 86_400_000) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}
