import { useState } from 'react';
import { App, Button, Drawer, Form, Input, Space, Switch, Tag, Typography } from 'antd';
import { PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../../components/AppTable';
import { useCan } from '../../../lib/auth';
import type { RouterOutputs } from '../../../lib/format';
import { trpc } from '../../../lib/trpc';
import { useTablePrefs } from '../../../lib/useTablePrefs';

type Row = RouterOutputs['workflowSetup']['companies'][number];
type FormValues = { companyCode: string; name: string; country: string; timeZone: string; defaultPlant: string; purchasingOrg: string; purchasingGroup: string; isActive: boolean };

const NEW: FormValues = { companyCode: '', name: '', country: '', timeZone: '', defaultPlant: 'HO01', purchasingOrg: '', purchasingGroup: '', isActive: true };

/** Configuration → Companies (spec 11). */
export function CompaniesTab() {
  const { message } = App.useApp();
  const can = useCan();
  const utils = trpc.useUtils();
  const prefs = useTablePrefs('wf-companies');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const list = trpc.workflowSetup.companies.useQuery();
  const save = trpc.workflowSetup.saveCompany.useMutation();
  const editable = can(P.configWfCompaniesEdit);

  const openDrawer = (r: Row | 'new') => {
    setEditing(r);
    form.setFieldsValue(
      r === 'new'
        ? NEW
        : { companyCode: r.CompanyCode, name: r.Name, country: r.Country, timeZone: r.TimeZone, defaultPlant: r.DefaultPlant, purchasingOrg: r.PurchasingOrg, purchasingGroup: r.PurchasingGroup, isActive: r.IsActive },
    );
  };

  const onSave = async (v: FormValues) => {
    try {
      await save.mutateAsync({ ...v, rowVer: editing === 'new' || !editing ? null : editing.RowVer });
      message.success(`Company ${v.companyCode} saved`);
      await Promise.all([utils.workflowSetup.companies.invalidate(), utils.workflowSetup.companyOptions.invalidate()]);
      setEditing(null);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const columns: AppColumn<Row>[] = [
    { title: 'Code', key: 'CompanyCode', dataIndex: 'CompanyCode', width: 70 },
    { title: 'Name', key: 'Name', dataIndex: 'Name', width: 140 },
    { title: 'Country', key: 'Country', dataIndex: 'Country', width: 65 },
    { title: 'Time zone', key: 'TimeZone', dataIndex: 'TimeZone', width: 110 },
    { title: 'Plant', key: 'DefaultPlant', dataIndex: 'DefaultPlant', width: 65 },
    { title: 'Purchasing org', key: 'PurchasingOrg', width: 100, render: (_: unknown, r) => r.PurchasingOrg || <Tag color="warning">not set</Tag> },
    { title: 'Purch. group', key: 'PurchasingGroup', dataIndex: 'PurchasingGroup', width: 85 },
    { title: 'Orgs used in POs', key: 'orgHints', width: 150, render: (_: unknown, r) => r.orgHints.map((h) => `${h.org} (${h.orders.toLocaleString('en-GB')})`).join(' · ') || '—' },
    { title: 'Status', key: 'IsActive', width: 70, render: (_: unknown, r) => <Tag color={r.IsActive ? 'green' : 'default'}>{r.IsActive ? 'Active' : 'Inactive'}</Tag> },
  ];

  const current = editing && editing !== 'new' ? editing : null;
  return (
    <>
      <AppTable<Row>
        prefs={prefs}
        itemName="companies"
        rowKey="CompanyCode"
        columns={columns}
        dataSource={list.data}
        loading={list.isFetching}
        page={page}
        total={list.data?.length ?? 0}
        onPageChange={setPage}
        onRow={(r) => ({ onClick: () => openDrawer(r), style: { cursor: 'pointer' } })}
        toolbar={editable && <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer('new')}>Add company</Button>}
      />
      <Drawer open={!!editing} onClose={() => setEditing(null)} width={420} title={current ? `Company ${current.CompanyCode}` : 'New company'} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={onSave} disabled={!editable} requiredMark={false}>
          <Form.Item label="Company code" name="companyCode" rules={[{ required: true, message: 'Enter the SAP company code' }]}>
            <Input id="companyCode" maxLength={10} disabled={!!current} />
          </Form.Item>
          <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Enter a name' }]}>
            <Input id="companyName" maxLength={100} />
          </Form.Item>
          <Form.Item label="Country (2 letters)" name="country" rules={[{ required: true, pattern: /^[A-Z]{2}$/, message: 'Two capital letters, e.g. SA' }]}>
            <Input id="companyCountry" maxLength={2} />
          </Form.Item>
          <Form.Item label="Time zone (for confirmed ETD dates)" name="timeZone" rules={[{ required: true, message: 'e.g. Asia/Riyadh' }]}>
            <Input id="companyTz" placeholder="Asia/Riyadh" />
          </Form.Item>
          <Form.Item label="Default plant" name="defaultPlant" rules={[{ required: true }]}>
            <Input id="companyPlant" maxLength={10} />
          </Form.Item>
          <Form.Item label="Purchasing organization" name="purchasingOrg"
            extra={current?.orgHints.length ? `Used in this company's POs: ${current.orgHints.map((h) => `${h.org} (${h.orders.toLocaleString('en-GB')})`).join(' · ')}` : 'Needed before POs can be built for this company.'}>
            <Input id="companyOrg" maxLength={10} />
          </Form.Item>
          <Form.Item label="Purchasing group" name="purchasingGroup">
            <Input id="companyGroup" maxLength={10} />
          </Form.Item>
          <Space>
            <Form.Item name="isActive" valuePropName="checked" noStyle>
              <Switch id="companyActive" />
            </Form.Item>
            <Typography.Text>Active</Typography.Text>
          </Space>
          {editable && (
            <div style={{ marginTop: 16 }}>
              <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={save.isPending}>Save</Button>
            </div>
          )}
        </Form>
      </Drawer>
    </>
  );
}
