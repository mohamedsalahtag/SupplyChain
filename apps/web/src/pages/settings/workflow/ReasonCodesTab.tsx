import { useState } from 'react';
import { App, Button, Drawer, Form, Input, Select, Space, Switch, Tag, Typography } from 'antd';
import { PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { P } from '@supplychain/shared';
import { AppTable, type AppColumn } from '../../../components/AppTable';
import { useCan } from '../../../lib/auth';
import type { RouterOutputs } from '../../../lib/format';
import { trpc } from '../../../lib/trpc';
import { useTablePrefs } from '../../../lib/useTablePrefs';

type Data = RouterOutputs['workflowSetup']['reasons'];
type Row = Data['rows'][number];
type Context = Data['contexts'][number];
type FormValues = { reasonCode: string; context: Context; description: string; countsAgainstProcurement: boolean; isActive: boolean };

export const CONTEXT_LABEL: Record<Context, string> = {
  CR_SALES: 'Sales change request',
  CR_PROC: 'Procurement change request',
  RELEASE: 'Release from RFQ',
  RFQ_CANCEL: 'Cancel RFQ',
  UNAWARD: 'Un-award',
  HANDOFF_RETURN: 'Handoff return',
  SKU_CHANGE: 'SKU change',
  PROCEED_NO_ACK: 'Proceed without acknowledgement',
  HANDOFF_AUTO: 'Automatic handoff return',
};

/** Configuration → Reason codes (spec 11). */
export function ReasonCodesTab() {
  const { message } = App.useApp();
  const can = useCan();
  const utils = trpc.useUtils();
  const prefs = useTablePrefs('wf-reasons');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const list = trpc.workflowSetup.reasons.useQuery();
  const save = trpc.workflowSetup.saveReason.useMutation();
  const editable = can(P.configWfReasonsEdit);

  const openDrawer = (r: Row | 'new') => {
    setEditing(r);
    form.setFieldsValue(
      r === 'new'
        ? { reasonCode: '', context: 'CR_SALES', description: '', countsAgainstProcurement: false, isActive: true }
        : { reasonCode: r.ReasonCode, context: r.Context as Context, description: r.Description, countsAgainstProcurement: r.CountsAgainstProcurement, isActive: r.IsActive },
    );
  };

  const onSave = async (v: FormValues) => {
    try {
      await save.mutateAsync({ ...v, rowVer: editing === 'new' || !editing ? null : editing.RowVer });
      message.success(`Reason code ${v.reasonCode} saved`);
      await utils.workflowSetup.reasons.invalidate();
      setEditing(null);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const columns: AppColumn<Row>[] = [
    { title: 'Code', key: 'ReasonCode', dataIndex: 'ReasonCode', width: 130 },
    { title: 'Context', key: 'Context', width: 190, render: (_: unknown, r) => CONTEXT_LABEL[r.Context as Context] ?? r.Context },
    { title: 'Description', key: 'Description', dataIndex: 'Description', width: 320 },
    { title: 'Counts against Procurement', key: 'Counts', width: 110, render: (_: unknown, r) => (r.CountsAgainstProcurement ? 'Yes' : 'No') },
    { title: 'Status', key: 'IsActive', width: 80, render: (_: unknown, r) => <Tag color={r.IsActive ? 'green' : 'default'}>{r.IsActive ? 'Active' : 'Inactive'}</Tag> },
  ];

  const current = editing && editing !== 'new' ? editing : null;
  return (
    <>
      <AppTable<Row>
        prefs={prefs}
        itemName="reason codes"
        rowKey="ReasonCode"
        columns={columns}
        dataSource={list.data?.rows}
        loading={list.isFetching}
        page={page}
        total={list.data?.rows.length ?? 0}
        onPageChange={setPage}
        onRow={(r) => ({ onClick: () => openDrawer(r), style: { cursor: 'pointer' } })}
        toolbar={editable && <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer('new')}>Add reason code</Button>}
      />
      <Drawer open={!!editing} onClose={() => setEditing(null)} width={420} title={current ? `Reason ${current.ReasonCode}` : 'New reason code'} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={onSave} disabled={!editable} requiredMark={false}>
          <Form.Item label="Code" name="reasonCode" extra={current ? 'The code and context cannot change; history refers to them.' : undefined}
            rules={[{ required: true, pattern: /^[A-Z0-9_]+$/, message: 'Capital letters, digits and _ only' }]}>
            <Input id="reasonCode" maxLength={40} disabled={!!current} />
          </Form.Item>
          <Form.Item label="Context" name="context" rules={[{ required: true }]}>
            <Select id="reasonContext" disabled={!!current} options={(list.data?.contexts ?? []).map((c) => ({ value: c, label: CONTEXT_LABEL[c] }))} />
          </Form.Item>
          <Form.Item label="Description" name="description" rules={[{ required: true, message: 'Enter a description' }]}>
            <Input id="reasonDescription" maxLength={200} />
          </Form.Item>
          <Space direction="vertical">
            <Space>
              <Form.Item name="countsAgainstProcurement" valuePropName="checked" noStyle><Switch id="reasonCounts" /></Form.Item>
              <Typography.Text>Counts against Procurement (KPIs)</Typography.Text>
            </Space>
            <Space>
              <Form.Item name="isActive" valuePropName="checked" noStyle><Switch id="reasonActive" /></Form.Item>
              <Typography.Text>Active (offered for new choices)</Typography.Text>
            </Space>
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
