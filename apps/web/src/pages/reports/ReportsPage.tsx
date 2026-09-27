import { useState } from 'react';
import { Alert, Button, Card, DatePicker, Drawer, Input, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { Link, useSearchParams } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { MultiFilter } from '../../components/MultiFilter';
import { downloadXlsx } from '../../lib/excel';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { TabLabel } from '../../components/TabLabel';
import { n } from '../rfq/rfqLabels';
import { APPLY_STATUS, CR_STATUS, CR_TYPE } from '../changes/ChangeRequestPage';
import { ArrivalsTab } from './ArrivalsTab';
import { DashboardTab } from './DashboardTab';
import { aboutExport, pct, Small, Updating, useFilterPage } from './dashboardParts';
import { PerformanceTab } from './PerformanceTab';
import { SuppliersTab } from './SuppliersTab';
import { TrendTab } from './TrendTab';

const DEPT: Record<string, string> = { SALES: 'Sales', PROCUREMENT: 'Procurement' };
const crType = (v: string) => CR_TYPE[v] ?? v;
const crStatus = (v: string) => CR_STATUS[v]?.label ?? v;
const applyStatus = (v: string | null) => (v && v !== 'NOT_REQUIRED' && v !== 'NONE' ? APPLY_STATUS[v]?.label ?? v : '');

type Filter = { q?: string; from?: string; to?: string; company?: string[] };
type Exec = RouterOutputs['reports']['execution'][number];
type Cr = RouterOutputs['reports']['changeRequests'][number];
const hrs = (v: number | null) => (v === null ? 'N/A' : v >= 48 ? `${Math.round((v / 24) * 10) / 10} days` : `${v} h`);
const today = () => new Date().toISOString().slice(0, 10);

/** What the search box matches on each tab; the Dashboard and Trend have no search (they show everything of the companies and dates). */
const SEARCH: Record<string, string | null> = {
  dashboard: null, trend: null, arrivals: 'Demand, supplier, material or SAP PO', execution: 'Demand number', cr: 'Change request or demand number',
  performance: 'Demand number (every section)', suppliers: 'Supplier name or code',
};

/** Reports: the Dashboard (spec 26) first, then execution by business origin, one demand in detail, the change request register, performance (spec 24). */
export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>({});
  const [search, setSearch] = useState('');
  const tab = params.get('tab') ?? 'dashboard';
  const searchHint = SEARCH[tab] ?? null;
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  // Row counts on the tab titles: COUNT queries only (reports.counts); each tab loads its own data when it is opened.
  const counts = trpc.reports.counts.useQuery(filter, { placeholderData: (p) => p });
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
          <MultiFilter id="repCompany" placeholder="Company" options={(companies.data ?? []).map((c) => c.CompanyCode)} value={filter.company} onChange={(v) => setFilter((f) => ({ ...f, company: v }))} width={140} />
          <Tooltip title={searchHint ? `Search: ${searchHint}` : 'The Dashboard and Trend show everything of the chosen companies and dates: the search does not apply here'}>
            <Input.Search id="repSearch" aria-label={searchHint ? `Search: ${searchHint}` : 'Search (not used on this tab)'} placeholder={searchHint ?? 'No search on this tab'} allowClear value={search} style={{ width: 290 }}
              disabled={!searchHint}
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setFilter((f) => ({ ...f, q: undefined })); }}
              onSearch={(v) => setFilter((f) => ({ ...f, q: v.trim() || undefined }))} />
          </Tooltip>
          <DatePicker.RangePicker id="repRange" allowEmpty={[true, true]} onChange={(r) => setRange(r as [Dayjs | null, Dayjs | null] | null)} />
        </Space>
      </div>
      {counts.error && <Alert type="error" showIcon message={counts.error.message} />}
      <Tabs activeKey={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} destroyOnHidden items={[
        { key: 'dashboard', label: 'Dashboard', children: <DashboardTab filter={{ company: filter.company, from: filter.from, to: filter.to }} /> },
        { key: 'arrivals', label: <TabLabel text="Arrivals" count={counts.data?.arrivals} />, children: <ArrivalsTab filter={filter} /> },
        { key: 'execution', label: <TabLabel text="Demand execution" count={counts.data?.execution} />, children: <Execution filter={filter} /> },
        { key: 'cr', label: <TabLabel text="Change request register" count={counts.data?.changeRequests} />, children: <CrRegister filter={filter} /> },
        { key: 'performance', label: 'Performance', children: <PerformanceTab filter={filter} /> },
        { key: 'suppliers', label: <TabLabel text="Suppliers" count={counts.data?.suppliers} />, children: <SuppliersTab filter={filter} /> },
        { key: 'trend', label: 'Trend', children: <TrendTab filter={{ company: filter.company, from: filter.from, to: filter.to }} /> },
      ]} />
    </Space>
  );
}

