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
  const setCompanies = trpc.users.setCompanies.useMutation();
  const companyOptions = trpc.workflowSetup.companyOptions.useQuery();
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [companies, setCompanyCodes] = useState<string[]>([]);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (user) {
      setRoleIds(user.roles.map((r) => r.RoleId));
      setCompanyCodes(user.companies);
      setActive(user.IsActive);
    }
  }, [user]);

  const editable = can(P.usersEdit);
  const companiesEditable = can(P.usersCompaniesEdit);
  const self = user?.UserId === me?.id;

  const onSave = async () => {
    if (!user) return;
    try {
      if (editable) await update.mutateAsync({ userId: user.UserId, roleIds, isActive: active });
      const companiesChanged = [...companies].sort().join() !== [...user.companies].sort().join();
      if (companiesEditable && companiesChanged) await setCompanies.mutateAsync({ userId: user.UserId, companyCodes: companies });
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
          <div>
            <Typography.Text>Companies</Typography.Text>
            <Select id="editCompanies" mode="multiple" style={{ width: '100%' }} value={companies} onChange={setCompanyCodes} disabled={!companiesEditable}
              placeholder="None — the user sees no workflow data"
              options={(companyOptions.data ?? []).map((c) => ({ value: c.CompanyCode, label: `${c.CompanyCode} · ${c.Name}` }))} />
          </div>
          <Space>
            <Switch id="editActive" checked={active} onChange={setActive} disabled={!editable || self} />
            <Typography.Text>{active ? 'Active — can sign in' : 'Disabled — cannot sign in'}</Typography.Text>
          </Space>
          {self && <Typography.Text type="secondary">You cannot disable your own account.</Typography.Text>}
          {(editable || companiesEditable) && (
            <Button type="primary" icon={<SaveOutlined />} loading={update.isPending || setCompanies.isPending} onClick={onSave}>Save</Button>
          )}
        </Space>
      )}
    </Drawer>
  );
}
