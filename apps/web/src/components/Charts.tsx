/**
 * Small charts for the dashboard (spec 26), plain SVG and CSS — no chart library. Rules: one hue for a magnitude, a fixed colour
 * per series, thin marks with a 2px gap, a legend beside every multi-series chart, values on hover, and a table view next to it.
 * Every SVG chart has an accessible name and description (`title` / `desc` from the caller); text sizes come from the app's
 * font setting (antd tokens), never a fixed pixel size.
 */
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { theme, Tooltip } from 'antd';

const fmt = (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: 3 });
const niceMax = (m: number) => {
  if (m <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(m)));
  const r = m / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p;
};

export type StackPart = { key: string; label: string; short: string; value: number; color: string; darkText?: boolean };

/** The chart text size and family from the theme (the app-wide font setting). */
function useChartFont() {
  const { token } = theme.useToken();
  return { size: token.fontSizeSM, family: token.fontFamily, css: `${token.fontSizeSM}px ${token.fontFamily}` };
}

/** <title> + <desc> for an SVG chart with role="img", so screen readers announce what it shows. */
function A11y({ id, title, desc }: { id: string; title: string; desc?: string }) {
  return <><title id={`${id}-t`}>{title}</title>{desc && <desc id={`${id}-d`}>{desc}</desc>}</>;
}
const labelledBy = (id: string, desc?: string) => ({ role: 'img', 'aria-labelledby': `${id}-t`, 'aria-describedby': desc ? `${id}-d` : undefined });

/** Measures an element's width (for labels that must fit, and charts that must fill their card). */
function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.clientWidth) || fallback);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, width];
}

/** One horizontal stacked bar. A label sits inside a segment only where it fits (never clipped); every segment shows its value on hover. */
export function StackBar({ parts }: { parts: StackPart[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(0);
  const font = useChartFont();
  const total = parts.reduce((s, p) => s + p.value, 0);
  const fits = (text: string, share: number) => width > 0 && (share / 100) * width >= text.length * font.size * 0.6 + 10;
  return (
    <div ref={ref} style={{ display: 'flex', height: 22, borderRadius: 4, overflow: 'hidden', background: '#f5f5f5' }}>
      {total > 0 && parts.filter((p) => p.value > 0).map((p) => {
        const share = (p.value / total) * 100;
        const full = `${p.short} ${fmt(p.value)}`;
        return (
          <Tooltip key={p.key} title={`${p.label}: ${fmt(p.value)} (${share.toFixed(1)}%)`}>
            <span style={{ width: `${share}%`, background: p.color, color: p.darkText ? '#1f1f1f' : '#fff', fontSize: font.size, display: 'flex', alignItems: 'center', justifyContent: 'center',
              whiteSpace: 'nowrap', overflow: 'hidden', boxShadow: 'inset -2px 0 0 #fff' }}>
              {fits(full, share) ? full : fits(p.short, share) ? p.short : ''}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; line?: boolean }[] }) {
  const font = useChartFont();
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: font.size, color: '#595959', marginTop: 6 }}>
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ display: 'inline-block', width: i.line ? 14 : 10, height: i.line ? 2 : 10, borderRadius: i.line ? 0 : 2, background: i.color, marginRight: 5, verticalAlign: i.line ? 2 : -1 }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export type BarRow = { key: string; label: string; value: number; text?: string; color?: string };

/** Horizontal bars for one measure (one hue); the value text sits beside each bar. Label and value columns shrink on narrow cards. */
export function HBars({ rows, max, labelWidth = 220, label }: { rows: BarRow[]; max?: number; labelWidth?: number; label?: string }) {
  const font = useChartFont();
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div role="list" aria-label={label}>
      {rows.map((r) => (
        <div key={r.key} role="listitem" aria-label={`${r.label}: ${r.text ?? fmt(r.value)}`} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0', fontSize: font.size }}>
          <div style={{ flex: `0 1 ${labelWidth}px`, maxWidth: '40%', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</div>
          <div style={{ flex: '1 1 60px', minWidth: 40, height: 12, background: '#fafafa', borderRadius: 3 }}>
            <div style={{ width: `${((r.value / top) * 100).toFixed(1)}%`, minWidth: r.value > 0 ? 2 : 0, height: 12, borderRadius: 3, background: r.color ?? '#1f6f43' }} />
          </div>
          <div style={{ flex: '0 1 150px', maxWidth: '30%', minWidth: 40, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#595959', fontVariantNumeric: 'tabular-nums' }} title={r.text ?? fmt(r.value)}>{r.text ?? fmt(r.value)}</div>
        </div>
      ))}
    </div>
  );
}

export type Series = { key: string; label: string; color: string; values: number[] };
export type LineSeries = { key: string; label: string; color: string; values: (number | null)[] };

/** Lines over categories (months), a marker per point with its value on hover; a gap where a value is N/A. */
export function Lines({ title, desc, categories, series, height = 200, yMax, suffix = '' }: {
  title: string; desc?: string; categories: string[]; series: LineSeries[]; height?: number; yMax?: number; suffix?: string;
}) {
  const [ref, measured] = useWidth<HTMLDivElement>(600);
  const font = useChartFont();
  const id = useId();
  const width = Math.max(320, measured);
  const padL = Math.round(font.size * 3.5), padR = 10, padT = 12, padB = Math.round(font.size * 2.2);
  const top = yMax ?? niceMax(Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0))) * 1.08);
  const plotW = width - padL - padR, plotH = height - padT - padB, n = categories.length;
  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + plotH - (Math.min(v, top) / top) * plotH;
  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} {...labelledBy(id, desc)} style={{ display: 'block', font: font.css }}>
        <A11y id={id} title={title} desc={desc} />
        {[0, 1, 2, 3, 4].map((t) => {
          const v = (top * t) / 4, yy = y(v);
          return <g key={t}><line x1={padL} x2={width - padR} y1={yy} y2={yy} stroke="#ededed" /><text x={padL - 6} y={yy + font.size / 3} textAnchor="end" fill="#595959">{fmt(Number(v.toFixed(top < 10 ? 1 : 0)))}{suffix}</text></g>;
        })}
        {series.map((s) => {
          const segments: string[] = [];
          let cur: string[] = [];
          s.values.forEach((v, i) => { if (v == null) { if (cur.length) segments.push(cur.join(' ')); cur = []; } else cur.push(`${x(i)},${y(v)}`); });
          if (cur.length) segments.push(cur.join(' '));
          return (
            <g key={s.key}>
              {segments.map((pts, j) => <polyline key={j} points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />)}
              {s.values.map((v, i) => v == null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={3.5} fill={s.color} stroke="#fff" strokeWidth={1.5}><title>{`${categories[i]} · ${s.label}: ${fmt(v)}${suffix}`}</title></circle>)}
            </g>
          );
        })}
        {categories.map((c, i) => (n <= 14 || i % Math.ceil(n / 12) === 0) && <text key={c} x={x(i)} y={height - font.size * 0.6} textAnchor="middle" fill="#595959">{c}</text>)}
        <line x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} stroke="#c3c2b7" />
      </svg>
    </div>
  );
}

