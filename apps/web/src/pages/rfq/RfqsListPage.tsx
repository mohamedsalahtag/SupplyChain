import { useMemo, useState } from 'react';
import { Alert, Button, Input, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { useNavigate } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { many, one, useListFilters, type FilterField } from '../../components/ListFilters';
import { useCan } from '../../lib/auth';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { RFQ_STATUS } from './rfqLabels';
import { StatusLegend, StatusTag } from '../../components/StatusTag';
import { LastStep } from '../../components/StepText';
import { Progress, TEAM_LOOK, WaitingOn } from '../../components/DemandProgress';

type Row = RouterOutputs['rfq']['list']['rows'][number];
type Team = keyof typeof TEAM_LOOK;
/** Statuses the progress bar cannot say on its own: their tag leads the Progress cell (a draft has no bar). */
const TAG_FIRST = new Set(['DRAFT', 'CANCELLED', 'CLOSED']);

/** Purchasing → RFQs (spec 18). Quotes to record are also on My work. */
export function RfqsListPage() {
  const navigate = useNavigate();
  const can = useCan();
  const prefs = useTablePrefs('rfqs', ['companyCode']);
  const [q, setQ] = useState<string>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const opts = trpc.rfq.filterOptions.useQuery();
  // The filter section (mockup list-filters, screen 2): Sub-major follows the chosen Major.
  const fields = useMemo<FilterField[]>(() => {
    const cats = opts.data?.categories ?? [];
    return [
      { key: 'status', label: 'Stage', type: 'multi', options: Object.entries(RFQ_STATUS).map(([value, d]) => ({ value, label: d.label })) },
      { key: 'waitingOn', label: 'Waiting on', type: 'multi', options: Object.entries(TEAM_LOOK).map(([value, t]) => ({ value, label: t.label })) },
      { key: 'supplier', label: 'Supplier (invited, quoted or awarded)', type: 'multi', options: (opts.data?.suppliers ?? []).map((x) => ({ value: x.code, label: `${x.code} · ${x.name}` })) },
      { key: 'origin', label: 'Origin', type: 'multi', options: (opts.data?.origins ?? []).map((o) => ({ value: o.code, label: `${o.code} · ${o.name}` })) },
      { key: 'major', label: 'Major category', type: 'multi', options: [...new Set(cats.map((c) => c.major))].map((m) => ({ value: m, label: m })) },
      { key: 'subMajor', label: 'Sub-major category', type: 'multi', parentKey: 'major',
        options: [...new Set(cats.map((c) => c.subMajor))].map((sm) => ({ value: sm, label: sm, parents: cats.filter((c) => c.subMajor === sm).map((c) => c.major) })) },
      { key: 'weeks', label: 'ETD week, from – to', type: 'weeks', fromKey: 'weekFrom', toKey: 'weekTo' },
      { key: 'createdBy', label: 'Created by', type: 'multi', options: (opts.data?.creators ?? []).map((u) => ({ value: u.id, label: u.name })) },
      { key: 'company', label: 'Company', type: 'multi', options: (companies.data ?? []).map((c) => ({ value: c.CompanyCode, label: `${c.CompanyCode} · ${c.Name}` })) },
    ];
  }, [opts.data, companies.data]);
  const filters = useListFilters(fields, () => setPage(1));
  const f = filters.applied;
  const list = trpc.rfq.list.useQuery({
    page, pageSize: prefs.pageSize, q, status: many(f, 'status'), waitingOn: many(f, 'waitingOn') as Team[] | undefined, supplier: many(f, 'supplier'),
    origin: many(f, 'origin'), major: many(f, 'major'), subMajor: many(f, 'subMajor'), weekFrom: one(f, 'weekFrom'), weekTo: one(f, 'weekTo'),
    createdBy: many(f, 'createdBy'), company: many(f, 'company'),
  }, { enabled: prefs.ready, placeholderData: (p) => p });

  const columns: AppColumn<Row>[] = [
    { title: 'RFQ', key: 'rfqNo', dataIndex: 'rfqNo', width: 110 },
    { title: 'Demand', key: 'demandNo', dataIndex: 'demandNo', width: 95 },
    { title: 'Company', key: 'companyCode', dataIndex: 'companyCode', width: 80 },
    // Status and progress in one column: the bar, led by the status tag when the bar cannot say it (draft, cancelled, closed).
    { title: 'Progress', key: 'progress', width: 240, render: (_: unknown, r) => (
      <div>
        {TAG_FIRST.has(r.status) && <StatusTag def={RFQ_STATUS[r.status]} />}
        {(!TAG_FIRST.has(r.status) || (r.status !== 'DRAFT' && r.progress)) && <Progress p={r.progress} />}
      </div>) },
    { title: 'Waiting on', key: 'waitingOn', width: 200, render: (_: unknown, r) => <WaitingOn w={r.waitingOn} /> },
    { title: 'Weeks', key: 'weeks', dataIndex: 'weeks', width: 150 },
    { title: 'Suppliers', key: 'suppliers', width: 120, render: (_: unknown, r) => (r.status === 'DRAFT' ? `${r.suppliers} invited` : `${r.quoted} of ${r.suppliers} quoted`) },
    { title: 'Last step', key: 'lastStep', width: 280, render: (_: unknown, r) => <LastStep step={r.lastStep} /> },
    { title: 'Created', key: 'created', width: 200, render: (_: unknown, r) => `${r.createdBy} · ${formatDateTime(r.createdAt)}` },
  ];

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space size={10} align="baseline">
          <Typography.Title level={5} style={{ margin: 0 }}>RFQs</Typography.Title>
          <Typography.Text type="secondary">Requests for quotation of your companies</Typography.Text>
        </Space>
        <Space>
          <StatusLegend title="What do the RFQ statuses mean?" defs={RFQ_STATUS} />
          {can(P.rfqManage) && <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/rfqs/new')}>New RFQ</Button>}
        </Space>
      </Space>
      {list.error && <Alert type="error" showIcon message="RFQs could not be loaded" description={list.error.message} />}
      <AppTable<Row>
        prefs={prefs} itemName="RFQs" rowKey="rfqId" columns={columns} dataSource={list.data?.rows} loading={!prefs.ready || list.isFetching}
        page={page} total={list.data?.total ?? 0} onPageChange={setPage}
        onRow={(r) => ({ onClick: () => navigate(`/rfqs/${r.rfqId}`), style: { cursor: 'pointer' } })}
        toolbar={
          <>
            <Input.Search id="rfqSearch" placeholder="RFQ or demand number" allowClear value={search} style={{ width: 210, maxWidth: '100%' }}
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) { setQ(undefined); setPage(1); } }}
              onSearch={(v) => { setQ(v.trim() || undefined); setPage(1); }} />
            {filters.bar}
          </>
        }
        beforeTable={filters.panel}
      />
    </Space>
  );
}
