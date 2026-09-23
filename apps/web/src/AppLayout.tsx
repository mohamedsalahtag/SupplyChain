import { Layout, Menu, Typography } from 'antd';
import { DatabaseOutlined, HomeOutlined, SettingOutlined } from '@ant-design/icons';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { trpc } from './lib/trpc';
import { HomePage } from './pages/HomePage';
import { MaterialsPage } from './pages/materials/MaterialsPage';
import { ConfigurationPage } from './pages/settings/ConfigurationPage';

/** Side-menu entries. A screen is added here only once its spec is approved. */
const MENU = [
  { key: '/', icon: <HomeOutlined />, label: 'Home' },
  {
    key: 'md',
    icon: <DatabaseOutlined />,
    label: 'Master data',
    children: [{ key: '/materials', label: 'Materials' }],
  },
  {
    key: 'settings',
    icon: <SettingOutlined />,
    label: 'Settings',
    children: [{ key: '/settings', label: 'Configuration' }],
  },
];

export function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const ui = trpc.settings.getUi.useQuery(undefined, { staleTime: Infinity });

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header
        style={{ display: 'flex', alignItems: 'center', paddingInline: 16, height: 40, lineHeight: '40px' }}
      >
        <img src={ui.data?.iconDataUrl ?? '/favicon.svg'} alt="" width={22} height={22} style={{ marginInlineEnd: 8, borderRadius: 4, objectFit: 'contain' }} />
        <Typography.Text strong style={{ color: '#fff', fontSize: 14 }}>
          {ui.data?.siteName ?? ''}
        </Typography.Text>
      </Layout.Header>
      <Layout>
        <Layout.Sider width={190} theme="light" breakpoint="lg" collapsedWidth={0}>
          <Menu
            mode="inline"
            selectedKeys={[pathname]}
            defaultOpenKeys={['md', 'settings']}
            items={MENU}
            onClick={({ key }) => navigate(key)}
            style={{ height: '100%', borderInlineEnd: 0 }}
          />
        </Layout.Sider>
        <Layout.Content style={{ padding: '12px 16px', minWidth: 0 }}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/materials" element={<MaterialsPage />} />
            <Route path="/settings" element={<ConfigurationPage />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
