import { useMemo, useState } from 'react';
import { Alert, App, Button, Card, Input, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { many, one, useListFilters, type FilterField } from '../../components/ListFilters';
import { StatusLegend, StatusTag } from '../../components/StatusTag';
import { useCan } from '../../lib/auth';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { PO_STATUS } from '../../lib/statuses';
import { trpc } from '../../lib/trpc';
import { savedPagination, useTablePrefs } from '../../lib/useTablePrefs';
import { errorText, newCommandId } from '../../lib/workflow';
import { countOf, TabLabel } from '../../components/TabLabel';

type Row = RouterOutputs['po']['list']['rows'][number];
type Status = 'DRAFT' | 'VALIDATED' | 'SUBMITTED' | 'UNKNOWN' | 'CREATED' | 'REJECTED' | 'VOID';

/** Purchasing → PO drafts & SAP (spec 23): the drafts and their SAP outcome, master data requests, the SAP stub. */
export function PoDraftsListPage() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  // Counts on the tab titles (the same queries as the tabs: shared cache)
  const drafts = trpc.po.list.useQuery({ page: 1, pageSize: 25 });
  const requests = trpc.po.requests.useQuery();
  const faults = trpc.po.faults.useQuery(undefined, { enabled: can(P.configSapEdit) });
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>PO drafts &amp; SAP</Typography.Title>
          <Typography.Text type="secondary">One purchase order per handoff, and what SAP answered</Typography.Text>
        </Space>
        <StatusLegend title="What do the PO statuses mean?" defs={PO_STATUS} />
      </div>
      <Tabs activeKey={params.get('tab') ?? 'drafts'} onChange={(k) => setParams((p) => { p.set('tab', k); return p; }, { replace: true })} items={[
        { key: 'drafts', label: <TabLabel text="PO drafts" count={drafts.data?.total} />, children: <Drafts /> },
        { key: 'mdr', label: <TabLabel text="Master data requests" count={requests.data?.filter((r) => r.status === 'OPEN').length} />, children: <Requests /> },
        ...(can(P.configSapEdit) ? [{ key: 'stub', label: <TabLabel text="SAP simulator" count={countOf(faults.data)} />, children: <Stub /> }] : []),
      ]} />
    </Space>
  );
}

function Drafts() {
  const navigate = useNavigate();
  const prefs = useTablePrefs('po-drafts', []);
  const [q, setQ] = useState<string>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const opts = trpc.po.filterOptions.useQuery();
  // The filter section (mockup list-filters).
  const fields = useMemo<FilterField[]>(() => [
    { key: 'status', label: 'Status', type: 'multi', options: Object.entries(PO_STATUS).map(([value, d]) => ({ value, label: d.label })) },
    { key: 'supplier', label: 'Supplier', type: 'multi', options: (opts.data?.suppliers ?? []).map((s) => ({ value: s.code, label: `${s.code} · ${s.name}` })) },
    { key: 'sap', label: 'SAP or simulator', type: 'multi', options: [{ value: 'SAP', label: 'SAP' }, { value: 'SIMULATED', label: 'Simulated' }] },
    { key: 'submitted', label: 'Submitted, from – to', type: 'dates', fromKey: 'submittedFrom', toKey: 'submittedTo' },
    { key: 'company', label: 'Company', type: 'multi', options: (companies.data ?? []).map((c) => ({ value: c.CompanyCode, label: `${c.CompanyCode} · ${c.Name}` })) },
  ], [opts.data, companies.data]);
  const filters = useListFilters(fields, () => setPage(1));
  const f = filters.applied;
  const list = trpc.po.list.useQuery({
    page, pageSize: prefs.pageSize, q, status: many(f, 'status') as Status[] | undefined, supplier: many(f, 'supplier'), sap: many(f, 'sap') as ('SAP' | 'SIMULATED')[] | undefined,
    submittedFrom: one(f, 'submittedFrom'), submittedTo: one(f, 'submittedTo'), company: many(f, 'company'),
  }, { enabled: prefs.ready, placeholderData: (p) => p,
    refetchInterval: (x) => (x.state.data?.rows.some((r) => r.status === 'SUBMITTED') ? 5_000 : false) }); // follow drafts waiting for SAP
  const columns: AppColumn<Row>[] = [
    { title: 'PO draft', key: 'no', dataIndex: 'poDraftNo', width: 115 },
    { title: 'SAP PO', key: 'sap', dataIndex: 'sapPoNumber', width: 110, render: (v: string | null, r: { simulated: boolean }) => (v ? (r.simulated ? <Tag color="orange" title="From the SAP simulator: nothing was created in SAP">{v}</Tag> : v) : '—') },
    { title: 'Supplier', key: 's', width: 220, render: (_: unknown, r) => <>{r.supplierName} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.supplierCode}</Typography.Text></> },
    { title: 'Handoff · demand', key: 'h', width: 170, render: (_: unknown, r) => `${r.hoNo} · ${r.demandNo}` },
    { title: 'Containers', key: 'c', dataIndex: 'containers', width: 90, align: 'right' },
    { title: 'Status', key: 'st', width: 230, render: (_: unknown, r) => <StatusTag def={PO_STATUS[r.status]} label={r.simulated && r.status === 'CREATED' ? 'Created in simulator — not in SAP' : undefined} /> },
    { title: 'Last message', key: 'e', width: 260, render: (_: unknown, r) => <Typography.Text type="secondary" ellipsis={{ tooltip: r.lastError }} style={{ fontSize: 12 }}>{r.lastError ?? '—'}</Typography.Text> },
    { title: 'Submitted', key: 'sub', width: 150, render: (_: unknown, r) => formatDateTime(r.submittedAt) },
  ];
  return (
    <>
      {list.error && <Alert type="error" showIcon message={list.error.message} />}
      <AppTable<Row> prefs={prefs} itemName="PO drafts" rowKey="poDraftId" columns={columns} dataSource={list.data?.rows} loading={!prefs.ready || list.isFetching}
        page={page} total={list.data?.total ?? 0} onPageChange={setPage} onRow={(r) => ({ onClick: () => navigate(`/po-drafts/${r.poDraftId}`), style: { cursor: 'pointer' } })}
        toolbar={<>
          <Input.Search id="poSearch" placeholder="PO draft, SAP PO, handoff, demand or supplier" allowClear value={search} style={{ width: 300 }}
            onChange={(e) => { setSearch(e.target.value); if (!e.target.value) { setQ(undefined); setPage(1); } }} onSearch={(v) => { setQ(v.trim() || undefined); setPage(1); }} />
          {filters.bar}
        </>}
        beforeTable={filters.panel} />
    </>
  );
}

