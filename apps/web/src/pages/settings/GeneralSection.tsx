import { useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, Space, Tag, Typography, Upload } from 'antd';
import { DeleteOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';

const ICON_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'];
const ICON_MAX_BYTES = 256 * 1024;
const DEFAULT_ICON = '/favicon.svg';

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Database status (moved here from the old Home screen, spec 10). */
function SystemStatusCard() {
  const health = trpc.health.useQuery();
  const status = health.isPending ? (
    <Tag>Checking…</Tag>
  ) : health.error ? (
    <Tag color="red">API unreachable</Tag>
  ) : health.data.database === 'connected' ? (
    <Tag color="green">Connected</Tag>
  ) : (
    <Tag color="red">Database unreachable — see the server log</Tag>
  );
  return (
    <Card size="small" title="System status">
      <Space>
        <Typography.Text>Database:</Typography.Text>
        {status}
      </Space>
    </Card>
  );
}

/** Configuration → General: system status, site name and icon (browser tab + header), for every user. Spec 04. */
export function GeneralSection() {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const ui = trpc.settings.getUi.useQuery();
  const save = trpc.settings.saveBranding.useMutation();
  const [siteName, setSiteName] = useState('');
  const [icon, setIcon] = useState<string | null>(null);

  useEffect(() => {
    if (!ui.data) return;
    setSiteName(ui.data.siteName);
    setIcon(ui.data.iconDataUrl);
  }, [ui.data]);

  const pickIcon = async (file: File) => {
    if (!ICON_TYPES.includes(file.type)) {
      message.error('Choose a PNG, JPG, SVG, WEBP or ICO image');
    } else if (file.size > ICON_MAX_BYTES) {
      message.error('The icon must be 256 KB or smaller');
    } else {
      setIcon(await readAsDataUrl(file));
    }
    return false; // keep the file in the browser until Save
  };

  const onSave = async () => {
    try {
      await save.mutateAsync({ siteName: siteName.trim(), iconDataUrl: icon });
      await utils.settings.getUi.invalidate(); // header, tab title and icon update at once
      message.success('Site name and icon saved');
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const changed = ui.data && (siteName.trim() !== ui.data.siteName || icon !== ui.data.iconDataUrl);

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <SystemStatusCard />
      <Card size="small" title="Site name and icon" loading={ui.isPending}
        extra={<Typography.Text type="secondary">Shown in the header and the browser tab, for every user</Typography.Text>}>
        <Form layout="horizontal" labelCol={{ flex: '150px' }} labelAlign="left" colon={false}>
          <Form.Item label="Site name" required validateStatus={siteName.trim() ? undefined : 'error'}
            help={siteName.trim() ? undefined : 'Enter a site name'}>
            <Input id="siteName" value={siteName} maxLength={60} showCount onChange={(e) => setSiteName(e.target.value)} style={{ width: 320 }} />
          </Form.Item>
          <Form.Item label="Icon" extra="PNG, JPG, SVG, WEBP or ICO, up to 256 KB. A square image works best.">
            <Space align="center" wrap>
              <img src={icon ?? DEFAULT_ICON} alt="Current icon" width={40} height={40}
                style={{ objectFit: 'contain', border: '1px solid #e5e7e6', borderRadius: 6, padding: 4, background: '#fff' }} />
              <Upload accept={ICON_TYPES.join(',')} showUploadList={false} beforeUpload={pickIcon}>
                <Button icon={<UploadOutlined />}>Choose image…</Button>
              </Upload>
              <Button icon={<DeleteOutlined />} disabled={!icon} onClick={() => setIcon(null)}>
                Use default icon
              </Button>
            </Space>
          </Form.Item>
          <Button type="primary" icon={<SaveOutlined />} disabled={!changed || !siteName.trim()} loading={save.isPending} onClick={onSave}>
            Save
          </Button>
        </Form>
      </Card>
    </Space>
  );
}
