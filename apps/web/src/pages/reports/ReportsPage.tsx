import { useState } from 'react';
import { Alert, Button, Card, Col, DatePicker, Drawer, Empty, Input, Row, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DownloadOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { Link, useSearchParams } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { downloadXlsx } from '../../lib/excel';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { countOf, TabLabel } from '../../components/TabLabel';
import { n } from '../rfq/rfqLabels';
import { APPLY_STATUS, CR_STATUS, CR_TYPE } from '../changes/ChangeRequestPage';

const DEPT: Record<string, string> = { SALES: 'Sales', PROCUREMENT: 'Procurement' };
const crType = (v: string) => CR_TYPE[v] ?? v;
const crStatus = (v: string) => CR_STATUS[v]?.label ?? v;
const applyStatus = (v: string | null) => (v && v !== 'NOT_REQUIRED' && v !== 'NONE' ? APPLY_STATUS[v]?.label ?? v : '');

type Filter = { q?: string; from?: string; to?: string };
type Exec = RouterOutputs['reports']['execution'][number];
type Cr = RouterOutputs['reports']['changeRequests'][number];
const pct = (v: number | null) => (v === null ? <Tooltip title="Nothing to measure yet (the denominator is zero)"><Typography.Text type="secondary">N/A</Typography.Text></Tooltip> : `${v}%`);
const hrs = (v: number | null) => (v === null ? 'N/A' : v >= 48 ? `${Math.round((v / 24) * 10) / 10} days` : `${v} h`);
const today = () => new Date().toISOString().slice(0, 10);

/** Reports (spec 24): execution by business origin, one demand in detail, the change request register, performance. */
export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>({});
  const [search, setSearch] = useState('');
  // Row counts on the tab titles: the same queries the tabs run (shared cache)
  const execCount = trpc.reports.execution.useQuery(filter, { placeholderData: (p) => p });
  const crCount = trpc.reports.changeRequests.useQuery(filter, { placeholderData: (p) => p });
  const setRange = (r: [Dayjs | null, Dayjs | null] | null) =>
    setFilter((f) => ({ ...f, from: r?.[0]?.format('YYYY-MM-DD'), to: r?.[1]?.format('YYYY-MM-DD') }));
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>Reports</Typography.Title>
          <Typography.Text type="secondary">What was asked, what was ordered, and how long it took. Quantities are never added across units.</Typography.Text>
        </Space>
        <Space wrap>
          <Input.Search id="repSearch" placeholder="Demand or change request number" allowClear value={search} style={{ width: 260 }}
            onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setFilter((f) => ({ ...f, q: undefined })); }}
            onSearch={(v) => setFilter((f) => ({ ...f, q: v.trim() || undefined }))} />
          <DatePicker.RangePicker id="repRange" allowEmpty={[true, true]} onChange={(r) => setRange(r as [Dayjs | null, Dayjs | null] | null)} />
        </Space>
      </div>
      <Tabs activeKey={params.get('tab') ?? 'execution'} onChange={(k) => setParams({ tab: k }, { replace: true })} destroyOnHidden items={[
        { key: 'execution', label: <TabLabel text="Demand execution" count={countOf(execCount.data)} />, children: <Execution filter={filter} /> },
        { key: 'cr', label: <TabLabel text="Change request register" count={countOf(crCount.data)} />, children: <CrRegister filter={filter} /> },
        { key: 'performance', label: 'Performance', children: <Performance filter={filter} /> },
      ]} />
    </Space>
  );
}

