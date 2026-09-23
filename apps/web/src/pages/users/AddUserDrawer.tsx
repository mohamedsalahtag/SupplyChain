import { useEffect, useState } from 'react';
import { Alert, App, Button, Drawer, Empty, Input, List, Select, Space, Tag, Typography } from 'antd';
import { UserAddOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';

type Person = { username: string; displayName: string; email: string; department: string; title: string; registered: boolean };

/** Find a person in Active Directory and register them with roles. Spec 06. */
export function AddUserDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Person | null>(null);
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const roles = trpc.users.roleOptions.useQuery();
  const search = trpc.users.searchDirectory.useQuery({ q }, { enabled: q.length >= 2, retry: false });
  const add = trpc.users.add.useMutation();

  // Search as the user types, after a short pause.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  // New users get Administrator until other rules exist.
  useEffect(() => {
    if (picked && roles.data) setRoleIds(roles.data.filter((r) => r.IsAdmin && r.IsActive).map((r) => r.RoleId));
  }, [picked, roles.data]);

  const reset = () => {
    setText('');
    setQ('');
    setPicked(null);
    setRoleIds([]);
  };

  const onRegister = async () => {
    if (!picked) return;
    try {
      await add.mutateAsync({ username: picked.username, roleIds });
      message.success(`${picked.displayName || picked.username} registered`);
      await utils.users.list.invalidate();
      await utils.security.roles.invalidate();
      reset();
      onClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Drawer open={open} onClose={() => { reset(); onClose(); }} width={480} title="Add user from Active Directory" destroyOnClose>
      {!picked ? (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Input.Search id="adSearch" placeholder="Name, username or email (at least 2 letters)" allowClear autoFocus value={text} onChange={(e) => setText(e.target.value)} loading={search.isFetching} />
          {search.error && <Alert type="error" showIcon message={search.error.message} />}
          {q.length >= 2 && !search.error && (
            <List<Person>
              size="small"
              bordered
              loading={search.isFetching}
              dataSource={search.data ?? []}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nobody found" /> }}
              renderItem={(p) => (
                <List.Item
                  data-testid="ad-result"
                  style={{ cursor: p.registered ? 'default' : 'pointer', opacity: p.registered ? 0.6 : 1 }}
                  onClick={() => !p.registered && setPicked(p)}
                  extra={p.registered ? <Tag>Registered</Tag> : <Button size="small">Select</Button>}
                >
                  <List.Item.Meta
                    title={p.displayName || p.username}
                    description={[p.username, p.email, p.department].filter(Boolean).join(' · ')}
                  />
                </List.Item>
              )}
            />
          )}
          {search.data?.length === 25 && <Typography.Text type="secondary">Showing the first 25 — type more to narrow it down.</Typography.Text>}
        </Space>
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Title level={5} style={{ margin: 0 }}>{picked.displayName || picked.username}</Typography.Title>
            <Typography.Text type="secondary">{[picked.username, picked.email, picked.department, picked.title].filter(Boolean).join(' · ')}</Typography.Text>
          </div>
          <div>
            <Typography.Text>Roles</Typography.Text>
            <Select id="addRoles" mode="multiple" style={{ width: '100%' }} value={roleIds} onChange={setRoleIds}
              options={(roles.data ?? []).filter((r) => r.IsActive).map((r) => ({ value: r.RoleId, label: r.Name }))} />
          </div>
          <Space>
            <Button type="primary" icon={<UserAddOutlined />} disabled={roleIds.length === 0} loading={add.isPending} onClick={onRegister}>Register</Button>
            <Button onClick={() => setPicked(null)}>Back to search</Button>
          </Space>
        </Space>
      )}
    </Drawer>
  );
}
