import { useMemo, useState } from 'react';
import { Alert, Descriptions, Drawer, Input, Space, Table, Typography, type TableProps } from 'antd';
import { Link } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { many, one, useListFilters, type FilterField } from '../../components/ListFilters';
import { formatDateTime, formatNumber, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';

type Row = RouterOutputs['purchaseOrders']['list']['rows'][number];
type Line = RouterOutputs['purchaseOrders']['lines'][number];
type SortField = 'PurchaseOrder' | 'OrderDate' | 'OrderType' | 'SupplierCode';
type Sort = { sortField: SortField; sortOrder: 'asc' | 'desc' };

const DEFAULT_SORT: Sort = { sortField: 'OrderDate', sortOrder: 'desc' };
const dateText = (d: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(`${d}T00:00:00Z`));
const money = (n: number) => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** Purchasing → Purchase orders: read-only list copied from SAP. Spec 09. */
export function PurchaseOrdersPage() {
  const prefs = useTablePrefs('purchase-orders');
  const [q, setQ] = useState<string>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [selected, setSelected] = useState<Row | null>(null);

  const opts = trpc.purchaseOrders.filterOptions.useQuery();
  // The filter section (mockup list-filters): Sub-major follows the chosen Major.
  const fields = useMemo<FilterField[]>(() => {
    const cats = opts.data?.categories ?? [];
    return [
      { key: 'type', label: 'Order type', type: 'multi', options: (opts.data?.types ?? []).map((t) => ({ value: t, label: t })) },
      { key: 'supplier', label: 'Supplier', type: 'multi', options: (opts.data?.suppliers ?? []).map((s) => ({ value: s.code, label: s.name ? `${s.code} · ${s.name}` : s.code })) },
      { key: 'major', label: 'Major category', type: 'multi', options: [...new Set(cats.map((c) => c.major))].map((m) => ({ value: m, label: m })) },
      { key: 'subMajor', label: 'Sub-major category', type: 'multi', parentKey: 'major',
        options: [...new Set(cats.map((c) => c.subMajor).filter(Boolean))].map((sm) => ({ value: sm, label: sm, parents: cats.filter((c) => c.subMajor === sm).map((c) => c.major) })) },
      { key: 'orderDate', label: 'Order date, from – to', type: 'dates', fromKey: 'from', toKey: 'to' },
      { key: 'company', label: 'Company', type: 'multi', options: (opts.data?.companies ?? []).map((c) => ({ value: c.code, label: c.name ? `${c.code} · ${c.name}` : c.code })) },
    ];
  }, [opts.data]);
  const filters = useListFilters(fields, () => setPage(1));
  const f = filters.applied;
  const list = trpc.purchaseOrders.list.useQuery({
    page, pageSize: prefs.pageSize, q, type: many(f, 'type'), supplier: many(f, 'supplier'), major: many(f, 'major'), subMajor: many(f, 'subMajor'),
    company: many(f, 'company'), from: one(f, 'from'), to: one(f, 'to'), ...sort,
  }, { placeholderData: (p) => p, enabled: prefs.ready });
  const lines = trpc.purchaseOrders.lines.useQuery({ purchaseOrder: selected?.PurchaseOrder ?? '' }, { enabled: !!selected });
  const status = trpc.sync.status.useQuery({ source: 'sap.purchaseOrders' });

  const sortable = (field: SortField) => ({
    sorter: true,
    sortOrder: sort.sortField === field ? (sort.sortOrder === 'asc' ? ('ascend' as const) : ('descend' as const)) : null,
  });

  const columns: AppColumn<Row>[] = [
    { title: 'PO number', key: 'PurchaseOrder', dataIndex: 'PurchaseOrder', width: 110, ...sortable('PurchaseOrder') },
    { title: 'Type', key: 'OrderType', dataIndex: 'OrderType', width: 70, ...sortable('OrderType') },
    { title: 'Date', key: 'OrderDate', width: 100, render: (_: unknown, r) => dateText(r.OrderDate), ...sortable('OrderDate') },
    { title: 'Supplier', key: 'SupplierCode', dataIndex: 'SupplierCode', width: 100, ...sortable('SupplierCode') },
    { title: 'Supplier name', key: 'SupplierName', width: 260, render: (_: unknown, r) => r.SupplierName || <Typography.Text type="secondary">not in Suppliers</Typography.Text> },
    { title: 'Company', key: 'CompanyCode', width: 75, render: (_: unknown, r) => r.CompanyCode || '—' },
    { title: 'Lines', key: 'LineCount', dataIndex: 'LineCount', width: 60, align: 'right' },
    { title: 'Currency', key: 'Currency', dataIndex: 'Currency', width: 75 },
  ];

  const lineColumns: TableProps<Line>['columns'] = [
    { title: 'Item', dataIndex: 'ItemNo', width: 55 },
    { title: 'Material', key: 'm', ellipsis: true, render: (_: unknown, l) => (
      <span title={l.Material}>{l.MaterialDescription || l.Material}{l.MaterialDescription && <Typography.Text type="secondary"> · {l.Material}</Typography.Text>}</span>
    ) },
    { title: 'Quantity', key: 'q', width: 110, align: 'right', render: (_: unknown, l) => `${formatNumber(l.Quantity)} ${l.Unit}` },
    { title: 'Net price', key: 'p', width: 120, align: 'right', render: (_: unknown, l) => `${money(l.NetPrice)} ${selected?.Currency ?? ''}${l.PriceQuantity !== 1 ? ` / ${formatNumber(l.PriceQuantity)}` : ''}` },
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

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>Purchase orders</Typography.Title>
          <Typography.Text type="secondary">Chosen Z order types from the start date, copied from SAP · read-only</Typography.Text>
        </Space>
        <Typography.Text type="secondary">
          {last ? `Last sync: ${formatDateTime(last.FinishedAt)} · ${last.StartedBy} · ` : 'Never synced · '}
          <Link to="/settings?tab=po">Sync settings</Link>
        </Typography.Text>
      </div>

      {list.error && <Alert type="error" showIcon message="Purchase orders could not be loaded" description={list.error.message} />}

      <AppTable<Row>
        prefs={prefs}
        itemName="orders"
        rowKey="PurchaseOrder"
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
            <Input.Search id="poSearch" placeholder="PO number, supplier code or name" allowClear value={search}
              onChange={(e) => { setSearch(e.target.value); if (!e.target.value) { setQ(undefined); setPage(1); } }}
              onSearch={(v) => { setQ(v.trim() || undefined); setPage(1); }} style={{ width: 250, maxWidth: '100%' }} />
            {filters.bar}
          </>
        }
        beforeTable={filters.panel}
      />

      <Drawer open={!!selected} onClose={() => setSelected(null)} width={620} title={selected ? `PO ${selected.PurchaseOrder}` : ''}>
        {selected && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions column={2} size="small" bordered items={[
              { label: 'Type', children: selected.OrderType },
              { label: 'Date', children: dateText(selected.OrderDate) },
              { label: 'Supplier', children: `${selected.SupplierCode}${selected.SupplierName ? ` · ${selected.SupplierName}` : ''}`, span: 2 },
              { label: 'Currency', children: selected.Currency },
              { label: 'Lines', children: selected.LineCount },
            ]} />
            <Table<Line> size="small" bordered rowKey="ItemNo" columns={lineColumns} dataSource={lines.data} loading={lines.isFetching}
              pagination={false} tableLayout="fixed" />
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
