import { Result, Space, Tabs, Typography } from 'antd';
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

/** Settings → Configuration: one tab per area, shown only with its permission. The open tab is in the URL (?tab=). */
export function ConfigurationPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();

  const tabs = [
    can(P.configGeneralEdit) && { key: 'general', label: 'General', children: <GeneralSection /> },
    can(P.configAppearanceEdit) && { key: 'appearance', label: 'Appearance', children: <AppearanceSection /> },
    can(P.configSapEdit) && { key: 'sap', label: 'SAP connection', children: <SapConnectionSection /> },
    can(P.configSapEdit) && { key: 'sappo', label: 'SAP purchase orders', children: <SapPoApiSection /> },
    (can(P.configSyncTypesEdit) || can(P.configSyncRun)) && {
      key: 'sync',
      label: 'Materials sync',
      children: (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {can(P.configSyncTypesEdit) && <MaterialTypesSection />}
          {can(P.configSyncRun) && <MaterialsSyncSection />}
        </Space>
      ),
    },
    (can(P.configSuppliersEdit) || can(P.configSuppliersRun)) && { key: 'suppliers', label: 'Suppliers sync', children: <SuppliersSyncTab /> },
    (can(P.configPoEdit) || can(P.configPoRun)) && { key: 'po', label: 'Purchase orders sync', children: <PurchaseOrdersSyncTab /> },
    can(P.configWfCompaniesEdit) && { key: 'companies', label: 'Companies', children: <CompaniesTab /> },
    can(P.configWfReasonsEdit) && { key: 'reasons', label: 'Reason codes', children: <ReasonCodesTab /> },
    can(P.configWfOriginsEdit) && { key: 'origins', label: 'Origins', children: <OriginsTab /> },
    can(P.configOpen) && { key: 'supplier-origins', label: 'Supplier origins', children: <SupplierOriginsTab /> },
    can(P.configWfSettingsEdit) && { key: 'workflow', label: 'Workflow', children: <WorkflowSettingsTab /> },
    can(P.configShippingEdit) && { key: 'shipping', label: 'Shipping terms', children: <ShippingTermsTab /> },
    can(P.configAdEdit) && { key: 'ad', label: 'Active Directory', children: <ActiveDirectorySection /> },
  ].filter((t): t is { key: string; label: string; children: JSX.Element } => !!t);

  const tab = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab')! : tabs[0]?.key;
  // Table tabs use the full page width; form tabs stay narrow.
  const wide = ['companies', 'reasons', 'origins'].includes(tab ?? '');

  return (
    <div style={{ width: '100%', maxWidth: wide ? undefined : 780 }}>
      <BackToWork />
      <Typography.Title level={5} style={{ margin: 0 }}>
        Configuration
      </Typography.Title>
      {tabs.length === 0 ? (
        <Result status="403" title="Nothing to configure" subTitle="You have no configuration permissions." />
      ) : (
        <Tabs activeKey={tab} onChange={(key) => setParams((p) => { p.set('tab', key); return p; }, { replace: true })} items={tabs} />
      )}
    </div>
  );
}
