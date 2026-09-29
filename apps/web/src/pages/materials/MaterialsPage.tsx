import { useMemo, useState } from 'react';
import { Alert, Input, Space, Typography, type TableProps } from 'antd';
import { Link } from 'react-router-dom';
import type { MaterialSortField } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { many, useListFilters, type FilterField } from '../../components/ListFilters';
import { trpc } from '../../lib/trpc';
import { formatDateTime } from '../../lib/format';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { MaterialDrawer, StatusTag, type MaterialRow } from './MaterialDrawer';

type Sort = { sortField: MaterialSortField; sortOrder: 'asc' | 'desc' };

/** Hidden until the user picks their own columns. */
const DEFAULT_HIDDEN = ['BaseUnit', 'MaterialGroup'];
const DEFAULT_SORT: Sort = { sortField: 'MaterialCode', sortOrder: 'asc' };
const mono = (v: string) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>;

/** Screen 01 — read-only list of materials copied from SAP. */
export function MaterialsPage() {
  const prefs = useTablePrefs('materials', DEFAULT_HIDDEN);
  const [q, setQ] = useState<string>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [selected, setSelected] = useState<MaterialRow | null>(null);

  const options = trpc.materials.filterOptions.useQuery();
  const status = trpc.sync.status.useQuery({ source: 'sap.materials' });

  // The filter section (mockup list-filters): Sub-major follows the chosen Major (a sub-major can sit under several).
  const fields = useMemo<FilterField[]>(() => {
    const o = options.data;
    const subs = o?.subMajors ?? [];
    const plain = (xs: string[] | undefined) => (xs ?? []).map((x) => ({ value: x, label: x }));
    return [
      { key: 'major', label: 'Major category', type: 'multi', options: plain(o?.majors) },
      { key: 'subMajor', label: 'Sub-major category', type: 'multi', parentKey: 'major',
        options: [...new Set(subs.map((x) => x.SubMajorCategory))].sort().map((sm) => ({ value: sm, label: sm, parents: subs.filter((x) => x.SubMajorCategory === sm).map((x) => x.MajorCategory) })) },
      { key: 'group', label: 'Group', type: 'multi', options: plain(o?.groups) },
      { key: 'origin', label: 'Origin', type: 'multi', options: plain(o?.origins) },
      { key: 'materialType', label: 'Material type', type: 'multi', options: plain(o?.materialTypes) },
      { key: 'inSap', label: 'In SAP', type: 'multi', options: [{ value: 'yes', label: 'In SAP' }, { value: 'no', label: 'Not in SAP' }] },
    ];
  }, [options.data]);
  const filters = useListFilters(fields, () => setPage(1));
  const f = filters.applied;
  const list = trpc.materials.list.useQuery(
    {
      page, pageSize: prefs.pageSize, q, major: many(f, 'major'), subMajor: many(f, 'subMajor'), group: many(f, 'group'), origin: many(f, 'origin'),
      materialType: many(f, 'materialType'), inSap: many(f, 'inSap')?.filter((x): x is 'yes' | 'no' => x === 'yes' || x === 'no'), ...sort,
    },
    { placeholderData: (prev) => prev, enabled: prefs.ready },
  );

  const sortable = (field: MaterialSortField) => ({
    sorter: true,
    sortOrder: sort.sortField === field ? (sort.sortOrder === 'asc' ? ('ascend' as const) : ('descend' as const)) : null,
  });

  const columns: AppColumn<MaterialRow>[] = [
    { title: 'Material', dataIndex: 'MaterialCode', key: 'MaterialCode', width: 175, render: mono, ...sortable('MaterialCode') },
    { title: 'Description', dataIndex: 'Description', key: 'Description', width: 230, ellipsis: true, ...sortable('Description') },
    { title: 'Major category', dataIndex: 'MajorCategory', key: 'MajorCategory', width: 125, ellipsis: true, ...sortable('MajorCategory') },
    { title: 'Sub-major category', dataIndex: 'SubMajorCategory', key: 'SubMajorCategory', width: 160, ellipsis: true, ...sortable('SubMajorCategory') },
    { title: 'Group', dataIndex: 'MaterialGroup', key: 'MaterialGroup', width: 120, ellipsis: true },
    { title: 'UoM', dataIndex: 'BaseUnit', key: 'BaseUnit', width: 50 },
    { title: 'Origin', dataIndex: 'Origin', key: 'Origin', width: 100, ellipsis: true },
    { title: 'Variety', dataIndex: 'Variety', key: 'Variety', width: 110, ellipsis: true },
    { title: 'Class', key: 'MaterialClass', width: 110, render: (_: unknown, r: MaterialRow) => r.MaterialClass || r.MaterialClassCode },
    { title: 'Size', dataIndex: 'Size', key: 'Size', width: 80, ellipsis: true, ...sortable('Size') },
    { title: 'Weight', dataIndex: 'Weight', key: 'Weight', width: 75, align: 'right', render: (w: number | null) => (w == null ? '' : mono(w.toFixed(3))) },
    { title: 'Status', dataIndex: 'InSap', key: 'InSap', width: 90, render: (v: boolean) => <StatusTag inSap={v} /> },
  ];

  const onSortChange: TableProps<MaterialRow>['onChange'] = (_p, _f, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const next: Sort =
      s?.order && s.columnKey
        ? { sortField: s.columnKey as MaterialSortField, sortOrder: s.order === 'ascend' ? 'asc' : 'desc' }
        : DEFAULT_SORT;
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
          <Typography.Title level={5} style={{ margin: 0 }}>
            Materials
          </Typography.Title>
          <Typography.Text type="secondary">Trading and fresh-produce materials from SAP · read-only</Typography.Text>
        </Space>
        <Typography.Text type="secondary">
          {status.data?.running
            ? 'Sync running… · '
            : last
              ? `Last sync: ${formatDateTime(last.FinishedAt)} · ${last.StartedBy}${last.Status === 'Failed' ? ' · failed' : ''} · `
              : 'Never synced · '}
          <Link to="/settings?tab=sync">Sync settings</Link>
        </Typography.Text>
      </div>

      {list.error && <Alert type="error" showIcon message="Materials could not be loaded" description={list.error.message} />}

      <AppTable<MaterialRow>
        prefs={prefs}
        itemName="materials"
        rowKey="MaterialCode"
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
            <Input.Search
              id="search"
              placeholder="Search code or description"
              allowClear
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (!e.target.value) { setQ(undefined); setPage(1); }
              }}
              onSearch={(v) => { setQ(v.trim() || undefined); setPage(1); }}
              style={{ width: 220, maxWidth: '100%' }}
            />
            {filters.bar}
          </>
        }
        beforeTable={filters.panel}
      />

      <MaterialDrawer material={selected} onClose={() => setSelected(null)} />
    </Space>
  );
}
