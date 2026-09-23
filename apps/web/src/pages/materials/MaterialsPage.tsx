import { useMemo, useState } from 'react';
import { Alert, Button, Input, Space, Typography, type TableProps } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { MaterialSortField } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { MultiFilter } from '../../components/MultiFilter';
import { trpc } from '../../lib/trpc';
import { formatDateTime } from '../../lib/format';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { MaterialDrawer, StatusTag, type MaterialRow } from './MaterialDrawer';

type Filters = { q?: string; major?: string[]; subMajor?: string[]; group?: string[]; origin?: string[] };
type Sort = { sortField: MaterialSortField; sortOrder: 'asc' | 'desc' };

/** Hidden until the user picks their own columns. */
const DEFAULT_HIDDEN = ['BaseUnit', 'MaterialGroup'];
const DEFAULT_SORT: Sort = { sortField: 'MaterialCode', sortOrder: 'asc' };
const mono = (v: string) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>;

/** Screen 01 — read-only list of materials copied from SAP. */
export function MaterialsPage() {
  const prefs = useTablePrefs('materials', DEFAULT_HIDDEN);
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [selected, setSelected] = useState<MaterialRow | null>(null);

  const list = trpc.materials.list.useQuery(
    { page, pageSize: prefs.pageSize, ...filters, ...sort },
    { placeholderData: (prev) => prev, enabled: prefs.ready },
  );
  const options = trpc.materials.filterOptions.useQuery();
  const status = trpc.materials.syncStatus.useQuery();

  // Sub-majors narrow to the chosen majors (all of them when none is chosen).
  const subMajorOptions = useMemo(() => {
    const majors = new Set(filters.major ?? []);
    const subs = (options.data?.subMajors ?? []).filter((s) => majors.size === 0 || majors.has(s.MajorCategory));
    return [...new Set(subs.map((s) => s.SubMajorCategory))].sort();
  }, [options.data, filters.major]);

  const setFilter = (patch: Filters) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  const onMajorChange = (major: string[] | undefined) => {
    const allowed = new Set(
      (options.data?.subMajors ?? []).filter((s) => !major || major.includes(s.MajorCategory)).map((s) => s.SubMajorCategory),
    );
    const subMajor = filters.subMajor?.filter((s) => allowed.has(s));
    setFilter({ major, subMajor: subMajor?.length ? subMajor : undefined });
  };

  const reset = () => {
    setFilters({});
    setSearch('');
    setPage(1);
  };

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
  const majors = options.data?.majors ?? [];

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
                if (!e.target.value) setFilter({ q: undefined });
              }}
              onSearch={(v) => setFilter({ q: v.trim() || undefined })}
              style={{ width: 220, maxWidth: '100%' }}
            />
            <MultiFilter id="f-major" placeholder="Major category" options={majors} value={filters.major} onChange={onMajorChange} width={170} />
            <MultiFilter id="f-submajor" placeholder="Sub-major category" options={subMajorOptions} value={filters.subMajor}
              onChange={(v) => setFilter({ subMajor: v })} width={190} />
            <MultiFilter id="f-group" placeholder="Group" options={options.data?.groups ?? []} value={filters.group}
              onChange={(v) => setFilter({ group: v })} />
            <MultiFilter id="f-origin" placeholder="Origin" options={options.data?.origins ?? []} value={filters.origin}
              onChange={(v) => setFilter({ origin: v })} />
            <Button icon={<ReloadOutlined />} onClick={reset}>
              Reset
            </Button>
          </>
        }
      />

      <MaterialDrawer material={selected} onClose={() => setSelected(null)} />
    </Space>
  );
}
