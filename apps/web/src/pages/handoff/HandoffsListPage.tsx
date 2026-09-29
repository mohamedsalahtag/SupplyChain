import { useMemo, useState } from 'react';
import { Alert, Input, Space, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { many, one, useListFilters, type FilterField } from '../../components/ListFilters';
import { StatusLegend, StatusTag } from '../../components/StatusTag';
import { LastStep } from '../../components/StepText';
import type { RouterOutputs } from '../../lib/format';
import { HANDOFF_STATUS } from '../../lib/statuses';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';

type Row = RouterOutputs['handoff']['list']['rows'][number];
type Status = 'HANDED_OFF' | 'ACCEPTED' | 'RETURNED';

/** Purchasing → Handoffs (spec 22): one row per supplier award handed to the PO team. */
export function HandoffsListPage() {
  const navigate = useNavigate();
  const prefs = useTablePrefs('handoffs', []);
  const [q, setQ] = useState<string>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const opts = trpc.handoff.filterOptions.useQuery();
  // The filter section (mockup list-filters).
  const fields = useMemo<FilterField[]>(() => [
    { key: 'status', label: 'Status', type: 'multi', options: Object.entries(HANDOFF_STATUS).map(([value, d]) => ({ value, label: d.label })) },
    { key: 'supplier', label: 'Supplier', type: 'multi', options: (opts.data?.suppliers ?? []).map((s) => ({ value: s.code, label: `${s.code} · ${s.name}` })) },
    { key: 'withoutAck', label: 'Without Sales acknowledgement', type: 'multi', options: [{ value: 'YES', label: 'Yes' }, { value: 'NO', label: 'No' }] },
    { key: 'weeks', label: 'ETD week, from – to', type: 'weeks', fromKey: 'weekFrom', toKey: 'weekTo' },
    { key: 'sent', label: 'Sent, from – to', type: 'dates', fromKey: 'sentFrom', toKey: 'sentTo' },
    { key: 'company', label: 'Company', type: 'multi', options: (companies.data ?? []).map((c) => ({ value: c.CompanyCode, label: `${c.CompanyCode} · ${c.Name}` })) },
  ], [opts.data, companies.data]);
  const filters = useListFilters(fields, () => setPage(1));
  const f = filters.applied;
  const list = trpc.handoff.list.useQuery({
    page, pageSize: prefs.pageSize, q, status: many(f, 'status') as Status[] | undefined, supplier: many(f, 'supplier'), withoutAck: many(f, 'withoutAck') as ('YES' | 'NO')[] | undefined,
    weekFrom: one(f, 'weekFrom'), weekTo: one(f, 'weekTo'), sentFrom: one(f, 'sentFrom'), sentTo: one(f, 'sentTo'), company: many(f, 'company'),
  }, { enabled: prefs.ready, placeholderData: (p) => p });

  const columns: AppColumn<Row>[] = [
    { title: 'Handoff', key: 'hoNo', dataIndex: 'hoNo', width: 110 },
    { title: 'Supplier', key: 'supplier', width: 220, render: (_: unknown, r) => <>{r.supplierName} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.supplierCode}</Typography.Text></> },
    { title: 'Award · demand', key: 'award', width: 170, render: (_: unknown, r) => `${r.abNo} · ${r.demandNo}` },
    { title: 'Containers · weeks', key: 'containers', width: 140, render: (_: unknown, r) => `${r.containers} · ${r.weeks}` },
    { title: 'Terms', key: 'terms', dataIndex: 'terms', width: 250 },
    { title: 'Status', key: 'status', width: 260, render: (_: unknown, r) => <Space size={4} wrap><StatusTag def={HANDOFF_STATUS[r.status]} />{r.withoutAck && <Tag color="gold">without Sales acknowledgement</Tag>}</Space> },
    { title: 'Last step', key: 'last', width: 260, render: (_: unknown, r) => <LastStep step={r.lastStep} /> },
  ];

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>Handoffs</Typography.Title>
          <Typography.Text type="secondary">Supplier awards handed to the PO team — one per future purchase order</Typography.Text>
        </Space>
        <StatusLegend title="What do the handoff statuses mean?" defs={HANDOFF_STATUS} />
      </div>
      {list.error && <Alert type="error" showIcon message="Handoffs could not be loaded" description={list.error.message} />}
      <AppTable<Row>
        prefs={prefs} itemName="handoffs" rowKey="handoffId" columns={columns} dataSource={list.data?.rows} loading={!prefs.ready || list.isFetching}
        page={page} total={list.data?.total ?? 0} onPageChange={setPage}
        onRow={(r) => ({ onClick: () => navigate(`/handoffs/${r.handoffId}`), style: { cursor: 'pointer' } })}
        toolbar={
          <>
            <Input.Search id="handoffSearch" placeholder="Handoff, award, demand or supplier" allowClear value={search} style={{ width: 260 }}
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) { setQ(undefined); setPage(1); } }} onSearch={(v) => { setQ(v.trim() || undefined); setPage(1); }} />
            {filters.bar}
          </>
        }
        beforeTable={filters.panel}
      />
    </Space>
  );
}
