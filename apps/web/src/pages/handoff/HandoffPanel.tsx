import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Col, Empty, Input, Modal, Row, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, SendOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { HANDOFF_STATUS } from '../../lib/statuses';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf } from '../../lib/workflow';

type Panel = RouterOutputs['handoff']['panel'];
type Card_ = Panel['cards'][number];
type Terms = { incoterm: string | null; portOfLoadingId: number | null; portOfDischargeId: number | null; paymentTerms: string | null };

const SOURCE: Record<string, string> = { SAVED: 'saved', LAST_HANDOFF: 'from this supplier’s last handoff', SAP: 'from SAP (supplier master)' };

/** The award's Handoff tab (spec 22): one card per supplier — terms, shipments, readiness, hand off. */
export function HandoffPanel({ awardBatchId }: { awardBatchId: string }) {
  const q = trpc.handoff.panel.useQuery({ awardBatchId });
  if (!q.data) return q.error ? <Alert type="error" showIcon message={q.error.message} /> : <Skeleton active />;
  if (!q.data.cards.length) return <Empty description="Nothing awarded in this award any more" />;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Alert type="info" showIcon message="One handoff per supplier = one purchase order. Each supplier of this award is handed off on its own; the others are not affected." />
      {q.data.cards.map((c) => <SupplierCard key={c.supplierCode} card={c} options={q.data.options} awardBatchId={awardBatchId} abNo={q.data.abNo} />)}
    </Space>
  );
}

