import type { ReactNode } from 'react';
import { Dropdown, Layout, Menu, Result, Spin, Typography } from 'antd';
import { DatabaseOutlined, DownOutlined, HomeOutlined, LogoutOutlined, SafetyOutlined, ShoppingCartOutlined, UserOutlined } from '@ant-design/icons';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { P } from '@supplychain/shared';
import { trpc } from './lib/trpc';
import { useCan, useMe } from './lib/auth';
import { HomePage } from './pages/HomePage';
import { MaterialsPage } from './pages/materials/MaterialsPage';
import { PurchaseOrdersPage } from './pages/purchaseOrders/PurchaseOrdersPage';
import { SuppliersPage } from './pages/suppliers/SuppliersPage';
import { ConfigurationPage } from './pages/settings/ConfigurationPage';
import { SecurityPage } from './pages/security/SecurityPage';
import { UsersPage } from './pages/users/UsersPage';

type Item = { key: string; label: string; perm: string };
type Group = { key: string; label: string; icon: ReactNode; items: Item[] };

/** Side menu, grouped like the permission catalogue. An entry shows only with its "open" permission. */
const MENU: Group[] = [
  { key: 'general', label: 'General', icon: <HomeOutlined />, items: [{ key: '/', label: 'Home', perm: P.homeOpen }] },
  { key: 'md', label: 'Master data', icon: <DatabaseOutlined />, items: [
    { key: '/materials', label: 'Materials', perm: P.materialsOpen },
    { key: '/suppliers', label: 'Suppliers', perm: P.suppliersOpen },
  ] },
  { key: 'purchasing', label: 'Purchasing', icon: <ShoppingCartOutlined />, items: [{ key: '/purchase-orders', label: 'Purchase orders', perm: P.purchaseOrdersOpen }] },
  {
    key: 'admin',
    label: 'Administration',
    icon: <SafetyOutlined />,
    items: [
      { key: '/users', label: 'Users', perm: P.usersOpen },
      { key: '/security', label: 'Security', perm: P.securityOpen },
      { key: '/settings', label: 'Configuration', perm: P.configOpen },
    ],
  },
];

/** Shows the page only with its permission. */
function Guarded({ perm, children }: { perm: string; children: ReactNode }) {
  const can = useCan();
  return can(perm) ? <>{children}</> : <Result status="403" title="No access" subTitle="You do not have permission to open this screen." />;
}

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const utils = trpc.useUtils();
  const { me, loading } = useMe();
  const can = useCan();
  const ui = trpc.settings.getUi.useQuery(undefined, { staleTime: Infinity });
  const logout = trpc.auth.logout.useMutation();

  if (loading) return <Spin fullscreen />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  const items = MENU.map((g) => ({ ...g, items: g.items.filter((i) => can(i.perm)) }))
    .filter((g) => g.items.length > 0)
    .map((g) => ({ key: g.key, icon: g.icon, label: g.label, children: g.items.map((i) => ({ key: i.key, label: i.label })) }));

  const onLogout = async () => {
    await logout.mutateAsync();
    utils.auth.me.setData(undefined, null);
    await utils.invalidate();
    navigate('/login', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', paddingInline: 16, height: 40, lineHeight: '40px' }}>
        <img src={ui.data?.iconDataUrl ?? '/favicon.svg'} alt="" width={22} height={22} style={{ marginInlineEnd: 8, borderRadius: 4, objectFit: 'contain' }} />
        <Typography.Text strong style={{ color: '#fff', fontSize: 14, flex: 1 }}>
          {ui.data?.siteName ?? ''}
        </Typography.Text>
        <Dropdown trigger={['click']} menu={{ items: [{ key: 'logout', icon: <LogoutOutlined />, label: 'Log out', onClick: onLogout }] }}>
          <a data-testid="user-menu" style={{ color: '#fff' }} onClick={(e) => e.preventDefault()}>
            <UserOutlined /> {me.displayName} <DownOutlined style={{ fontSize: 10 }} />
          </a>
        </Dropdown>
      </Layout.Header>
      <Layout>
        <Layout.Sider width={190} theme="light" breakpoint="lg" collapsedWidth={0}>
          <Menu
            mode="inline"
            selectedKeys={[location.pathname]}
            defaultOpenKeys={MENU.map((g) => g.key)}
            items={items}
            onClick={({ key }) => navigate(key)}
            style={{ height: '100%', borderInlineEnd: 0 }}
          />
        </Layout.Sider>
        <Layout.Content style={{ padding: '12px 16px', minWidth: 0 }}>
          <Routes>
            <Route path="/" element={<Guarded perm={P.homeOpen}><HomePage /></Guarded>} />
            <Route path="/materials" element={<Guarded perm={P.materialsOpen}><MaterialsPage /></Guarded>} />
            <Route path="/suppliers" element={<Guarded perm={P.suppliersOpen}><SuppliersPage /></Guarded>} />
            <Route path="/purchase-orders" element={<Guarded perm={P.purchaseOrdersOpen}><PurchaseOrdersPage /></Guarded>} />
            <Route path="/users" element={<Guarded perm={P.usersOpen}><UsersPage /></Guarded>} />
            <Route path="/security" element={<Guarded perm={P.securityOpen}><SecurityPage /></Guarded>} />
            <Route path="/settings" element={<Guarded perm={P.configOpen}><ConfigurationPage /></Guarded>} />
            <Route path="*" element={<Result status="404" title="Page not found" />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
