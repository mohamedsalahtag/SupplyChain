import { useState } from 'react';
import { Alert, App, Button, Drawer, Input, InputNumber, Modal, Select, Space, Table, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf, weekLabel, weekOptions } from '../../lib/workflow';
import { n } from './rfqLabels';
import { emptySpec, SpecPicker, specComplete, specLabel, type Spec } from './SpecPicker';

type Rfq = RouterOutputs['rfq']['get'];
type Line = Rfq['lines'][number];
type Result = { crId: string; crNo: string; status: string; problems: string[] } | { dryRun: true; problems: string[]; items: number };

/** Reason + comment + Check + Send, shared by the three Procurement requests (spec 19). */
function useSend(send: (dryRun: boolean, extra: { reasonCode: string; comment: string }) => Promise<Result>, onDone: () => void) {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const reasons = trpc.cr.reasons.useQuery({ context: 'CR_PROC' });
  const [reason, setReason] = useState<string>();
  const [comment, setComment] = useState('');
  const [problems, setProblems] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    if (!reason) return;
    setBusy(true);
    try {
      const r = await send(dryRun, { reasonCode: reason, comment });
      if ('dryRun' in r) { setProblems(r.problems); return; }
      await Promise.all([utils.rfq.invalidate(), utils.cr.invalidate(), utils.demand.invalidate(), utils.work.invalidate()]);
      if (r.status === 'BLOCKED') message.warning(`${r.crNo} was saved as Blocked — see the reasons`);
      else message.success(`${r.crNo} sent to Sales`);
      onDone();
      navigate(`/change-requests/${r.crId}`);
    } catch (err) {
      const p = problemsOf(err);
      if (p.length) setProblems(p); else message.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const ready = !!reason && !!comment.trim();
  const footer = (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap style={{ width: '100%' }}>
        <Select id="procReason" style={{ width: 340 }} placeholder="Reason (required)" value={reason} onChange={setReason}
          options={(reasons.data ?? []).map((r) => ({ value: r.ReasonCode, label: `${r.ReasonCode} · ${r.Description}` }))} />
        <Input id="procComment" style={{ width: 420, maxWidth: '100%' }} placeholder="Comment for Sales (required)" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Space>
      {problems && (problems.length ? <Alert type="error" showIcon message="This request would be Blocked" description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />
        : <Alert type="success" showIcon message="OK — what it touches goes on hold until Sales decides." />)}
      <Space>
        <Button disabled={!ready} loading={busy} onClick={() => run(true)}>Check</Button>
        <Button type="primary" icon={<SendOutlined />} disabled={!ready} loading={busy} onClick={() => run(false)}>Send to Sales</Button>
      </Space>
    </Space>
  );
  return { footer, reset: () => setProblems(null) };
}

/** Add quantity… (plan §4 rule 7): Procurement-added quantity (+ extra containers), joins the RFQ at once. */
export function AddQuantityModal({ rfq, open, onClose }: { rfq: Rfq; open: boolean; onClose: () => void }) {
  const add = trpc.rfq.addQuantity.useMutation();
  const [spec, setSpec] = useState<Spec>(emptySpec);
  const [week, setWeek] = useState(rfq.weeks[0]?.etdWeek);
  const [qty, setQty] = useState<number | null>(null);
  const [extra, setExtra] = useState<number | null>(0);
  const weeks = [...new Set([...rfq.weeks.map((w) => w.etdWeek), ...weekOptions(26)])].sort();
  const { footer, reset } = useSend((dryRun, why) => add.mutateAsync({ commandId: newCommandId(), rfqId: rfq.rfqId, etdWeek: week!, spec, qty: String(qty ?? 0), extraContainers: extra ?? 0, ...why, dryRun }), onClose);
  return (
    <Modal open={open} onCancel={onClose} footer={null} width={1000} title={`Add quantity · ${rfq.rfqNo}`} destroyOnHidden>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Alert type="info" showIcon message="A supplier offers more than asked? Propose it to Sales: the quantity joins this RFQ now (suppliers can quote it) and is added to the demand only if Sales approves." />
        <SpecPicker idPrefix="add" value={spec} onChange={(s) => { setSpec(s); reset(); }} />
        <Space wrap>
          <Typography.Text>ETD week</Typography.Text>
          <Select id="addWeek" style={{ width: 210 }} value={week} onChange={(v) => { setWeek(v); reset(); }} options={weeks.map((w) => ({ value: w, label: weekLabel(w) }))} />
          <Typography.Text>Quantity</Typography.Text>
          <InputNumber id="addQty" min={1} precision={0} value={qty ?? undefined} onChange={(v) => { setQty(v); reset(); }} addonAfter={spec.unit || '—'} />
          <Typography.Text>Extra containers</Typography.Text>
          <InputNumber id="addContainers" min={0} max={99} precision={0} value={extra ?? 0} onChange={(v) => { setExtra(v); reset(); }} style={{ width: 70 }} />
          <Typography.Text type="secondary">optional; Sales decides it separately</Typography.Text>
        </Space>
        {specComplete(spec) && qty ? footer : <Typography.Text type="secondary">Choose the material and the quantity.</Typography.Text>}
      </Space>
    </Modal>
  );
}

/** Propose week shift… (plan §4 rule 8) for one RFQ line. */
export function WeekShiftModal({ rfq, line, onClose }: { rfq: Rfq; line: Line | null; onClose: () => void }) {
  const shift = trpc.rfq.weekShift.useMutation();
  const [to, setTo] = useState<string>();
  const [containers, setContainers] = useState<number | null>(null);
  const { footer, reset } = useSend((dryRun, why) => shift.mutateAsync({ commandId: newCommandId(), rfqId: rfq.rfqId, rfqLineId: line!.rfqLineId, toWeek: to!, containers: containers ?? 0, ...why, dryRun }), onClose);
  const live = line ? Number(line.inRfq) + Number(line.quoted) : 0;
  return (
    <Modal open={!!line} onCancel={onClose} footer={null} width={900} title={line ? `Propose week shift · ${line.label} ${line.originCode}` : ''} destroyOnHidden>
      {line && <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Text>{n(live)} {line.unit} (nothing awarded) from <b>{line.week}</b> to</Typography.Text>
          <Select id="shiftWeek" style={{ width: 210 }} value={to} onChange={(v) => { setTo(v); reset(); }}
            options={weekOptions(26).filter((w) => w !== line.week).map((w) => ({ value: w, label: weekLabel(w) }))} />
          <Typography.Text>Containers for that week in this RFQ</Typography.Text>
          <InputNumber id="shiftContainers" min={0} max={999} precision={0} value={containers ?? undefined} onChange={(v) => { setContainers(v); reset(); }} style={{ width: 70 }} />
        </Space>
        <Typography.Text type="secondary">Until Sales decides, the line shows the new week and is on hold; rejected or withdrawn → back to {line.week}.</Typography.Text>
        {to && containers != null ? footer : <Typography.Text type="secondary">Choose the week and the containers.</Typography.Text>}
      </Space>}
    </Modal>
  );
}

type Addition = { uid: string; week: string; spec: Spec; qty: number | null };

/** Propose mix change… (plan §4 rule 9): less of some lines, more / new materials in the same weeks. */
export function MixChangeDrawer({ rfq, open, onClose }: { rfq: Rfq; open: boolean; onClose: () => void }) {
  const mix = trpc.rfq.mixChange.useMutation();
  const [less, setLess] = useState<Record<string, number | null>>({});
  const [adds, setAdds] = useState<Addition[]>([]);
  const [draft, setDraft] = useState<Addition>({ uid: '', week: rfq.weeks[0]?.etdWeek ?? '', spec: emptySpec, qty: null });
  const candidates = rfq.lines.filter((l) => l.origin === 'DEMAND' && l.canShift);
  const { footer, reset } = useSend((dryRun, why) => mix.mutateAsync({
    commandId: newCommandId(), rfqId: rfq.rfqId, ...why, dryRun,
    reductions: Object.entries(less).filter(([, q]) => (q ?? 0) > 0).map(([rfqLineId, q]) => ({ rfqLineId, qty: String(q) })),
    additions: adds.map((a) => ({ etdWeek: a.week, spec: a.spec, qty: String(a.qty) })),
  }), onClose);
  const hasItems = Object.values(less).some((q) => (q ?? 0) > 0) || adds.length > 0;
  return (
    <Drawer open={open} onClose={onClose} width={1100} title={`Propose mix change · ${rfq.rfqNo}`} destroyOnHidden>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Alert type="info" showIcon message="Less of some materials and/or more of others, in the same weeks. Sales decides each item: reductions are cancelled on the demand (origin Change, not counted against Procurement); additions land Open on the demand." />
        <Table size="small" bordered pagination={false} rowKey="rfqLineId" dataSource={candidates} tableLayout="fixed" locale={{ emptyText: 'No line can be reduced' }}
          columns={[
            { title: 'Week', dataIndex: 'week', width: 95 },
            { title: 'Material', key: 'm', render: (_: unknown, l) => `${l.label} ${l.originCode}` },
            { title: 'In this RFQ', key: 'q', width: 130, align: 'right', render: (_: unknown, l) => `${n(Number(l.inRfq) + Number(l.quoted))} ${l.unit}` },
            { title: 'Less by', key: 'less', width: 150, render: (_: unknown, l) => <InputNumber size="small" min={0} max={Number(l.inRfq) + Number(l.quoted)} precision={0} value={less[l.rfqLineId] ?? undefined}
                onChange={(v) => { setLess({ ...less, [l.rfqLineId]: v }); reset(); }} aria-label={`Less ${l.label}`} style={{ width: 120 }} /> },
          ]} />
        <Typography.Text strong>Add material</Typography.Text>
        <SpecPicker idPrefix="mix" value={draft.spec} onChange={(s) => setDraft({ ...draft, spec: s })} />
        <Space wrap>
          <Select id="mixWeek" style={{ width: 210 }} value={draft.week} onChange={(v) => setDraft({ ...draft, week: v })} options={rfq.weeks.map((w) => ({ value: w.etdWeek, label: weekLabel(w.etdWeek) }))} />
          <InputNumber id="mixQty" min={1} precision={0} value={draft.qty ?? undefined} onChange={(v) => setDraft({ ...draft, qty: v })} addonAfter={draft.spec.unit || '—'} />
          <Button icon={<PlusOutlined />} disabled={!specComplete(draft.spec) || !draft.qty} onClick={() => { setAdds([...adds, { ...draft, uid: crypto.randomUUID() }]); setDraft({ ...draft, spec: emptySpec, qty: null }); reset(); }}>Add row</Button>
        </Space>
        {adds.map((a) => (
          <Space key={a.uid}>
            <Typography.Text>{a.week} · {specLabel(a.spec)} · +{n(a.qty ?? 0)} {a.spec.unit}</Typography.Text>
            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => { setAdds(adds.filter((x) => x.uid !== a.uid)); reset(); }} aria-label="Remove row" />
          </Space>
        ))}
        {hasItems ? footer : <Typography.Text type="secondary">Reduce a line or add a material.</Typography.Text>}
      </Space>
    </Drawer>
  );
}
