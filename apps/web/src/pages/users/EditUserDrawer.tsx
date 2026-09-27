import { useEffect, useState } from 'react';
import { App, Button, Descriptions, Drawer, Select, Space, Switch, Typography } from 'antd';
import { DeleteOutlined, SaveOutlined } from '@ant-design/icons';
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
          {can(P.usersDelete) && <DeleteUser user={user} onDeleted={onClose} />}
        </Space>
      )}
    </Drawer>
  );
}

/** Delete: states first whether the user is deleted outright or archived (their name is on records), then confirms. */
function DeleteUser({ user, onDeleted }: { user: UserRow; onDeleted: () => void }) {
  const { message, modal } = App.useApp();
  const utils = trpc.useUtils();
  const preview = trpc.users.deletePreview.useQuery({ userId: user.UserId });
  const del = trpc.users.delete.useMutation();
  const p = preview.data;
  const onDelete = () => modal.confirm({
    title: `Delete ${user.DisplayName}?`,
    okText: p?.mode === 'archive' ? 'Archive and remove' : 'Delete',
    okButtonProps: { danger: true },
    content: p?.mode === 'archive'
      ? `${user.DisplayName} is on records, so the account is archived: removed from this list, unable to sign in, roles and companies removed. The records keep their name. The same person can be registered again later.`
      : `${user.DisplayName} has no records; the account, its roles and companies are deleted.`,
    onOk: async () => {
      try {
        const r = await del.mutateAsync({ userId: user.UserId });
        message.success(r.mode === 'archive' ? `${r.displayName} archived` : `${r.displayName} deleted`);
        await Promise.all([utils.users.list.invalidate(), utils.security.invalidate()]);
        onDeleted();
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
  });
  return (
    <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12, marginTop: 8 }}>
      <Typography.Text strong type="danger">Delete user</Typography.Text>
      {p && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 8px' }}>
          {p.refusal ?? (p.mode === 'archive'
            ? `On records (${p.references.slice(0, 4).map((r) => `${r.count} ${r.label}`).join(', ')}${p.references.length > 4 ? ', …' : ''}): the account is archived, the records keep the name.`
            : 'No records: the account is deleted outright.')}
        </Typography.Paragraph>
      )}
      <Button danger icon={<DeleteOutlined />} disabled={!p || !!p.refusal} loading={preview.isPending || del.isPending} onClick={onDelete} data-testid="user-delete">
        Delete user…
      </Button>
    </div>
  );
}
