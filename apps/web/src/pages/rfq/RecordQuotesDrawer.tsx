import { Fragment, useEffect, useState } from 'react';
import { Alert, App, Button, Drawer, Input, InputNumber, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { CopyOutlined, SaveOutlined } from '@ant-design/icons';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf, weekLabel } from '../../lib/workflow';
import { n } from './rfqLabels';

type Rfq = RouterOutputs['rfq']['get'];
type ViewRow = Rfq['supplierView'][number];
type Entry = { unitPrice: string; available: number | null; sku: string | null };

/**
 * Record quotes for one supplier (spec 18, revised 2026-09-24): rows per week, only the origins
 * it can supply. Available starts at what was asked; containers are per week (one container can
 * carry several sizes and grades); a price can be copied to the same material in every week.
 */
export function RecordQuotesDrawer({ rfq, open, onClose }: { rfq: Rfq; open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const save = trpc.rfq.recordQuotes.useMutation();
  const [supplier, setSupplier] = useState<string>();
  const [currency, setCurrency] = useState('USD');
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [containers, setContainers] = useState<Record<string, number | null>>({});
  const [allPrice, setAllPrice] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const s = rfq.suppliers.find((x) => x.supplierCode === supplier);
  const rows = s ? rfq.supplierView.filter((v) => s.originsAtInvite.includes(v.originCode)) : [];
  const weeks = [...new Set(rows.map((v) => v.week))].sort();
  const key = (v: Pick<ViewRow, 'week' | 'key'>) => `${v.week}|${v.key}`;
  const current = (v: ViewRow) => rfq.quotes.find((q) => q.supplierCode === supplier && q.week === v.week && q.key === v.key);
  const inManyWeeks = (v: ViewRow) => rows.filter((x) => x.key === v.key).length > 1;

  useEffect(() => {
    if (!open) return;
    setSupplier((rfq.suppliers.find((x) => x.quotedRows === 0) ?? rfq.suppliers[0])?.supplierCode);
  }, [open, rfq.suppliers]);
  useEffect(() => { // start from the supplier's current quotes; new rows: available = asked
    if (!s) return;
    setCurrency(rfq.quotes.find((q) => q.supplierCode === s.supplierCode)?.currency ?? s.currency ?? 'USD');
    setEntries(Object.fromEntries(rfq.supplierView.map((v) => {
      const q = rfq.quotes.find((x) => x.supplierCode === s.supplierCode && x.week === v.week && x.key === v.key);
      return [key(v), { unitPrice: q?.unitPrice ?? '', available: q ? Number(q.available) : Number(v.qty), sku: q?.quotedSku ?? null }];
    })));
    setContainers(Object.fromEntries(rfq.weeks.map((w) => [w.etdWeek, rfq.weekOffers.find((o) => o.supplierCode === s.supplierCode && o.week === w.etdWeek)?.containers ?? null])));
    setProblems([]);
  }, [s, rfq.supplierView, rfq.quotes, rfq.weeks, rfq.weekOffers]);
  const set = (v: ViewRow, patch: Partial<Entry>) => setEntries((e) => ({ ...e, [key(v)]: { ...e[key(v)], ...patch } }));
  /** The row's price (and SKU) for the same material in every week of this RFQ. */
  const allWeeks = (v: ViewRow) => setEntries((e) => {
    const src = e[key(v)];
    const next = { ...e };
    for (const x of rows.filter((r) => r.key === v.key)) next[key(x)] = { ...next[key(x)], unitPrice: src.unitPrice, sku: src.sku };
    return next;
  });

  const priced = rows.filter((v) => entries[key(v)]?.unitPrice && entries[key(v)]?.available != null);
  const weeksToSave = weeks.filter((w) => containers[w] != null);
  /** No quote without the containers offered for its week (at least 1). */
  const missing = [...new Set(priced.map((v) => v.week))].filter((w) => !((containers[w] ?? 0) >= 1));
  const onSave = async () => {
    if (!supplier) return;
    setProblems([]);
    try {
      const r = await save.mutateAsync({
        commandId: newCommandId(), rfqId: rfq.rfqId, supplierCode: supplier, currency,
        rows: priced.map((v) => ({ etdWeek: v.week, lineKey: v.key, unitPrice: entries[key(v)].unitPrice.trim(), availableQty: String(entries[key(v)].available), quotedSku: entries[key(v)].sku })),
        weeks: weeksToSave.map((w) => ({ etdWeek: w, containersOffered: containers[w]! })),
      });
      message.success(`${r.saved} quote(s) saved${r.replaced ? `, ${r.replaced} replacing earlier ones` : ''}`);
      await Promise.all([utils.rfq.invalidate(), utils.work.invalidate(), utils.demand.invalidate()]);
      onClose();
    } catch (err) {
      const p = problemsOf(err);
      if (p.length) setProblems(p); else message.error(errorText(err));
    }
  };

  const cell: React.CSSProperties = { padding: '4px 8px', borderBottom: '1px solid #f0f0f0', verticalAlign: 'middle' };
  return (
    <Drawer open={open} onClose={onClose} width={1080} title={`Record quotes · ${rfq.rfqNo}`} destroyOnHidden
      extra={<Button type="primary" icon={<SaveOutlined />} disabled={(!priced.length && !weeksToSave.length) || missing.length > 0} loading={save.isPending} onClick={onSave}>Save quotes</Button>}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Text>Supplier</Typography.Text>
          <Select id="quoteSupplier" style={{ width: 380 }} value={supplier} onChange={setSupplier}
            options={rfq.suppliers.map((x) => ({ value: x.supplierCode, label: `${x.supplierCode} · ${x.name} (${x.originsAtInvite.join(', ')})${x.quotedRows ? ` · ${x.quotedRows} quoted` : ''}` }))} />
          <Typography.Text>Currency</Typography.Text>
          <Input id="quoteCurrency" style={{ width: 80 }} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">Tools:</Typography.Text>
          <Space.Compact>
            <Input id="quoteAllPrice" style={{ width: 130 }} placeholder="Price for all rows" inputMode="decimal" value={allPrice} onChange={(e) => setAllPrice(e.target.value.replace(/[^\d.]/g, ''))} />
            <Button disabled={!allPrice} onClick={() => setEntries((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, rows.some((r) => key(r) === k) ? { ...v, unitPrice: allPrice } : v])))}>Apply</Button>
          </Space.Compact>
          <Button onClick={() => setEntries((e) => ({ ...e, ...Object.fromEntries(rows.map((v) => [key(v), { ...e[key(v)], available: Number(v.qty) }])) }))}>Available = asked for all</Button>
          {s && rows.length < rfq.supplierView.length && <Typography.Text type="secondary">Rows of origins this supplier cannot supply are not listed.</Typography.Text>}
        </Space>

        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <thead><tr style={{ background: '#fafafa', textAlign: 'left' }}>
            <th style={cell}>Material</th><th style={{ ...cell, width: 120, textAlign: 'right' }}>Asked</th><th style={{ ...cell, width: 150 }}>Unit price</th>
            <th style={{ ...cell, width: 130 }}>Available</th><th style={{ ...cell, width: 230 }}>Quoted SKU</th>
          </tr></thead>
          <tbody>
            {weeks.map((w) => (
              <Fragment key={w}>
                <tr style={{ background: '#f6f8fa' }}>
                  <td style={cell} colSpan={5}>
                    <Space wrap>
                      <Typography.Text strong>{weekLabel(w)}</Typography.Text>
                      <Tag>{rfq.weeks.find((x) => x.etdWeek === w)?.containerCount ?? 0} containers asked</Tag>
                      <Typography.Text>Containers offered</Typography.Text>
                      <InputNumber size="small" min={0} max={999} precision={0} value={containers[w] ?? undefined} style={{ width: 70 }} aria-label={`Containers ${w}`}
                        status={missing.includes(w) ? 'error' : undefined} onChange={(x) => setContainers((c) => ({ ...c, [w]: x }))} />
                      {missing.includes(w)
                        ? <Typography.Text type="danger">required to save this week's quotes (at least 1)</Typography.Text>
                        : <Typography.Text type="secondary">for the whole week — one container can carry several sizes and grades</Typography.Text>}
                    </Space>
                  </td>
                </tr>
                {rows.filter((v) => v.week === w).map((v) => (
                  <tr key={key(v)} style={current(v) ? { background: '#e6f4ff' } : undefined}>
                    <td style={cell}><Typography.Text ellipsis={{ tooltip: v.label }}>{v.label} <Tag color="blue">{v.originCode}</Tag></Typography.Text></td>
                    <td style={{ ...cell, textAlign: 'right' }}>{n(v.qty)} {v.unit}</td>
                    <td style={cell}>
                      <Space.Compact>
                        <Input size="small" inputMode="decimal" value={entries[key(v)]?.unitPrice} aria-label={`Price ${v.label}`} style={{ width: 90 }}
                          onChange={(e) => set(v, { unitPrice: e.target.value.replace(/[^\d.]/g, '') })} />
                        {inManyWeeks(v) && <Tooltip title="Same price (and SKU) in all weeks for this material"><Button size="small" icon={<CopyOutlined />} aria-label={`All weeks ${v.label}`} disabled={!entries[key(v)]?.unitPrice} onClick={() => allWeeks(v)} /></Tooltip>}
                      </Space.Compact>
                    </td>
                    <td style={cell}><InputNumber size="small" min={0} precision={0} value={entries[key(v)]?.available ?? undefined} aria-label={`Available ${v.label}`}
                      onChange={(x) => set(v, { available: x })} style={{ width: '100%' }} /></td>
                    <td style={cell}><Select size="small" allowClear placeholder="—" value={entries[key(v)]?.sku ?? undefined} style={{ width: '100%' }}
                      onChange={(x) => set(v, { sku: x ?? null })} options={v.skus.map((k) => ({ value: k.code, label: `${k.code} ${k.description}` }))} /></td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
        <Typography.Text type="secondary">Blue rows already have a quote from this supplier: saving replaces it (the earlier one stays in history). Rows without a price are not saved. Available starts at the quantity asked.</Typography.Text>
        {missing.length > 0 && <Alert type="warning" showIcon message={`Enter the containers offered for ${missing.join(', ')} before saving`} />}
        {problems.length > 0 && <Alert type="error" showIcon message="Some quotes cannot be saved" description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />}
      </Space>
    </Drawer>
  );
}
