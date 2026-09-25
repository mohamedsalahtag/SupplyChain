import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Collapse, Input, InputNumber, Result, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { TrophyOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf } from '../../lib/workflow';
import { n } from '../rfq/rfqLabels';
import { AwardGrid, colorOf, containerValue, countIn, priced, type Grid, type Group, type Picks } from './AwardGrid';

/** Award… (spec 20 revision 1): containers per supplier, per week and container group. */
export function AwardPage() {
  const { rfqId = '' } = useParams();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const utils = trpc.useUtils();
  const q = trpc.award.grid.useQuery({ rfqId }, { retry: false, refetchOnWindowFocus: false });
  const save = trpc.award.awardContainers.useMutation();
  const grid = q.data;
  const [picks, setPicks] = useState<Picks>({});
  const [added, setAdded] = useState<Record<string, number>>({});
  const [brush, setBrush] = useState<string | null>(null);
  const [other, setOther] = useState<Record<string, number>>({}); // rfqLineId|supplier → qty
  const [etd, setEtd] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  useEffect(() => { // fresh grid: every open container starts Not awarded
    if (!grid) return;
    setPicks(Object.fromEntries(grid.weeks.flatMap((w) => w.groups.map((g) => [g.groupId, Array<string | null>(g.available).fill(null)]))));
    setAdded({});
    setBrush((b) => b ?? grid.suppliers[0]?.code ?? null);
  }, [grid]);
  useEffect(() => { const up = () => setDragging(false); document.addEventListener('mouseup', up); return () => document.removeEventListener('mouseup', up); }, []);

  const groups = useMemo(() => grid?.weeks.flatMap((w) => w.groups.map((g) => ({ ...g, week: w.week }))) ?? [], [grid]);
  const groupOf = (id: string) => groups.find((g) => g.groupId === id)!;
  const touched = () => setProblems([]);
  const update = (id: string, fn: (rows: (string | null)[]) => (string | null)[]) => { setPicks((p) => ({ ...p, [id]: fn([...(p[id] ?? [])]) })); touched(); };

  if (q.error) return <Result status="warning" title="No award possible here" subTitle={q.error.message} extra={<Link to={`/rfqs/${rfqId}`}>Back to the RFQ</Link>} />;
  if (!grid) return <Skeleton active />;

  const paint = (id: string, i: number, start: boolean) => {
    if (!start && !dragging) return;
    if (start) setDragging(true);
    const g = groupOf(id);
    if (brush && !priced(g, brush)) { if (start) message.warning(`${grid.suppliers.find((s) => s.code === brush)?.name} did not price every material of ${g.name}`); return; }
    update(id, (rows) => { rows[i] = start && rows[i] === brush ? null : brush; return rows; });
  };
  const setCount = (id: string, code: string, want: number) => update(id, (rows) => {
    let have = rows.filter((x) => x === code).length;
    for (let i = rows.length - 1; i >= 0 && have > want; i--) if (rows[i] === code) { rows[i] = null; have--; }
    for (let i = 0; i < rows.length && have < want; i++) if (!rows[i]) { rows[i] = code; have++; }
    return rows;
  });
  const setWeek = (week: string, code: string | null) => {
    for (const g of grid.weeks.find((w) => w.week === week)!.groups) if (!g.blocker && (!code || priced(g, code))) update(g.groupId, (rows) => rows.map(() => code));
  };
  const addContainer = (id: string) => { setAdded((a) => ({ ...a, [id]: (a[id] ?? 0) + 1 })); update(id, (rows) => [...rows, null]); };
  const removeAdded = (id: string) => { if (!added[id]) return; setAdded((a) => ({ ...a, [id]: a[id] - 1 })); update(id, (rows) => rows.slice(0, -1)); };
  const order = (g: Group) => grid.suppliers.map((s) => s.code).filter((c) => priced(g, c)).sort((a, b) => containerValue(g, a) - containerValue(g, b));
  const allCheapest = () => { for (const g of groups) if (!g.blocker) update(g.groupId, (rows) => rows.map(() => order(g)[0] ?? null)); };
  const asOffered = () => {
    for (const w of grid.weeks) {
      const left = Object.fromEntries(grid.suppliers.map((s) => [s.code, (w.offered[s.code] ?? 0) - (w.awardedBefore[s.code] ?? 0)]));
      for (const g of w.groups) if (!g.blocker) update(g.groupId, (rows) => rows.map(() => { const s = order(g).find((c) => left[c] > 0); if (s) { left[s]--; return s; } return null; }));
    }
  };
  const clearAll = () => { for (const g of groups) update(g.groupId, (rows) => rows.map(() => null)); setOther({}); };

  // Shipments: supplier × week, containers from the picks (+ quantity-only awards).
  const ships = grid.weeks.flatMap((w) => grid.suppliers.map((s) => {
    const containers = w.groups.reduce((t, g) => t + countIn(picks, g.groupId, s.code), 0);
    const byQty = grid.other.some((l) => l.week === w.week && (other[`${l.rfqLineId}|${s.code}`] ?? 0) > 0);
    const total = containers + (w.awardedBefore[s.code] ?? 0);
    return { week: w.week, supplier: s, containers, byQty, over: containers ? total - (w.offered[s.code] ?? 0) : 0 };
  })).filter((x) => x.containers || x.byQty);
  type Ship = (typeof ships)[number];
  const materials = groups.flatMap((g) => grid.suppliers.flatMap((s) => {
    const c = countIn(picks, g.groupId, s.code);
    return c ? g.items.map((it, i) => ({ key: `${g.groupId}|${s.code}|${i}`, supplier: s.name, week: g.week, label: it.label, qty: Number(it.perContainer) * c, unit: g.unit, price: g.prices[s.code]![i]!, currency: s.currency })) : [];
  }));
  type Material = (typeof materials)[number];
  type Other = Grid['other'][number];

  const onAward = () => modal.confirm({
    title: `Award ${ships.reduce((t, x) => t + x.containers, 0)} container(s) from ${grid.rfq.rfqNo}?`,
    content: 'The quantity becomes Awarded and Sales is asked to acknowledge. It can be un-awarded until it is handed off.',
    okText: 'Award',
    onOk: async () => {
      try {
        const r = await save.mutateAsync({
          commandId: newCommandId(), rfqId, rfqRowVer: grid.rfq.rowVer, comment,
          containers: groups.flatMap((g) => grid.suppliers.map((s) => ({ groupId: g.groupId, supplierCode: s.code, count: countIn(picks, g.groupId, s.code) }))).filter((c) => c.count > 0),
          added: Object.entries(added).filter(([, c]) => c > 0).map(([groupId, count]) => ({ groupId, count })),
          other: Object.entries(other).filter(([, v]) => v > 0).map(([k, v]) => { const [rfqLineId, supplierCode] = k.split('|'); return { rfqLineId, supplierCode, qty: String(v) }; }),
          shipments: ships.map((x) => ({ supplierCode: x.supplier.code, etdWeek: x.week, confirmedEtd: etd[`${x.supplier.code}|${x.week}`] || null, note: note[`${x.supplier.code}|${x.week}`] || undefined })),
        });
        await Promise.all([utils.rfq.invalidate(), utils.award.invalidate(), utils.demand.invalidate(), utils.work.invalidate()]);
        message.success(`${r.abNo} awarded`);
        navigate(`/awards/${r.awardBatchId}`);
      } catch (err) {
        const p = problemsOf(err);
        setProblems(p.length ? p : [errorText(err)]);
      }
    },
  });

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Link to={`/rfqs/${rfqId}`}><Typography.Text type="secondary">← {grid.rfq.rfqNo}</Typography.Text></Link>
      <Space size={10} align="baseline" wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>Award · {grid.rfq.rfqNo}</Typography.Title>
        <Typography.Text type="secondary">{grid.rfq.demandNo} · {grid.rfq.companyCode} · {grid.weeks.length} week(s) · {groups.reduce((t, g) => t + g.containerCount, 0)} containers · {grid.suppliers.length} supplier(s) quoted</Typography.Text>
      </Space>
      {!grid.suppliers.length && <Alert type="info" showIcon message="No supplier has quoted yet — record quotes first." />}

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <div style={{ padding: '8px 12px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid #f0f0f0' }}>
          <Button onClick={asOffered}>As offered (cheapest first)</Button>
          <Button onClick={allCheapest}>All to the cheapest</Button>
          <Button onClick={clearAll}>Clear</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>amber outline = above the supplier's offer (allowed, logged)</Typography.Text>
        </div>
        <div style={{ padding: '8px 12px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', background: '#fafafa' }}>
          <Typography.Text strong style={{ fontSize: 12 }}>Squares go to:</Typography.Text>
          {grid.suppliers.map((s) => {
            const [c, bg] = colorOf(grid, s.code);
            const on = brush === s.code;
            return (
              <Tag.CheckableTag key={s.code} checked={on} onChange={() => setBrush(s.code)}
                style={{ border: `1px solid ${on ? c : '#d9d9d9'}`, background: on ? bg : '#fff', color: '#1f1f1f', borderRadius: 14, padding: '0 10px' }}>
                <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: c, marginRight: 5 }} />{s.name}
              </Tag.CheckableTag>
            );
          })}
          <Tag.CheckableTag checked={brush === null} onChange={() => setBrush(null)} style={{ border: '1px solid #d9d9d9', borderRadius: 14, padding: '0 10px', background: brush === null ? '#f5f5f5' : '#fff', color: '#1f1f1f' }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: '#d9d9d9', marginRight: 5 }} />Not awarded
          </Tag.CheckableTag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>then click a square (or drag across several) — one click per container</Typography.Text>
        </div>
      </Card>
      <AwardGrid grid={grid} picks={picks} added={added} brush={brush} onBrush={setBrush} onPaint={paint} onCount={setCount} onWeek={setWeek} onAdd={addContainer} onRemoveAdded={removeAdded} />

      {grid.other.length > 0 && (
        <Card size="small" title="Other quantity" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>quoted quantity in no container group (e.g. added by Procurement) — awarded by quantity</Typography.Text>}>
          <Table<Other> size="small" pagination={false} rowKey="rfqLineId" dataSource={grid.other} columns={[
            { title: 'Week · material', key: 'l', render: (_: unknown, l) => <>{l.week} · {l.label} {l.originCode} <Typography.Text type="secondary">· {n(l.quoted)} {l.unit} quoted</Typography.Text>{l.blocker && <Tag color="gold" style={{ marginInlineStart: 6 }}>{l.blocker}</Tag>}</> },
            ...grid.suppliers.map((s) => ({
              title: s.name, key: s.code, width: 190, align: 'center' as const,
              render: (_: unknown, l: Other) => (l.prices[s.code] == null ? <Typography.Text type="secondary">— not priced</Typography.Text> : (
                <Space size={4}><Typography.Text type="secondary" style={{ fontSize: 12 }}>{l.prices[s.code]}</Typography.Text>
                  <InputNumber size="small" min={0} precision={0} disabled={!!l.blocker} value={other[`${l.rfqLineId}|${s.code}`] ?? 0} style={{ width: 90 }} aria-label={`Quantity ${s.name} ${l.label}`}
                    onChange={(v) => { setOther((o) => ({ ...o, [`${l.rfqLineId}|${s.code}`]: v ?? 0 })); touched(); }} /></Space>)),
            })),
          ]} />
        </Card>
      )}

      <Card size="small" title="Shipments" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>one per supplier × week, from your picks</Typography.Text>}>
        <Table<Ship> size="small" pagination={false} rowKey={(x) => `${x.supplier.code}|${x.week}`} dataSource={ships} locale={{ emptyText: 'Pick containers above' }} columns={[
          { title: 'Supplier', key: 's', render: (_: unknown, x) => x.supplier.name },
          { title: 'Week', dataIndex: 'week', width: 110 },
          { title: 'Containers', key: 'c', width: 110, align: 'right', render: (_: unknown, x) => x.containers || 1 },
          { title: 'Confirmed ETD', key: 'e', width: 180, render: (_: unknown, x) => <Input size="small" type="date" aria-label={`ETD ${x.supplier.name} ${x.week}`} value={etd[`${x.supplier.code}|${x.week}`] ?? ''} onChange={(e) => setEtd((m) => ({ ...m, [`${x.supplier.code}|${x.week}`]: e.target.value }))} /> },
          { title: '', key: 'o', render: (_: unknown, x) => x.over > 0 && <Space size={6}><Tag color="gold">{x.over} above the offer — logged</Tag>
            <Input size="small" placeholder="Note (optional)" maxLength={500} style={{ width: 220 }} value={note[`${x.supplier.code}|${x.week}`] ?? ''} onChange={(e) => setNote((m) => ({ ...m, [`${x.supplier.code}|${x.week}`]: e.target.value }))} /></Space> },
        ]} />
        <Collapse ghost size="small" style={{ marginTop: 6 }} items={[{ key: 'm', label: <Typography.Text type="secondary" style={{ fontSize: 12 }}>Materials awarded ({materials.length})</Typography.Text>, children: (
          <Table<Material> size="small" pagination={false} rowKey="key" dataSource={materials} locale={{ emptyText: 'Nothing picked yet' }} columns={[
            { title: 'Supplier', dataIndex: 'supplier' }, { title: 'Week', dataIndex: 'week', width: 110 }, { title: 'Material', dataIndex: 'label' },
            { title: 'Quantity', key: 'q', align: 'right', render: (_: unknown, m) => `${n(m.qty)} ${m.unit}` },
            { title: 'Price per unit', key: 'p', align: 'right', render: (_: unknown, m) => `${m.price} ${m.currency}` },
          ]} />) }]} />
      </Card>

      <Space wrap>
        <Input id="awardComment" style={{ width: 420, maxWidth: '100%' }} placeholder="Comment (optional)" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
        <Button type="primary" icon={<TrophyOutlined />} disabled={!ships.length} loading={save.isPending} onClick={onAward}>Award</Button>
      </Space>
      {problems.length > 0 && <Alert type="error" showIcon message="The award cannot be made" description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />}
    </Space>
  );
}