function Execution({ filter }: { filter: Filter }) {
  const q = trpc.reports.execution.useQuery(filter, { placeholderData: (p) => p });
  const prefs = useTablePrefs('report-execution', ['sc', 'pa']);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string>();
  const rows = q.data ?? [];
  const exportXlsx = () => downloadXlsx(`demand-execution-${today()}`, [{ name: 'Demand execution', header: ['Demand', 'Company', 'Unit', 'Accepted', 'Committed', 'Executed (PO created)', 'Not sourced', 'Cancelled by Sales', 'Outstanding', 'Procurement added', 'Procurement ordered', 'Execution %', 'Not sourced %'],
    rows: rows.map((r) => [r.demandNo, r.companyCode, r.unit, r.acceptedAt?.slice(0, 10), r.committed, r.executed, r.notSourced, r.salesCancelled, r.outstanding, r.procApproved, r.procOrdered, r.executionRate ?? 'N/A', r.notSourcedRate ?? 'N/A']) }]);
  const columns: AppColumn<Exec>[] = [
    { title: 'Demand', key: 'd', dataIndex: 'demandNo', width: 100 }, { title: 'Company', key: 'co', dataIndex: 'companyCode', width: 75 }, { title: 'Unit', key: 'u', dataIndex: 'unit', width: 55 },
    { title: 'Committed', key: 'c', width: 100, align: 'right', render: (_: unknown, r) => n(r.committed) },
    { title: 'Executed', key: 'e', width: 100, align: 'right', render: (_: unknown, r) => n(r.executed) },
    { title: 'Outstanding', key: 'o', width: 100, align: 'right', render: (_: unknown, r) => n(r.outstanding) },
    { title: 'Not sourced', key: 'ns', width: 100, align: 'right', render: (_: unknown, r) => n(r.notSourced) },
    { title: 'Cancelled by Sales', key: 'sc', width: 110, align: 'right', render: (_: unknown, r) => n(r.salesCancelled) },
    { title: 'Procurement added · ordered', key: 'pa', width: 150, align: 'right', render: (_: unknown, r) => (Number(r.procApproved) ? `${n(r.procApproved)} · ${n(r.procOrdered)}` : '—') },
    { title: 'Execution', key: 'rate', width: 85, align: 'right', render: (_: unknown, r) => pct(r.executionRate) },
  ];
  return (
    <>
      {q.error && <Alert type="error" showIcon message={q.error.message} />}
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message="How to read it"
        description={<>Committed = what Sales asked for and did not cancel (merged-away quantity counts on the demand it merged into). Executed = SAP PO created.
          Not sourced = cancelled by Procurement. Quantity Procurement added (extra containers) is shown apart and is not part of the execution rate. Click a row for the demand in detail.</>} />
      <AppTable<Exec> prefs={prefs} itemName="demand × unit rows (accepted demands)" rowKey={(r) => `${r.demandId}|${r.unit}`} columns={columns} loading={!prefs.ready || q.isFetching}
        dataSource={rows.slice((page - 1) * prefs.pageSize, page * prefs.pageSize)} page={page} total={rows.length} onPageChange={setPage}
        onRow={(r) => ({ onClick: () => setOpen(r.demandId), style: { cursor: 'pointer' } })}
        toolbar={<Button icon={<DownloadOutlined />} disabled={!rows.length} onClick={() => void exportXlsx()}>Export to Excel</Button>} />
      <DemandDrawer demandId={open} onClose={() => setOpen(undefined)} />
    </>
  );
}

