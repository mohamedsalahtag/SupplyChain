import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Divider, Form, Input, Space, Switch, Typography } from 'antd';
import { ApiOutlined, LoginOutlined, SaveOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';
import { formatNumber } from '../../lib/format';

type FormValues = {
  url: string;
  baseDn: string;
  upnSuffix: string;
  allowSelfSigned: boolean;
  searchUser: string;
  searchPassword: string;
};

type Notice = { type: 'success' | 'error' | 'warning' | 'info'; message: string; description?: React.ReactNode } | null;

/** Configuration → Active Directory: connection, search account, Test connection, Test login. Spec 05. */
export function ActiveDirectorySection() {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const settings = trpc.ad.get.useQuery();
  const save = trpc.ad.save.useMutation();
  const test = trpc.ad.test.useMutation();
  const testLogin = trpc.ad.testLogin.useMutation();
  const [testNotice, setTestNotice] = useState<Notice>(null);
  const [loginNotice, setLoginNotice] = useState<Notice>(null);
  const [probe, setProbe] = useState({ username: '', password: '' });

  useEffect(() => {
    if (settings.data) form.setFieldsValue({ ...settings.data, searchPassword: '' });
  }, [settings.data, form]);

  const onSave = async (v: FormValues) => {
    try {
      await save.mutateAsync(v);
      message.success('Active Directory settings saved');
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
        ? { type: 'success', message: 'Connected', description: `Signed in with the search account in ${(r.ms / 1000).toFixed(1)} s · ${formatNumber(r.people)} people under the Base DN.` }
        : { type: 'error', message: 'Connection failed', description: r.message },
    );
  };

  const onTestLogin = async () => {
    setLoginNotice(null);
    const r = await testLogin.mutateAsync(probe).catch((err: Error) => ({ ok: false as const, message: err.message }));
    setProbe((p) => ({ ...p, password: '' })); // never keep the password on screen
    if (!r.ok) {
      setLoginNotice({ type: 'error', message: 'Sign-in failed', description: r.message });
      return;
    }
    setLoginNotice({
      type: r.registered && r.active ? 'success' : 'warning',
      message: r.registered ? (r.active ? 'Password accepted — this user can sign in' : 'Password accepted, but the user is disabled in this app') : 'Password accepted, but this user is not registered in this app',
      description: (
        <Descriptions size="small" column={1} items={[
          { label: 'Name', children: r.user.displayName || '—' },
          { label: 'Username', children: r.user.username },
          { label: 'Email', children: r.user.email || '—' },
          { label: 'Department', children: r.user.department || '—' },
        ]} />
      ),
    });
  };

  return (
    <Card size="small" title="Active Directory" loading={settings.isPending}
      extra={<Typography.Text type="secondary">{settings.data?.saved ? 'Saved settings' : 'Using the defaults from the server settings file'}</Typography.Text>}>
      <Form<FormValues> form={form} layout="horizontal" labelCol={{ flex: '160px' }} labelAlign="left" colon={false} onFinish={onSave}>
        <Form.Item label="Server URL" name="url" rules={[{ required: true }]} extra="ldaps://…:636 keeps passwords encrypted on the network.">
          <Input id="adUrl" style={{ width: 320 }} />
        </Form.Item>
        <Form.Item label="Base DN" name="baseDn" rules={[{ required: true }]}>
          <Input id="adBaseDn" />
        </Form.Item>
        <Form.Item label="UPN suffix" name="upnSuffix" rules={[{ required: true }]} extra="Added to a username typed without @, e.g. mohamed.tag → mohamed.tag@sharbatlyfruit.com">
          <Input id="adUpnSuffix" style={{ width: 240 }} />
        </Form.Item>
        <Form.Item label="Allow self-signed cert" name="allowSelfSigned" valuePropName="checked">
          <Switch id="adAllowSelfSigned" size="small" />
        </Form.Item>
        <Divider orientation="left" plain style={{ margin: '4px 0 12px' }}>Search account (used on the Users page)</Divider>
        <Form.Item label="Username" name="searchUser" extra="Temporary: your own account. Replace with a service account from IT.">
          <Input id="adSearchUser" style={{ width: 240 }} autoComplete="off" />
        </Form.Item>
        <Form.Item label="Password" name="searchPassword"
          extra={settings.data?.hasSearchPassword ? 'Stored encrypted. Leave empty to keep the saved password.' : undefined}>
          <Input.Password id="adSearchPassword" style={{ width: 240 }} placeholder={settings.data?.hasSearchPassword ? '••••••••' : ''} autoComplete="new-password" />
        </Form.Item>
        <Space wrap>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={save.isPending}>Save</Button>
          <Button icon={<ApiOutlined />} loading={test.isPending} onClick={onTest}>Test connection</Button>
        </Space>
      </Form>
      {testNotice && <Alert {...testNotice} showIcon closable onClose={() => setTestNotice(null)} style={{ marginTop: 10 }} />}

      <Divider orientation="left" plain style={{ margin: '16px 0 12px' }}>Test login (nothing is stored)</Divider>
      <Space wrap>
        <Input id="probeUser" placeholder="Username" value={probe.username} onChange={(e) => setProbe({ ...probe, username: e.target.value })} style={{ width: 200 }} autoComplete="off" />
        <Input.Password id="probePassword" placeholder="Password" value={probe.password} onChange={(e) => setProbe({ ...probe, password: e.target.value })} style={{ width: 200 }} autoComplete="new-password" />
        <Button icon={<LoginOutlined />} disabled={!probe.username || !probe.password} loading={testLogin.isPending} onClick={onTestLogin}>Test login</Button>
      </Space>
      {loginNotice && <Alert {...loginNotice} showIcon closable onClose={() => setLoginNotice(null)} style={{ marginTop: 10 }} />}
    </Card>
  );
}
