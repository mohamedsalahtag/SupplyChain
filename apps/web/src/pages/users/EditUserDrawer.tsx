import { useEffect, useState } from 'react';
import { App, Button, Descriptions, Drawer, Select, Space, Switch, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { trpc } from '../../lib/trpc';
import { useCan, useMe } from '../../lib/auth';
import { formatDateTime, type RouterOutputs } from '../../lib/format';

export type UserRow = RouterOutputs['users']['list'][number];

/** A registered user's details, roles and active status. Spec 06. */
export function EditUserDrawer({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const can = useCan();
  const { me } = useMe();
  const roles = trpc.users.roleOptions.useQuery();
  const update = trpc.users.update.useMutation();
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (user) {
      setRoleIds(user.roles.map((r) => r.RoleId));
      setActive(user.IsActive);
    }
  }, [user]);

  const editable = can(P.usersEdit);
  const self = user?.UserId === me?.id;

  const onSave = async () => {
    if (!user) return;
    try {
      await update.mutateAsync({ userId: user.UserId, roleIds, isActive: active });
      message.success('User saved');
      await Promise.all([utils.users.list.invalidate(), utils.security.invalidate(), utils.auth.me.invalidate()]);
      onClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Drawer open={!!user} onClose={onClose} width={460} title={user?.DisplayName}>
      {user && (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Descriptions size="small" column={1} bordered items={[
            { label: 'Username', children: user.Username },
            { label: 'Email', children: user.Email || '—' },
            { label: 'Department', children: user.Department || '—' },
            { label: 'Job title', children: user.Title || '—' },
            { label: 'Last sign-in', children: formatDateTime(user.LastLoginAt) },
            { label: 'Registered', children: formatDateTime(user.CreatedAt) },
          ]} />
          <div>
            <Typography.Text>Roles</Typography.Text>
            <Select id="editRoles" mode="multiple" style={{ width: '100%' }} value={roleIds} onChange={setRoleIds} disabled={!editable}
              options={(roles.data ?? []).map((r) => ({ value: r.RoleId, label: r.IsActive ? r.Name : `${r.Name} (inactive)` }))} />
          </div>
          <Space>
            <Switch id="editActive" checked={active} onChange={setActive} disabled={!editable || self} />
            <Typography.Text>{active ? 'Active — can sign in' : 'Disabled — cannot sign in'}</Typography.Text>
          </Space>
          {self && <Typography.Text type="secondary">You cannot disable your own account.</Typography.Text>}
          {editable && <Button type="primary" icon={<SaveOutlined />} loading={update.isPending} onClick={onSave}>Save</Button>}
        </Space>
      )}
    </Drawer>
  );
}
