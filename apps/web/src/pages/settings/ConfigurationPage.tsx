import { Space, Tabs, Typography } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { AppearanceSection } from './AppearanceSection';
import { GeneralSection } from './GeneralSection';
import { MaterialsSyncSection } from './MaterialsSyncSection';
import { MaterialTypesSection } from './MaterialTypesSection';
import { SapConnectionSection } from './SapConnectionSection';

const TABS = [
  { key: 'general', label: 'General', children: <GeneralSection /> },
  { key: 'appearance', label: 'Appearance', children: <AppearanceSection /> },
  { key: 'sap', label: 'SAP connection', children: <SapConnectionSection /> },
  {
    key: 'sync',
    label: 'Materials sync',
    children: (
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <MaterialTypesSection />
        <MaterialsSyncSection />
      </Space>
    ),
  },
];

/** Settings → Configuration: one tab per area. The open tab is in the URL (?tab=), so links and refresh keep it. */
export function ConfigurationPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab')! : 'general';

  return (
    <div style={{ width: '100%', maxWidth: 780 }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        Configuration
      </Typography.Title>
      <Tabs activeKey={tab} onChange={(key) => setParams({ tab: key }, { replace: true })} items={TABS} />
    </div>
  );
}
