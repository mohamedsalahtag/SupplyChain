import { useState } from 'react';
import { Alert, App, Button, Card, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { FileAddOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { StatusTag } from '../../components/StatusTag';
import type { RouterOutputs } from '../../lib/format';
import { PO_STATUS } from '../../lib/statuses';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf } from '../../lib/workflow';
import { n } from '../rfq/rfqLabels';

type Prep = RouterOutputs['po']['preparation'];
type Item = Prep['items'][number];
const SKU_LABEL: Record<string, { label: string; color: string }> = {
  RESOLVED_AT_DEMAND: { label: 'from the demand', color: 'green' }, RESOLVED_AT_RFQ: { label: 'from the quote', color: 'green' },
  RESOLVED_AT_PO: { label: 'picked by the PO team', color: 'blue' }, PENDING: { label: 'to pick', color: 'gold' }, PENDING_MASTER_DATA: { label: 'waiting for SAP master data', color: 'orange' },
};

/** PO preparation of one accepted handoff (spec 23): SKUs where none was provided, then one PO draft for all weeks. */
export function PoPreparation({ handoffId }: { handoffId: string }) {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const q = trpc.po.preparation.useQuery({ handoffId });
  const build = trpc.po.build.useMutation();
  const [picking, setPicking] = useState<Item | null>(null);
  const [missing, setMissing] = useState<Item | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  if (q.error) return <Alert type="error" showIcon message="PO preparation could not be loaded" description={q.error.message} />;
  if (!q.data) return <Card size="small" title="PO preparation" loading />;
  const p = q.data;
  const onBuild = async () => {
    try {
      const r = await build.mutateAsync({ commandId: newCommandId(), handoffId });
      message.success(`${r.poDraftNo} built`); await utils.po.invalidate(); navigate(`/po-drafts/${r.poDraftId}`);
    } catch (err) { const x = problemsOf(err); setProblems(x.length ? x : [errorText(err)]); }
  };

  const toPick = p.items.filter((i) => i.skuStatus === 'PENDING').length;
  const waiting = p.items.filter((i) => i.skuStatus === 'PENDING_MASTER_DATA').length;
  return (
    <Card size="small" title="PO preparation" extra={!p.canBuild && p.drafts.every((d) => ['REJECTED', 'VOID'].includes(d.status)) && (toPick + waiting > 0)
      ? <Typography.Text type="secondary">{toPick ? `${toPick} SKU(s) to pick` : ''}{toPick && waiting ? ' · ' : ''}{waiting ? `${waiting} waiting for SAP master data` : ''} before the draft can be built</Typography.Text>
      : p.canBuild && <Button type="primary" icon={<FileAddOutlined />} loading={build.isPending} onClick={onBuild}>Build PO draft</Button>}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>One purchase order for this handoff, all weeks. Pick a SKU only where none was provided; a SKU provided by Sales or Procurement is fixed — if it is wrong, return the handoff (SKU issue).</Typography.Paragraph>
      <Table<Item> size="small" pagination={false} rowKey="awardItemId" dataSource={p.items} columns={[
        { title: 'Week', dataIndex: 'week', width: 100 }, { title: 'Material', dataIndex: 'label' },
        { title: 'Quantity', key: 'q', align: 'right', width: 110, render: (_: unknown, i) => `${n(i.qty)} ${i.unit}` },
        { title: 'Confirmed ETD', dataIndex: 'confirmedEtd', width: 120 },
        { title: 'SKU', key: 's', render: (_: unknown, i) => (
          <Space size={4} wrap>
            {i.skus.map((k) => <span key={k.code}>{k.code}{i.skus.length > 1 ? ` · ${n(k.qty)}` : ''}</span>)}
            <Tag color={SKU_LABEL[i.skuStatus]?.color}>{SKU_LABEL[i.skuStatus]?.label ?? i.skuStatus}</Tag>
            {i.mdr && <Typography.Text type="secondary" style={{ fontSize: 12 }}>request: {i.mdr.note}</Typography.Text>}
          </Space>) },
        { title: '', key: 'x', width: 210, render: (_: unknown, i) => i.canSelect && (
          <Space size={0}>
            <Button size="small" type="link" onClick={() => setPicking(i)}>{i.skus.length ? 'Change SKU…' : 'Pick SKU…'}</Button>
            {i.skuStatus === 'PENDING' && <Button size="small" type="link" onClick={() => setMissing(i)}>Not in SAP…</Button>}
          </Space>) },
      ]} />
      {problems.length > 0 && <Alert style={{ marginTop: 8 }} type="error" showIcon message="No draft built" description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((x) => <li key={x}>{x}</li>)}</ul>} />}
      {p.drafts.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Typography.Text type="secondary">PO drafts of this handoff: </Typography.Text>
          {p.drafts.map((d) => <Link key={d.poDraftId} to={`/po-drafts/${d.poDraftId}`} style={{ marginRight: 10 }}>{d.poDraftNo} <StatusTag def={PO_STATUS[d.status]} />{d.sapPoNumber ? ` SAP ${d.sapPoNumber}` : ''}</Link>)}
        </div>
      )}
      <SkuModal item={picking} onClose={() => setPicking(null)} />
      <MissingModal item={missing} onClose={() => setMissing(null)} />
    </Card>
  );
}

