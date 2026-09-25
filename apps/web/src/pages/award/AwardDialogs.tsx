import { useState } from 'react';
import { App, Input, InputNumber, Modal, Radio, Select, Space, Typography } from 'antd';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf } from '../../lib/workflow';
import { n } from '../rfq/rfqLabels';

type Batch = RouterOutputs['award']['get'];
type Item = Batch['items'][number];
type Shipment = Batch['shipments'][number];
type Containers = Batch['containers'][number];

function useRun(onDone: () => void) {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      await Promise.all([utils.award.invalidate(), utils.rfq.invalidate(), utils.demand.invalidate(), utils.work.invalidate()]);
      onDone();
    } catch (err) {
      const p = problemsOf(err);
      message.error(p.length ? p.join(' · ') : errorText(err));
    }
  };
}

/** Un-award… (spec 20): all or part; keep the quotes (→ Quoted) or release (→ Open); reason required. */
export function UnawardModal({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const run = useRun(onClose);
  const unaward = trpc.award.unaward.useMutation();
  const reasons = trpc.award.reasons.useQuery({ context: 'UNAWARD' });
  const [all, setAll] = useState(true);
  const [qty, setQty] = useState<number | null>(null);
  const [mode, setMode] = useState<'KEEP_QUOTES' | 'RELEASE'>('KEEP_QUOTES');
  const [reason, setReason] = useState<string>();
  const [comment, setComment] = useState('');
  return (
    <Modal open={!!item} onCancel={onClose} title={item ? `Un-award · ${item.supplierName} · ${item.week} · ${item.label} · ${n(item.qty)} ${item.unit}` : ''} okText="Un-award" destroyOnHidden
      okButtonProps={{ danger: true, disabled: !reason || (!all && !qty), loading: unaward.isPending }}
      onOk={() => item && run(() => unaward.mutateAsync({ commandId: newCommandId(), awardItemId: item.awardItemId, rowVer: item.rowVer, qty: all ? 'ALL' : String(qty), mode, reasonCode: reason!, comment }), 'Un-awarded')}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Radio.Group value={all} onChange={(e) => setAll(e.target.value)}>
          <Radio value>All</Radio>
          <Radio value={false}>Part: <InputNumber id="unawardQty" size="small" min={1} max={item ? Number(item.qty) : 1} precision={0} value={qty ?? undefined} onChange={setQty} disabled={all} /> {item?.unit}</Radio>
        </Radio.Group>
        <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
          <Space direction="vertical">
            <Radio value="KEEP_QUOTES">Keep the quotes — back to Quoted (award it again, e.g. to another supplier)</Radio>
            <Radio value="RELEASE">Release — back to Open</Radio>
          </Space>
        </Radio.Group>
        <Select id="unawardReason" style={{ width: '100%' }} placeholder="Reason (required)" value={reason} onChange={setReason}
          options={(reasons.data ?? []).map((x) => ({ value: x.ReasonCode, label: `${x.ReasonCode} · ${x.Description}` }))} />
        <Input.TextArea rows={2} maxLength={2000} placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <Typography.Text type="secondary">Sales' acknowledgement goes back to Pending.</Typography.Text>
      </Space>
    </Modal>
  );
}

/** Correct SKU… (spec 20): another SKU of the same specification, reason required. */
export function SkuModal({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const run = useRun(onClose);
  const correct = trpc.award.correctSku.useMutation();
  const options = trpc.award.skuOptions.useQuery(item?.spec ?? { majorCategory: '', subMajorCategory: '', size: '', materialClass: '', originCode: '', unit: '' }, { enabled: !!item });
  const [sku, setSku] = useState<string>();
  const [reason, setReason] = useState('');
  return (
    <Modal open={!!item} onCancel={onClose} title={item ? `Correct SKU · ${item.label} ${item.originCode}` : ''} okText="Save SKU" destroyOnHidden
      okButtonProps={{ disabled: !sku || !reason.trim(), loading: correct.isPending }}
      onOk={() => item && run(() => correct.mutateAsync({ commandId: newCommandId(), awardItemId: item.awardItemId, rowVer: item.rowVer, materialCode: sku!, reason }), `SKU set to ${sku}`)}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">Only SKUs of the same specification (size, class, origin, unit) are offered.{item?.skuStatus === 'RESOLVED_AT_DEMAND' ? ' This replaces the demand\'s own SKU: Sales is told.' : ''}</Typography.Text>
        <Select id="skuPick" showSearch style={{ width: '100%' }} placeholder="SKU" value={sku} onChange={setSku} optionFilterProp="label"
          options={(options.data ?? []).map((o) => ({ value: o.code, label: `${o.code} ${o.description}` }))} />
        <Input id="skuReason" placeholder="Reason (required)" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Space>
    </Modal>
  );
}

/** Edit a shipment: containers and confirmed ETD (before handoff). */
export function ShipmentModal({ shipment, fixedContainers, onClose }: { shipment: Shipment | null; fixedContainers?: boolean; onClose: () => void }) {
  const run = useRun(onClose);
  const update = trpc.award.updateShipment.useMutation();
  const [boxes, setBoxes] = useState<number | null>(null);
  const [etd, setEtd] = useState<string | null>(null);
  const b = boxes ?? shipment?.containers ?? null;
  const e = etd ?? shipment?.confirmedEtd ?? '';
  return (
    <Modal open={!!shipment} onCancel={onClose} title={shipment ? `Shipment · ${shipment.supplierName} · ${shipment.week}` : ''} okText="Save" destroyOnHidden
      okButtonProps={{ disabled: !b, loading: update.isPending }}
      onOk={() => shipment && run(() => update.mutateAsync({ commandId: newCommandId(), shipmentId: shipment.shipmentId, rowVer: shipment.rowVer, containerCount: b!, confirmedEtd: e || null }), 'Shipment saved')}>
      <Space wrap>
        <Typography.Text>Containers</Typography.Text>
        {fixedContainers ? <Typography.Text strong>{b}</Typography.Text> : <InputNumber id="shipBoxes" min={1} max={999} precision={0} value={b ?? undefined} onChange={setBoxes} />}
        <Typography.Text>Confirmed ETD</Typography.Text>
        <Input id="shipEtd" type="date" value={e} onChange={(x) => setEtd(x.target.value)} style={{ width: 170 }} />
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>Sales' acknowledgement goes back to Pending.</Typography.Paragraph>
    </Modal>
  );
}

/** Un-award n containers (spec 20 revision 1): their materials go back — quotes kept (Quoted) or released (Open); reason required. */
export function ContainerUnawardModal({ row, onClose }: { row: Containers | null; onClose: () => void }) {
  const run = useRun(onClose);
  const unaward = trpc.award.unawardContainers.useMutation();
  const reasons = trpc.award.reasons.useQuery({ context: 'UNAWARD' });
  const [count, setCount] = useState<number | null>(null);
  const [mode, setMode] = useState<'KEEP_QUOTES' | 'RELEASE'>('KEEP_QUOTES');
  const [reason, setReason] = useState<string>();
  const [comment, setComment] = useState('');
  const c = count ?? row?.containers ?? 1;
  return (
    <Modal open={!!row} onCancel={onClose} title={row ? `Un-award containers · ${row.supplierName} · ${row.week} · ${row.groupName}` : ''} okText="Un-award" destroyOnHidden
      okButtonProps={{ danger: true, disabled: !reason || !c, loading: unaward.isPending }}
      onOk={() => row && run(() => unaward.mutateAsync({ commandId: newCommandId(), awardContainerId: row.awardContainerId, rowVer: row.rowVer, count: c, mode, reasonCode: reason!, comment }), `${c} container(s) un-awarded`)}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Text>Containers</Typography.Text>
          <InputNumber id="unawardCount" min={1} max={row?.containers ?? 1} precision={0} value={c} onChange={setCount} />
          <Typography.Text type="secondary">of {row?.containers} · each {row?.mix} {row?.unit}</Typography.Text>
        </Space>
        <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
          <Space direction="vertical">
            <Radio value="KEEP_QUOTES">Keep the quotes — back to Quoted (award them again, e.g. to another supplier)</Radio>
            <Radio value="RELEASE">Release — back to Open</Radio>
          </Space>
        </Radio.Group>
        <Select id="unawardReason" style={{ width: '100%' }} placeholder="Reason (required)" value={reason} onChange={setReason}
          options={(reasons.data ?? []).map((x) => ({ value: x.ReasonCode, label: `${x.ReasonCode} · ${x.Description}` }))} />
        <Input.TextArea rows={2} maxLength={2000} placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <Typography.Text type="secondary">Sales' acknowledgement goes back to Pending.</Typography.Text>
      </Space>
    </Modal>
  );
}
