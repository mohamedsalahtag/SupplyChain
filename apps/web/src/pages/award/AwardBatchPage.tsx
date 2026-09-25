import { useState } from 'react';
import { Alert, App, Button, Descriptions, Input, List, Skeleton, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AttachmentsPanel } from '../../components/AttachmentsPanel';
import { StatusTag } from '../../components/StatusTag';
import { HandoffPanel } from '../handoff/HandoffPanel';
import { BackToWork } from '../../components/BackToWork';
import { ThreadPanel } from '../../components/ThreadPanel';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { P } from '@supplychain/shared';
import { useCan } from '../../lib/auth';
import { errorText, isoWeekOfDate, newCommandId } from '../../lib/workflow';
import { n } from '../rfq/rfqLabels';
import { ACK_CAUSE, ACK_STATUS, CHANGE_TYPE, CONTAINER_CHANGE, SKU_STATUS } from './awardLabels';
import { ContainerUnawardModal, ShipmentModal, SkuModal, UnawardModal } from './AwardDialogs';
import { LoadError } from '../../components/LoadError';

type Batch = RouterOutputs['award']['get'];
type Item = Batch['items'][number];
type Shipment = Batch['shipments'][number];
type Containers = Batch['containers'][number];

/** An award batch (spec 20): items, shipments, the Sales acknowledgement, changes, comments. */
export function AwardBatchPage() {
  const { awardBatchId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const batch = trpc.award.get.useQuery({ awardBatchId }, { retry: false });
  const thread = trpc.award.thread.useQuery({ awardBatchId });
  const [showOld, setShowOld] = useState(false);
  const attachments = trpc.award.attachments.useQuery({ awardBatchId, includeOld: showOld });
  const comment = trpc.award.comment.useMutation();
  const ack = trpc.award.acknowledge.useMutation();
  const query = trpc.award.raiseQuery.useMutation();
  const answer = trpc.award.answerQuery.useMutation();
  const [unawarding, setUnawarding] = useState<Item | null>(null);
  const [sku, setSku] = useState<Item | null>(null);
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [unawardBoxes, setUnawardBoxes] = useState<Containers | null>(null);
  const [text, setText] = useState('');

  if (batch.error) return <LoadError error={batch.error} what="Award" onRetry={() => void batch.refetch()} extra={<Link to="/awards">Awards</Link>} />;
  if (!batch.data) return <Skeleton active />;
  const b = batch.data;
  const a = b.ack;
  const refresh = () => Promise.all([utils.award.invalidate(), utils.work.invalidate()]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); message.success(ok); setText(''); await refresh(); } catch (err) { message.error(errorText(err)); }
  };
  const active = b.items.filter((i) => i.isActive);

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={12}>
        <BackToWork />
        <Link to={`/demands/${b.demandId}`}><Typography.Text type="secondary">{b.demandNo}</Typography.Text></Link>
        <Link to={`/rfqs/${b.rfqId}`}><Typography.Text type="secondary">{b.rfqNo}</Typography.Text></Link>
        <Link to="/awards"><Typography.Text type="secondary">Awards</Typography.Text></Link>
      </Space>
      <Space size={10} align="baseline" wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>{b.abNo}</Typography.Title>
        {a && <StatusTag def={ACK_STATUS[a.status]} label={`${ACK_STATUS[a.status].label} · revision ${a.revision}`} />}
        <Typography.Text type="secondary">{b.rfqNo} · {b.demandNo} · {b.companyCode} · by {b.createdBy} {formatDateTime(b.createdAt)}</Typography.Text>
      </Space>

      {a?.canRespond && (
        <Alert type="info" showIcon message="Procurement awarded your demand — have a look"
          description={<Space direction="vertical" style={{ width: '100%' }}>
            <span>Acknowledging is a heads-up, not an approval: nothing waits for it. A question goes to Procurement's My work.</span>
            <Space wrap>
              <Input id="ackComment" style={{ width: 420, maxWidth: '100%' }} placeholder="Comment (optional to acknowledge, required for a query)" value={text} onChange={(e) => setText(e.target.value)} />
              <Button type="primary" loading={ack.isPending} onClick={() => run(() => ack.mutateAsync({ commandId: newCommandId(), ackId: a.ackId, rowVer: a.rowVer, comment: text }), 'Acknowledged')}>Acknowledge</Button>
              {a.status === 'PENDING' && <Button disabled={!text.trim()} loading={query.isPending} onClick={() => run(() => query.mutateAsync({ commandId: newCommandId(), ackId: a.ackId, rowVer: a.rowVer, comment: text }), 'Query sent to Procurement')}>Raise query</Button>}
            </Space>
          </Space>} />
      )}
      {a?.canAnswer && (
        <Alert type="warning" showIcon message={`Sales asks: ${a.comment}`}
          description={<Space wrap>
            <Input id="ackAnswer" style={{ width: 420, maxWidth: '100%' }} placeholder="Your answer (required)" value={text} onChange={(e) => setText(e.target.value)} />
            <Button type="primary" disabled={!text.trim()} loading={answer.isPending} onClick={() => run(() => answer.mutateAsync({ commandId: newCommandId(), ackId: a.ackId, rowVer: a.rowVer, answer: text }), 'Answered; Sales is asked again')}>Answer</Button>
          </Space>} />
      )}

      {b.containers.length > 0 && (
        <Table<Containers> size="small" bordered pagination={false} rowKey="awardContainerId" dataSource={b.containers} tableLayout="fixed"
          title={() => <Typography.Text strong>Containers</Typography.Text>}
          rowClassName={(c) => (c.isActive ? '' : 'ant-table-row-disabled')}
          columns={[
            { title: 'Supplier', dataIndex: 'supplierName', ellipsis: true },
            { title: 'Week', dataIndex: 'week', width: 100 },
            { title: 'Container group', key: 'g', ellipsis: true, render: (_: unknown, c) => <>{c.groupName} <Typography.Text type="secondary" style={{ fontSize: 12 }}>· {c.mix} {c.unit} per container</Typography.Text></> },
            { title: 'Containers', key: 'n', width: 110, align: 'right', render: (_: unknown, c) => (c.isActive ? c.containers : <Typography.Text delete type="secondary">un-awarded</Typography.Text>) },
            { title: '', key: 'x', width: 110, render: (_: unknown, c) => c.canChange && <Button size="small" type="link" onClick={() => setUnawardBoxes(c)}>Un-award…</Button> },
          ]} />
      )}

      <Table<Item> size="small" bordered pagination={false} rowKey="awardItemId" dataSource={b.items} tableLayout="fixed"
        title={() => <Typography.Text strong>Materials</Typography.Text>}
        rowClassName={(i) => (i.isActive ? '' : 'ant-table-row-disabled')}
        columns={[
          { title: 'Supplier', dataIndex: 'supplierName', ellipsis: true },
          { title: 'Week', dataIndex: 'week', width: 95 },
          { title: 'Material', key: 'm', ellipsis: true, render: (_: unknown, i) => <>{i.label} {i.originCode}{i.procurementAdded && <Tag color="blue" style={{ marginInlineStart: 4 }}>Procurement</Tag>}</> },
          { title: 'Quantity', key: 'q', width: 120, align: 'right', render: (_: unknown, i) => (i.isActive ? `${n(i.qty)} ${i.unit}` : <Typography.Text delete type="secondary">un-awarded</Typography.Text>) },
          { title: 'Price', key: 'p', width: 110, align: 'right', render: (_: unknown, i) => <>{i.unitPrice} {i.currency}{i.overrideReason && <Tooltip title={`Over the quoted availability: ${i.overrideReason}`}><Tag color="gold" style={{ marginInlineStart: 4 }}>override</Tag></Tooltip>}</> },
          { title: 'SKU', key: 's', width: 230, render: (_: unknown, i) => <Space size={4} wrap>{i.skus.map((x) => <span key={x}>{x}</span>)}<Tag color={SKU_STATUS[i.skuStatus].color}>{SKU_STATUS[i.skuStatus].label}</Tag></Space> },
          { title: '', key: 'x', width: 170, render: (_: unknown, i) => i.canChange && <Space size={0}>
              {!i.byContainers && <Button size="small" type="link" onClick={() => setUnawarding(i)}>Un-award…</Button>}
              <Button size="small" type="link" onClick={() => setSku(i)}>Correct SKU…</Button></Space> },
        ]} />

      <Table<Shipment> size="small" bordered pagination={false} rowKey="shipmentId" dataSource={b.shipments} tableLayout="fixed"
        title={() => <Typography.Text strong>Shipments</Typography.Text>}
        columns={[
          { title: 'Supplier', dataIndex: 'supplierName', ellipsis: true },
          { title: 'Week', dataIndex: 'week', width: 100 },
          { title: 'Containers', dataIndex: 'containers', width: 110, align: 'right' },
          { title: 'Confirmed ETD', key: 'e', width: 230, render: (_: unknown, s) => (s.confirmedEtd
            ? <Space size={4}>{s.confirmedEtd}{isoWeekOfDate(s.confirmedEtd) !== s.week && <Tag color="gold">in {isoWeekOfDate(s.confirmedEtd)}</Tag>}</Space>
            : <Tag color="gold">missing · needed before handoff</Tag>) },
          { title: '', key: 'x', width: 90, render: (_: unknown, s) => (s.isActive ? s.canEdit && <Button size="small" type="link" onClick={() => setShipment(s)}>Edit…</Button> : <Tag>inactive</Tag>) },
        ]} />
      {b.comment && <Descriptions size="small" bordered items={[{ label: 'Comment', children: b.comment }]} />}

      <Tabs activeKey={params.get('tab') ?? (can(P.handoffSend) || !can(P.ackRespond) ? 'handoff' : 'ack')} onChange={(k) => setParams({ tab: k }, { replace: true })} items={[
        { key: 'handoff', label: 'Handoff (per supplier)', children: <HandoffPanel awardBatchId={awardBatchId} /> },
        { key: 'ack', label: 'Acknowledgement', children: (
          <List size="small" bordered dataSource={b.ackHistory} renderItem={(h) => (
            <List.Item><Space wrap><Typography.Text type="secondary">{formatDateTime(h.at)}</Typography.Text><span>{h.by}</span>
              <Typography.Text strong>{ACK_CAUSE[h.cause] ?? h.cause}</Typography.Text><Tag>revision {h.revision}</Tag>{h.comment && <Typography.Text type="secondary">“{h.comment}”</Typography.Text>}</Space></List.Item>
          )} />
        ) },
        { key: 'changes', label: `Changes (${b.changes.length + b.containerChanges.length})`, children: (<>
          {b.containerChanges.length > 0 && <List size="small" bordered style={{ marginBottom: 8 }} dataSource={b.containerChanges} renderItem={(c) => (
            <List.Item><Space wrap><Typography.Text type="secondary">{formatDateTime(c.at)}</Typography.Text><span>{c.by}</span>
              <Typography.Text strong>{CONTAINER_CHANGE[c.type]}</Typography.Text>
              {c.type === 'ABOVE_OFFER' ? <span>{c.supplierCode}, {c.week}: {c.containers} containers (offered {c.offered})</span>
                : <span>{c.supplierCode ? `${c.supplierCode}, ` : ''}{c.week}: {c.containers} container(s){c.groupName ? ` of ${c.groupName}` : ''}</span>}
              {c.reason && <Tag>{c.reason}</Tag>}{c.note && <Typography.Text type="secondary">“{c.note}”</Typography.Text>}</Space></List.Item>
          )} />}
          <List size="small" bordered dataSource={b.changes} locale={{ emptyText: 'No material changes' }} renderItem={(c) => (
            <List.Item><Space wrap><Typography.Text type="secondary">{formatDateTime(c.at)}</Typography.Text><span>{c.by}</span><Typography.Text strong>{CHANGE_TYPE[c.type]}</Typography.Text>
              <span>{c.supplierCode}</span>{c.qty && <span>{c.qty}</span>}{c.crNo && <Tag>{c.crNo}</Tag>}{c.reason && <Tag>{c.reason}</Tag>}{c.detail?.to && <span>→ {c.detail.to}</span>}</Space></List.Item>
          )} />
        </>) },
        { key: 'comments', label: `Comments${thread.data?.length ? ` (${thread.data.length})` : ''}`, children: (
          <ThreadPanel entries={thread.data} loading={thread.isPending} canAdd
            onAdd={async (body) => { await comment.mutateAsync({ awardBatchId, commandId: newCommandId(), body }); await utils.award.thread.invalidate({ awardBatchId }); }} />
        ) },
        { key: 'attachments', label: 'Attachments', children: (
          <AttachmentsPanel entityType="AWARD_BATCH" entityId={awardBatchId} rows={attachments.data} loading={attachments.isPending} canUpload={b.actions.manage}
            showOld={showOld} onShowOld={setShowOld} onChanged={() => void utils.award.attachments.invalidate({ awardBatchId })} />
        ) },
      ]} />
      <UnawardModal item={unawarding} onClose={() => setUnawarding(null)} />
      <SkuModal item={sku} onClose={() => setSku(null)} />
      <ShipmentModal shipment={shipment} fixedContainers={b.containers.some((c) => c.supplierCode === shipment?.supplierCode && c.week === shipment?.week)} onClose={() => setShipment(null)} />
      <ContainerUnawardModal row={unawardBoxes} onClose={() => setUnawardBoxes(null)} />
      {active.length === 0 && <Alert type="info" showIcon message="Everything in this award was un-awarded or cancelled." />}
    </Space>
  );
}