function Requests() {
  const { message } = App.useApp();
  const can = useCan();
  const utils = trpc.useUtils();
  const q = trpc.po.requests.useQuery();
  const prefs = useTablePrefs('po-master-data-requests');
  const close = trpc.po.closeRequest.useMutation();
  return (
    <Table size="small" rowKey="mdrId" dataSource={q.data} loading={q.isPending} pagination={savedPagination(prefs)} locale={{ emptyText: 'No requests' }} columns={[
      { title: 'Material missing in SAP', dataIndex: 'label' }, { title: 'Request', dataIndex: 'note' },
      { title: 'Asked by', key: 'b', render: (_: unknown, r: RouterOutputs['po']['requests'][number]) => `${r.createdBy} · ${formatDateTime(r.createdAt)}` },
      { title: 'Status', key: 's', width: 110, render: (_: unknown, r: RouterOutputs['po']['requests'][number]) => <Tag color={r.status === 'OPEN' ? 'orange' : 'green'}>{r.status === 'OPEN' ? 'Open' : 'Done'}</Tag> },
      { title: '', key: 'x', width: 220, render: (_: unknown, r: RouterOutputs['po']['requests'][number]) => <Space size={0}>
        {r.handoffId && <Link to={`/handoffs/${r.handoffId}`}><Button size="small" type="link">Open handoff</Button></Link>}
        {r.status === 'OPEN' && can(P.poManage) && <Button size="small" type="link" onClick={async () => {
          try { await close.mutateAsync({ commandId: newCommandId(), mdrId: r.mdrId }); message.success('Closed — pick the SKU now'); await utils.po.invalidate(); } catch (err) { message.error(errorText(err)); }
        }}>Created in SAP — close</Button>}
      </Space> },
    ]} />
  );
}

/** Until the real SAP (ZCON) adapter: the stub, with fault injection to rehearse unknown outcomes. */
function Stub() {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const faults = trpc.po.faults.useQuery();
  const add = trpc.po.addFault.useMutation();
  const clear = trpc.po.clearFaults.useMutation();
  const proc = trpc.po.processNow.useMutation();
  const [ref, setRef] = useState('*');
  const [mode, setMode] = useState<'reject' | 'timeout-before-create' | 'timeout-after-create' | 'lookup-unknown'>('timeout-after-create');
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); message.success(ok); await utils.po.invalidate(); } catch (err) { message.error(errorText(err)); } };
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Alert type="warning" showIcon message="SAP simulator" description={<>While Configuration → <Link to="/settings?tab=sappo">SAP purchase orders</Link> is set to the simulator, purchase orders are not created in SAP. The simulator behaves like SAP (one PO per key, the portal reference is searchable) and can inject faults to rehearse rejections and unknown outcomes.</>} />
      <Card size="small" title="Inject a fault for the next submission">
        <Space wrap>
          <Input style={{ width: 150 }} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="* or POD-000001" aria-label="Reference" />
          <Select style={{ width: 240 }} value={mode} onChange={setMode} options={[
            { value: 'reject', label: 'SAP rejects the PO' }, { value: 'timeout-before-create', label: 'Timeout before the PO is created' },
            { value: 'timeout-after-create', label: 'PO created, reply lost' }, { value: 'lookup-unknown', label: 'Lookup times out' },
          ]} />
          <Button onClick={() => run(() => add.mutateAsync({ reference: ref, mode }), 'Fault added')}>Add</Button>
          <Button onClick={() => run(() => clear.mutateAsync(), 'Faults cleared')}>Clear all</Button>
          <Button icon={<SyncOutlined />} loading={proc.isPending} onClick={() => run(() => proc.mutateAsync(), 'SAP outbox run')}>Process now</Button>
        </Space>
        <Table size="small" style={{ marginTop: 8 }} pagination={false} rowKey="FaultId" dataSource={faults.data} locale={{ emptyText: 'No faults waiting' }} columns={[
          { title: 'Reference', dataIndex: 'Reference' }, { title: 'Fault', dataIndex: 'Mode' }, { title: 'Remaining', dataIndex: 'Remaining' },
        ]} />
      </Card>
    </Space>
  );
}
