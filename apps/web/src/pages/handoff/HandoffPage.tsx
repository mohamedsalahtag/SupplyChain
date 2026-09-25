import { useState } from 'react';
import { Alert, App, Button, Card, Col, Descriptions, Input, Modal, Row, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { CheckOutlined, RollbackOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { BackToWork } from '../../components/BackToWork';
import { StatusTag } from '../../components/StatusTag';
import { ThreadPanel } from '../../components/ThreadPanel';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { ACK_STATUS, HANDOFF_STATUS } from '../../lib/statuses';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId } from '../../lib/workflow';
import { n } from '../rfq/rfqLabels';
import { PoPreparation } from '../po/PoPreparation';
import { P } from '@supplychain/shared';
import { useCan } from '../../lib/auth';
import { LoadError } from '../../components/LoadError';

type H = RouterOutputs['handoff']['get'];
type Item = H['snapshot']['items'][number];

/** One handoff as the PO team sees it (spec 22) — exactly as it was sent. */
export function HandoffPage() {
  const { handoffId = '' } = useParams();
  const { message } = App.useApp();
  const can = useCan();
  const utils = trpc.useUtils();
  const q = trpc.handoff.get.useQuery({ handoffId }, { retry: false });
  const thread = trpc.handoff.thread.useQuery({ handoffId });
  const accept = trpc.handoff.accept.useMutation();
  const ret = trpc.handoff.return.useMutation();
  const reasons = trpc.handoff.reasons.useQuery({ context: 'HANDOFF_RETURN' });
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState<string>();
  const [comment, setComment] = useState('');

  if (q.error) return <LoadError error={q.error} what="Handoff" onRetry={() => void q.refetch()} extra={<Link to="/handoffs">Handoffs</Link>} />;
  if (!q.data) return <Skeleton active />;
  const h = q.data;
  const s = h.snapshot;
  const refresh = () => Promise.all([utils.handoff.invalidate(), utils.work.invalidate(), utils.award.invalidate()]);
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); message.success(ok); await refresh(); return true; } catch (err) { message.error(errorText(err)); return false; } };
  const total = s.items.reduce((a, i) => a + Number(i.value), 0);

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={12}>
        <BackToWork />
        <Link to="/handoffs"><Typography.Text type="secondary">Handoffs</Typography.Text></Link>
        <Link to={`/awards/${h.awardBatchId}`}><Typography.Text type="secondary">{s.award.abNo}</Typography.Text></Link>
        <Link to={`/demands/${h.demandId}`}><Typography.Text type="secondary">{s.award.demandNo}</Typography.Text></Link>
      </Space>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>{h.hoNo}</Typography.Title>
          <StatusTag def={HANDOFF_STATUS[h.status]} />
          {h.withoutAck && <Tag color="gold">without Sales acknowledgement</Tag>}
          <Typography.Text type="secondary">{s.supplier.name} · {s.award.abNo} · {s.award.demandNo} · company {s.award.companyCode}</Typography.Text>
        </Space>
        <Space>
          {h.actions.accept && <Button type="primary" icon={<CheckOutlined />} loading={accept.isPending} onClick={() => run(() => accept.mutateAsync({ commandId: newCommandId(), handoffId, rowVer: h.rowVer }), `${h.hoNo} accepted`)}>Accept</Button>}
          {h.actions.return && <Button danger icon={<RollbackOutlined />} onClick={() => setReturning(true)}>Return to Procurement…</Button>}
        </Space>
      </Space>

      <Alert type={h.returned ? 'warning' : h.withoutAck ? 'warning' : 'success'} showIcon
        message={<>Handed off by {h.sentBy} (Procurement) on {formatDateTime(h.sentAt)} · {h.withoutAck
          ? <>sent <b>without Sales acknowledgement</b> ({h.proceedReason}{h.proceedComment ? `: ${h.proceedComment}` : ''}){h.ackNow?.status === 'ACKNOWLEDGED_LATE' ? ' — Sales acknowledged it later' : ''}</>
          : <>Sales acknowledged (revision {h.ackRevision})</>}
          {h.acceptedAt && <> · accepted by {h.acceptedBy} (PO team) on {formatDateTime(h.acceptedAt)}</>}
          {h.returned && <> · returned {h.returned.by ? `by ${h.returned.by} (PO team)` : 'automatically'} on {formatDateTime(h.returned.at)} — {h.returned.reason}: {h.returned.comment}</>}</>}
        description="This page shows the handoff exactly as it was sent. Later edits on the award do not change it." />

      <Card size="small" title="Supplier" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>as it was when handed off</Typography.Text>}>
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} items={[
          { label: 'Supplier code', children: <Typography.Text strong copyable>{s.supplier.code}</Typography.Text> },
          { label: 'Supplier name', children: <Typography.Text strong>{s.supplier.name}</Typography.Text> },
          { label: 'Country · origins', children: `${s.supplier.country || '—'} · ${s.supplier.origins.join(', ') || '—'}` },
          { label: `Purchasing org (company ${s.award.companyCode})`, children: s.supplier.purchasingOrg ? `${s.supplier.purchasingOrg} · ${s.supplier.orgBlocked ? 'blocked' : 'not blocked'}` : '—' },
          { label: 'SAP payment terms · Incoterm', children: `${s.supplier.sapPaymentTerms ?? '—'} · ${s.supplier.sapIncoterm ?? '—'}` },
          { label: 'City · e-mail', children: `${s.supplier.city || '—'} · ${s.supplier.email || '—'}` },
        ]} />
      </Card>

      <Row gutter={12}>
        <Col xs={24} lg={12}>
          <Card size="small" title="Shipping terms">
            <Descriptions size="small" column={1} items={[
              { label: 'Incoterm', children: s.terms.incotermText ?? '—' },
              { label: 'Port of loading', children: s.terms.portOfLoading ?? '—' },
              { label: 'Port of discharge', children: s.terms.portOfDischarge ?? '—' },
              { label: 'Payment terms', children: s.terms.paymentTermsText ?? '—' },
              { label: 'Currency', children: s.terms.currency ?? '—' },
            ]} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="Shipments" extra={<Typography.Text type="secondary">{s.shipments.reduce((a, x) => a + x.containers, 0)} container(s) in total</Typography.Text>}>
            <Table size="small" pagination={false} rowKey="week" dataSource={s.shipments} columns={[
              { title: 'Week', dataIndex: 'week' }, { title: 'Containers', dataIndex: 'containers', align: 'right' }, { title: 'Confirmed ETD', dataIndex: 'confirmedEtd' },
            ]} />
            {s.containers.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.containers.map((c) => `${c.containers} × ${c.group} (${c.week})`).join(' · ')}</Typography.Text>}
          </Card>
        </Col>
      </Row>

      <Card size="small" title="Materials" extra={<Typography.Text type="secondary">{total.toLocaleString('en-GB', { maximumFractionDigits: 2 })} {s.terms.currency}</Typography.Text>}>
        <Table<Item> size="small" pagination={false} rowKey={(i) => `${i.week}|${i.label}`} dataSource={s.items} columns={[
          { title: 'Week', dataIndex: 'week', width: 110 }, { title: 'Material', dataIndex: 'label' },
          { title: 'Quantity', key: 'q', align: 'right', render: (_: unknown, i) => `${n(i.qty)} ${i.unit}` },
          { title: 'Price per unit', key: 'p', align: 'right', render: (_: unknown, i) => `${i.unitPrice} ${i.currency}` },
          { title: 'Value', key: 'v', align: 'right', render: (_: unknown, i) => `${Number(i.value).toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${i.currency}` },
          { title: 'SKU', key: 's', render: (_: unknown, i) => (i.skus.length ? i.skus.join(', ') : <Typography.Text type="secondary">pending — picked when the PO is prepared (Stage 7)</Typography.Text>) },
        ]} />
      </Card>

      {can(P.poOpen) && (h.status === 'ACCEPTED' || h.hasDrafts) && <PoPreparation handoffId={handoffId} />}

      <Card size="small" title="Comments">
        <ThreadPanel entries={thread.data} loading={thread.isPending} canAdd={false} onAdd={async () => undefined} />
      </Card>
      {h.ackNow && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Sales acknowledgement now: {ACK_STATUS[h.ackNow.status]?.label} (revision {h.ackNow.revision})</Typography.Text>}

      <Modal open={returning} title={`Return ${h.hoNo} to Procurement`} okText="Return" okButtonProps={{ danger: true, disabled: !reason || !comment.trim(), loading: ret.isPending }} destroyOnHidden
        onCancel={() => setReturning(false)}
        onOk={async () => { if (await run(() => ret.mutateAsync({ commandId: newCommandId(), handoffId, rowVer: h.rowVer, reasonCode: reason!, comment }), `${h.hoNo} returned to Procurement`)) setReturning(false); }}>
        <Typography.Paragraph>The quantity goes back to Awarded; Procurement fixes it and hands off again (a new handoff).</Typography.Paragraph>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select id="returnReason" style={{ width: '100%' }} placeholder="Reason (required)" value={reason} onChange={setReason}
            options={(reasons.data ?? []).map((r) => ({ value: r.ReasonCode, label: `${r.ReasonCode} · ${r.Description}` }))} />
          <Input.TextArea id="returnComment" rows={3} maxLength={2000} placeholder="What must Procurement fix? (required)" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Space>
      </Modal>
    </Space>
  );
}
