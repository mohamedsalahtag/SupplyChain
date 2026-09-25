import { useState } from 'react';
import { Alert, Badge, Button, Input, Result, Select, Space, Tabs, Tag, Typography } from 'antd';
import { FilterOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { MultiFilter } from '../../components/MultiFilter';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { withFrom } from '../../components/BackToWork';

type Row = RouterOutputs['work']['list']['rows'][number];
type Due = 'overdue' | 'today' | 'later' | 'none';
type Filters = { q?: string; company?: string[]; due?: Due };

/** "Due in 6 h", "Overdue 2 d" — whole hours below two days, whole days above. */
function dueText(iso: string | null, overdue: boolean): string {
  if (!iso) return 'No due date';
  const hours = Math.abs(new Date(iso).getTime() - Date.now()) / 3_600_000;
  const span = hours < 48 ? `${Math.max(1, Math.round(hours))} h` : `${Math.round(hours / 24)} d`;
  return overdue ? `Overdue ${span}` : `Due in ${span}`;
}

/** My work (spec 10): everything waiting on the signed-in user, next step one click away. */
export function MyWorkPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const prefs = useTablePrefs('my-work', ['note']);
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);

  const tabs = trpc.work.tabs.useQuery(undefined, { refetchInterval: 60_000 });
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const tabList = tabs.data?.tabs ?? [];
  const tab = tabList.some((t) => t.key === params.get('tab')) ? params.get('tab')! : tabList[0]?.key;
  const list = trpc.work.list.useQuery(
    { tab, page, pageSize: prefs.pageSize, ...filters },
    { enabled: prefs.ready && !!tab, placeholderData: (p) => p, refetchInterval: 60_000 },
  );

  const setFilter = (patch: Filters) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const open = (r: Row) => navigate(withFrom(r.action.link, `/work?tab=${tab}`));

  const columns: AppColumn<Row>[] = [
    {
      title: 'Due', key: 'due', width: 150,
      render: (_: unknown, r) => (
        <Space size={4}>
          <Tag color={r.overdue ? 'red' : r.dueAt ? 'default' : undefined} style={{ marginInlineEnd: 0 }}>{dueText(r.dueAt, r.overdue)}</Tag>
          {r.escalated && <Tag color="red" style={{ marginInlineEnd: 0 }}>Escalated</Tag>}
        </Space>
      ),
    },
    { title: 'Number', key: 'number', dataIndex: 'number', width: 110 },
    { title: 'What', key: 'title', dataIndex: 'title', width: 340 },
    { title: 'Company', key: 'company', width: 80, render: (_: unknown, r) => r.companyCode ?? '—' },
    { title: 'Raised by', key: 'raisedBy', dataIndex: 'raisedBy', width: 120 },
    { title: 'Raised at', key: 'createdAt', width: 130, render: (_: unknown, r) => formatDateTime(r.createdAt) },
    { title: 'Note', key: 'note', width: 260, render: (_: unknown, r) => r.note ?? '' },
    {
      title: 'Action', key: 'action', width: 140, ellipsis: false,
      render: (_: unknown, r) => (
        <Button type="primary" size="small" onClick={(e) => { e.stopPropagation(); open(r); }}>{r.action.label}</Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={10} align="baseline" wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>My work</Typography.Title>
        <Typography.Text type="secondary">Everything waiting on you, next step one click away.</Typography.Text>
      </Space>

      {tabs.data && !tabs.data.hasCompany && (
        <Alert type="info" showIcon message="You are not assigned to a company yet — ask an administrator. Only system items are shown." />
      )}
      {(tabs.error || list.error) && <Alert type="error" showIcon message="My work could not be loaded" description={(tabs.error ?? list.error)?.message} />}

      {tabs.data && tabList.length === 0 ? (
        <Result status="success" title="Nothing waiting on you" subTitle="New work appears here as soon as it is created." />
      ) : (
        <>
          <Tabs
            activeKey={tab}
            onChange={(key) => { setParams({ tab: key }, { replace: true }); setPage(1); }}
            tabBarExtraContent={<Button icon={<FilterOutlined />} onClick={() => setShowFilters((v) => !v)}>Filters</Button>}
            items={tabList.map((t) => ({
              key: t.key,
              label: (
                <Space size={6}>
                  {t.label}
                  <Badge count={t.count} color={t.overdue > 0 ? 'red' : '#8c8c8c'} showZero overflowCount={999} />
                </Space>
              ),
            }))}
          />
          <AppTable<Row>
            prefs={prefs}
            itemName="items"
            rowKey="id"
            columns={columns}
            dataSource={list.data?.rows}
            loading={!prefs.ready || list.isFetching}
            page={page}
            total={list.data?.total ?? 0}
            onPageChange={setPage}
            onRow={(r) => ({ onClick: () => open(r), style: { cursor: 'pointer' } })}
            toolbar={
              showFilters && (
                <>
                  <Input.Search id="workSearch" placeholder="Search number or text" allowClear value={search}
                    onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setFilter({ q: undefined }); }}
                    onSearch={(v) => setFilter({ q: v.trim() || undefined })} style={{ width: 230, maxWidth: '100%' }} />
                  <MultiFilter id="f-company" placeholder="Company" options={(companies.data ?? []).map((c) => c.CompanyCode)} value={filters.company}
                    onChange={(v) => setFilter({ company: v })} width={150} />
                  <Select id="f-due" allowClear placeholder="Due" value={filters.due} onChange={(v: Due | undefined) => setFilter({ due: v })} style={{ width: 150 }}
                    options={[{ value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' }, { value: 'later', label: 'Later' }, { value: 'none', label: 'No due date' }]} />
                  <Button icon={<ReloadOutlined />} onClick={() => { setFilters({}); setSearch(''); setPage(1); }}>Reset</Button>
                </>
              )
            }
          />
        </>
      )}
    </Space>
  );
}
