import { useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, DatePicker, Select, Space, Tag, Typography, theme } from 'antd';
import { DownOutlined, FilterOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import { isoWeekMonday, isoWeekOf, nextWeek } from '../lib/workflow';

/**
 * The filter section of every list (mockup docs/mockups/list-filters.html): the search box stays on top; every other
 * filter sits in a section that starts collapsed. Nothing applies until Apply (or Enter). Applied filters show as chips
 * (× removes one) and live in the page address, so they survive opening a record and coming back.
 */
export type FilterOption = { value: string; label: string; /** For a dependent list: the parent values it belongs to (a sub-major can sit under several majors). */ parents?: string[] };
export type FilterField =
  | { key: string; label: string; type: 'multi'; options: FilterOption[]; /** Only options whose parent is chosen in this field. */ parentKey?: string }
  | { key: string; label: string; type: 'weeks'; fromKey: string; toKey: string }
  | { key: string; label: string; type: 'dates'; fromKey: string; toKey: string };
export type FilterValues = Record<string, string[] | string | undefined>;

const WEEK = /^\d{4}-W\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const keysOf = (f: FilterField) => (f.type === 'multi' ? [f.key] : [f.fromKey, f.toKey]);

/** ISO weeks from a year back to a year ahead, labelled with their Monday. */
function weekChoices(): FilterOption[] {
  const out: string[] = [];
  let w = isoWeekOf(new Date(Date.now() - 52 * 7 * 86_400_000));
  for (let i = 0; i < 105; i++) { out.push(w); w = nextWeek(w); }
  return out.map((x) => ({ value: x, label: `${x} · ${dayjs(isoWeekMonday(x)!).format('D MMM YYYY')}` }));
}

function readUrl(params: URLSearchParams, fields: FilterField[]): FilterValues {
  const v: FilterValues = {};
  for (const f of fields) {
    if (f.type === 'multi') { const all = params.getAll(f.key).filter(Boolean); if (all.length) v[f.key] = all; }
    else for (const k of [f.fromKey, f.toKey]) { const x = params.get(k); if (x && (f.type === 'weeks' ? WEEK : DAY).test(x)) v[k] = x; }
  }
  return v;
}

/** Drop dependent choices whose parent is no longer chosen. */
function prune(fields: FilterField[], v: FilterValues): FilterValues {
  const out = { ...v };
  for (const f of fields) {
    if (f.type !== 'multi' || !f.parentKey || !Array.isArray(out[f.key])) continue;
    const parents = out[f.parentKey] as string[] | undefined;
    if (!parents?.length) continue;
    const ok = new Set(f.options.filter((o) => o.parents?.some((x) => parents.includes(x))).map((o) => o.value));
    const kept = (out[f.key] as string[]).filter((x) => ok.has(x));
    out[f.key] = kept.length ? kept : undefined;
  }
  return out;
}

export function useListFilters(fields: FilterField[], onApplied?: () => void) {
  const { token } = theme.useToken();
  const [params, setParams] = useSearchParams();
  const applied = useMemo(() => readUrl(params, fields), [params, fields]);
  const [draft, setDraft] = useState<FilterValues>(applied);
  const [open, setOpen] = useState(false);
  const weeks = useMemo(weekChoices, []);

  const write = (v: FilterValues) => {
    setParams((p) => {
      for (const f of fields) for (const k of keysOf(f)) p.delete(k);
      for (const [k, x] of Object.entries(v)) (Array.isArray(x) ? x : x ? [x] : []).forEach((one) => p.append(k, one));
      return p;
    }, { replace: true });
    onApplied?.();
  };
  const apply = () => { const v = prune(fields, draft); setDraft(v); write(v); setOpen(false); };
  const clearAll = () => { setDraft({}); write({}); };
  const toggle = () => { if (!open) setDraft(applied); setOpen(!open); };

  const label = (f: FilterField, value: string) => (f.type === 'multi' ? f.options.find((o) => o.value === value)?.label ?? value : value);
  const chips: { key: string; text: string; remove: () => void }[] = [];
  for (const f of fields) {
    if (f.type === 'multi') {
      const vals = applied[f.key] as string[] | undefined;
      if (vals?.length) chips.push({ key: f.key, text: `${f.label}: ${vals.map((x) => label(f, x)).join(', ')}`, remove: () => write(prune(fields, { ...applied, [f.key]: undefined })) });
    } else if (applied[f.fromKey] || applied[f.toKey]) {
      chips.push({ key: f.key, text: `${f.label}: ${applied[f.fromKey] ?? '…'} – ${applied[f.toKey] ?? '…'}`, remove: () => write({ ...applied, [f.fromKey]: undefined, [f.toKey]: undefined }) });
    }
  }

  const bar: ReactNode = (
    <>
      <Button icon={<FilterOutlined />} onClick={toggle} data-testid="filters-button">
        Filters {chips.length > 0 && <Badge count={chips.length} color={token.colorPrimary} size="small" />} {open ? <DownOutlined /> : <RightOutlined />}
      </Button>
      {chips.map((c) => <Tag key={c.key} color="blue" closable onClose={(e) => { e.preventDefault(); c.remove(); }} style={{ marginInlineEnd: 0, alignSelf: 'center' }}>{c.text}</Tag>)}
    </>
  );

  const set = (patch: FilterValues) => setDraft((d) => prune(fields, { ...d, ...patch }));
  const panel: ReactNode = open ? (
    <div onKeyDown={(e) => { if (e.key === 'Enter' && !(e.target as HTMLElement).closest('.ant-select')) apply(); }}
      style={{ background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG, padding: '10px 12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '8px 14px' }}>
        {fields.map((f) => (
          <div key={f.key}>
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: token.fontSizeSM }}>{f.label}</Typography.Text>
            {f.type === 'multi' ? (() => {
              const parents = f.parentKey ? (draft[f.parentKey] as string[] | undefined) : undefined;
              const opts = parents?.length ? f.options.filter((o) => o.parents?.some((x) => parents.includes(x))) : f.options;
              return (
                <Select id={`flt-${f.key}`} mode="multiple" allowClear showSearch optionFilterProp="label" maxTagCount="responsive" placeholder="Any" style={{ width: '100%' }}
                  virtual options={opts.map((o) => ({ value: o.value, label: o.label }))} value={(draft[f.key] as string[] | undefined) ?? []}
                  onChange={(v: string[]) => set({ [f.key]: v.length ? v : undefined })}
                  notFoundContent={parents?.length ? `Nothing under the chosen ${fields.find((x) => x.key === f.parentKey)?.label.toLowerCase()}` : undefined} />
              );
            })() : f.type === 'weeks' ? (
              <Space.Compact style={{ width: '100%' }}>
                <Select id={`flt-${f.fromKey}`} allowClear showSearch placeholder="From week" style={{ width: '50%' }} options={weeks} value={draft[f.fromKey] as string | undefined}
                  onChange={(v?: string) => set({ [f.fromKey]: v })} />
                <Select id={`flt-${f.toKey}`} allowClear showSearch placeholder="To week" style={{ width: '50%' }} options={weeks} value={draft[f.toKey] as string | undefined}
                  onChange={(v?: string) => set({ [f.toKey]: v })} />
              </Space.Compact>
            ) : (
              <DatePicker.RangePicker id={`flt-${f.fromKey}`} allowEmpty={[true, true]} style={{ width: '100%' }} format="D MMM YYYY"
                value={[draft[f.fromKey] ? dayjs(draft[f.fromKey] as string) : null, draft[f.toKey] ? dayjs(draft[f.toKey] as string) : null]}
                onChange={(v) => set({ [f.fromKey]: v?.[0]?.format('YYYY-MM-DD'), [f.toKey]: v?.[1]?.format('YYYY-MM-DD') })} />
            )}
          </div>
        ))}
      </div>
      <Space style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${token.colorBorderSecondary}`, width: '100%' }}>
        <Button type="primary" onClick={apply} data-testid="filters-apply">Apply</Button>
        <Button onClick={clearAll}>Clear all</Button>
        <Button type="link" onClick={() => setOpen(false)}>Close</Button>
      </Space>
    </div>
  ) : null;

  return { applied, bar, panel, clearAll };
}

/** Helpers for pages: the applied values as the API wants them. */
export const many = (v: FilterValues, k: string) => (Array.isArray(v[k]) && (v[k] as string[]).length ? (v[k] as string[]) : undefined);
export const one = (v: FilterValues, k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
