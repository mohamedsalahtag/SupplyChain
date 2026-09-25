import { useState } from 'react';
import { Alert, Button, Input, Space, Tag, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { useNavigate } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { MultiFilter } from '../../components/MultiFilter';
import { useCan } from '../../lib/auth';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { RFQ_STATUS } from './rfqLabels';
import { StatusLegend, StatusTag } from '../../components/StatusTag';
import { LastStep } from '../../components/StepText';

type Row = RouterOutputs['rfq']['list']['rows'][number];
type Filters = { q?: string; status?: string[]; company?: string[] };
const statusByLabel = Object.fromEntries(Object.entries(RFQ_STATUS).map(([k, v]) => [v.label, k]));

/** Purchasing → RFQs (spec 18). Quotes to record are also on My work. */
export function RfqsListPage() {
  const navigate = useNavigate();
  const can = useCan();
  const prefs = useTablePrefs('rfqs', []);
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const list = trpc.rfq.list.useQuery({ page, pageSize: prefs.pageSize, ...filters }, { enabled: prefs.ready, placeholderData: (p) => p });
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const setFilter = (patch: Filters) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };

  const columns: AppColumn<Row>[] = [
    { title: 'RFQ', key: 'rfqNo', dataIndex: 'rfqNo', width: 110 },
    { title: 'Demand', key: 'demandNo', dataIndex: 'demandNo', width: 95 },
    { title: 'Company', key: 'companyCode', dataIndex: 'companyCode', width: 80 },
    { title: 'Status', key: 'status', width: 210, render: (_: unknown, r) => <StatusTag def={RFQ_STATUS[r.status]} /> },
    { title: 'Weeks', key: 'weeks', dataIndex: 'weeks', width: 170 },
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
            <Input.Search id="rfqSearch" placeholder="RFQ or demand number" allowClear value={search} style={{ width: 210 }}
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setFilter({ q: undefined }); }} onSearch={(v) => setFilter({ q: v.trim() || undefined })} />
            <MultiFilter id="f-status" placeholder="Status" options={Object.values(RFQ_STATUS).map((s) => s.label)} value={filters.status?.map((s) => RFQ_STATUS[s].label)}
              onChange={(v) => setFilter({ status: v?.map((l) => statusByLabel[l]) })} width={170} />
            <MultiFilter id="f-company" placeholder="Company" options={(companies.data ?? []).map((c) => c.CompanyCode)} value={filters.company} onChange={(v) => setFilter({ company: v })} width={120} />
            <Button icon={<ReloadOutlined />} onClick={() => { setFilters({}); setSearch(''); setPage(1); }}>Reset</Button>
          </>
        }
      />
    </Space>
  );
}
