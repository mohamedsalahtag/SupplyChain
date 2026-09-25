import { useState } from 'react';
import { Alert, Button, Input, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { MultiFilter } from '../../components/MultiFilter';
import { StatusLegend, StatusTag } from '../../components/StatusTag';
import { LastStep } from '../../components/StepText';
import type { RouterOutputs } from '../../lib/format';
import { HANDOFF_STATUS } from '../../lib/statuses';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';

type Row = RouterOutputs['handoff']['list']['rows'][number];
type Status = 'HANDED_OFF' | 'ACCEPTED' | 'RETURNED';
const byLabel = Object.fromEntries(Object.entries(HANDOFF_STATUS).map(([k, v]) => [v.label, k])) as Record<string, Status>;

/** Purchasing → Handoffs (spec 22): one row per supplier award handed to the PO team. */
export function HandoffsListPage() {
  const navigate = useNavigate();
  const prefs = useTablePrefs('handoffs', []);
  const [status, setStatus] = useState<Status[] | undefined>();
  const [q, setQ] = useState<string>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const list = trpc.handoff.list.useQuery({ page, pageSize: prefs.pageSize, q, status }, { enabled: prefs.ready, placeholderData: (p) => p });

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
            <MultiFilter id="f-hostatus" placeholder="Status" options={Object.values(HANDOFF_STATUS).map((s) => s.label)} value={status?.map((s) => HANDOFF_STATUS[s].label)}
              onChange={(v) => { setStatus(v?.map((l) => byLabel[l])); setPage(1); }} width={230} />
            <Button icon={<ReloadOutlined />} onClick={() => { setStatus(undefined); setQ(undefined); setSearch(''); setPage(1); }}>Reset</Button>
          </>
        }
      />
    </Space>
  );
}
