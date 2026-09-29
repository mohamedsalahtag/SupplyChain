import { useMemo, useState } from 'react';
import { Alert, Input, Space, Table, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { many, one, useListFilters, type FilterField } from '../../components/ListFilters';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { ACK_STATUS } from './awardLabels';
import { StatusLegend, StatusTag } from '../../components/StatusTag';
import { Progress, TEAM_LOOK, WaitingOn } from '../../components/DemandProgress';

type Row = RouterOutputs['award']['list']['rows'][number];
type Team = keyof typeof TEAM_LOOK;

const ackTag = (r: Row) => <StatusTag def={ACK_STATUS[r.ackStatus]} label={`${ACK_STATUS[r.ackStatus]?.label ?? r.ackStatus}${r.revision > 1 ? ` · revision ${r.revision}` : ''}`} />;

/** Purchasing → Awards (spec 20). */
export function AwardsListPage() {
  const navigate = useNavigate();
  const prefs = useTablePrefs('awards', ['companyCode']);
  const [q, setQ] = useState<string>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const opts = trpc.award.filterOptions.useQuery();
  // The filter section (mockup list-filters): Sub-major follows the chosen Major.
  const fields = useMemo<FilterField[]>(() => {
    const cats = opts.data?.categories ?? [];
    return [
      { key: 'waitingOn', label: 'Waiting on', type: 'multi', options: Object.entries(TEAM_LOOK).map(([value, t]) => ({ value, label: t.label })) },
      { key: 'ack', label: 'Sales acknowledgement', type: 'multi', options: Object.entries(ACK_STATUS).map(([value, d]) => ({ value, label: d.label })) },
      { key: 'supplier', label: 'Supplier', type: 'multi', options: (opts.data?.suppliers ?? []).map((x) => ({ value: x.code, label: `${x.code} · ${x.name}` })) },
      { key: 'origin', label: 'Origin', type: 'multi', options: (opts.data?.origins ?? []).map((o) => ({ value: o.code, label: `${o.code} · ${o.name}` })) },
      { key: 'major', label: 'Major category', type: 'multi', options: [...new Set(cats.map((c) => c.major))].map((m) => ({ value: m, label: m })) },
      { key: 'subMajor', label: 'Sub-major category', type: 'multi', parentKey: 'major',
        options: [...new Set(cats.map((c) => c.subMajor))].map((sm) => ({ value: sm, label: sm, parents: cats.filter((c) => c.subMajor === sm).map((c) => c.major) })) },
      { key: 'weeks', label: 'ETD week, from – to', type: 'weeks', fromKey: 'weekFrom', toKey: 'weekTo' },
      { key: 'currency', label: 'Currency', type: 'multi', options: (opts.data?.currencies ?? []).map((c) => ({ value: c, label: c })) },
      { key: 'awarded', label: 'Awarded, from – to', type: 'dates', fromKey: 'awardedFrom', toKey: 'awardedTo' },
      { key: 'company', label: 'Company', type: 'multi', options: (companies.data ?? []).map((c) => ({ value: c.CompanyCode, label: `${c.CompanyCode} · ${c.Name}` })) },
    ];
  }, [opts.data, companies.data]);
  const filters = useListFilters(fields, () => setPage(1));
  const f = filters.applied;
  const list = trpc.award.list.useQuery({
    page, pageSize: prefs.pageSize, q, ack: many(f, 'ack'), waitingOn: many(f, 'waitingOn') as Team[] | undefined, supplier: many(f, 'supplier'),
    origin: many(f, 'origin'), major: many(f, 'major'), subMajor: many(f, 'subMajor'), weekFrom: one(f, 'weekFrom'), weekTo: one(f, 'weekTo'),
    currency: many(f, 'currency'), awardedFrom: one(f, 'awardedFrom'), awardedTo: one(f, 'awardedTo'), company: many(f, 'company'),
  }, { enabled: prefs.ready, placeholderData: (p) => p });

  const columns: AppColumn<Row>[] = [
    { title: 'Award', key: 'abNo', dataIndex: 'abNo', width: 110 },
    { title: 'RFQ', key: 'rfqNo', dataIndex: 'rfqNo', width: 110 },
    { title: 'Demand', key: 'demandNo', dataIndex: 'demandNo', width: 95 },
    { title: 'Company', key: 'companyCode', dataIndex: 'companyCode', width: 80 },
    { title: 'Suppliers', key: 'suppliers', dataIndex: 'suppliers', width: 90, align: 'right' },
    { title: 'Quantity', key: 'quantity', dataIndex: 'quantity', width: 180 },
    { title: 'Progress', key: 'progress', width: 200, render: (_: unknown, r) => <Progress p={r.progress} /> },
    { title: 'Waiting on', key: 'waitingOn', width: 200, render: (_: unknown, r) => <WaitingOn w={r.waitingOn} /> },
    { title: 'Sales acknowledgement', key: 'ack', width: 200, render: (_: unknown, r) => ackTag(r) },
    { title: 'Created', key: 'created', width: 200, render: (_: unknown, r) => `${r.createdBy} · ${formatDateTime(r.createdAt)}` },
  ];

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={10} align="baseline">
        <Typography.Title level={5} style={{ margin: 0 }}>Awards</Typography.Title>
        <Typography.Text type="secondary">Quantities awarded to suppliers, where they are now, and Sales' acknowledgement</Typography.Text>
        <StatusLegend title="What do the acknowledgement statuses mean?" defs={ACK_STATUS} />
      </Space>
      {list.error && <Alert type="error" showIcon message="Awards could not be loaded" description={list.error.message} />}
      <AppTable<Row>
        prefs={prefs} itemName="awards" rowKey="awardBatchId" columns={columns} dataSource={list.data?.rows} loading={!prefs.ready || list.isFetching}
        page={page} total={list.data?.total ?? 0} onPageChange={setPage}
        onRow={(r) => ({ onClick: () => navigate(`/awards/${r.awardBatchId}`), style: { cursor: 'pointer' } })}
        toolbar={
          <>
            <Input.Search id="awardSearch" placeholder="Award, RFQ or demand number" allowClear value={search} style={{ width: 240, maxWidth: '100%' }}
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

/** The Awards tab on an RFQ or a demand. */
export function AwardsTab({ rfqId, demandId }: { rfqId?: string; demandId?: string }) {
  const navigate = useNavigate();
  const list = trpc.award.list.useQuery({ rfqId, demandId, page: 1, pageSize: 100 });
  return (
    <Table<Row> size="small" bordered pagination={false} rowKey="awardBatchId" dataSource={list.data?.rows} loading={list.isPending}
      locale={{ emptyText: 'Nothing awarded yet' }}
      onRow={(r) => ({ onClick: () => navigate(`/awards/${r.awardBatchId}`), style: { cursor: 'pointer' } })}
      columns={[
        { title: 'Award', dataIndex: 'abNo', width: 110 },
        ...(demandId ? [{ title: 'RFQ', dataIndex: 'rfqNo', width: 110 }] : []),
        { title: 'Suppliers', dataIndex: 'suppliers', width: 90, align: 'right' as const },
        { title: 'Quantity', dataIndex: 'quantity' },
        { title: 'Sales acknowledgement', key: 'ack', width: 250, render: (_: unknown, r) => ackTag(r) },
        { title: 'Created', key: 'c', width: 200, render: (_: unknown, r) => `${r.createdBy} · ${formatDateTime(r.createdAt)}` },
      ]} />
  );
}