function DemandDrawer({ demandId, onClose }: { demandId?: string; onClose: () => void }) {
  const q = trpc.reports.demand.useQuery({ demandId: demandId ?? '0' }, { enabled: !!demandId });
  const d = q.data;
  const exportXlsx = () => d && downloadXlsx(`${d.demandNo}-execution`, [{ name: 'Lines', title: `${d.demandNo} · company ${d.companyCode}`, header: ['Week', 'Material', 'Unit', 'Baseline (v1)', 'Requested now', 'Open', 'In RFQ', 'Awarded', 'Handed off', 'PO submitted', 'PO created', 'Cancelled by Sales', 'Not sourced', 'Cancelled by change', 'Merged in', 'Merged out', 'Procurement added', 'SAP POs'],
    rows: d.lines.map((l) => [l.week, l.label, l.unit, l.baseline ?? '', l.requested, l.open, l.inRfq, l.awarded, l.handedOff, l.poSubmitted, l.poCreated, l.cancelledSales, l.notSourced, l.cancelledChange, l.mergedIn, l.mergedOut, l.procurementAdded, l.sapPos.join(' ')]) },
    { name: 'Containers per week', header: ['Week', 'Baseline (v1)', 'Now', 'Awarded', 'Ordered (SAP PO)'], rows: d.weeks.map((w) => [w.week, w.baseline, w.current, w.awarded, w.ordered]) }]);
  return (
    <Drawer open={!!demandId} onClose={onClose} width={Math.min(1200, window.innerWidth - 40)} destroyOnHidden
      title={d ? <Space>{d.demandNo}<Link to={`/demands/${d.demandId}`}><Button size="small" type="link">Open the demand</Button></Link></Space> : 'Demand'}
      extra={<Button size="small" icon={<DownloadOutlined />} disabled={!d} onClick={() => void exportXlsx()}>Export to Excel</Button>}>
      {q.error && <Alert type="error" showIcon message={q.error.message} />}
      {d && <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Typography.Text type="secondary">Company {d.companyCode} · accepted {formatDateTime(d.acceptedAt)} · baseline = version 1 as accepted{d.baselineAvailable ? '' : ' (not available)'}</Typography.Text>
        <Card size="small" title="Containers per week">
          <Table size="small" pagination={false} rowKey="week" dataSource={d.weeks} columns={[
            { title: 'Week', dataIndex: 'week' }, { title: 'Baseline', dataIndex: 'baseline', align: 'right', render: (v: number | null) => v ?? '—' },
            { title: 'Now', dataIndex: 'current', align: 'right', render: (v: number | null) => v ?? '—' },
            { title: 'Awarded', dataIndex: 'awarded', align: 'right' }, { title: 'Ordered (SAP PO)', dataIndex: 'ordered', align: 'right' },
          ]} />
        </Card>
        <Card size="small" title="Lines — where the quantity is now">
          <Table size="small" pagination={false} rowKey="lineId" dataSource={d.lines} tableLayout="fixed" columns={[
            { title: 'Week', dataIndex: 'week', width: 80 }, { title: 'Material', dataIndex: 'label', width: 200, ellipsis: { showTitle: true } }, { title: 'Unit', dataIndex: 'unit', width: 45 },
            ...(['baseline', 'requested', 'open', 'inRfq', 'awarded', 'handedOff', 'poSubmitted', 'poCreated', 'cancelledSales', 'notSourced', 'cancelledChange', 'mergedIn', 'mergedOut', 'procurementAdded'] as const).map((k) => ({
              title: { baseline: 'Baseline', requested: 'Requested', open: 'Open', inRfq: 'In RFQ', awarded: 'Awarded', handedOff: 'Handed off', poSubmitted: 'PO submitted', poCreated: 'PO created',
                cancelledSales: 'Cancelled (Sales)', notSourced: 'Not sourced', cancelledChange: 'Cancelled (change)', mergedIn: 'Merged in', mergedOut: 'Merged out', procurementAdded: 'Proc. added' }[k],
              key: k, align: 'right' as const, width: 70, render: (_: unknown, l: (typeof d.lines)[number]) => (l[k] === null || Number(l[k]) === 0 ? <Typography.Text type="secondary">—</Typography.Text> : n(l[k]!)),
            })),
            { title: 'SAP POs', key: 'po', width: 110, render: (_: unknown, l) => l.sapPos.map((p) => <Tag key={p}>{p}</Tag>) },
          ]} />
        </Card>
      </Space>}
    </Drawer>
  );
}

