import { useMemo, useState } from 'react';
import { Alert, Button, Input, Space, Tag, Typography } from 'antd';
import { UserAddOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { MultiFilter } from '../../components/MultiFilter';
import { useCan } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { AddUserDrawer } from './AddUserDrawer';
import { EditUserDrawer, type UserRow } from './EditUserDrawer';

const STATUS = { active: 'Active', disabled: 'Disabled' } as const;

/** Administration → Users: people registered from Active Directory. Spec 06. */
export function UsersPage() {
  const can = useCan();
  const prefs = useTablePrefs('users', ['Department']);
  const list = trpc.users.list.useQuery();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string[]>();
  const [statusFilter, setStatusFilter] = useState<string[]>();
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<UserRow | null>(null);

  const users = list.data ?? [];
  const roleNames = useMemo(() => [...new Set(users.flatMap((u) => u.roles.map((r) => r.Name)))].sort(), [users]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter(
      (u) =>
        (!q || [u.DisplayName, u.Username, u.Email].some((v) => v.toLowerCase().includes(q))) &&
        (!roleFilter || u.roles.some((r) => roleFilter.includes(r.Name))) &&
        (!statusFilter || statusFilter.includes(u.IsActive ? STATUS.active : STATUS.disabled)),
    );
  }, [users, search, roleFilter, statusFilter]);

  const columns: AppColumn<UserRow>[] = [
    { title: 'Name', key: 'DisplayName', dataIndex: 'DisplayName', width: 190, sorter: (a, b) => a.DisplayName.localeCompare(b.DisplayName) },
    { title: 'Username', key: 'Username', dataIndex: 'Username', width: 150 },
    { title: 'Email', key: 'Email', dataIndex: 'Email', width: 220 },
    { title: 'Department', key: 'Department', dataIndex: 'Department', width: 150 },
    { title: 'Roles', key: 'Roles', width: 170, render: (_: unknown, u) => u.roles.map((r) => <Tag key={r.RoleId}>{r.Name}</Tag>) },
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
            <MultiFilter id="f-role" placeholder="Role" options={roleNames} value={roleFilter} onChange={setAndReset(setRoleFilter)} />
            <MultiFilter id="f-status" placeholder="Status" options={[STATUS.active, STATUS.disabled]} value={statusFilter} onChange={setAndReset(setStatusFilter)} width={130} />
          </>
        }
      />

      <AddUserDrawer open={adding} onClose={() => setAdding(false)} />
      <EditUserDrawer user={selected} onClose={() => setSelected(null)} />
    </Space>
  );
}
