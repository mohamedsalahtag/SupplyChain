import { useEffect, useState } from 'react';
import { App, Button, Card, Empty, Form, Input, List, Modal, Popconfirm, Space, Spin, Switch, Tabs, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, SafetyCertificateOutlined, SaveOutlined, TeamOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { useCan } from '../../lib/auth';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { RolePermissions } from './RolePermissions';

type RoleUser = { UserId: number; Username: string; DisplayName: string; Email: string; IsActive: boolean };

/** Administration → Security: roles, the screens and buttons each may use, and who holds them. Spec 07. */
export function SecurityPage() {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const can = useCan();
  const canEdit = can(P.securityRolesEdit);
  const roles = trpc.security.roles.useQuery();
  const catalog = trpc.security.catalog.useQuery();
  const [roleId, setRoleId] = useState<number>();
  const [tab, setTab] = useState('permissions');
  const [creating, setCreating] = useState(false);
  const [details, setDetails] = useState({ name: '', description: '', isActive: true });
  const [usersPage, setUsersPage] = useState(1);
  const usersPrefs = useTablePrefs('security-role-users');

  const role = roles.data?.find((r) => r.RoleId === roleId);
  const roleData = trpc.security.role.useQuery({ roleId: roleId! }, { enabled: !!roleId });
  const create = trpc.security.createRole.useMutation();
  const update = trpc.security.updateRole.useMutation();
  const remove = trpc.security.deleteRole.useMutation();

  useEffect(() => {
    if (!roleId && roles.data?.length) setRoleId(roles.data[0].RoleId);
  }, [roles.data, roleId]);
  useEffect(() => {
    if (role) setDetails({ name: role.Name, description: role.Description, isActive: role.IsActive });
  }, [role]);

  const refresh = () => Promise.all([utils.security.roles.invalidate(), utils.users.roleOptions.invalidate()]);
  const fail = (err: unknown) => message.error(err instanceof Error ? err.message : String(err));

  const onCreate = async (v: { name: string; description?: string }) => {
    try {
      const r = await create.mutateAsync({ name: v.name, description: v.description ?? '' });
      await refresh();
      setRoleId(r.roleId);
      setTab('permissions');
      setCreating(false);
      message.success(`Role "${v.name}" created — now choose its permissions`);
    } catch (err) {
      fail(err);
    }
  };

  const onSaveDetails = async () => {
    if (!role) return;
    try {
      await update.mutateAsync({ roleId: role.RoleId, ...details });
      await Promise.all([refresh(), utils.auth.me.invalidate()]);
      message.success('Role details saved');
    } catch (err) {
      fail(err);
    }
  };

  const onDelete = async () => {
    if (!role) return;
    try {
      await remove.mutateAsync({ roleId: role.RoleId });
      setRoleId(undefined);
      await refresh();
      message.success(`Role "${role.Name}" deleted`);
    } catch (err) {
      fail(err);
    }
  };

  const userColumns: AppColumn<RoleUser>[] = [
    { title: 'Name', key: 'DisplayName', dataIndex: 'DisplayName', width: 200 },
    { title: 'Username', key: 'Username', dataIndex: 'Username', width: 150 },
    { title: 'Email', key: 'Email', dataIndex: 'Email', width: 220 },
    { title: 'Status', key: 'Status', width: 80, render: (_: unknown, u) => <Tag color={u.IsActive ? 'green' : 'default'}>{u.IsActive ? 'Active' : 'Disabled'}</Tag> },
  ];

  const lockedDetails = !canEdit || !!role?.IsBuiltIn;

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}><SafetyCertificateOutlined /> Security</Typography.Title>
          <Typography.Text type="secondary">Build roles from the screens and buttons each one may use, then assign them on the Users screen.</Typography.Text>
        </Space>
        {canEdit && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>New role</Button>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
        <Card size="small" title="Roles" styles={{ body: { padding: 0 } }}>
          <List
            loading={roles.isPending}
            dataSource={roles.data ?? []}
            renderItem={(r) => (
              <List.Item data-testid={`role-${r.Name}`} onClick={() => { setRoleId(r.RoleId); setUsersPage(1); }}
                style={{ cursor: 'pointer', paddingInline: 12, background: r.RoleId === roleId ? '#e8f3ec' : undefined, borderInlineStart: r.RoleId === roleId ? '3px solid #1f6f43' : '3px solid transparent' }}>
                <List.Item.Meta
                  title={<Space size={6}>{r.Name}{r.IsBuiltIn && <Tag>Built-in</Tag>}{!r.IsActive && <Tag color="orange">Inactive</Tag>}</Space>}
                  description={`${r.userCount} ${r.userCount === 1 ? 'user' : 'users'} · ${r.permissionCount} ${r.permissionCount === 1 ? 'permission' : 'permissions'}`}
                />
              </List.Item>
            )}
          />
        </Card>

        {!role ? (
          <Card size="small">{roles.isPending ? <Spin /> : <Empty description="Choose a role" />}</Card>
        ) : (
          <Space direction="vertical" size={10} style={{ width: '100%', minWidth: 0 }}>
            <Card size="small">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                <div style={{ flex: '1 1 180px' }}>
                  <Typography.Text type="secondary">Role name</Typography.Text>
                  <Input id="roleName" value={details.name} disabled={lockedDetails} onChange={(e) => setDetails({ ...details, name: e.target.value })} />
                </div>
                <div style={{ flex: '2 1 260px' }}>
                  <Typography.Text type="secondary">Description</Typography.Text>
                  <Input id="roleDescription" value={details.description} disabled={lockedDetails} onChange={(e) => setDetails({ ...details, description: e.target.value })} />
                </div>
                <Space>
                  <Switch id="roleActive" size="small" checked={details.isActive} disabled={lockedDetails} onChange={(v) => setDetails({ ...details, isActive: v })} />
                  <Typography.Text>Active</Typography.Text>
                </Space>
                {!lockedDetails && (
                  <Space>
                    <Button icon={<SaveOutlined />} loading={update.isPending} onClick={onSaveDetails}>Save details</Button>
                    <Popconfirm title={`Delete role "${role.Name}"?`} description={role.userCount ? 'Remove it from its users first.' : 'This cannot be undone.'}
                      okText="Delete" okButtonProps={{ danger: true, disabled: role.userCount > 0 }} onConfirm={onDelete}>
                      <Button danger icon={<DeleteOutlined />}>Delete</Button>
                    </Popconfirm>
                  </Space>
                )}
              </div>
            </Card>

            <Tabs activeKey={tab} onChange={setTab} type="card" items={[
              {
                key: 'permissions',
                label: <span><UnorderedListOutlined /> Permissions</span>,
                children: roleData.data && catalog.data ? (
                  <RolePermissions roleId={role.RoleId} isAdmin={role.IsAdmin} canEdit={canEdit && !role.IsBuiltIn}
                    catalog={catalog.data} granted={roleData.data.permissionKeys} />
                ) : <Spin />,
              },
              {
                key: 'users',
                label: <span><TeamOutlined /> Users <Tag>{role.userCount}</Tag></span>,
                children: (
                  <AppTable<RoleUser> prefs={usersPrefs} itemName="users" rowKey="UserId" columns={userColumns}
                    dataSource={roleData.data?.users ?? []} loading={roleData.isPending}
                    page={usersPage} total={roleData.data?.users.length ?? 0} onPageChange={setUsersPage}
                    toolbar={<Typography.Text type="secondary">Assign roles on the Users screen.</Typography.Text>} />
                ),
              },
            ]} />
          </Space>
        )}
      </div>

      <Modal open={creating} title="New role" onCancel={() => setCreating(false)} footer={null} destroyOnClose>
        <Form layout="vertical" onFinish={onCreate} requiredMark={false}>
          <Form.Item label="Role name" name="name" rules={[{ required: true, min: 2, message: 'Enter a role name' }]}>
            <Input id="newRoleName" autoFocus maxLength={100} />
          </Form.Item>
          <Form.Item label="Description" name="description">
            <Input.TextArea id="newRoleDescription" maxLength={400} rows={2} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending}>Create role</Button>
        </Form>
      </Modal>
    </Space>
  );
}