function CrRegister({ filter }: { filter: Filter }) {
  const q = trpc.reports.changeRequests.useQuery(filter, { placeholderData: (p) => p });
  const prefs = useTablePrefs('report-cr-register', []);
  const [page, setPage] = useState(1);
  const rows = q.data ?? [];
  const exportXlsx = () => downloadXlsx(`change-requests-${today()}`, [{ name: 'Change requests', header: ['CR', 'Demand', 'Company', 'Type', 'Raised by', 'Department', 'Submitted', 'Reason', 'Comment', 'Status', 'Applied', 'Decided by', 'Decided', 'Response hours', 'Decision comment', 'Requested', 'Approved', 'Applied qty', 'Unit'],
    rows: rows.map((r) => [r.crNo, r.demandNo, r.companyCode, crType(r.type), r.raisedBy, DEPT[r.raisedByDept] ?? r.raisedByDept, r.submittedAt.slice(0, 16), r.reason, r.comment, crStatus(r.status), applyStatus(r.applyStatus),
      r.decidedBy, r.decidedAt?.slice(0, 16), r.responseHours, r.decisionComment, r.requested, r.approved, r.applied, r.unit]) }]);
  const columns: AppColumn<Cr>[] = [
    { title: 'CR', key: 'no', width: 105, render: (_: unknown, r) => <Link to={`/change-requests/${r.crId}`} onClick={(e) => e.stopPropagation()}>{r.crNo}</Link> },
    { title: 'Demand', key: 'd', width: 100, render: (_: unknown, r) => <Link to={`/demands/${r.demandId}`}>{r.demandNo}</Link> },
    { title: 'Type', key: 't', width: 130, render: (_: unknown, r) => crType(r.type) },
    { title: 'Raised', key: 'r', width: 200, render: (_: unknown, r) => <>{r.raisedBy} <Typography.Text type="secondary" style={{ fontSize: 12 }}>({DEPT[r.raisedByDept] ?? r.raisedByDept}) {formatDateTime(r.submittedAt)}</Typography.Text></> },
    { title: 'Reason', key: 'why', width: 220, render: (_: unknown, r) => `${r.reason} · ${r.comment}` },
    { title: 'Status', key: 's', width: 160, render: (_: unknown, r) => <>{crStatus(r.status)}{applyStatus(r.applyStatus) ? <Typography.Text type="secondary"> · {applyStatus(r.applyStatus)}</Typography.Text> : null}</> },
    { title: 'Decided', key: 'dec', width: 190, render: (_: unknown, r) => (r.decidedAt ? <>{r.decidedBy} <Typography.Text type="secondary" style={{ fontSize: 12 }}>after {hrs(r.responseHours)}</Typography.Text></> : '—') },
    { title: 'Requested · approved · applied', key: 'q', width: 200, align: 'right', render: (_: unknown, r) => (r.requested === null ? (r.unit === 'several units' ? 'several units' : '—') : `${n(r.requested)} · ${r.approved === null ? '—' : n(r.approved)} · ${r.applied === null ? '—' : n(r.applied)} ${r.unit ?? ''}`) },
  ];
  return (
    <>
      {q.error && <Alert type="error" showIcon message={q.error.message} />}
      <AppTable<Cr> prefs={prefs} itemName="change requests" rowKey="crId" columns={columns} loading={!prefs.ready || q.isFetching}
        dataSource={rows.slice((page - 1) * prefs.pageSize, page * prefs.pageSize)} page={page} total={rows.length} onPageChange={setPage}
        toolbar={<Button icon={<DownloadOutlined />} disabled={!rows.length} onClick={() => void exportXlsx()}>Export to Excel</Button>} />
    </>
  );
}

/** Without dates the performance report covers the last 3 months: over years of history it is the heaviest query (database review 2026-09). */
const lastQuarter = () => new Date(Date.now() - 91 * 86_400_000).toISOString().slice(0, 10);

