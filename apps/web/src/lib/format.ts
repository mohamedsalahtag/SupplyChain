import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../api/src/trpc/router';

export type RouterOutputs = inferRouterOutputs<AppRouter>;

const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** ISO timestamp from the API → local "23 Sept 2026, 21:13". */
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : '—');

export const formatNumber = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-GB'));

export type SyncRun = NonNullable<RouterOutputs['sync']['status']['last']>;

/** "15,003 read from SAP · 12 new · 3 updated · 1 marked Not in SAP" */
export function syncSummary(run: SyncRun, missingLabel = 'marked "Not in SAP"'): string {
  return [
    `${formatNumber(run.RowsRead)} read from SAP`,
    `${formatNumber(run.RowsInserted)} new`,
    `${formatNumber(run.RowsUpdated)} updated`,
    `${formatNumber(run.RowsMarkedMissing)} ${missingLabel}`,
  ].join(' · ');
}
