import { useState } from 'react';
import { App, Button, Card, Col, Input, Modal, Row, Select, Space, Switch, Table, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText } from '../../lib/workflow';

type Lists = RouterOutputs['handoff']['lists'];
type Port = Lists['ports'][number];
type Pay = Lists['paymentTerms'][number];
const USED_FOR = { LOADING: 'Loading', DISCHARGE: 'Discharge', BOTH: 'Loading and discharge' } as const;

/**
 * Configuration → Shipping terms (spec 22): the choices buyers get on the handoff. Payment-term codes come from SAP
 * (added by the supplier sync); Incoterms and ports are kept here because SAP does not have them for import suppliers.
 */
export function ShippingTermsTab() {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const q = trpc.handoff.lists.useQuery();
  const setInco = trpc.handoff.setIncoterm.useMutation();
  const savePort = trpc.handoff.savePort.useMutation();
  const savePay = trpc.handoff.savePaymentTerm.useMutation();
  const [port, setPort] = useState<(Omit<Port, 'portId'> & { portId: number | null }) | null>(null);
  const [desc, setDesc] = useState<Record<string, string>>({});
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); message.success(ok); await utils.handoff.invalidate(); return true; } catch (err) { message.error(errorText(err)); return false; } };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Text type="secondary">The choices buyers get when they complete the shipping terms of a handoff. Payment-term codes come from SAP (each supplier&apos;s own term is the default); Incoterms and ports are kept here because SAP does not have them for import suppliers.</Typography.Text>
      <Row gutter={[12, 12]}>
        <Col xs={24} xl={8}>
          <Card size="small" title="Incoterms" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>switch off what you don&apos;t use</Typography.Text>}>
            <Table size="small" pagination={false} rowKey="code" dataSource={q.data?.incoterms} loading={q.isPending} columns={[
              { title: 'Code', dataIndex: 'code', width: 70 }, { title: 'Meaning', dataIndex: 'description' },
              { title: 'In use', key: 'a', width: 70, render: (_: unknown, i: Lists['incoterms'][number]) => <Switch size="small" checked={i.isActive} aria-label={`Incoterm ${i.code} in use`}
                onChange={(v) => run(() => setInco.mutateAsync({ code: i.code, isActive: v }), `${i.code} ${v ? 'in use' : 'switched off'}`)} /> },
            ]} />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card size="small" title="Ports" extra={<Button size="small" icon={<PlusOutlined />} onClick={() => setPort({ portId: null, name: '', countryCode: '', usedFor: 'LOADING', isActive: true })}>Add port</Button>}>
            <Table size="small" pagination={false} rowKey="portId" dataSource={q.data?.ports} loading={q.isPending}
              onRow={(p) => ({ onClick: () => setPort(p), style: { cursor: 'pointer' } })} columns={[
                { title: 'Port', dataIndex: 'name' }, { title: 'Country', dataIndex: 'countryCode', width: 75 },
                { title: 'Used for', key: 'u', render: (_: unknown, p: Port) => USED_FOR[p.usedFor] }, { title: 'In use', key: 'a', width: 60, render: (_: unknown, p: Port) => (p.isActive ? 'Yes' : 'No') },
              ]} />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card size="small" title="Payment terms" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>codes from SAP — describe them once</Typography.Text>}>
            <Table size="small" pagination={{ pageSize: 15, size: 'small' }} rowKey="code" dataSource={q.data?.paymentTerms} loading={q.isPending}
              locale={{ emptyText: 'None yet — they arrive with the next suppliers sync' }} columns={[
                { title: 'SAP code', dataIndex: 'code', width: 80 },
                { title: 'Description', key: 'd', render: (_: unknown, p: Pay) => (
                  <Input size="small" aria-label={`Description ${p.code}`} value={desc[p.code] ?? p.description} placeholder="Description" maxLength={100}
                    onChange={(e) => setDesc((d) => ({ ...d, [p.code]: e.target.value }))}
                    onBlur={() => { if (desc[p.code] !== undefined && desc[p.code] !== p.description) void run(() => savePay.mutateAsync({ code: p.code, description: desc[p.code], isActive: p.isActive }), `${p.code} saved`); }} />) },
                { title: 'Suppliers', dataIndex: 'suppliers', width: 80, align: 'right' },
                { title: 'In use', key: 'a', width: 60, render: (_: unknown, p: Pay) => <Switch size="small" checked={p.isActive} onChange={(v) => run(() => savePay.mutateAsync({ code: p.code, description: desc[p.code] ?? p.description, isActive: v }), `${p.code} saved`)} /> },
              ]} />
          </Card>
        </Col>
      </Row>
      <Modal open={!!port} title={port?.portId ? `Port · ${port.name}` : 'Add port'} okText="Save" destroyOnHidden onCancel={() => setPort(null)}
        okButtonProps={{ disabled: !port?.name.trim() || !/^[A-Za-z]{2,3}$/.test(port?.countryCode ?? ''), loading: savePort.isPending }}
        onOk={async () => { if (port && await run(() => savePort.mutateAsync(port), 'Port saved')) setPort(null); }}>
        {port && (
          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10, alignItems: 'center' }}>
            <Typography.Text>Port</Typography.Text><Input id="portName" value={port.name} maxLength={80} onChange={(e) => setPort({ ...port, name: e.target.value })} />
            <Typography.Text>Country</Typography.Text><Input id="portCountry" value={port.countryCode} maxLength={3} placeholder="e.g. SA" style={{ width: 90 }} onChange={(e) => setPort({ ...port, countryCode: e.target.value.toUpperCase() })} />
            <Typography.Text>Used for</Typography.Text>
            <Select value={port.usedFor} onChange={(v) => setPort({ ...port, usedFor: v })} options={Object.entries(USED_FOR).map(([value, label]) => ({ value, label }))} />
            <Typography.Text>In use</Typography.Text><Switch checked={port.isActive} onChange={(v) => setPort({ ...port, isActive: v })} />
          </div>
        )}
      </Modal>
    </Space>
  );
}