/** Columns per category, stacked or side by side, with an optional baseline tick and flagged (red) category labels. A label with " · " takes two lines. */
export function Columns({ title, desc, categories, labels, series, stacked = true, baseline, flagged, height = 220 }: {
  title: string; desc?: string; categories: string[]; labels?: string[]; series: Series[]; stacked?: boolean; baseline?: (number | null)[]; flagged?: boolean[]; height?: number;
}) {
  const [ref, measured] = useWidth<HTMLDivElement>(600);
  const font = useChartFont();
  const id = useId();
  const width = Math.max(320, measured);
  const twoLines = (labels ?? []).some((l) => l.includes(' · '));
  const lh = Math.round(font.size * 1.1);
  const padL = Math.round(font.size * 3.3), padR = 8, padT = 14, padB = twoLines ? lh * 2 + 14 : lh + 14;
  const n = categories.length;
  const tops = categories.map((_, i) => (stacked ? series.reduce((s, se) => s + (se.values[i] ?? 0), 0) : Math.max(0, ...series.map((se) => se.values[i] ?? 0))));
  const max = niceMax(Math.max(...tops, ...(baseline ?? []).map((b) => b ?? 0), 0) * 1.08);
  const plotW = width - padL - padR, plotH = height - padT - padB, slot = n ? plotW / n : plotW;
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} {...labelledBy(id, desc)} style={{ display: 'block', font: font.css }}>
        <A11y id={id} title={title} desc={desc} />
        {[0, 1, 2, 3, 4].map((t) => {
          const v = (max * t) / 4, yy = y(v);
          return <g key={t}><line x1={padL} x2={width - padR} y1={yy} y2={yy} stroke="#ededed" /><text x={padL - 6} y={yy + font.size / 3} textAnchor="end" fill="#595959">{fmt(Math.round(v))}</text></g>;
        })}
        {categories.map((c, i) => {
          const x0 = padL + i * slot;
          const marks: JSX.Element[] = [];
          if (stacked) {
            const bw = Math.min(slot * 0.6, 44), x = x0 + (slot - bw) / 2;
            let acc = 0;
            for (const se of series) {
              const v = se.values[i] ?? 0;
              if (v <= 0) continue;
              const y1 = y(acc + v), y0 = y(acc);
              marks.push(<rect key={se.key} x={x} y={y1} width={bw} height={Math.max(0, y0 - y1 - 2)} rx={2} fill={se.color}><title>{`${c} · ${se.label}: ${fmt(v)}`}</title></rect>);
              acc += v;
            }
            const b = baseline?.[i];
            if (b != null) marks.push(<line key="b" x1={x - 5} x2={x + bw + 5} y1={y(b)} y2={y(b)} stroke="#1f1f1f" strokeWidth={2}><title>{`${c} · baseline (version 1): ${fmt(b)}`}</title></line>);
            if (acc > 0) marks.push(<text key="t" x={x + bw / 2} y={y(acc) - 5} textAnchor="middle" fill="#1f1f1f">{fmt(acc)}</text>);
          } else {
            const k = series.length, bw = Math.min((slot * 0.72) / k, 24), gx = x0 + (slot - (bw * k + 2 * (k - 1))) / 2;
            series.forEach((se, j) => {
              const v = se.values[i] ?? 0, x = gx + j * (bw + 2);
              marks.push(<rect key={se.key} x={x} y={y(v)} width={bw} height={Math.max(0, y(0) - y(v))} rx={2} fill={se.color}><title>{`${c} · ${se.label}: ${fmt(v)}`}</title></rect>);
            });
          }
          const flag = flagged?.[i];
          const lines = (labels?.[i] ?? c).split(' · ');
          return (
            <g key={c}>
              {marks}
              <text x={x0 + slot / 2} y={height - (lines.length > 1 ? lh + 8 : 8)} textAnchor="middle" fill={flag ? '#cf1322' : '#595959'} fontWeight={flag ? 600 : 400}>
                {lines.map((l, j) => <tspan key={j} x={x0 + slot / 2} dy={j ? lh : 0}>{l}</tspan>)}
              </text>
            </g>
          );
        })}
        <line x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} stroke="#c3c2b7" />
      </svg>
    </div>
  );
}