function Execution({ filter }: { filter: Filter }) {
  const q = trpc.reports.execution.useQuery(filter, { placeholderData: (p) => p });
  const prefs = useTablePrefs('report-execution', ['sc', 'pa']);
  const [page, setPage] = useFilterPage(filter);
  const [open, setOpen] = useState<string>();
  const rows = q.data ?? [];
  const exportXlsx = () => downloadXlsx(`demand-execution-${today()}`, [{ name: 'Demand execution',
    numeric: ['Committed', 'Executed (PO created)', 'Not sourced', 'Cancelled by Sales', 'Outstanding', 'Procurement added', 'Procurement ordered', 'Execution %', 'Not sourced %'], header: ['Demand', 'Company', 'Unit', 'Accepted', 'Committed', 'Executed (PO created)', 'Not sourced', 'Cancelled by Sales', 'Outstanding', 'Procurement added', 'Procurement ordered', 'Execution %', 'Not sourced %'],
    rows: rows.map((r) => [r.demandNo, r.companyCode, r.unit, r.acceptedAt?.slice(0, 10), r.committed, r.executed, r.notSourced, r.salesCancelled, r.outstanding, r.procApproved, r.procOrdered, r.executionRate ?? 'N/A', r.notSourcedRate ?? 'N/A']) }],
    aboutExport('Demand execution', filter, ['One row per accepted demand and unit; demands accepted in the period. Add quantities only within one unit.']));
  const columns: AppColumn<Exec>[] = [
    // A real button, so keyboard users can open the demand's detail too (the row click is a mouse shortcut).
    { title: 'Demand', key: 'd', width: 100, render: (_: unknown, r) => <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={(e) => { e.stopPropagation(); setOpen(r.demandId); }}>{r.demandNo}</Button> }, { title: 'Company', key: 'co', dataIndex: 'companyCode', width: 75 }, { title: 'Unit', key: 'u', dataIndex: 'unit', width: 55 },
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
          Not sourced = cancelled by Procurement. Quantity Procurement added (extra containers) is shown apart and is not part of the execution rate. Click a demand number (or the row) for the demand in detail.</>} />
      <AppTable<Exec> prefs={prefs} itemName="demand × unit rows (accepted demands)" rowKey={(r) => `${r.demandId}|${r.unit}`} columns={columns} loading={!prefs.ready || q.isFetching}
        dataSource={rows.slice((page - 1) * prefs.pageSize, page * prefs.pageSize)} page={page} total={rows.length} onPageChange={setPage}
        onRow={(r) => ({ onClick: () => setOpen(r.demandId), style: { cursor: 'pointer' } })}
        toolbar={<Space><Button icon={<DownloadOutlined />} disabled={!rows.length} onClick={() => void exportXlsx()}>Export to Excel</Button><Updating show={q.isPlaceholderData} /></Space>} />
      <DemandDrawer demandId={open} onClose={() => setOpen(undefined)} />
    </>
  );
}

