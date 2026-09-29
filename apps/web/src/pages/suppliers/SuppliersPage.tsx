import { useMemo, useState } from 'react';
import { Alert, Descriptions, Drawer, Input, Space, Tag, Typography, type TableProps } from 'antd';
import { Link } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { many, useListFilters, type FilterField } from '../../components/ListFilters';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';

type Row = RouterOutputs['suppliers']['list']['rows'][number];
type SortField = 'SupplierCode' | 'Name' | 'SupplierGroup' | 'Country' | 'City';
type Sort = { sortField: SortField; sortOrder: 'asc' | 'desc' };

const DEFAULT_SORT: Sort = { sortField: 'Name', sortOrder: 'asc' };
const orDash = (v: string) => v || '—';
const BlockedTag = ({ row }: { row: Pick<Row, 'PurchasingIsBlocked' | 'PostingIsBlocked'> }) =>
  row.PurchasingIsBlocked || row.PostingIsBlocked ? (
    <Tag color="red" style={{ marginInlineEnd: 0 }}>{row.PurchasingIsBlocked && row.PostingIsBlocked ? 'Blocked' : row.PurchasingIsBlocked ? 'Purchasing' : 'Posting'}</Tag>
  ) : (
    <Typography.Text type="secondary">No</Typography.Text>
  );
const StatusTag = ({ inSap }: { inSap: boolean }) => (
  <Tag color={inSap ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>{inSap ? 'Active' : 'Not in SAP'}</Tag>
);

/** Master data → Suppliers: read-only list copied from SAP. Spec 08. */
export function SuppliersPage() {
  const prefs = useTablePrefs('suppliers', ['Address']);
  const [q, setQ] = useState<string>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [selected, setSelected] = useState<Row | null>(null);

  const options = trpc.suppliers.filterOptions.useQuery();
  const status = trpc.sync.status.useQuery({ source: 'sap.suppliers' });

  // The filter section (mockup list-filters).
  const fields = useMemo<FilterField[]>(() => {
    const o = options.data;
    const plain = (xs: string[] | undefined) => (xs ?? []).map((x) => ({ value: x, label: x }));
    return [
      { key: 'group', label: 'Group', type: 'multi', options: plain(o?.groups) },
      { key: 'country', label: 'Country', type: 'multi', options: plain(o?.countries) },
      { key: 'currency', label: 'Currency', type: 'multi', options: plain(o?.currencies) },
      { key: 'origin', label: 'Origin', type: 'multi', options: (o?.origins ?? []).map((x) => ({ value: x.code, label: x.name ? `${x.code} · ${x.name}` : x.code })) },
      { key: 'blocked', label: 'Blocked', type: 'multi', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
      { key: 'purchasingOrg', label: 'Purchasing org', type: 'multi', options: plain(o?.purchasingOrgs) },
    ];
  }, [options.data]);
  const filters = useListFilters(fields, () => setPage(1));
  const f = filters.applied;
  const list = trpc.suppliers.list.useQuery({
    page, pageSize: prefs.pageSize, q, group: many(f, 'group'), country: many(f, 'country'), currency: many(f, 'currency'), origin: many(f, 'origin'),
    blocked: many(f, 'blocked')?.filter((x): x is 'yes' | 'no' => x === 'yes' || x === 'no'), purchasingOrg: many(f, 'purchasingOrg'), ...sort,
  }, { placeholderData: (p) => p, enabled: prefs.ready });
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
    { title: 'Purchasing orgs', key: 'PurchasingOrgs', width: 130, render: (_: unknown, r) => r.PurchasingOrgs || '—' },
    { title: 'Blocked', key: 'Blocked', width: 80, render: (_: unknown, r) => <BlockedTag row={r} /> },
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
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) { setQ(undefined); setPage(1); } }}
              onSearch={(v) => { setQ(v.trim() || undefined); setPage(1); }} style={{ width: 230, maxWidth: '100%' }} />
            {filters.bar}
          </>
        }
        beforeTable={filters.panel}
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
              { label: 'Blocked', children: <BlockedTag row={s} /> },
              { label: 'Purchasing orgs', children: orDash(s.PurchasingOrgs) },
              { label: 'Payment terms · Incoterm (SAP)', children: orDash(s.SapTerms) },
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
