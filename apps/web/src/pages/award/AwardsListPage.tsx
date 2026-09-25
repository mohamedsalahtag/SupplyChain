import { useState } from 'react';
import { Alert, Button, Input, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { MultiFilter } from '../../components/MultiFilter';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { ACK_STATUS } from './awardLabels';
import { StatusLegend, StatusTag } from '../../components/StatusTag';

type Row = RouterOutputs['award']['list']['rows'][number];
type Filters = { q?: string; ack?: string[] };
const ackByLabel = Object.fromEntries(Object.entries(ACK_STATUS).map(([k, v]) => [v.label, k]));

const ackTag = (r: Row) => <StatusTag def={ACK_STATUS[r.ackStatus]} label={`${ACK_STATUS[r.ackStatus]?.label ?? r.ackStatus}${r.revision > 1 ? ` · revision ${r.revision}` : ''}`} />;

/** Purchasing → Awards (spec 20). */
export function AwardsListPage() {
  const navigate = useNavigate();
  const prefs = useTablePrefs('awards', []);
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const list = trpc.award.list.useQuery({ page, pageSize: prefs.pageSize, ...filters }, { enabled: prefs.ready, placeholderData: (p) => p });
  const setFilter = (patch: Filters) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };

  const columns: AppColumn<Row>[] = [
    { title: 'Award', key: 'abNo', dataIndex: 'abNo', width: 110 },
    { title: 'RFQ', key: 'rfqNo', dataIndex: 'rfqNo', width: 110 },
    { title: 'Demand', key: 'demandNo', dataIndex: 'demandNo', width: 95 },
    { title: 'Company', key: 'companyCode', dataIndex: 'companyCode', width: 80 },
    { title: 'Suppliers', key: 'suppliers', dataIndex: 'suppliers', width: 90, align: 'right' },
    { title: 'Quantity', key: 'quantity', dataIndex: 'quantity', width: 180 },
    { title: 'Sales acknowledgement', key: 'ack', width: 250, render: (_: unknown, r) => ackTag(r) },
    { title: 'Created', key: 'created', width: 200, render: (_: unknown, r) => `${r.createdBy} · ${formatDateTime(r.createdAt)}` },
  ];

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={10} align="baseline">
        <Typography.Title level={5} style={{ margin: 0 }}>Awards</Typography.Title>
        <Typography.Text type="secondary">Quantities awarded to suppliers, and Sales' acknowledgement</Typography.Text>
        <StatusLegend title="What do the acknowledgement statuses mean?" defs={ACK_STATUS} />
      </Space>
      {list.error && <Alert type="error" showIcon message="Awards could not be loaded" description={list.error.message} />}
      <AppTable<Row>
        prefs={prefs} itemName="awards" rowKey="awardBatchId" columns={columns} dataSource={list.data?.rows} loading={!prefs.ready || list.isFetching}
        page={page} total={list.data?.total ?? 0} onPageChange={setPage}
        onRow={(r) => ({ onClick: () => navigate(`/awards/${r.awardBatchId}`), style: { cursor: 'pointer' } })}
        toolbar={
          <>
            <Input.Search id="awardSearch" placeholder="Award, RFQ or demand number" allowClear value={search} style={{ width: 240 }}
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setFilter({ q: undefined }); }} onSearch={(v) => setFilter({ q: v.trim() || undefined })} />
            <MultiFilter id="f-ack" placeholder="Sales" options={Object.values(ACK_STATUS).map((s) => s.label)} value={filters.ack?.map((s) => ACK_STATUS[s].label)}
              onChange={(v) => setFilter({ ack: v?.map((l) => ackByLabel[l]) })} width={200} />
            <Button icon={<ReloadOutlined />} onClick={() => { setFilters({}); setSearch(''); setPage(1); }}>Reset</Button>
          </>
        }
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