function Performance({ filter }: { filter: Filter }) {
  const defaulted = !filter.from && !filter.to;
  const q = trpc.reports.performance.useQuery(defaulted ? { ...filter, from: lastQuarter() } : filter, { placeholderData: (p) => p });
  const p = q.data;
  if (q.error) return <Alert type="error" showIcon message={q.error.message} />;
  if (!p) return <Card loading />;
  const exportXlsx = () => downloadXlsx(`performance-${today()}`, [
    { name: 'Headline', header: ['Unit', 'Committed', 'Executed', 'Outstanding', 'Execution %', 'Not sourced %', `On time % (≥ ${p.onTimeDays} days before ETD)`, 'Accepted → PO created (h)', 'Procurement added', 'Procurement ordered'],
      rows: p.headline.map((u) => [u.unit, u.committed, u.executed, u.outstanding, u.executionRate ?? 'N/A', u.notSourcedRate ?? 'N/A', u.onTimeRate ?? 'N/A', u.endToEndHours ?? 'N/A', u.procApproved, u.procOrdered]) },
    { name: 'Stage times', header: ['Unit', 'Stage', 'Hours (quantity-weighted)'], rows: p.headline.flatMap((u) => u.stages.map((st) => [u.unit, st.label, st.hours ?? 'N/A'])) },
    { name: 'Other KPIs', header: ['Area', 'Measure', 'Value'], rows: [
      ...p.crResponse.map((c) => ['Change requests', `Decided by ${c.decidedBy} · average hours`, c.avgHours ?? 'N/A']),
      ['Acknowledgement', 'Award batches', p.acknowledgement.batches], ['Acknowledgement', 'Average hours to acknowledge', p.acknowledgement.avgHoursToAck ?? 'N/A'],
      ['Acknowledgement', 'Resets by award changes', p.acknowledgement.resets], ['Acknowledgement', 'Handed off without it', p.acknowledgement.handedOffWithoutAck],
      ['Handoffs', 'Handoffs', p.handoffs.handoffs], ['Handoffs', 'Returned by the PO team', p.handoffs.returnedByPoTeam], ['Handoffs', 'Return rate %', p.handoffs.returnRate ?? 'N/A'],
      ['Handoffs', 'Returned automatically', p.handoffs.returnedAutomatically], ['Handoffs', 'SKU issues', p.handoffs.skuIssues], ['Handoffs', 'Sent without acknowledgement', p.handoffs.sentWithoutAck],
      ['SAP', 'Submitted', p.sap.submitted], ['SAP', 'Created on the first reply', p.sap.createdFirstReply], ['SAP', 'First-reply rate %', p.sap.firstReplyRate ?? 'N/A'],
      ['SAP', 'Created after a lookup', p.sap.createdAfterReconcile], ['SAP', 'Resolved by hand', p.sap.manualResolutions], ['SAP', 'Rejected', p.sap.rejected], ['SAP', 'Unknown now', p.sap.unknownNow],
    ] },
  ]);
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {defaulted && <Alert type="info" showIcon message={`Last 3 months (demands accepted since ${lastQuarter()}). Pick dates above for another period.`} />}
      <div style={{ textAlign: 'right' }}><Button icon={<DownloadOutlined />} disabled={!p.headline.length} onClick={() => void exportXlsx()}>Export to Excel</Button></div>
      {p.headline.length === 0 && <Empty description="No accepted demands in this period" />}
      {p.headline.map((u) => (
        <Card key={u.unit} size="small" title={<>Unit {u.unit} <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>— rates are quantity-weighted; not combined with other units</Typography.Text></>}>
          <Row gutter={[16, 8]}>
            <Col xs={12} md={4}><Statistic title="Committed" value={n(u.committed)} /></Col>
            <Col xs={12} md={4}><Statistic title="Executed (PO created)" value={n(u.executed)} /></Col>
            <Col xs={12} md={4}><Statistic title="Execution rate" valueRender={() => pct(u.executionRate)} /></Col>
            <Col xs={12} md={4}><Statistic title="Not sourced" valueRender={() => pct(u.notSourcedRate)} /></Col>
            <Col xs={12} md={4}><Statistic title={<>On time <Tooltip title={`PO created at least ${p.onTimeDays} days before the confirmed ETD (setting under Configuration → Workflow)`}><InfoCircleOutlined /></Tooltip></>} valueRender={() => pct(u.onTimeRate)} /></Col>
            <Col xs={12} md={4}><Statistic title="Accepted → PO created" value={hrs(u.endToEndHours)} /></Col>
          </Row>
          <Table size="small" style={{ marginTop: 8 }} pagination={false} rowKey="label" dataSource={u.stages} columns={[
            { title: 'Stage (average, weighted by quantity; PO-created quantity only)', dataIndex: 'label' }, { title: 'Time', dataIndex: 'hours', align: 'right', render: (v: number | null) => hrs(v) },
          ]} />
          {Number(u.procApproved) > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Procurement added {n(u.procApproved)} {u.unit}, ordered {n(u.procOrdered)} — outside the execution rate.</Typography.Text>}
        </Card>
      ))}
      <Row gutter={12}>
        <Col xs={24} md={12} xl={6}><Card size="small" title="Change requests — response">
          {p.crResponse.length ? p.crResponse.map((c) => <div key={c.decidedBy}>{c.decidedBy} decided {c.decided}, average {hrs(c.avgHours)}</div>) : <Typography.Text type="secondary">None decided</Typography.Text>}
        </Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="Sales acknowledgement">
          <div>{p.acknowledgement.batches} award batch(es), average {hrs(p.acknowledgement.avgHoursToAck)} to answer</div>
          <div>{p.acknowledgement.resets} reset(s) by award changes · {p.acknowledgement.handedOffWithoutAck} handed off without it</div>
        </Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="Handoffs">
          <div>{p.handoffs.handoffs} handoff(s), {p.handoffs.sentWithoutAck} without acknowledgement</div>
          <div>Returned by the PO team {p.handoffs.returnedByPoTeam} ({pct(p.handoffs.returnRate)}) · automatically {p.handoffs.returnedAutomatically} · SKU issues {p.handoffs.skuIssues}</div>
        </Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="SAP">
          <div>{p.sap.submitted} submitted · created on the first reply {p.sap.createdFirstReply} ({pct(p.sap.firstReplyRate)})</div>
          <div>after a lookup {p.sap.createdAfterReconcile} · resolved by hand {p.sap.manualResolutions} · rejected {p.sap.rejected} · unknown now {p.sap.unknownNow}</div>
        </Card></Col>
      </Row>
    </Space>
  );
}