function SupplierCard({ card: c, options, awardBatchId, abNo }: { card: Card_; options: Panel['options']; awardBatchId: string; abNo: string }) {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const save = trpc.handoff.saveTerms.useMutation();
  const send = trpc.handoff.send.useMutation();
  const ship = trpc.award.updateShipment.useMutation();
  const reasons = trpc.handoff.reasons.useQuery({ context: 'PROCEED_NO_ACK' });
  const [t, setT] = useState<Terms>(c.terms);
  const [dirty, setDirty] = useState(false);
  const [noAck, setNoAck] = useState(false);
  const [reason, setReason] = useState<string>();
  const [comment, setComment] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => { if (!dirty) setT(c.terms); }, [c.terms, dirty]);
  const refresh = () => Promise.all([utils.handoff.invalidate(), utils.award.invalidate(), utils.work.invalidate()]);

  const set = (patch: Partial<Terms>) => { setT((x) => ({ ...x, ...patch })); setDirty(true); setProblems([]); };
  const saveTerms = async () => {
    try {
      await save.mutateAsync({ commandId: newCommandId(), awardBatchId, supplierCode: c.supplierCode, ...t });
      setDirty(false); message.success('Shipping terms saved'); await refresh();
    } catch (err) { const p = problemsOf(err); message.error(p.length ? p.join(' · ') : errorText(err)); }
  };
  const doSend = async (withoutAck: boolean) => {
    try {
      if (dirty) { await save.mutateAsync({ commandId: newCommandId(), awardBatchId, supplierCode: c.supplierCode, ...t }); setDirty(false); }
      const r = await send.mutateAsync({ commandId: newCommandId(), awardBatchId, supplierCode: c.supplierCode, confirmWithoutAck: withoutAck, reasonCode: withoutAck ? reason ?? null : null, comment: withoutAck ? comment || null : null });
      setNoAck(false); message.success(`${r.hoNo} handed off to the PO team`); await refresh();
    } catch (err) {
      if ((err as { data?: { domainCode?: string } }).data?.domainCode === 'ACK_MISSING') { setNoAck(true); return; }
      const p = problemsOf(err); setProblems(p.length ? p : [errorText(err)]);
    }
  };
  const setEtd = async (s: Card_['shipments'][number], etd: string) => {
    try { await ship.mutateAsync({ commandId: newCommandId(), shipmentId: s.shipmentId, rowVer: s.rowVer, containerCount: s.containers, confirmedEtd: etd || null }); await refresh(); }
    catch (err) { message.error(errorText(err)); }
  };

  const ports = (usedFor: 'LOADING' | 'DISCHARGE') => options.ports.filter((p) => p.usedFor !== (usedFor === 'LOADING' ? 'DISCHARGE' : 'LOADING'))
    .map((p) => ({ value: p.portId, label: `${p.name} (${p.countryCode})` }));
  const ready = c.readiness;
  const editable = c.canEdit;
  const last = c.handoffs[0];

  return (
    <Card size="small" title={<Space wrap><Typography.Text strong>{c.name}</Typography.Text><Typography.Text type="secondary">{c.supplierCode} · {c.containers} container(s) · {c.quantity} · {c.value}</Typography.Text></Space>}
      extra={c.open ? <Link to={`/handoffs/${c.open.handoffId}`}><StatusTag def={HANDOFF_STATUS[c.open.status]} label={`${c.open.hoNo} · ${HANDOFF_STATUS[c.open.status].label}${c.open.withoutAck ? ' · without Sales acknowledgement' : ''}`} /></Link>
        : last ? <StatusTag def={HANDOFF_STATUS[last.status]} label={`${last.hoNo} · ${HANDOFF_STATUS[last.status].label}`} /> : <Tag>Not handed off yet</Tag>}>
      {last?.status === 'RETURNED' && !c.open && (
        <Alert type="warning" showIcon style={{ marginBottom: 10 }} message={`${last.hoNo} returned ${last.returnedBy === 'automatically' ? 'automatically' : `by ${last.returnedBy} (PO team)`} · ${last.returnReason}`}
          description={`${last.returnComment ?? ''} — fix it and hand off again (a new handoff number; ${last.hoNo} keeps what was sent).`} />
      )}
      <Row gutter={[24, 12]}>
        <Col xs={24} lg={13}>
          <Typography.Text strong>Shipping terms</Typography.Text>{' '}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{dirty ? '— not saved yet' : c.termsSource ? `— ${SOURCE[c.termsSource]}${c.termsSourceNote ? ` (${c.termsSourceNote})` : ''}` : ''}</Typography.Text>
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px 10px', alignItems: 'center', marginTop: 8 }}>
            <Typography.Text type="secondary">Incoterm</Typography.Text>
            <Select id={`inc-${c.supplierCode}`} disabled={!editable} allowClear value={t.incoterm ?? undefined} onChange={(v) => set({ incoterm: v ?? null })} aria-label={`Incoterm ${c.name}`}
              options={options.incoterms.map((i) => ({ value: i.code, label: `${i.code} · ${i.description}` }))} />
            <Typography.Text type="secondary">Port of loading</Typography.Text>
            <Select id={`pol-${c.supplierCode}`} disabled={!editable} allowClear showSearch optionFilterProp="label" value={t.portOfLoadingId ?? undefined} onChange={(v) => set({ portOfLoadingId: v ?? null })} aria-label={`Port of loading ${c.name}`} options={ports('LOADING')} />
            <Typography.Text type="secondary">Port of discharge</Typography.Text>
            <Select id={`pod-${c.supplierCode}`} disabled={!editable} allowClear showSearch optionFilterProp="label" value={t.portOfDischargeId ?? undefined} onChange={(v) => set({ portOfDischargeId: v ?? null })} aria-label={`Port of discharge ${c.name}`} options={ports('DISCHARGE')} />
            <Typography.Text type="secondary">Payment terms</Typography.Text>
            <div>
              <Select id={`pay-${c.supplierCode}`} disabled={!editable} allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} value={t.paymentTerms ?? undefined} onChange={(v) => set({ paymentTerms: v ?? null })} aria-label={`Payment terms ${c.name}`}
                options={options.paymentTerms.map((p) => ({ value: p.code, label: p.description ? `${p.code} · ${p.description}` : p.code }))} />
              {c.sap?.paymentTerms && <Typography.Text type="secondary" style={{ fontSize: 11 }}>SAP (supplier master): {c.sap.paymentTerms}{c.sap.incoterm ? ` · Incoterm ${c.sap.incoterm} ${c.sap.location}` : ''}</Typography.Text>}
            </div>
            <Typography.Text type="secondary">Currency</Typography.Text>
            <Typography.Text strong>{c.terms.currency ?? '—'} <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>the award&apos;s currency — fixed</Typography.Text></Typography.Text>
          </div>
          <Table size="small" style={{ marginTop: 12 }} pagination={false} rowKey="shipmentId" dataSource={c.shipments} title={() => <Typography.Text strong>Shipments</Typography.Text>} columns={[
            { title: 'Week', dataIndex: 'week', width: 110 },
            { title: 'Containers', dataIndex: 'containers', width: 100, align: 'right' },
            { title: 'Confirmed ETD', key: 'e', render: (_: unknown, s: Card_['shipments'][number]) => (editable
              ? <Input type="date" size="small" style={{ width: 170 }} defaultValue={s.confirmedEtd ?? ''} aria-label={`Confirmed ETD ${c.name} ${s.week}`} onBlur={(e) => { if ((e.target.value || null) !== s.confirmedEtd) void setEtd(s, e.target.value); }} />
              : s.confirmedEtd ?? '—') },
          ]} />
        </Col>
        <Col xs={24} lg={11}>
          {ready ? (
            <>
              <Typography.Text strong>Ready to hand off?</Typography.Text>
              <div style={{ marginTop: 6 }}>
                {ready.checks.map((k) => (
                  <div key={k.key} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                    {k.ok ? <CheckCircleFilled style={{ color: '#52c41a', marginTop: 4 }} /> : k.warning ? <ExclamationCircleFilled style={{ color: '#faad14', marginTop: 4 }} /> : <CloseCircleFilled style={{ color: '#ff4d4f', marginTop: 4 }} />}
                    <span>{k.label}{k.detail ? <Typography.Text type="secondary" style={{ fontSize: 12 }}> · {k.detail}</Typography.Text> : null}</span>
                  </div>
                ))}
              </div>
              {editable && (
                <Space style={{ marginTop: 12 }} wrap>
                  <Button disabled={!dirty} loading={save.isPending} onClick={saveTerms}>Save terms</Button>
                  <Button type="primary" icon={<SendOutlined />} disabled={!ready.ready && !dirty} loading={send.isPending} onClick={() => doSend(false)}>Hand off to PO team</Button>
                </Space>
              )}
              {dirty && <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 4 }}>The checklist shows the saved terms; Hand off saves your changes first.</div>}
              {problems.length > 0 && <Alert style={{ marginTop: 8 }} type="error" showIcon message="Not handed off" description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />}
            </>
          ) : c.open ? (
            <Typography.Paragraph type="secondary">Handed off — the terms and shipments are locked until the PO team returns it. <Link to={`/handoffs/${c.open.handoffId}`}>Open {c.open.hoNo}</Link></Typography.Paragraph>
          ) : null}
          {c.handoffs.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12 }}>
              <Typography.Text type="secondary">Handoffs of this supplier</Typography.Text>
              {c.handoffs.map((h) => (
                <div key={h.handoffId}><Link to={`/handoffs/${h.handoffId}`}>{h.hoNo}</Link> · {HANDOFF_STATUS[h.status].label} · sent by {h.sentBy} {formatDateTime(h.sentAt)}
                  {h.returnedAt ? ` · returned ${h.returnedBy === 'automatically' ? 'automatically' : `by ${h.returnedBy}`} (${h.returnReason})` : h.acceptedAt ? ` · accepted by ${h.acceptedBy}` : ''}</div>
              ))}
            </div>
          )}
        </Col>
      </Row>
      <Modal open={noAck} title={`Sales has not acknowledged ${abNo}`} okText="Hand off anyway" onCancel={() => setNoAck(false)} destroyOnHidden
        okButtonProps={{ disabled: !reason || (reason === 'OTHER_NO_ACK' && !comment.trim()), loading: send.isPending }} onOk={() => doSend(true)}>
        <Typography.Paragraph>Acknowledging is a heads-up for Sales, not an approval. You can hand off anyway; the handoff is marked <Tag color="gold">without Sales acknowledgement</Tag> and Sales can still acknowledge later.</Typography.Paragraph>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select id="noAckReason" style={{ width: '100%' }} placeholder="Reason (required)" value={reason} onChange={setReason}
            options={(reasons.data ?? []).map((r) => ({ value: r.ReasonCode, label: `${r.ReasonCode} · ${r.Description}` }))} />
          <Input.TextArea rows={2} maxLength={1000} placeholder={reason === 'OTHER_NO_ACK' ? 'Comment (required)' : 'Comment (optional)'} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Space>
      </Modal>
    </Card>
  );
}
