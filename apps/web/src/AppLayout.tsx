import type { ReactNode } from 'react';
import { Badge, Dropdown, Layout, Menu, Result, Space, Spin, Typography } from 'antd';
import { CheckSquareOutlined, DatabaseOutlined, DownOutlined, LogoutOutlined, SafetyOutlined, ShoppingCartOutlined, UserOutlined } from '@ant-design/icons';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { P } from '@supplychain/shared';
import { trpc } from './lib/trpc';
import { useCan, useMe } from './lib/auth';
import { MaterialsPage } from './pages/materials/MaterialsPage';
import { PurchaseOrdersPage } from './pages/purchaseOrders/PurchaseOrdersPage';
import { SuppliersPage } from './pages/suppliers/SuppliersPage';
import { ConfigurationPage } from './pages/settings/ConfigurationPage';
import { SecurityPage } from './pages/security/SecurityPage';
import { UsersPage } from './pages/users/UsersPage';
import { MyWorkPage } from './pages/work/MyWorkPage';
import { DemandPage } from './pages/demands/DemandPage';
import { ChangeEditorPage } from './pages/changes/ChangeEditorPage';
import { ChangeRequestPage } from './pages/changes/ChangeRequestPage';
import { ChangeRequestsListPage } from './pages/changes/ChangeRequestsListPage';
import { NotSourcedPage } from './pages/changes/NotSourcedPage';
import { MergePage } from './pages/merge/MergePage';
import { AwardBatchPage } from './pages/award/AwardBatchPage';
import { AwardPage } from './pages/award/AwardPage';
import { AwardsListPage } from './pages/award/AwardsListPage';
import { HandoffPage } from './pages/handoff/HandoffPage';
import { PoDraftPage } from './pages/po/PoDraftPage';
import { PoDraftsListPage } from './pages/po/PoDraftsListPage';
import { ReportsPage } from './pages/reports/ReportsPage';
import { OpsStatusPage } from './pages/ops/OpsStatusPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HandoffsListPage } from './pages/handoff/HandoffsListPage';
import { RfqBuilderPage } from './pages/rfq/RfqBuilderPage';
import { RfqPage } from './pages/rfq/RfqPage';
import { RfqsListPage } from './pages/rfq/RfqsListPage';
import { DemandsListPage } from './pages/demands/DemandsListPage';
import { ViewAsBanner, ViewAsMenu } from './components/ViewAs';

type Item = { key: string; label: string; perm: string };
type Group = { key: string; label: string; icon: ReactNode; items: Item[] };

