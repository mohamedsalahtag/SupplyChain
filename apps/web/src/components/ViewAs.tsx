import { Alert, App, Button, Dropdown, Space, Typography } from 'antd';
import { DownOutlined, EyeOutlined, StopOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { trpc } from '../lib/trpc';
import { useMe } from '../lib/auth';

/** Switch and go to My work, with everything reloaded as the new user. */
function useSwitch() {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const start = trpc.auth.viewAsStart.useMutation();
  const stop = trpc.auth.viewAsStop.useMutation();
  const after = async () => {
    await utils.invalidate();
    navigate('/work');
  };
  return {
    busy: start.isPending || stop.isPending,
    start: async (userId: number) => {
      try { await start.mutateAsync({ userId }); await after(); } catch (err) { message.error((err as Error).message); }
    },
    stop: async () => {
      try { await stop.mutateAsync(); await after(); } catch (err) { message.error((err as Error).message); }
    },
  };
}

/**
 * View as (spec 16): the header menu an administrator uses to test the app as a demo
 * account (Demo Sales, Demo Procurement…). Hidden when the server does not allow it.
 */
export function ViewAsMenu() {
  const { me } = useMe();
  const options = trpc.auth.viewAsOptions.useQuery(undefined, { enabled: !!me?.canViewAs, staleTime: 60_000 });
  const sw = useSwitch();
  if (!me?.canViewAs) return null;

  const items = [
    { key: 'title', type: 'group' as const, label: 'View the app as', children: (options.data ?? []).map((o) => ({
      key: String(o.userId),
      icon: <UserOutlined />,
      label: <Space direction="vertical" size={0}><span>{o.displayName}</span><Typography.Text type="secondary" style={{ fontSize: 11 }}>{o.roles.join(', ') || 'no role'} · {o.companies.join(', ') || 'no company'}</Typography.Text></Space>,
      disabled: me.displayName === o.displayName,
    })) },
    ...(me.viewAs ? [{ type: 'divider' as const }, { key: 'stop', icon: <StopOutlined />, label: `Stop previewing (back to ${me.viewAs.realName})` }] : []),
  ];
  return (
    <Dropdown trigger={['click']} disabled={sw.busy} menu={{ items, onClick: ({ key }) => (key === 'stop' ? sw.stop() : sw.start(Number(key))) }}>
      <a data-testid="view-as" style={{ color: '#fff', marginInlineEnd: 20 }} onClick={(e) => e.preventDefault()}>
        <EyeOutlined /> {me.viewAs ? `View as: ${me.displayName}` : 'View as'} <DownOutlined style={{ fontSize: 10 }} />
      </a>
    </Dropdown>
  );
}

/** The banner on every page while viewing as a demo account. */
export function ViewAsBanner() {
  const { me } = useMe();
  const sw = useSwitch();
  if (!me?.viewAs) return null;
  return (
    <Alert type="warning" showIcon banner style={{ marginBottom: 10 }}
      message={<>You are viewing the app as <b>{me.displayName}</b>. Everything you do now is recorded as {me.displayName}, not as {me.viewAs.realName}.</>}
      action={<Button size="small" icon={<StopOutlined />} loading={sw.busy} onClick={sw.stop}>Stop previewing</Button>} />
  );
}