function SkuModal({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const cands = trpc.po.candidates.useQuery({ awardItemId: item?.awardItemId ?? '0' }, { enabled: !!item });
  const save = trpc.po.selectSkus.useMutation();
  const [rows, setRows] = useState<{ code?: string; qty: number | null }[] | null>(null);
  const total = Number(item?.qty ?? 0);
  const list = rows ?? (item ? (item.skus.length ? item.skus.map((k) => ({ code: k.code, qty: Number(k.qty) })) : [{ code: undefined, qty: total }]) : []);
  const sum = list.reduce((a, r) => a + (r.qty ?? 0), 0);
  const close = () => { setRows(null); onClose(); };
  return (
    <Modal open={!!item} title={item ? `SKU · ${item.label} · ${item.week}` : ''} okText="Save SKUs" onCancel={close} destroyOnHidden
      okButtonProps={{ disabled: Math.abs(sum - total) > 0.0005 || list.some((r) => !r.code || !r.qty), loading: save.isPending }}
      onOk={async () => {
        try {
          await save.mutateAsync({ commandId: newCommandId(), awardItemId: item!.awardItemId, allocations: list.map((r) => ({ materialCode: r.code!, qty: String(r.qty) })) });
          message.success('SKUs saved'); await utils.po.invalidate(); close();
        } catch (err) { message.error(errorText(err)); }
      }}>
      <Typography.Paragraph type="secondary">Materials of this specification, origin and unit only. Split across several SKUs if needed — the quantities must add up to {n(total)} {item?.unit}.</Typography.Paragraph>
      <Space direction="vertical" style={{ width: '100%' }}>
        {list.map((r, idx) => (
          <Space key={idx} style={{ width: '100%' }}>
            <Select style={{ width: 330 }} placeholder="SKU" showSearch optionFilterProp="label" value={r.code} aria-label={`SKU ${idx + 1}`} loading={cands.isPending}
              options={(cands.data ?? []).map((c) => ({ value: c.code, label: `${c.code} · ${c.description}` }))} onChange={(v) => setRows(list.map((x, j) => (j === idx ? { ...x, code: v } : x)))} />
            <InputNumber min={0} precision={0} value={r.qty ?? undefined} style={{ width: 120 }} aria-label={`Quantity ${idx + 1}`} onChange={(v) => setRows(list.map((x, j) => (j === idx ? { ...x, qty: v } : x)))} />
            {list.length > 1 && <Button type="text" icon={<MinusCircleOutlined />} onClick={() => setRows(list.filter((_, j) => j !== idx))} />}
          </Space>
        ))}
        <Button size="small" icon={<PlusOutlined />} onClick={() => setRows([...list, { code: undefined, qty: Math.max(0, total - sum) }])}>Split: add a SKU</Button>
        <Typography.Text type={Math.abs(sum - total) > 0.0005 ? 'danger' : 'success'}>{n(sum)} of {n(total)} {item?.unit}</Typography.Text>
        {cands.data?.length === 0 && <Alert type="warning" showIcon message="No material of this specification exists in SAP — use “Not in SAP…”." />}
      </Space>
    </Modal>
  );
}

function MissingModal({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const save = trpc.po.markMissing.useMutation();
  const [note, setNote] = useState('');
  return (
    <Modal open={!!item} title="Material missing in SAP" okText="Save request" onCancel={onClose} destroyOnHidden okButtonProps={{ disabled: !note.trim(), loading: save.isPending }}
      onOk={async () => {
        try { await save.mutateAsync({ commandId: newCommandId(), awardItemId: item!.awardItemId, note }); message.success('Request saved — the item waits for SAP'); setNote(''); await utils.po.invalidate(); onClose(); }
        catch (err) { message.error(errorText(err)); }
      }}>
      <Typography.Paragraph type="secondary">Ask for the material to be created in SAP (outside the portal) and note it here. The PO cannot be built until the request is closed and a SKU is picked.</Typography.Paragraph>
      <Input.TextArea rows={3} maxLength={1000} placeholder={`Which material must be created — ${item?.label ?? ''}`} value={note} onChange={(e) => setNote(e.target.value)} />
    </Modal>
  );
}
