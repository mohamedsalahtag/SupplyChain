import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Input, Modal, Segmented, Select, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { P } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { many, one, useListFilters, type FilterField } from '../../components/ListFilters';
import { useCan } from '../../lib/auth';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { DEMAND_STATUS, errorText, newCommandId } from '../../lib/workflow';
import { StatusTag } from './DemandView';
import { StatusLegend } from '../../components/StatusTag';
import { LastStep } from '../../components/StepText';
import { Progress, TEAM_LOOK, WaitingOn } from '../../components/DemandProgress';

type Row = RouterOutputs['demand']['list']['rows'][number];
type Team = keyof typeof TEAM_LOOK;
/** Statuses the progress bar cannot show on its own (not accepted yet, merged, closed): their tag leads the Progress cell. */
const TAG_FIRST = new Set(['DRAFT', 'SUBMITTED', 'RETURNED', 'MERGED', 'CANCELLED', 'CLOSED_FULLY_EXECUTED', 'CLOSED_PARTIALLY_EXECUTED']);
const NO_BAR = new Set(['DRAFT', 'SUBMITTED', 'RETURNED']);

/** Purchasing → Demands (spec 13). */
export function DemandsListPage() {
  const { message } = App.useApp();
  const can = useCan();
  const navigate = useNavigate();
  const prefs = useTablePrefs('demands', ['companyCode', 'acceptedAt', 'version']);
  // Everyone follows every demand of their companies; "Mine" is one click away.
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState<string>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [company, setCompany] = useState<string>();

  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const opts = trpc.demand.filterOptions.useQuery();
  // The filter section (mockup list-filters): Sub-major follows the chosen Major.
  const fields = useMemo<FilterField[]>(() => {
    const cats = opts.data?.categories ?? [];
    return [
      { key: 'status', label: 'Stage', type: 'multi', options: Object.entries(DEMAND_STATUS).map(([value, d]) => ({ value, label: d.label })) },
      { key: 'waitingOn', label: 'Waiting on', type: 'multi', options: Object.entries(TEAM_LOOK).map(([value, t]) => ({ value, label: t.label })) },
      { key: 'major', label: 'Major category', type: 'multi', options: [...new Set(cats.map((c) => c.major))].map((m) => ({ value: m, label: m })) },
      { key: 'subMajor', label: 'Sub-major category', type: 'multi', parentKey: 'major',
        options: [...new Set(cats.map((c) => c.subMajor))].map((sm) => ({ value: sm, label: sm, parents: cats.filter((c) => c.subMajor === sm).map((c) => c.major) })) },
      { key: 'origin', label: 'Origin', type: 'multi', options: (opts.data?.origins ?? []).map((o) => ({ value: o.code, label: `${o.code} · ${o.name}` })) },
      { key: 'weeks', label: 'ETD week, from – to', type: 'weeks', fromKey: 'weekFrom', toKey: 'weekTo' },
      { key: 'createdBy', label: 'Created by', type: 'multi', options: (opts.data?.creators ?? []).map((u) => ({ value: u.id, label: u.name })) },
      { key: 'submitted', label: 'Submitted, from – to', type: 'dates', fromKey: 'submittedFrom', toKey: 'submittedTo' },
      { key: 'company', label: 'Company', type: 'multi', options: (companies.data ?? []).map((c) => ({ value: c.CompanyCode, label: `${c.CompanyCode} · ${c.Name}` })) },
    ];
  }, [opts.data, companies.data]);
  const filters = useListFilters(fields, () => setPage(1));
  const f = filters.applied;
  const list = trpc.demand.list.useQuery({
    mine, page, pageSize: prefs.pageSize, q, status: many(f, 'status'), waitingOn: many(f, 'waitingOn') as Team[] | undefined, major: many(f, 'major'),
    subMajor: many(f, 'subMajor'), origin: many(f, 'origin'), weekFrom: one(f, 'weekFrom'), weekTo: one(f, 'weekTo'), createdBy: many(f, 'createdBy'),
    submittedFrom: one(f, 'submittedFrom'), submittedTo: one(f, 'submittedTo'), company: many(f, 'company'),
  }, { enabled: prefs.ready, placeholderData: (p) => p });
  const myCompanies = trpc.work.tabs.useQuery(); // hasCompany
  const create = trpc.demand.create.useMutation();
  // The dialog may open before the companies have loaded: default to the first one once they arrive.
  useEffect(() => { if (creating && !company && companies.data?.length) setCompany(companies.data[0].CompanyCode); }, [creating, company, companies.data]);

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
    { title: 'Number', key: 'demandNo', dataIndex: 'demandNo', width: 115 },
    { title: 'Company', key: 'companyCode', dataIndex: 'companyCode', width: 70 },
    // Status and progress in one column: the bar, led by the status tag when the bar cannot say it (draft, waiting, merged, closed).
    { title: 'Progress', key: 'progress', width: 240, render: (_: unknown, r) => (
      <div>
        {TAG_FIRST.has(r.status) && <StatusTag status={r.status} mergedInto={r.mergedInto} />}
        {!NO_BAR.has(r.status) && <Progress p={r.progress} />}
      </div>) },
    { title: 'Waiting on', key: 'waitingOn', width: 190, render: (_: unknown, r) => <WaitingOn w={r.waitingOn} /> },
    { title: 'Last step', key: 'lastStep', width: 210, render: (_: unknown, r) => <LastStep step={r.lastStep} /> },
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
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) { setQ(undefined); setPage(1); } }}
              onSearch={(v) => { setQ(v.trim() || undefined); setPage(1); }} style={{ width: 220, maxWidth: '100%' }} />
            {filters.bar}
          </>
        }
        beforeTable={filters.panel}
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
