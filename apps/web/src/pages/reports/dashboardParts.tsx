/** Shared pieces of the Reports tabs (specs 24, 26, 28): the card frame, the chart/table switch, the period default, small formatters and helpers. */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Alert, Card, Segmented, Space, Tag, theme, Tooltip, Typography } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import type { About } from '../../lib/excel';
import { isoWeekMonday, isoWeekOf } from '../../lib/workflow';

export type DashFilter = { company?: string[]; from?: string; to?: string };

/** Period cards default to the last 12 ISO weeks: this week and the 11 before it. */
export function defaultPeriod(f: DashFilter): DashFilter & { defaulted: boolean } {
  if (f.from || f.to) return { company: f.company, from: f.from, to: f.to, defaulted: false };
  const monday = isoWeekMonday(isoWeekOf(new Date())) ?? new Date();
  return { company: f.company, from: new Date(monday.getTime() - 11 * 7 * 86_400_000).toISOString().slice(0, 10), defaulted: true };
}

/** Live cards read only the company filter. */
export const liveFilter = (f: DashFilter): DashFilter => ({ company: f.company });
export const LIVE = { refetchInterval: 60_000 };

export const fmtN = (v: string | number | null | undefined) => (v == null || v === '' ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 3 }));
export const pct = (v: number | null | undefined) => (v == null ? <Tooltip title="Nothing to measure yet (the denominator is zero)"><Typography.Text type="secondary">N/A</Typography.Text></Tooltip> : `${v}%`);
/** A rate with its sample size: "92% (n=12)", N/A when there is nothing to measure. `what` says what n counts. */
export const pctN = (v: number | null | undefined, n: number | undefined, what = 'demands measured') => (v == null ? pct(v) : (
  <Tooltip title={`n = ${n ?? 0} ${what}`}><span>{v}% <Small>(n={n ?? 0})</Small></span></Tooltip>
));
export const hrs = (v: number | null | undefined) => (v == null ? 'N/A' : v >= 48 ? `${Math.round((v / 24) * 10) / 10} days` : `${v} h`);
/** "3 d" or "6 h" between an ISO time and now. */
export function ageText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const h = Math.abs(Date.now() - new Date(iso).getTime()) / 3_600_000;
  return h < 48 ? `${Math.max(1, Math.round(h))} h` : `${Math.round(h / 24)} d`;
}
export const dateText = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(iso)) : '—');
export const weekLabel = (week: string, monday: string) => `${week.slice(5)} · ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${monday}T00:00:00Z`))}`;

/** Secondary text one step smaller than the app font (the font setting's small size — never a fixed pixel size). */
export function Small({ children, type = 'secondary', strong }: { children: ReactNode; type?: 'secondary' | 'danger' | 'default'; strong?: boolean }) {
  const { token } = theme.useToken();
  return <Typography.Text type={type === 'default' ? undefined : type} strong={strong} style={{ fontSize: token.fontSizeSM, fontWeight: strong ? undefined : 400 }}>{children}</Typography.Text>;
}
/** A paragraph in the small size (card summaries and notes). */
export function SmallPara({ children, secondary, style }: { children: ReactNode; secondary?: boolean; style?: CSSProperties }) {
  const { token } = theme.useToken();
  return <Typography.Paragraph type={secondary ? 'secondary' : undefined} style={{ margin: '0 0 6px', fontSize: token.fontSizeSM, ...style }}>{children}</Typography.Paragraph>;
}

/** Shown while a card or table still displays the previous filter's numbers and the new ones are loading. */
export function Updating({ show }: { show: boolean | undefined }) {
  return show ? <Tag icon={<SyncOutlined spin />} color="processing" bordered={false} style={{ marginInlineEnd: 0 }}>Updating…</Tag> : null;
}

/** The page of a paged table, back to 1 whenever the filter changes (no stale "page 4 of 1"). */
export function useFilterPage(filter: unknown): [number, (p: number) => void] {
  const key = JSON.stringify(filter);
  const [s, set] = useState({ key, page: 1 });
  return [s.key === key ? s.page : 1, (page: number) => set({ key, page })];
}

/** The "About this export" sheet of a report export: when, what was filtered, and how to read the quantities. */
export function aboutExport(report: string, f: DashFilter & { q?: string }, notes: string[] = []): About {
  return [
    ['Report', report],
    ['Generated', new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })],
    ['Companies', f.company?.length ? f.company.join(', ') : 'all of yours'],
    ['Period', f.from || f.to ? `${f.from ?? 'start'} – ${f.to ?? 'today'}` : 'the report default (see the screen)'],
    ['Search', f.q ?? '—'],
    ['Quantities', 'Per unit of measure. Quantities of different units are never added together; add only rows of the same unit.'],
    ['Rates', 'Percent; N/A (or empty) when there is nothing to divide by.'],
    ...notes.map((n): [string, string] => ['Note', n]),
  ];
}

export type View = 'Chart' | 'Table';
export function ViewSwitch({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  return <Segmented size="small" value={value} onChange={(v) => onChange(v as View)} options={['Chart', 'Table']} />;
}

/** The card frame: title, a "now" or "period" tag, who it is for, an error or the content, and the reading note under it. */
export function DashCard({ title, mode, audience, extra, error, loading, updating, note, children }: {
  title: string; mode: 'now' | 'period'; audience: string; extra?: ReactNode; error?: string; loading?: boolean; updating?: boolean; note?: ReactNode; children: ReactNode;
}) {
  return (
    <Card size="small" style={{ height: '100%' }} loading={loading} extra={extra}
      title={
        <Space size={6} wrap>
          <Typography.Text strong>{title}</Typography.Text>
          <Tooltip title={mode === 'now' ? 'Live: refreshed every minute; the dates above do not apply' : 'Follows the From – To dates above (the last 12 weeks when empty)'}>
            <Tag bordered={false} color={mode === 'now' ? 'blue' : 'purple'} style={{ marginInlineEnd: 0, cursor: 'help' }}>{mode}</Tag>
          </Tooltip>
          <Small>{audience}</Small>
          <Updating show={updating} />
        </Space>
      }>
      {error ? <Alert type="error" showIcon message={error} /> : children}
      {note && <SmallPara secondary style={{ margin: '8px 0 0' }}>{note}</SmallPara>}
    </Card>
  );
}

/** A small headline number with its label and a line of context. */
export function Tile({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'dim' }) {
  const { token } = theme.useToken();
  const color = tone === 'ok' ? '#389e0d' : tone === 'warn' ? '#d48806' : tone === 'bad' ? '#cf1322' : tone === 'dim' ? '#8c8c8c' : undefined;
  return (
    <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: '6px 10px', minWidth: 120, flex: '1 1 120px' }}>
      <div style={{ fontSize: token.fontSizeSM, color: '#595959' }}>{label}</div>
      <div style={{ fontSize: token.fontSizeXL, fontWeight: 600, lineHeight: 1.25, color }}>{value}</div>
      {sub && <div style={{ fontSize: token.fontSizeSM, color: '#8c8c8c' }}>{sub}</div>}
    </div>
  );
}
export const Tiles = ({ children }: { children: ReactNode }) => <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{children}</div>;