/** Side menu, grouped like the permission catalogue. An entry shows only with its "open" permission. */
const MENU: Group[] = [
  { key: 'general', label: 'General', icon: <CheckSquareOutlined />, items: [{ key: '/work', label: 'My work', perm: P.workOpen }] },
  { key: 'md', label: 'Master data', icon: <DatabaseOutlined />, items: [
    { key: '/materials', label: 'Materials', perm: P.materialsOpen },
    { key: '/suppliers', label: 'Suppliers', perm: P.suppliersOpen },
  ] },
  { key: 'purchasing', label: 'Purchasing', icon: <ShoppingCartOutlined />, items: [
    { key: '/demands', label: 'Demands', perm: P.demandsOpen },
    { key: '/rfqs', label: 'RFQs', perm: P.rfqsOpen },
    { key: '/awards', label: 'Awards', perm: P.awardsOpen },
    { key: '/handoffs', label: 'Handoffs', perm: P.handoffsOpen },
    { key: '/po-drafts', label: 'PO drafts & SAP', perm: P.poOpen },
    { key: '/change-requests', label: 'Change requests', perm: P.crsOpen },
    { key: '/purchase-orders', label: 'Purchase orders', perm: P.purchaseOrdersOpen },
    { key: '/reports', label: 'Reports', perm: P.reportsOpen },
  ] },
  {
    key: 'admin',
    label: 'Administration',
    icon: <SafetyOutlined />,
    items: [
      { key: '/users', label: 'Users', perm: P.usersOpen },
      { key: '/security', label: 'Security', perm: P.securityOpen },
      { key: '/operations', label: 'Operations status', perm: P.operationsOpen },
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
  // Menu badge (spec 10): open work items, refreshed every minute while the tab is visible.
  const work = trpc.work.tabs.useQuery(undefined, { enabled: !!me && can(P.workOpen), refetchInterval: 60_000 });
  const workCount = work.data?.total ?? 0;
  const workOverdue = (work.data?.tabs ?? []).some((t) => t.overdue > 0);

  if (loading) return <Spin fullscreen />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  const items = MENU.map((g) => ({ ...g, items: g.items.filter((i) => can(i.perm)) }))
    .filter((g) => g.items.length > 0)
    .map((g) => ({
      key: g.key,
      icon: g.icon,
      label: g.label,
      children: g.items.map((i) => ({
        key: i.key,
        label:
          i.key === '/work' && workCount > 0 ? (
            <Space size={6}>{i.label}<Badge count={workCount} color={workOverdue ? 'red' : '#8c8c8c'} overflowCount={999} /></Space>
          ) : (
            i.label
          ),
      })),
    }));

  const onLogout = async () => {
    await logout.mutateAsync();
    utils.auth.me.setData(undefined, null);
    await utils.invalidate();
    navigate('/login', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', paddingInline: 16, height: 40, lineHeight: '40px', ...(me.viewAs ? { background: '#ad4e00' } : {}) }}>
        <img src={ui.data?.iconDataUrl ?? '/favicon.svg'} alt="" width={22} height={22} style={{ marginInlineEnd: 8, borderRadius: 4, objectFit: 'contain' }} />
        <Typography.Text strong style={{ color: '#fff', fontSize: 14, flex: 1 }}>
          {ui.data?.siteName ?? ''}
        </Typography.Text>
        <ViewAsMenu />
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
            selectedKeys={[location.pathname.startsWith('/demands/') ? '/demands' : location.pathname.startsWith('/change-requests/') ? '/change-requests' : location.pathname.startsWith('/rfqs/') ? '/rfqs' : location.pathname.startsWith('/awards/') ? '/awards' : location.pathname.startsWith('/handoffs/') ? '/handoffs' : location.pathname.startsWith('/po-drafts/') ? '/po-drafts' : location.pathname]}
            defaultOpenKeys={MENU.map((g) => g.key)}
            items={items}
            onClick={({ key }) => navigate(key)}
            style={{ height: '100%', borderInlineEnd: 0 }}
          />
        </Layout.Sider>
        <Layout.Content style={{ padding: '12px 16px', minWidth: 0 }}>
          <ViewAsBanner />
          <ErrorBoundary resetKey={location.pathname}>
          <Routes>
            <Route path="/" element={<Navigate to="/work" replace />} />
            <Route path="/work" element={<Guarded perm={P.workOpen}><MyWorkPage /></Guarded>} />
            <Route path="/materials" element={<Guarded perm={P.materialsOpen}><MaterialsPage /></Guarded>} />
            <Route path="/suppliers" element={<Guarded perm={P.suppliersOpen}><SuppliersPage /></Guarded>} />
            <Route path="/demands" element={<Guarded perm={P.demandsOpen}><DemandsListPage /></Guarded>} />
            <Route path="/demands/:demandId" element={<Guarded perm={P.demandsOpen}><DemandPage /></Guarded>} />
            <Route path="/demands/:demandId/change" element={<Guarded perm={P.crRaiseSales}><ChangeEditorPage /></Guarded>} />
            <Route path="/demands/:demandId/merge" element={<Guarded perm={P.demandMerge}><MergePage /></Guarded>} />
            <Route path="/demands/:demandId/not-sourced" element={<Guarded perm={P.crRaiseProcurement}><NotSourcedPage /></Guarded>} />
            <Route path="/rfqs" element={<Guarded perm={P.rfqsOpen}><RfqsListPage /></Guarded>} />
            <Route path="/rfqs/new" element={<Guarded perm={P.rfqManage}><RfqBuilderPage /></Guarded>} />
            <Route path="/rfqs/:rfqId" element={<Guarded perm={P.rfqsOpen}><RfqPage /></Guarded>} />
            <Route path="/rfqs/:rfqId/award" element={<Guarded perm={P.awardManage}><AwardPage /></Guarded>} />
            <Route path="/awards" element={<Guarded perm={P.awardsOpen}><AwardsListPage /></Guarded>} />
            <Route path="/awards/:awardBatchId" element={<Guarded perm={P.awardsOpen}><AwardBatchPage /></Guarded>} />
            <Route path="/handoffs" element={<Guarded perm={P.handoffsOpen}><HandoffsListPage /></Guarded>} />
            <Route path="/handoffs/:handoffId" element={<Guarded perm={P.handoffsOpen}><HandoffPage /></Guarded>} />
            <Route path="/po-drafts" element={<Guarded perm={P.poOpen}><PoDraftsListPage /></Guarded>} />
            <Route path="/operations" element={<Guarded perm={P.operationsOpen}><OpsStatusPage /></Guarded>} />
            <Route path="/reports" element={<Guarded perm={P.reportsOpen}><ReportsPage /></Guarded>} />
            <Route path="/po-drafts/:poDraftId" element={<Guarded perm={P.poOpen}><PoDraftPage /></Guarded>} />
            <Route path="/change-requests" element={<Guarded perm={P.crsOpen}><ChangeRequestsListPage /></Guarded>} />
            <Route path="/change-requests/:crId" element={<Guarded perm={P.crsOpen}><ChangeRequestPage /></Guarded>} />
            <Route path="/purchase-orders" element={<Guarded perm={P.purchaseOrdersOpen}><PurchaseOrdersPage /></Guarded>} />
            <Route path="/users" element={<Guarded perm={P.usersOpen}><UsersPage /></Guarded>} />
            <Route path="/security" element={<Guarded perm={P.securityOpen}><SecurityPage /></Guarded>} />
            <Route path="/settings" element={<Guarded perm={P.configOpen}><ConfigurationPage /></Guarded>} />
            <Route path="*" element={<Result status="404" title="Page not found" />} />
          </Routes>
          </ErrorBoundary>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
