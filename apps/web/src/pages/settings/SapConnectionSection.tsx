import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Space, Switch, Typography } from 'antd';
import { ApiOutlined, SaveOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';
import { formatNumber } from '../../lib/format';

type FormValues = {
  baseUrl: string;
  materialsPath: string;
  sapClient: string;
  user: string;
  password: string;
  allowSelfSigned: boolean;
};

type Notice = { type: 'success' | 'error' | 'warning'; message: string; description?: string } | null;

/** Configuration → SAP connection: save and test. Spec 02. */
export function SapConnectionSection() {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [testNotice, setTestNotice] = useState<Notice>(null);

  const settings = trpc.settings.getSap.useQuery();
  const save = trpc.settings.saveSap.useMutation();
  const test = trpc.settings.testSap.useMutation();

  useEffect(() => {
    if (settings.data) form.setFieldsValue({ ...settings.data, password: '' });
  }, [settings.data, form]);

  const onSave = async (values: FormValues) => {
    try {
      await save.mutateAsync({ ...values, sapClient: values.sapClient ?? '' });
      message.success('Connection settings saved');
      setTestNotice(null);
      await settings.refetch();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const onTest = async () => {
    setTestNotice(null);
    const r = await test.mutateAsync().catch((err: Error) => ({ ok: false as const, message: err.message }));
    setTestNotice(
      r.ok
        ? { type: 'success', message: 'Connected', description: `SAP answered in ${(r.ms / 1000).toFixed(1)} s · ${formatNumber(r.count)} SAP materials of type ${r.materialTypes.join(', ')} in the chosen categories (codes starting with a number are skipped by the sync).` }
        : { type: 'error', message: 'Connection failed', description: r.message },
    );
  };

  /** True when the form differs from what is saved (a typed password always counts). */
  const hasUnsavedChanges = () => {
    const saved = settings.data;
    if (!saved) return true;
    const v = form.getFieldsValue();
    return (
      !!v.password ||
      (['baseUrl', 'materialsPath', 'sapClient', 'user', 'allowSelfSigned'] as const).some((k) => (v[k] ?? '') !== (saved[k] ?? ''))
    );
  };

  return (
    <Card size="small" title="SAP connection" extra={<Typography.Text type="secondary">Where the app reads master data from</Typography.Text>} loading={settings.isPending}>
        <Form<FormValues> form={form} layout="horizontal" labelCol={{ flex: '150px' }} labelAlign="left" colon={false} onFinish={onSave}
          initialValues={{ allowSelfSigned: false, sapClient: '' }}>
          <Form.Item label="Base URL" name="baseUrl" rules={[{ required: true, type: 'url', message: 'Enter the full https:// address' }]}>
            <Input id="baseUrl" />
          </Form.Item>
          <Form.Item label="Materials service path" name="materialsPath" rules={[{ required: true }]}>
            <Input id="materialsPath" />
          </Form.Item>
          <Form.Item label="SAP client" name="sapClient">
            <Input id="sapClient" style={{ width: 90 }} />
          </Form.Item>
          <Form.Item label="User" name="user" rules={[{ required: true }]}>
            <Input id="user" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item label="Password" name="password"
            rules={[{ required: !settings.data?.hasPassword, message: 'Enter the password' }]}
            extra={settings.data?.hasPassword ? 'Stored encrypted. Leave empty to keep the saved password.' : undefined}>
            <Input.Password id="password" style={{ width: 220 }} placeholder={settings.data?.hasPassword ? '••••••••' : ''} autoComplete="new-password" />
          </Form.Item>
          <Form.Item label="Allow self-signed cert" name="allowSelfSigned" valuePropName="checked">
            <Switch id="allowSelfSigned" size="small" />
          </Form.Item>
          <Space wrap>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={save.isPending}>
              Save
            </Button>
            <Button icon={<ApiOutlined />} loading={test.isPending} onClick={() => (hasUnsavedChanges() ? message.warning('Save your changes first — the test uses the saved settings') : onTest())}>
              Test connection
            </Button>
          </Space>
        </Form>
        {testNotice && <Alert {...testNotice} showIcon closable onClose={() => setTestNotice(null)} style={{ marginTop: 10 }} />}
    </Card>
  );
}
