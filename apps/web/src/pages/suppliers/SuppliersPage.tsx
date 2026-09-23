import { useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Input, Space, Tag, Typography, type TableProps } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { MultiFilter } from '../../components/MultiFilter';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';

type Row = RouterOutputs['suppliers']['list']['rows'][number];
type Filters = { q?: string; group?: string[]; country?: string[]; currency?: string[] };
type SortField = 'SupplierCode' | 'Name' | 'SupplierGroup' | 'Country' | 'City';
type Sort = { sortField: SortField; sortOrder: 'asc' | 'desc' };

const DEFAULT_SORT: Sort = { sortField: 'Name', sortOrder: 'asc' };
const orDash = (v: string) => v || '—';
const StatusTag = ({ inSap }: { inSap: boolean }) => (
  <Tag color={inSap ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>{inSap ? 'Active' : 'Not in SAP'}</Tag>
);

/** Master data → Suppliers: read-only list copied from SAP. Spec 08. */
export function SuppliersPage() {
  const prefs = useTablePrefs('suppliers', ['Address']);
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [selected, setSelected] = useState<Row | null>(null);

  const list = trpc.suppliers.list.useQuery({ page, pageSize: prefs.pageSize, ...filters, ...sort }, { placeholderData: (p) => p, enabled: prefs.ready });
  const options = trpc.suppliers.filterOptions.useQuery();
  const status = trpc.sync.status.useQuery({ source: 'sap.suppliers' });

  const setFilter = (patch: Filters) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const sortable = (field: SortField) => ({
    sorter: true,
    sortOrder: sort.sortField === field ? (sort.sortOrder === 'asc' ? ('ascend' as const) : ('descend' as const)) : null,
  });

  const columns: AppColumn<Row>[] = [
    { title: 'Code', key: 'SupplierCode', dataIndex: 'SupplierCode', width: 100, ...sortable('SupplierCode') },
    { title: 'Name', key: 'Name', dataIndex: 'Name', width: 260, ...sortable('Name') },
    { title: 'Group', key: 'SupplierGroup', dataIndex: 'SupplierGroup', width: 80, ...sortable('SupplierGroup') },
    { title: 'Country', key: 'Country', dataIndex: 'Country', width: 75, ...sortable('Country') },
    { title: 'Currency', key: 'Currency', dataIndex: 'Currency', width: 80 },
    { title: 'City', key: 'City', dataIndex: 'City', width: 120, ...sortable('City') },
    { title: 'Address', key: 'Address', dataIndex: 'Address', width: 260 },
    { title: 'Email', key: 'Email', dataIndex: 'Email', width: 200 },
    { title: 'Status', key: 'InSap', width: 90, render: (_: unknown, r) => <StatusTag inSap={r.InSap} /> },
  ];

  const onSortChange: TableProps<Row>['onChange'] = (_p, _f, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const next: Sort = s?.order && s.columnKey ? { sortField: s.columnKey as SortField, sortOrder: s.order === 'ascend' ? 'asc' : 'desc' } : DEFAULT_SORT;
    if (next.sortField !== sort.sortField || next.sortOrder !== sort.sortOrder) {
      setSort(next);
      setPage(1);
    }
  };

  const last = status.data?.last;
  const s = selected;

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>Suppliers</Typography.Title>
          <Typography.Text type="secondary">Suppliers in the chosen Z groups, copied from SAP · read-only</Typography.Text>
        </Space>
        <Typography.Text type="secondary">
          {last ? `Last sync: ${formatDateTime(last.FinishedAt)} · ${last.StartedBy} · ` : 'Never synced · '}
          <Link to="/settings?tab=suppliers">Sync settings</Link>
        </Typography.Text>
      </div>

      {list.error && <Alert type="error" showIcon message="Suppliers could not be loaded" description={list.error.message} />}

      <AppTable<Row>
        prefs={prefs}
        itemName="suppliers"
        rowKey="SupplierCode"
        columns={columns}
        dataSource={list.data?.rows}
        loading={!prefs.ready || list.isFetching}
        page={page}
        total={list.data?.total ?? 0}
        onPageChange={setPage}
        onChange={onSortChange}
        onRow={(r) => ({ onClick: () => setSelected(r), style: { cursor: 'pointer' } })}
        toolbar={
          <>
            <Input.Search id="supplierSearch" placeholder="Search code, name or email" allowClear value={search}
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setFilter({ q: undefined }); }}
              onSearch={(v) => setFilter({ q: v.trim() || undefined })} style={{ width: 230, maxWidth: '100%' }} />
            <MultiFilter id="f-group" placeholder="Group" options={options.data?.groups ?? []} value={filters.group} onChange={(v) => setFilter({ group: v })} width={140} />
            <MultiFilter id="f-country" placeholder="Country" options={options.data?.countries ?? []} value={filters.country} onChange={(v) => setFilter({ country: v })} width={140} />
            <MultiFilter id="f-currency" placeholder="Currency" options={options.data?.currencies ?? []} value={filters.currency} onChange={(v) => setFilter({ currency: v })} width={140} />
            <Button icon={<ReloadOutlined />} onClick={() => { setFilters({}); setSearch(''); setPage(1); }}>Reset</Button>
          </>
        }
      />

      <Drawer open={!!s} onClose={() => setSelected(null)} width={440} title={s ? `${s.SupplierCode} · ${s.Name}` : ''}>
        {s && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions title="Supplier" column={1} size="small" bordered items={[
              { label: 'Code', children: s.SupplierCode },
              { label: 'Name', children: s.Name },
              { label: 'Group', children: s.SupplierGroup },
              { label: 'Currency', children: orDash(s.Currency) },
              { label: 'Email', children: orDash(s.Email) },
              { label: 'Status', children: <StatusTag inSap={s.InSap} /> },
            ]} />
            <Descriptions title="Address" column={1} size="small" bordered items={[
              { label: 'Street', children: orDash([s.Street, s.HouseNumber].filter(Boolean).join(' ')) },
              { label: 'Postal code', children: orDash(s.PostalCode) },
              { label: 'City', children: orDash(s.City) },
              { label: 'Region', children: orDash(s.Region) },
              { label: 'Country', children: orDash(s.Country) },
            ]} />
            <Typography.Text type="secondary">Last changed by a sync: {formatDateTime(s.SapChangedAt)}</Typography.Text>
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
