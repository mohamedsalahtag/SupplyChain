import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Empty, InputNumber, Result, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { FileAddOutlined } from '@ant-design/icons';
import { defaultRfqContainers } from '@supplychain/shared';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BackToWork } from '../../components/BackToWork';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf } from '../../lib/workflow';
import { MATCH_LABEL, n } from './rfqLabels';

type Builder = RouterOutputs['rfq']['builder'];
type Row = Builder['rows'][number];
const rowKey = (r: Pick<Row, 'lineId' | 'week'>) => `${r.lineId}|${r.week}`;

/** Pick the demand when the builder is opened from Purchasing → RFQs. */
function DemandPicker() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const list = trpc.demand.list.useQuery({ mine: false, q: q || undefined, status: ['NOT_STARTED', 'PARTIALLY_IN_EXECUTION'], page: 1, pageSize: 25 });
  return (
    <Card size="small" title="New RFQ · which demand?">
      <Select id="rfqDemand" showSearch style={{ width: 420 }} placeholder="Accepted demand with Open quantity" filterOption={false} onSearch={setQ}
        onChange={(id: string) => navigate(`/rfqs/new?demand=${id}`)} loading={list.isFetching}
        options={(list.data?.rows ?? []).map((d) => ({ value: d.demandId, label: `${d.demandNo} · ${d.companyCode} · open ${d.open || '—'}` }))} />
    </Card>
  );
}

/**
 * RFQ builder (spec 18): quantity per line and week, containers per week, the
 * origin shortlist ranked by our history, and what suppliers will see.
 */
