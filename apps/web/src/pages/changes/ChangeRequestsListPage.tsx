import { useMemo, useState } from 'react';
import { Alert, Input, Segmented, Space, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { many, one, useListFilters, type FilterField } from '../../components/ListFilters';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { APPLY_STATUS, CR_STATUS, CR_TYPE } from './ChangeRequestPage';

type Row = RouterOutputs['cr']['list']['rows'][number];

/** Purchasing → Change requests (spec 15). Requests waiting for your decision are on My work. */
export function ChangeRequestsListPage() {
  const navigate = useNavigate();
  const prefs = useTablePrefs('change-requests', ['comment', 'responseHours']);
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState<string>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const opts = trpc.cr.filterOptions.useQuery();
  // The filter section (mockup list-filters).
  const fields = useMemo<FilterField[]>(() => [
    { key: 'type', label: 'Type', type: 'multi', options: Object.entries(CR_TYPE).map(([value, label]) => ({ value, label })) },
    { key: 'status', label: 'Status', type: 'multi', options: Object.entries(CR_STATUS).map(([value, d]) => ({ value, label: d.label })) },
    { key: 'raisedBy', label: 'Raised by', type: 'multi', options: [{ value: 'SALES', label: 'Sales' }, { value: 'PROCUREMENT', label: 'Procurement' }] },
    { key: 'reason', label: 'Reason', type: 'multi', options: (opts.data?.reasons ?? []).map((r) => ({ value: r.code, label: r.description === r.code ? r.code : `${r.code} · ${r.description}` })) },
    { key: 'submitted', label: 'Submitted, from – to', type: 'dates', fromKey: 'submittedFrom', toKey: 'submittedTo' },
    { key: 'company', label: 'Company', type: 'multi', options: (companies.data ?? []).map((c) => ({ value: c.CompanyCode, label: `${c.CompanyCode} · ${c.Name}` })) },
  ], [opts.data, companies.data]);
  const filters = useListFilters(fields, () => setPage(1));
  const f = filters.applied;
  const list = trpc.cr.list.useQuery({
    mine, page, pageSize: prefs.pageSize, q, type: many(f, 'type'), status: many(f, 'status'), raisedBy: many(f, 'raisedBy') as ('SALES' | 'PROCUREMENT')[] | undefined,
    reason: many(f, 'reason'), submittedFrom: one(f, 'submittedFrom'), submittedTo: one(f, 'submittedTo'), company: many(f, 'company'),
  }, { enabled: prefs.ready, placeholderData: (p) => p });

  const columns: AppColumn<Row>[] = [
    { title: 'Number', key: 'crNo', dataIndex: 'crNo', width: 95 },
    { title: 'Demand', key: 'demandNo', dataIndex: 'demandNo', width: 90 },
    { title: 'Company', key: 'companyCode', dataIndex: 'companyCode', width: 70 },
    { title: 'Type', key: 'crType', width: 130, render: (_: unknown, r) => CR_TYPE[r.crType] },
    { title: 'Raised by', key: 'raisedBy', dataIndex: 'raisedBy', width: 120 },
    { title: 'Raised at', key: 'raisedAt', width: 125, render: (_: unknown, r) => formatDateTime(r.raisedAt) },
    { title: 'Reason', key: 'reasonCode', dataIndex: 'reasonCode', width: 110 },
    { title: 'Status', key: 'status', width: 140, render: (_: unknown, r) => <Tag color={CR_STATUS[r.status].color}>{CR_STATUS[r.status].label}</Tag> },
    { title: 'Apply status', key: 'applyStatus', width: 120, render: (_: unknown, r) => (r.applyStatus === 'NOT_REQUIRED' ? '—' : <Tag color={APPLY_STATUS[r.applyStatus].color}>{APPLY_STATUS[r.applyStatus].label}</Tag>) },
    { title: 'Decided by', key: 'decidedBy', width: 120, render: (_: unknown, r) => r.decidedBy ?? '—' },
    { title: 'Decided at', key: 'decidedAt', width: 125, render: (_: unknown, r) => formatDateTime(r.decidedAt) },
    { title: 'Comment', key: 'comment', dataIndex: 'comment', width: 220 },
    { title: 'Response (h)', key: 'responseHours', width: 90, align: 'right', render: (_: unknown, r) => r.responseHours ?? '—' },
  ];

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={10} align="baseline" wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>Change requests</Typography.Title>
        <Typography.Text type="secondary">Change requests of your companies · to decide one, use My work</Typography.Text>
      </Space>
      {list.error && <Alert type="error" showIcon message="Change requests could not be loaded" description={list.error.message} />}
      <AppTable<Row>
        prefs={prefs} itemName="change requests" rowKey="crId" columns={columns} dataSource={list.data?.rows} loading={!prefs.ready || list.isFetching}
        page={page} total={list.data?.total ?? 0} onPageChange={setPage}
        onRow={(r) => ({ onClick: () => navigate(`/change-requests/${r.crId}`), style: { cursor: 'pointer' } })}
        toolbar={
          <>
            <Segmented value={mine ? 'mine' : 'all'} onChange={(v) => { setMine(v === 'mine'); setPage(1); }} options={[{ value: 'mine', label: 'Raised by me' }, { value: 'all', label: 'All in my companies' }]} />
            <Input.Search id="crSearch" placeholder="CR or demand number" allowClear value={search} style={{ width: 200 }}
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) { setQ(undefined); setPage(1); } }} onSearch={(v) => { setQ(v.trim() || undefined); setPage(1); }} />
            {filters.bar}
          </>
        }
        beforeTable={filters.panel}
      />
    </Space>
  );
}
