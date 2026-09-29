import { useMemo, useState } from 'react';
import { Alert, Button, Input, Space, Tag, Typography } from 'antd';
import { UserAddOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { many, useListFilters, type FilterField } from '../../components/ListFilters';
import { useCan } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { AddUserDrawer } from './AddUserDrawer';
import { EditUserDrawer, type UserRow } from './EditUserDrawer';

const STATUS = { active: 'Active', disabled: 'Disabled' } as const;
/** The Company filter's choice for users without a company (the "None" tag in the Companies column). */
const NO_COMPANY = '-';

/** Administration → Users: people registered from Active Directory. Spec 06. */
export function UsersPage() {
  const can = useCan();
  const prefs = useTablePrefs('users', ['Department']);
  const list = trpc.users.list.useQuery();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const companies = trpc.workflowSetup.companyOptions.useQuery();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<UserRow | null>(null);

  const users = list.data ?? [];
  // The filter section (mockup list-filters). Companies: the active ones, plus any a user still holds, plus "None".
  const fields = useMemo<FilterField[]>(() => {
    const names = new Map((companies.data ?? []).map((c) => [c.CompanyCode, `${c.CompanyCode} · ${c.Name}`]));
    for (const code of users.flatMap((u) => u.companies)) if (!names.has(code)) names.set(code, code);
    return [
      { key: 'role', label: 'Role', type: 'multi', options: [...new Set(users.flatMap((u) => u.roles.map((r) => r.Name)))].sort().map((n) => ({ value: n, label: n })) },
      { key: 'status', label: 'Status', type: 'multi', options: [{ value: 'active', label: STATUS.active }, { value: 'disabled', label: STATUS.disabled }] },
      { key: 'company', label: 'Company', type: 'multi', options: [...[...names].sort(([a], [b]) => a.localeCompare(b)).map(([value, label]) => ({ value, label })), { value: NO_COMPANY, label: 'None' }] },
    ];
  }, [users, companies.data]);
  const filters = useListFilters(fields, () => setPage(1));
  const roleFilter = many(filters.applied, 'role');
  const statusFilter = many(filters.applied, 'status');
  const companyFilter = many(filters.applied, 'company');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter(
      (u) =>
        (!q || [u.DisplayName, u.Username, u.Email].some((v) => v.toLowerCase().includes(q))) &&
        (!roleFilter || u.roles.some((r) => roleFilter.includes(r.Name))) &&
        (!statusFilter || statusFilter.includes(u.IsActive ? 'active' : 'disabled')) &&
        (!companyFilter || (u.companies.length ? u.companies.some((c) => companyFilter.includes(c)) : companyFilter.includes(NO_COMPANY))),
    );
  }, [users, search, roleFilter, statusFilter, companyFilter]);

  const columns: AppColumn<UserRow>[] = [
    { title: 'Name', key: 'DisplayName', dataIndex: 'DisplayName', width: 190, sorter: (a, b) => a.DisplayName.localeCompare(b.DisplayName) },
    { title: 'Username', key: 'Username', width: 150, render: (_: unknown, u) => <Space size={4}>{u.Username}{u.IsDemo && <Tag color="orange">Demo</Tag>}</Space> },
    { title: 'Email', key: 'Email', dataIndex: 'Email', width: 220 },
    { title: 'Department', key: 'Department', dataIndex: 'Department', width: 150 },
    { title: 'Roles', key: 'Roles', width: 170, render: (_: unknown, u) => u.roles.map((r) => <Tag key={r.RoleId}>{r.Name}</Tag>) },
    { title: 'Companies', key: 'Companies', width: 110, render: (_: unknown, u) => (u.companies.length ? u.companies.join(', ') : <Tag color="warning">None</Tag>) },
    { title: 'Status', key: 'Status', width: 80, render: (_: unknown, u) => <Tag color={u.IsActive ? 'green' : 'default'}>{u.IsActive ? STATUS.active : STATUS.disabled}</Tag> },
    { title: 'Last sign-in', key: 'LastLoginAt', width: 140, render: (_: unknown, u) => formatDateTime(u.LastLoginAt) },
  ];

  const setAndReset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>Users</Typography.Title>
          <Typography.Text type="secondary">People who can sign in, registered from Active Directory</Typography.Text>
        </Space>
        {can(P.usersAdd) && <Button type="primary" icon={<UserAddOutlined />} onClick={() => setAdding(true)}>Add user</Button>}
      </div>

      {list.error && <Alert type="error" showIcon message="Users could not be loaded" description={list.error.message} />}

      <AppTable<UserRow>
        prefs={prefs}
        itemName="users"
        rowKey="UserId"
        columns={columns}
        dataSource={filtered}
        loading={list.isPending}
        page={page}
        total={filtered.length}
        onPageChange={setPage}
        onRow={(u) => ({ onClick: () => setSelected(u), style: { cursor: 'pointer' } })}
        toolbar={
          <>
            <Input.Search id="userSearch" placeholder="Search name, username or email" allowClear value={search}
              onChange={(e) => setAndReset(setSearch)(e.target.value)} style={{ width: 240, maxWidth: '100%' }} />
            {filters.bar}
          </>
        }
        beforeTable={filters.panel}
      />

      <AddUserDrawer open={adding} onClose={() => setAdding(false)} />
      <EditUserDrawer user={selected} onClose={() => setSelected(null)} />
    </Space>
  );
}
