import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, Modal, Segmented, Select, Space, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { P } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { MultiFilter } from '../../components/MultiFilter';
import { useCan } from '../../lib/auth';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { DEMAND_STATUS, errorText, newCommandId } from '../../lib/workflow';
import { StatusTag } from './DemandView';
import { StatusLegend } from '../../components/StatusTag';
import { LastStep, Progress } from '../../components/StepText';

type Row = RouterOutputs['demand']['list']['rows'][number];
type Filters = { q?: string; company?: string[]; status?: string[]; weekFrom?: string; weekTo?: string };
const WEEK = /^\d{4}-W\d{2}$/;
const STATUS_BY_LABEL = Object.fromEntries(Object.entries(DEMAND_STATUS).map(([k, v]) => [v.label, k]));

/** Purchasing → Demands (spec 13). */
export function DemandsListPage() {
  const { message } = App.useApp();
  const can = useCan();
  const navigate = useNavigate();
  const prefs = useTablePrefs('demands', ['acceptedAt', 'version']);
  // Everyone follows every demand of their companies; "Mine" is one click away.
  const [mine, setMine] = useState(false);
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [company, setCompany] = useState<string>();

  const list = trpc.demand.list.useQuery({ mine, page, pageSize: prefs.pageSize, ...filters }, { enabled: prefs.ready, placeholderData: (p) => p });
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const myCompanies = trpc.work.tabs.useQuery(); // hasCompany
  const create = trpc.demand.create.useMutation();
  // The dialog may open before the companies have loaded: default to the first one once they arrive.
  useEffect(() => { if (creating && !company && companies.data?.length) setCompany(companies.data[0].CompanyCode); }, [creating, company, companies.data]);

  const setFilter = (patch: Filters) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const onCreate = async () => {
    if (!company) return;
    try {
      const r = await create.mutateAsync({ commandId: newCommandId(), companyCode: company });
      setCreating(false);
      navigate(`/demands/${r.demandId}`);
    } catch (err) {
      message.error(errorText(err));
    }
  };

  const columns: AppColumn<Row>[] = [
    { title: 'Number', key: 'demandNo', dataIndex: 'demandNo', width: 95 },
    { title: 'Company', key: 'companyCode', dataIndex: 'companyCode', width: 70 },
    { title: 'Status', key: 'status', width: 200, render: (_: unknown, r) => <StatusTag status={r.status} mergedInto={r.mergedInto} /> },
    { title: 'Progress', key: 'progress', width: 170, render: (_: unknown, r) => <Progress p={r.progress} /> },
    { title: 'Last step', key: 'lastStep', width: 260, render: (_: unknown, r) => <LastStep step={r.lastStep} /> },
    { title: 'Created by', key: 'createdBy', dataIndex: 'createdBy', width: 130 },
    { title: 'Created at', key: 'createdAt', width: 130, render: (_: unknown, r) => formatDateTime(r.createdAt) },
    { title: 'Submitted', key: 'submittedAt', width: 130, render: (_: unknown, r) => formatDateTime(r.submittedAt) },
    { title: 'ETD weeks', key: 'weeks', dataIndex: 'weeks', width: 110 },
    { title: 'Containers', key: 'containers', dataIndex: 'containers', width: 80, align: 'right' },
    { title: 'Lines', key: 'lines', dataIndex: 'lines', width: 55, align: 'right' },
    { title: 'Requested', key: 'requested', width: 150, render: (_: unknown, r) => r.requested || '—' },
    { title: 'Open', key: 'open', width: 150, render: (_: unknown, r) => r.open || '—' },
    { title: 'Accepted at', key: 'acceptedAt', width: 130, render: (_: unknown, r) => formatDateTime(r.acceptedAt) },
    { title: 'Version', key: 'version', dataIndex: 'currentVersion', width: 65, align: 'right' },
  ];

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>Demands</Typography.Title>
          <Typography.Text type="secondary">Demands of your companies</Typography.Text>
        </Space>
        <Space>
        <StatusLegend title="What do the demand statuses mean?" defs={DEMAND_STATUS} />
        {can(P.demandCreate) && <Button type="primary" icon={<PlusOutlined />} onClick={() => { setCompany(companies.data?.[0]?.CompanyCode); setCreating(true); }}>New demand</Button>}
        </Space>
      </div>
      {myCompanies.data && !myCompanies.data.hasCompany && <Alert type="info" showIcon message="You are not assigned to a company yet — ask an administrator." />}
      {list.error && <Alert type="error" showIcon message="Demands could not be loaded" description={list.error.message} />}

      <AppTable<Row>
        prefs={prefs}
        itemName="demands"
        rowKey="demandId"
        columns={columns}
        dataSource={list.data?.rows}
        loading={!prefs.ready || list.isFetching}
        page={page}
        total={list.data?.total ?? 0}
        onPageChange={setPage}
        onRow={(r) => ({ onClick: () => navigate(`/demands/${r.demandId}`), style: { cursor: 'pointer' } })}
        toolbar={
          <>
            <Segmented id="mine" value={mine ? 'mine' : 'all'} onChange={(v) => { setMine(v === 'mine'); setPage(1); }}
              options={[{ value: 'mine', label: 'Mine' }, { value: 'all', label: 'All in my companies' }]} />
            <Input.Search id="demandSearch" placeholder="Search number or material" allowClear value={search}
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setFilter({ q: undefined }); }}
              onSearch={(v) => setFilter({ q: v.trim() || undefined })} style={{ width: 220, maxWidth: '100%' }} />
            <MultiFilter id="f-company" placeholder="Company" options={(companies.data ?? []).map((c) => c.CompanyCode)} value={filters.company} onChange={(v) => setFilter({ company: v })} width={130} />
            <MultiFilter id="f-status" placeholder="Status" options={Object.values(DEMAND_STATUS).map((s) => s.label)}
              value={filters.status?.map((s) => DEMAND_STATUS[s]?.label ?? s)} onChange={(v) => setFilter({ status: v?.map((l) => STATUS_BY_LABEL[l]) })} width={180} />
            <Input placeholder="Week from" allowClear style={{ width: 105 }} onChange={(e) => { const v = e.target.value.trim().toUpperCase(); if (!v || WEEK.test(v)) setFilter({ weekFrom: v || undefined }); }} />
            <Input placeholder="Week to" allowClear style={{ width: 105 }} onChange={(e) => { const v = e.target.value.trim().toUpperCase(); if (!v || WEEK.test(v)) setFilter({ weekTo: v || undefined }); }} />
            <Button icon={<ReloadOutlined />} onClick={() => { setFilters({}); setSearch(''); setPage(1); }}>Reset</Button>
          </>
        }
      />

      <Modal open={creating} title="New demand" okText="Create draft" okButtonProps={{ disabled: !company, loading: create.isPending }} onOk={onCreate} onCancel={() => setCreating(false)} destroyOnClose>
        <Typography.Text>Company</Typography.Text>
        <Select id="newDemandCompany" style={{ width: '100%', marginTop: 4 }} value={company} onChange={setCompany} placeholder="Choose a company"
          options={(companies.data ?? []).map((c) => ({ value: c.CompanyCode, label: `${c.CompanyCode} · ${c.Name}` }))} />
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          The draft gets its number now. Add ETD weeks and lines, save as often as you like, then submit to Procurement.
        </Typography.Paragraph>
      </Modal>
    </Space>
  );
}