export function RfqBuilderPage() {
  const [params] = useSearchParams();
  const demandId = params.get('demand') ?? '';
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const builder = trpc.rfq.builder.useQuery({ demandId }, { enabled: /^\d+$/.test(demandId), retry: false });
  const create = trpc.rfq.create.useMutation();
  const flag = trpc.rfq.flagMissingOrigin.useMutation();
  const [ask, setAsk] = useState<Record<string, number | null>>({}); // cartons per row; null = not chosen
  const [containers, setContainers] = useState<Record<string, number>>({});
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    if (builder.data) setAsk(Object.fromEntries(builder.data.rows.filter((r) => !r.hold).map((r) => [rowKey(r), Number(r.open)])));
  }, [builder.data]);
  const chosen = useMemo(() => (builder.data?.rows ?? []).filter((r) => (ask[rowKey(r)] ?? 0) > 0), [builder.data, ask]);
  const lineIds = useMemo(() => [...new Set(chosen.map((r) => r.lineId))].sort(), [chosen]);
  const shortlist = trpc.rfq.shortlist.useQuery({ demandId, lineIds }, { enabled: lineIds.length > 0, placeholderData: (p) => p });
  useEffect(() => { // an origin nobody can supply goes to My work once
    for (const g of shortlist.data ?? []) if (g.problem && !g.problem.includes('purchasing organization')) flag.mutate({ demandId, originCode: g.originCode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortlist.data]);

  if (!demandId) return <DemandPicker />;
  if (builder.error) return <Result status="warning" title="No RFQ possible here" subTitle={builder.error.message} extra={<Link to="/rfqs">RFQs</Link>} />;
  if (!builder.data) return <Skeleton active />;
  const b = builder.data;

  const weeks = [...new Set(chosen.map((r) => r.week))].sort().map((w) => {
    const info = b.weeks.find((x) => x.etdWeek === w);
    const asked = chosen.filter((r) => r.week === w).reduce((s, r) => s + (ask[rowKey(r)] ?? 0) * 1000, 0);
    const def = defaultRfqContainers(info?.containers ?? 0, asked, info?.liveMilli ?? 0);
    return { etdWeek: w, demandContainers: info?.containers ?? 0, share: info?.liveMilli ? asked / info.liveMilli : 0, def, count: containers[w] ?? def };
  });
  const view = chosen.map((r) => ({ key: rowKey(r), week: r.week, label: r.label, originCode: r.originCode, unit: r.unit, qty: ask[rowKey(r)] ?? 0 }));

  const onCreate = () => modal.confirm({
    title: `Create an RFQ from ${b.demand.demandNo}?`,
    content: `${chosen.length} line(s), ${suppliers.length} supplier(s). The quantity becomes In RFQ; you send it from the RFQ page.`,
    okText: 'Create RFQ',
    onOk: async () => {
      setProblems([]);
      try {
        const r = await create.mutateAsync({
          commandId: newCommandId(), demandId, suppliers,
          lines: chosen.map((x) => ({ lineId: x.lineId, week: x.week, qty: String(ask[rowKey(x)]) })),
          weeks: weeks.map((w) => ({ etdWeek: w.etdWeek, containerCount: w.count })),
        });
        message.success(`${r.rfqNo} created`);
        navigate(`/rfqs/${r.rfqId}`);
      } catch (err) {
        const p = problemsOf(err);
        if (p.length) setProblems(p);
        else message.error(errorText(err));
      }
    },
  });

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={12}>
        <BackToWork />
        <Link to={`/demands/${demandId}`}><Typography.Text type="secondary">← {b.demand.demandNo}</Typography.Text></Link>
      </Space>
      <Typography.Title level={5} style={{ margin: 0 }}>New RFQ from {b.demand.demandNo} · {b.demand.companyCode}</Typography.Title>

      <Card size="small" title="1 · Quantity to ask for" extra={<Typography.Text type="secondary">Open quantity per line and approved ETD week</Typography.Text>}>
        {b.rows.length === 0 ? <Empty description="Nothing Open on this demand" /> : (
          <Table<Row> size="small" bordered pagination={false} rowKey={rowKey} dataSource={b.rows} tableLayout="fixed"
            columns={[
              { title: '', key: 'c', width: 40, render: (_: unknown, r) => <Checkbox checked={(ask[rowKey(r)] ?? 0) > 0} aria-label={`Ask ${r.label}`} onChange={(e) => setAsk({ ...ask, [rowKey(r)]: e.target.checked ? Number(r.open) : null })} /> },
              { title: 'Week', dataIndex: 'week', width: 95 },
              { title: 'Material', key: 'm', render: (_: unknown, r) => <>{r.label} {r.hold && <Tag color="gold">⏸ {r.hold}</Tag>}</> },
              { title: 'Origin', key: 'o', width: 70, render: (_: unknown, r) => <Tag color="blue">{r.originCode}</Tag> },
              { title: 'Open', key: 'open', width: 120, align: 'right', render: (_: unknown, r) => `${n(r.open)} ${r.unit}` },
              {
                title: 'Ask for', key: 'ask', width: 150, align: 'right',
                render: (_: unknown, r) => <InputNumber size="small" min={1} max={Number(r.open)} precision={0} value={ask[rowKey(r)] ?? undefined} disabled={!(ask[rowKey(r)] ?? 0)}
                  onChange={(v) => setAsk({ ...ask, [rowKey(r)]: v ?? ask[rowKey(r)] })} style={{ width: 110 }} aria-label={`Quantity ${r.label}`} />,
              },
            ]} />
        )}
      </Card>

      {weeks.length > 0 && (
        <Card size="small" title="2 · Containers per week">
          <Table size="small" bordered pagination={false} rowKey="etdWeek" dataSource={weeks} tableLayout="fixed"
            columns={[
              { title: 'Week', dataIndex: 'etdWeek', width: 95 },
              { title: 'Demand containers', dataIndex: 'demandContainers', width: 150, align: 'right' },
              { title: 'Share of the week asked for', key: 's', width: 200, align: 'right', render: (_: unknown, w) => `${Math.round(w.share * 100)}%` },
              { title: 'Default', dataIndex: 'def', width: 90, align: 'right' },
              { title: 'Containers', key: 'c', width: 130, align: 'right', render: (_: unknown, w) => <InputNumber size="small" min={0} max={999} precision={0} value={w.count} onChange={(v) => setContainers({ ...containers, [w.etdWeek]: v ?? 0 })} aria-label={`Containers ${w.etdWeek}`} style={{ width: 80 }} /> },
              { title: '', key: 'd', render: (_: unknown, w) => w.count !== w.def && <Tag color="gold">differs from default ({w.def})</Tag> },
            ]} />
        </Card>
      )}

      {lineIds.length > 0 && (
        <Card size="small" title="3 · Suppliers" extra={<Typography.Text type="secondary">Only suppliers able to supply the origin, not blocked and extended to the company · ranked by what they supplied to us</Typography.Text>}>
          {shortlist.isPending ? <Skeleton active /> : (shortlist.data ?? []).map((g) => (
            <div key={g.originCode} style={{ marginBottom: 10 }}>
              <Space style={{ marginBottom: 4 }}><Tag color="blue">{g.originCode}</Tag><Typography.Text strong>{chosen.filter((r) => r.originCode === g.originCode).map((r) => r.label.split(' ').slice(0, 2).join(' ')).filter((x, i, a) => a.indexOf(x) === i).join(', ')}</Typography.Text></Space>
              {g.problem ? <Alert type="warning" showIcon message={g.problem} description="It is on My work as an exception: add the origin to a supplier (Configuration → Supplier origins) or extend a supplier in SAP." /> : (
                <Table size="small" bordered pagination={false} rowKey="supplierCode" dataSource={g.entries} tableLayout="fixed"
                  columns={[
                    { title: '', key: 'c', width: 40, render: (_: unknown, e) => <Checkbox checked={suppliers.includes(e.supplierCode)} aria-label={`Invite ${e.name}`} onChange={(ev) => setSuppliers(ev.target.checked ? [...suppliers, e.supplierCode] : suppliers.filter((s) => s !== e.supplierCode))} /> },
                    { title: '#', key: 'r', width: 45, render: (_: unknown, e) => e.rank ?? '—' },
                    { title: 'Supplier', key: 's', width: 280, ellipsis: true, render: (_: unknown, e) => `${e.supplierCode} · ${e.name}` },
                    { title: 'Origins', key: 'o', width: 110, render: (_: unknown, e) => e.origins.join(', ') },
                    {
                      title: 'Our history (same material and origin)', key: 'h',
                      render: (_: unknown, e) => e.hint.matchLevel === 'NONE' ? <Typography.Text type="secondary">No history with us for this material/origin</Typography.Text> : (
                        <span><Tag color={MATCH_LABEL[e.hint.matchLevel].color}>{MATCH_LABEL[e.hint.matchLevel].label}</Tag>
                          {e.hint.poCount} POs · {n(e.hint.totalQty)} {e.hint.unit} · last {e.hint.lastPoDate}{e.hint.lastPrice ? ` at ${e.hint.lastPrice} ${e.hint.lastCurrency}` : ''} · since {e.hint.firstPoDate}</span>
                      ),
                    },
                  ]} />
              )}
            </div>
          ))}
        </Card>
      )}

      {view.length > 0 && (
        <Card size="small" title="4 · Supplier view" extra={<Typography.Text type="secondary">What suppliers see — no demand numbers</Typography.Text>}>
          <Table size="small" bordered pagination={false} rowKey="key" dataSource={view} tableLayout="fixed"
            columns={[
              { title: 'ETD week', dataIndex: 'week', width: 95 },
              { title: 'Material', dataIndex: 'label' },
              { title: 'Origin', dataIndex: 'originCode', width: 70 },
              { title: 'Quantity', key: 'q', width: 130, align: 'right', render: (_: unknown, v) => `${n(v.qty)} ${v.unit}` },
              { title: 'Containers (week)', key: 'c', width: 140, align: 'right', render: (_: unknown, v) => weeks.find((w) => w.etdWeek === v.week)?.count },
            ]} />
          {problems.length > 0 && <Alert type="error" showIcon style={{ marginTop: 8 }} message="The RFQ cannot be created" description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />}
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" icon={<FileAddOutlined />} disabled={!suppliers.length} loading={create.isPending} onClick={onCreate}>Create RFQ</Button>
            {!suppliers.length && <Typography.Text type="secondary">Choose at least one supplier.</Typography.Text>}
          </Space>
        </Card>
      )}
    </Space>
  );
}
