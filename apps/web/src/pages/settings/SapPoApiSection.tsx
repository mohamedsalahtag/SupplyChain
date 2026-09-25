import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, InputNumber, Radio, Select, Space, Switch, Typography } from 'antd';
import { ApiOutlined, SaveOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';
import { errorText } from '../../lib/workflow';

type FormValues = {
  mode: 'stub' | 'api'; baseUrl: string; createPath: string; lookupPath: string; sapClient: string; authType: 'basic' | 'none';
  user: string; password: string; csrf: boolean; allowSelfSigned: boolean; timeoutSeconds: number; referenceField: string; poNumberPath: string;
};

/** Configuration → SAP purchase orders (spec 23): where the PO outbox sends — the simulator, or the company's PO API. */
export function SapPoApiSection() {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const settings = trpc.settings.getSapPo.useQuery();
  const save = trpc.settings.saveSapPo.useMutation();
  const test = trpc.settings.testSapPo.useMutation();
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const mode = Form.useWatch('mode', form);
  const authType = Form.useWatch('authType', form);

  useEffect(() => { if (settings.data) form.setFieldsValue({ ...settings.data, password: '' }); }, [settings.data, form]);

  const onSave = async (v: FormValues) => {
    try {
      await save.mutateAsync({ ...v, sapClient: v.sapClient ?? '', password: v.password ?? '' });
      message.success('Saved — the SAP outbox uses it from the next run');
      setNotice(null);
      await settings.refetch();
    } catch (err) { message.error(errorText(err)); }
  };
  const onTest = async () => {
    const r = await test.mutateAsync().catch((err: Error) => ({ ok: false as const, message: err.message }));
    setNotice({ type: r.ok ? 'success' : 'error', message: r.message });
  };
  const api = mode === 'api';
  const d = settings.data;

  return (
    <Card size="small" title="SAP purchase orders" loading={settings.isPending}
      extra={<Typography.Text type="secondary">Where the PO team's submitted purchase orders are sent</Typography.Text>}>
      {d && d.mode === 'stub' && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="Purchase orders go to the simulator"
        description="Nothing reaches SAP. A production server refuses to submit to the simulator. Enter the company's PO API below when it is available, test it, then switch the mode to “PO API”." />}
      {d && d.mode === 'api' && d.problems.length > 0 && <Alert type="error" showIcon style={{ marginBottom: 10 }} message="Not complete — nothing is sent until these are filled" description={d.problems.join(' · ')} />}
      <Form<FormValues> form={form} layout="horizontal" labelCol={{ flex: '210px' }} labelAlign="left" colon={false} onFinish={onSave}>
        <Form.Item label="Send purchase orders to" name="mode">
          <Radio.Group id="poMode" options={[{ value: 'stub', label: 'Simulator (test only)' }, { value: 'api', label: 'PO API (SAP)' }]} />
        </Form.Item>
        <Form.Item label="Base URL" name="baseUrl" rules={[{ required: api, pattern: /^https?:\/\//i, message: 'Enter the full https:// address' }]}>
          <Input id="poBaseUrl" placeholder="https://sap-gateway.example.com:44300" />
        </Form.Item>
        <Form.Item label="Create path (POST)" name="createPath" rules={[{ required: api }]} extra="Creates one purchase order. The body is the frozen PO draft plus the reference field.">
          <Input id="poCreatePath" placeholder="/sap/opu/odata/sap/ZCON_PO_SRV/PurchaseOrders" />
        </Form.Item>
        <Form.Item label="Lookup path (GET)" name="lookupPath" rules={[{ required: api, pattern: /\{reference\}/, message: 'Must contain {reference}' }]}
          extra="Finds a PO by the portal reference (POD-…) after a lost reply. {reference} is replaced by the draft number.">
          <Input id="poLookupPath" placeholder="/sap/opu/odata/sap/ZCON_PO_SRV/PurchaseOrders?$filter=ZZPORTALREF eq '{reference}'" />
        </Form.Item>
        <Form.Item label="SAP field for the portal reference" name="referenceField" rules={[{ required: api }]}
          extra="Required: without it an unknown outcome cannot be checked in SAP. Agree it with the SAP team.">
          <Input id="poRefField" style={{ width: 220 }} placeholder="ZZPORTALREF" />
        </Form.Item>
        <Form.Item label="PO number in the reply" name="poNumberPath" rules={[{ required: api }]} extra="Dot path in SAP's JSON reply, e.g. d.PurchaseOrder">
          <Input id="poNumberPath" style={{ width: 220 }} />
        </Form.Item>
        <Form.Item label="SAP client" name="sapClient"><Input id="poSapClient" style={{ width: 90 }} /></Form.Item>
        <Form.Item label="Sign-in" name="authType">
          <Select id="poAuth" style={{ width: 220 }} options={[{ value: 'basic', label: 'User and password (Basic)' }, { value: 'none', label: 'None (network-trusted)' }]} />
        </Form.Item>
        {authType === 'basic' && <>
          <Form.Item label="User" name="user" rules={[{ required: api }]}><Input id="poUser" style={{ width: 220 }} autoComplete="off" /></Form.Item>
          <Form.Item label="Password" name="password" rules={[{ required: api && !d?.hasPassword, message: 'Enter the password' }]}
            extra={d?.hasPassword ? 'Stored encrypted. Leave empty to keep it (only for the same address and user).' : undefined}>
            <Input.Password id="poPassword" style={{ width: 220 }} placeholder={d?.hasPassword ? '••••••••' : ''} autoComplete="new-password" />
          </Form.Item>
        </>}
        <Form.Item label="Fetch a CSRF token first" name="csrf" valuePropName="checked" extra="SAP Gateway (OData) services need it for a POST.">
          <Switch id="poCsrf" size="small" />
        </Form.Item>
        <Form.Item label="Allow self-signed cert" name="allowSelfSigned" valuePropName="checked"><Switch id="poSelfSigned" size="small" /></Form.Item>
        <Form.Item label="Timeout (seconds)" name="timeoutSeconds" extra={`No answer within this time = “SAP outcome unknown” (never resent blindly). Below ${d?.leaseMinutes ?? 5} minutes.`}>
          <InputNumber id="poTimeout" min={5} max={240} style={{ width: 90 }} />
        </Form.Item>
        <Space wrap>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={save.isPending}>Save</Button>
          <Button icon={<ApiOutlined />} loading={test.isPending} disabled={d?.mode !== 'api'} onClick={onTest}>Test lookup</Button>
          <Typography.Text type="secondary">The test only looks a reference up; it never creates a purchase order.</Typography.Text>
        </Space>
      </Form>
      {notice && <Alert type={notice.type} showIcon closable onClose={() => setNotice(null)} message={notice.message} style={{ marginTop: 10 }} />}
    </Card>
  );
}
