import { Grid, Menu, Result, Space, Typography } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { P } from '@supplychain/shared';
import { useCan } from '../../lib/auth';
import { ActiveDirectorySection } from './ActiveDirectorySection';
import { AppearanceSection } from './AppearanceSection';
import { GeneralSection } from './GeneralSection';
import { MaterialsSyncSection } from './MaterialsSyncSection';
import { MaterialTypesSection } from './MaterialTypesSection';
import { PurchaseOrdersSyncTab } from './PurchaseOrdersSyncTab';
import { SapConnectionSection } from './SapConnectionSection';
import { SapPoApiSection } from './SapPoApiSection';
import { ShippingTermsTab } from './ShippingTermsTab';
import { SuppliersSyncTab } from './SuppliersSyncTab';
import { CompaniesTab } from './workflow/CompaniesTab';
import { OriginsTab } from './workflow/OriginsTab';
import { SupplierOriginsTab } from './workflow/SupplierOriginsTab';
import { ReasonCodesTab } from './workflow/ReasonCodesTab';
import { WorkflowSettingsTab } from './workflow/WorkflowSettingsTab';
import { BackToWork } from '../../components/BackToWork';

/**
 * Settings → Configuration: one section per area, shown only with its permission, listed in a vertical menu grouped by
 * subject so every section is always visible. The open section is in the URL (?tab=), as before.
 */
export function ConfigurationPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();

  const screens = Grid.useBreakpoint();
  const tabs = [
    can(P.configGeneralEdit) && { key: 'general', group: 'General', label: 'General', children: <GeneralSection /> },
    can(P.configAppearanceEdit) && { key: 'appearance', group: 'General', label: 'Appearance', children: <AppearanceSection /> },
    can(P.configSapEdit) && { key: 'sap', group: 'SAP', label: 'SAP connection', children: <SapConnectionSection /> },
    can(P.configSapEdit) && { key: 'sappo', group: 'SAP', label: 'SAP purchase orders', children: <SapPoApiSection /> },
    (can(P.configSyncTypesEdit) || can(P.configSyncRun)) && {
      key: 'sync',
      group: 'SAP',
      label: 'Materials sync',
      children: (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {can(P.configSyncTypesEdit) && <MaterialTypesSection />}
          {can(P.configSyncRun) && <MaterialsSyncSection />}
        </Space>
      ),
    },
    (can(P.configSuppliersEdit) || can(P.configSuppliersRun)) && { key: 'suppliers', group: 'SAP', label: 'Suppliers sync', children: <SuppliersSyncTab /> },
    (can(P.configPoEdit) || can(P.configPoRun)) && { key: 'po', group: 'SAP', label: 'Purchase orders sync', children: <PurchaseOrdersSyncTab /> },
    can(P.configWfCompaniesEdit) && { key: 'companies', group: 'Workflow', label: 'Companies', children: <CompaniesTab /> },
    can(P.configWfReasonsEdit) && { key: 'reasons', group: 'Workflow', label: 'Reason codes', children: <ReasonCodesTab /> },
    can(P.configWfOriginsEdit) && { key: 'origins', group: 'Workflow', label: 'Origins', children: <OriginsTab /> },
    can(P.configOpen) && { key: 'supplier-origins', group: 'Workflow', label: 'Supplier origins', children: <SupplierOriginsTab /> },
    can(P.configWfSettingsEdit) && { key: 'workflow', group: 'Workflow', label: 'Workflow', children: <WorkflowSettingsTab /> },
    can(P.configShippingEdit) && { key: 'shipping', group: 'Workflow', label: 'Shipping terms', children: <ShippingTermsTab /> },
    can(P.configAdEdit) && { key: 'ad', group: 'Sign-in', label: 'Active Directory', children: <ActiveDirectorySection /> },
  ].filter((t): t is { key: string; group: string; label: string; children: JSX.Element } => !!t);

  const tab = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab')! : tabs[0]?.key;
  // Table tabs use the full page width; form tabs stay narrow.
  const wide = ['companies', 'reasons', 'origins'].includes(tab ?? '');

  const groups = ['General', 'SAP', 'Workflow', 'Sign-in'].map((g) => ({
    type: 'group' as const, key: g, label: g,
    children: tabs.filter((t) => t.group === g).map((t) => ({ key: t.key, label: t.label })),
  })).filter((g) => g.children.length > 0);
  const current = tabs.find((t) => t.key === tab);
  const open = (key: string) => setParams((p) => { p.set('tab', key); return p; }, { replace: true });

  return (
    <div style={{ width: '100%' }}>
      <BackToWork />
      <Typography.Title level={5} style={{ margin: 0 }}>
        Configuration
      </Typography.Title>
      {tabs.length === 0 ? (
        <Result status="403" title="Nothing to configure" subTitle="You have no configuration permissions." />
      ) : (
        <div style={{ display: 'flex', flexDirection: screens.md ? 'row' : 'column', gap: 16, alignItems: 'flex-start', marginTop: 8 }}>
          <nav aria-label="Configuration sections" style={{ width: screens.md ? 210 : '100%', flex: 'none', position: screens.md ? 'sticky' : undefined, top: 8 }}>
            <Menu mode="inline" selectedKeys={tab ? [tab] : []} items={groups} onClick={(e) => open(e.key)} data-testid="config-menu"
              style={{ borderInlineEnd: 'none', background: 'transparent' }} />
          </nav>
          <section aria-label={current?.label} data-testid="config-section" style={{ flex: 1, minWidth: 0, maxWidth: wide ? undefined : 780, width: '100%' }}>
            {current?.children}
          </section>
        </div>
      )}
    </div>
  );
}
