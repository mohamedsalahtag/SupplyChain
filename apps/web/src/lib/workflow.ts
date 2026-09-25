/** Small helpers shared by the workflow screens (Demand-to-PO). */
import type { TRPCClientErrorLike } from '@trpc/client';

/** One id per user action: the server applies a repeated command only once. */
export const newCommandId = () => crypto.randomUUID();

/** The list of problems a business-rule error carries (e.g. "cannot be submitted yet"), if any. */
export function problemsOf(err: unknown): string[] {
  const data = (err as TRPCClientErrorLike<never> | undefined)?.data as { details?: { problems?: unknown } } | undefined;
  const p = data?.details?.problems;
  return Array.isArray(p) ? p.map(String) : [];
}

/** The message to show; a stale-version conflict says what to do about it. */
export function errorText(err: unknown): string {
  const data = (err as TRPCClientErrorLike<never> | undefined)?.data as { domainCode?: string } | undefined;
  if (data?.domainCode === 'STALE_WRITE') {
    return 'Someone else changed this since you opened it. Reload the page to see their change, then do it again.';
  }
  return err instanceof Error ? err.message : String(err);
}

/** True when the record is missing or hidden (the page shows "not found"); other errors show their message. */
export const isNotFound = (err: unknown) => ((err as TRPCClientErrorLike<never> | undefined)?.data as { code?: string } | undefined)?.code === 'NOT_FOUND';

/** Status label and tag colour for demands (spec 12). */
/** Spec 21: the wording lives in statuses.ts. */
export { DEMAND_STATUS } from './statuses';

/** "5000.000" → "5,000"; keeps up to 3 decimals, never through floating-point sums. */
export function qtyText(s: string): string {
  const [int, dec = ''] = s.split('.');
  const d = dec.replace(/0+$/, '');
  return `${Number(int).toLocaleString('en-GB')}${d ? `.${d}` : ''}`;
}

/** ISO week helpers (same rules as the server). */
export function isoWeekMonday(w: string): Date | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(w);
  if (!m) return null;
  const y = Number(m[1]);
  const n = Number(m[2]);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday1 = new Date(jan4);
  monday1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const d = new Date(monday1);
  d.setUTCDate(monday1.getUTCDate() + (n - 1) * 7);
  return n >= 1 && n <= 53 ? d : null;
}
export function isoWeekOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const year = d.getUTCFullYear();
  const week = 1 + Math.round((d.getTime() - isoWeekMonday(`${year}-W01`)!.getTime() - 3 * 86_400_000) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}
export const nextWeek = (w: string) => {
  const m = isoWeekMonday(w);
  return m ? isoWeekOf(new Date(m.getTime() + 7 * 86_400_000)) : isoWeekOf(new Date());
};
export const mondayText = (w: string) => {
  const m = isoWeekMonday(w);
  return m ? `Mon ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(m)}` : '';
};

/** ETD weeks that can be chosen: the current ISO week and the next `ahead` weeks (spec 12: no past weeks). */
export function weekOptions(ahead = 52): string[] {
  const out = [isoWeekOf(new Date())];
  for (let i = 0; i < ahead; i++) out.push(nextWeek(out[out.length - 1]));
  return out;
}
export const weekLabel = (w: string) => `${w} · ${mondayText(w)}`;

/** Percent string → hundredths, or null when not a valid share. */
export function shareHundredths(s: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}
/** ISO week of a 'YYYY-MM-DD' date. */
export const isoWeekOfDate = (ymd: string) => isoWeekOf(new Date(`${ymd}T00:00:00Z`));
