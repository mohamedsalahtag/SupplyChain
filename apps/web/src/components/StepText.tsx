import { useState } from 'react';
import { Button, Tooltip, Typography } from 'antd';
import { formatDateTime } from '../lib/format';

type Step = { text: string; note: string | null; at: string };

/** "Returned to Sales by Omar (Procurement) · 24 Sep 11:30 · "Wrong week"" (spec 21). */
export function LastStep({ step }: { step: Step | null | undefined }) {
  if (!step) return <Typography.Text type="secondary">—</Typography.Text>;
  const text = `${step.text} · ${formatDateTime(step.at)}${step.note ? ` · "${step.note}"` : ''}`;
  return <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: text }}>{text}</Typography.Text>;
}

/** The history, one step per line (newest last); the last few shown, the rest one click away (spec 21). */
export function History({ steps, show = 4 }: { steps: Step[]; show?: number }) {
  const [all, setAll] = useState(false);
  if (!steps.length) return null;
  const hidden = all ? 0 : Math.max(0, steps.length - show);
  return (
    <div style={{ fontSize: 12, color: '#595959', lineHeight: 1.7 }}>
      {hidden > 0 && <Button type="link" size="small" style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={() => setAll(true)}>Show all {steps.length} steps</Button>}
      {steps.slice(hidden).map((s, i) => (
        <div key={i}><Typography.Text type="secondary" style={{ fontSize: 12, display: 'inline-block', minWidth: 150 }}>{formatDateTime(s.at)}</Typography.Text>{s.text}{s.note ? ` — "${s.note}"` : ''}</div>
      ))}
    </div>
  );
}

const PARTS: [key: 'open' | 'inRfq' | 'awarded' | 'onPo' | 'cancelled', label: string, color: string][] = [
  ['onPo', 'on PO', '#237804'], ['awarded', 'awarded', '#52c41a'], ['inRfq', 'in RFQ', '#722ed1'], ['open', 'open', '#bfbfbf'], ['cancelled', 'cancelled', '#ff7875'],
];

/** How much of a demand's quantity is open, in RFQ, awarded, on PO, cancelled (spec 21). */
export function Progress({ p }: { p: Record<'open' | 'inRfq' | 'awarded' | 'onPo' | 'cancelled', number> | null | undefined }) {
  if (!p) return <Typography.Text type="secondary">—</Typography.Text>;
  const shown = PARTS.filter(([k]) => p[k] > 0);
  const text = shown.map(([k, label]) => `${p[k]}% ${label}`).join(' · ');
  return (
    <Tooltip title={text}>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: '#f0f0f0', marginTop: 4 }}>
        {shown.map(([k, , color]) => <span key={k} style={{ width: `${p[k]}%`, background: color }} />)}
      </div>
      <div style={{ fontSize: 11, color: '#595959', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</div>
    </Tooltip>
  );
}
