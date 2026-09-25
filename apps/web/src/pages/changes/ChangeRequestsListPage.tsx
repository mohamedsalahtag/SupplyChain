import { useState } from 'react';
import { Alert, Button, Input, Segmented, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { MultiFilter } from '../../components/MultiFilter';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { APPLY_STATUS, CR_STATUS, CR_TYPE } from './ChangeRequestPage';

type Row = RouterOutputs['cr']['list']['rows'][number];
type Filters = { q?: string; type?: string[]; status?: string[]; company?: string[] };
const byLabel = (m: Record<string, { label: string } | string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [typeof v === 'string' ? v : v.label, k]));

/** Purchasing → Change requests (spec 15). Requests waiting for your decision are on My work. */
export function ChangeRequestsListPage() {
  const navigate = useNavigate();
  const prefs = useTablePrefs('change-requests', ['comment', 'responseHours']);
  const [mine, setMine] = useState(false);
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const list = trpc.cr.list.useQuery({ mine, page, pageSize: prefs.pageSize, ...filters }, { enabled: prefs.ready, placeholderData: (p) => p });
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const setFilter = (patch: Filters) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };
  const typeByLabel = byLabel(CR_TYPE);
  const statusByLabel = byLabel(CR_STATUS);

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
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setFilter({ q: undefined }); }} onSearch={(v) => setFilter({ q: v.trim() || undefined })} />
            <MultiFilter id="f-type" placeholder="Type" options={Object.values(CR_TYPE)} value={filters.type?.map((t) => CR_TYPE[t])} onChange={(v) => setFilter({ type: v?.map((l) => typeByLabel[l]) })} width={170} />
            <MultiFilter id="f-status" placeholder="Status" options={Object.values(CR_STATUS).map((s) => s.label)} value={filters.status?.map((s) => CR_STATUS[s].label)}
              onChange={(v) => setFilter({ status: v?.map((l) => statusByLabel[l]) })} width={170} />
            <MultiFilter id="f-company" placeholder="Company" options={(companies.data ?? []).map((c) => c.CompanyCode)} value={filters.company} onChange={(v) => setFilter({ company: v })} width={120} />
            <Button icon={<ReloadOutlined />} onClick={() => { setFilters({}); setSearch(''); setPage(1); }}>Reset</Button>
          </>
        }
      />
    </Space>
  );
}