function DemandDrawer({ demandId, onClose }: { demandId?: string; onClose: () => void }) {
  const q = trpc.reports.demand.useQuery({ demandId: demandId ?? '0' }, { enabled: !!demandId });
  const d = q.data;
  const exportXlsx = () => d && downloadXlsx(`${d.demandNo}-execution`, [{ name: 'Lines', numeric: ['Baseline (v1)', 'Requested now', 'Open', 'In RFQ', 'Awarded', 'Handed off', 'PO submitted', 'PO created', 'Cancelled by Sales', 'Not sourced', 'Cancelled by change', 'Merged in', 'Merged out', 'Procurement added'], title: `${d.demandNo} · company ${d.companyCode}`, header: ['Week', 'Material', 'Unit', 'Baseline (v1)', 'Requested now', 'Open', 'In RFQ', 'Awarded', 'Handed off', 'PO submitted', 'PO created', 'Cancelled by Sales', 'Not sourced', 'Cancelled by change', 'Merged in', 'Merged out', 'Procurement added', 'SAP POs'],
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
  const [page, setPage] = useFilterPage(filter);
  const rows = q.data ?? [];
  const exportXlsx = () => downloadXlsx(`change-requests-${today()}`, [{ name: 'Change requests', numeric: ['Response hours', 'Requested', 'Approved', 'Applied qty'], header: ['CR', 'Demand', 'Company', 'Type', 'Raised by', 'Department', 'Submitted', 'Reason', 'Comment', 'Status', 'Applied', 'Decided by', 'Decided', 'Response hours', 'Decision comment', 'Requested', 'Approved', 'Applied qty', 'Unit'],
    rows: rows.map((r) => [r.crNo, r.demandNo, r.companyCode, crType(r.type), r.raisedBy, DEPT[r.raisedByDept] ?? r.raisedByDept, r.submittedAt.slice(0, 16), r.reason, r.comment, crStatus(r.status), applyStatus(r.applyStatus),
      r.decidedBy, r.decidedAt?.slice(0, 16), r.responseHours, r.decisionComment, r.requested, r.approved, r.applied, r.unit]) }],
    aboutExport('Change request register', filter, ['Change requests submitted in the period. Quantities are summed only when all items of a request share one unit.']));
  const columns: AppColumn<Cr>[] = [
    { title: 'CR', key: 'no', width: 105, render: (_: unknown, r) => <Link to={`/change-requests/${r.crId}`} onClick={(e) => e.stopPropagation()}>{r.crNo}</Link> },
    { title: 'Demand', key: 'd', width: 100, render: (_: unknown, r) => <Link to={`/demands/${r.demandId}`}>{r.demandNo}</Link> },
    { title: 'Type', key: 't', width: 130, render: (_: unknown, r) => crType(r.type) },
    { title: 'Raised', key: 'r', width: 200, render: (_: unknown, r) => <>{r.raisedBy} <Small>({DEPT[r.raisedByDept] ?? r.raisedByDept}) {formatDateTime(r.submittedAt)}</Small></> },
    { title: 'Reason', key: 'why', width: 220, render: (_: unknown, r) => `${r.reason} · ${r.comment}` },
    { title: 'Status', key: 's', width: 160, render: (_: unknown, r) => <>{crStatus(r.status)}{applyStatus(r.applyStatus) ? <Typography.Text type="secondary"> · {applyStatus(r.applyStatus)}</Typography.Text> : null}</> },
    { title: 'Decided', key: 'dec', width: 190, render: (_: unknown, r) => (r.decidedAt ? <>{r.decidedBy} <Small>after {hrs(r.responseHours)}</Small></> : '—') },
    { title: 'Requested · approved · applied', key: 'q', width: 200, align: 'right', render: (_: unknown, r) => (r.requested === null ? (r.unit === 'several units' ? 'several units' : '—') : `${n(r.requested)} · ${r.approved === null ? '—' : n(r.approved)} · ${r.applied === null ? '—' : n(r.applied)} ${r.unit ?? ''}`) },
  ];
  return (
    <>
      {q.error && <Alert type="error" showIcon message={q.error.message} />}
      <AppTable<Cr> prefs={prefs} itemName="change requests" rowKey="crId" columns={columns} loading={!prefs.ready || q.isFetching}
        dataSource={rows.slice((page - 1) * prefs.pageSize, page * prefs.pageSize)} page={page} total={rows.length} onPageChange={setPage}
        toolbar={<Space><Button icon={<DownloadOutlined />} disabled={!rows.length} onClick={() => void exportXlsx()}>Export to Excel</Button><Updating show={q.isPlaceholderData} /></Space>} />
    </>
  );
}
