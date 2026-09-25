import { useState } from 'react';
import { Alert, App, Button, Card, Col, Descriptions, Input, Modal, Radio, Row, Skeleton, Space, Table, Tooltip, Typography } from 'antd';
import { CheckOutlined, SendOutlined, SyncOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { P } from '@supplychain/shared';
import { useCan } from '../../lib/auth';
import { AttachmentsPanel } from '../../components/AttachmentsPanel';
import { BackToWork } from '../../components/BackToWork';
import { ProcessSteps, StatusTag } from '../../components/StatusTag';
import { ThreadPanel } from '../../components/ThreadPanel';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { PO_STATUS, PO_STEPS } from '../../lib/statuses';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf } from '../../lib/workflow';
import { n } from '../rfq/rfqLabels';
import { LoadError } from '../../components/LoadError';

type D = RouterOutputs['po']['get'];
/** Plain words for the outbox codes (spec 23). */
const SUBMISSION: Record<string, string> = {
  PENDING: 'Waiting to be sent', IN_FLIGHT: 'Being sent to SAP', UNKNOWN: 'SAP did not answer — being checked', MANUAL: 'Needs a person to check SAP',
  CREATED: 'Created in SAP', REJECTED: 'Refused by SAP',
};
const RESOLUTION: Record<string, string> = {
  SAP_REPLY: 'SAP confirmed it', RECONCILED: 'found in SAP after a lost reply', MANUAL_CREATED: 'confirmed by the PO team from SAP', MANUAL_NOT_CREATED: 'confirmed not in SAP by the PO team',
};
const ATTEMPT: Record<string, string> = { CREATE: 'Send to SAP', LOOKUP: 'Ask SAP by reference' };
const OUTCOME: Record<string, string> = { CREATED: 'created', REJECTED: 'refused', UNKNOWN: 'no answer', FOUND: 'found', NOT_FOUND: 'not found' };
type Item = D['items'][number];

/** One PO draft (spec 23): header, items, checks, SAP submission and its attempts; resolve an unknown outcome. */
export function PoDraftPage() {
  const { poDraftId = '' } = useParams();
  const { message, modal } = App.useApp();
  const can = useCan();
  const utils = trpc.useUtils();
  const q = trpc.po.get.useQuery({ poDraftId }, { retry: false, refetchInterval: (x) => (['SUBMITTED', 'UNKNOWN'].includes(x.state.data?.status ?? '') ? 10_000 : false) });
  const thread = trpc.po.thread.useQuery({ poDraftId });
  const [showOld, setShowOld] = useState(false);
  const files = trpc.po.attachments.useQuery({ poDraftId, includeOld: showOld });
  const validate = trpc.po.validate.useMutation();
  const submit = trpc.po.submit.useMutation();
  const processNow = trpc.po.processNow.useMutation();
  const [resolving, setResolving] = useState(false);
  const [problems, setProblems] = useState<string[] | null>(null);
  if (q.error) return <LoadError error={q.error} what="PO draft" onRetry={() => void q.refetch()} extra={<Link to="/po-drafts">PO drafts</Link>} />;
  if (!q.data) return <Skeleton active />;
  const d = q.data;
  const refresh = () => Promise.all([utils.po.invalidate(), utils.work.invalidate(), utils.handoff.invalidate()]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); message.success(ok); setProblems(null); await refresh(); } catch (err) { const p = problemsOf(err); setProblems(p.length ? p : [errorText(err)]); }
  };
  const total = d.items.reduce((a, i) => a + Number(i.value), 0);

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={12}>
        <BackToWork />
        <Link to="/po-drafts"><Typography.Text type="secondary">PO drafts</Typography.Text></Link>
        <Link to={`/handoffs/${d.handoffId}`}><Typography.Text type="secondary">{d.hoNo}</Typography.Text></Link>
        <Link to={`/demands/${d.demandId}`}><Typography.Text type="secondary">{d.demandNo}</Typography.Text></Link>
      </Space>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>{d.poDraftNo}</Typography.Title>
          <StatusTag def={PO_STATUS[d.status]} />
          {d.sapPoNumber && <Typography.Text strong copyable>SAP PO {d.sapPoNumber}</Typography.Text>}
          <Typography.Text type="secondary">{d.supplierName} · {d.hoNo} · {d.abNo} · company {d.companyCode}</Typography.Text>
        </Space>
        <Space wrap>
          {d.actions.validate && <Button icon={<CheckOutlined />} loading={validate.isPending} onClick={() => run(async () => {
            const r = await validate.mutateAsync({ commandId: newCommandId(), poDraftId, rowVer: d.rowVer });
            if (r.problems.length) throw Object.assign(new Error('Not valid'), { data: { details: { problems: r.problems } } });
          }, 'Validated — ready to submit')}>Validate</Button>}
          {d.actions.submit && <Button type="primary" icon={<SendOutlined />} loading={submit.isPending} onClick={() => modal.confirm({
            title: `Submit ${d.poDraftNo} to SAP?`, okText: 'Submit to SAP',
            content: `${d.supplierName} · ${d.containers} container(s) · ${total.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${d.currency}. The draft is frozen and cannot be changed after this; SAP creates one purchase order.`,
            onOk: () => run(() => submit.mutateAsync({ commandId: newCommandId(), poDraftId, rowVer: d.rowVer }), `${d.poDraftNo} submitted to SAP`),
          })}>Submit to SAP</Button>}
          {d.status === 'REJECTED' && <Link to={`/handoffs/${d.handoffId}`}><Button type="primary">Go to PO preparation</Button></Link>}
          {can(P.poManage) && ['SUBMITTED', 'UNKNOWN'].includes(d.status) && <Button icon={<SyncOutlined />} loading={processNow.isPending} onClick={() => run(() => processNow.mutateAsync(), 'SAP outbox run')}>Process now</Button>}
          {d.actions.resolve && <Button danger onClick={() => setResolving(true)}>Resolve…</Button>}
        </Space>
      </Space>
      <ProcessSteps steps={PO_STEPS} current={PO_STATUS[d.status]?.step ?? -1} />
      {problems && <Alert type="error" showIcon message="Not possible" description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />}
      {!problems && d.problems.length > 0 && <Alert type={d.status === 'REJECTED' ? 'error' : 'warning'} showIcon message={d.status === 'REJECTED' ? 'Not created in SAP' : d.status === 'UNKNOWN' ? 'SAP outcome unknown' : 'Last validation'}
        description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{d.problems.map((p) => <li key={p}>{p}</li>)}</ul>} />}

      <Row gutter={12}>
        <Col xs={24} lg={12}>
          <Card size="small" title="Header">
            <Descriptions size="small" column={1} items={[
              { label: 'Supplier', children: `${d.supplierCode} · ${d.supplierName}` },
              { label: 'Company · plant', children: `${d.companyCode} · plant ${d.plant} · purchasing org ${d.purchasingOrg} / group ${d.purchasingGroup || '—'}` },
              { label: 'Incoterm', children: d.incoterm }, { label: 'Ports', children: `${d.portOfLoading} → ${d.portOfDischarge}` },
              { label: 'Payment terms', children: d.paymentTerms }, { label: 'Currency', children: d.currency },
              { label: 'Containers (total)', children: <Typography.Text strong>{d.containers}</Typography.Text> },
              { label: 'Portal reference', children: <Typography.Text copyable>{d.poDraftNo}</Typography.Text> },
            ]} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="SAP submission">
            {d.submission ? (
              <>
                <Descriptions size="small" column={1} items={[
                  { label: 'Status', children: SUBMISSION[d.submission.status] ?? d.submission.status }, { label: 'Sent · asked SAP', children: `${d.submission.attempts} time(s) · ${d.submission.checks} time(s)` },
                  { label: 'Submitted', children: `${d.submittedBy ?? ''} · ${formatDateTime(d.submittedAt)}` },
                  { label: 'What was sent', children: <Tooltip title={`Idempotency key ${d.submission.key} · SHA-256 ${d.submission.hash}`}><Typography.Text type="secondary">frozen at submit (details on hover)</Typography.Text></Tooltip> },
                  ...(d.sapCreatedAt ? [{ label: 'Created in SAP', children: `${formatDateTime(d.sapCreatedAt)} · ${d.resolution ? RESOLUTION[d.resolution] ?? d.resolution : ''}` }] : []),
                ]} />
                <Table size="small" pagination={false} rowKey={(a) => `${a.kind}${a.startedAt}`} dataSource={d.attempts} style={{ marginTop: 6 }} columns={[
                  { title: 'When', key: 'w', render: (_: unknown, a: D['attempts'][number]) => formatDateTime(a.startedAt) }, { title: 'What', dataIndex: 'kind', render: (v: string) => ATTEMPT[v] ?? v },
                  { title: 'Result', dataIndex: 'outcome', render: (v: string | null) => (v ? OUTCOME[v] ?? v : 'running…') }, { title: 'Detail', dataIndex: 'detail', ellipsis: true },
                ]} />
              </>
            ) : <Typography.Text type="secondary">Not submitted yet — validate, then submit. The checks run again at submit.</Typography.Text>}
          </Card>
        </Col>
      </Row>

      <Card size="small" title="Items" extra={<Typography.Text type="secondary">{total.toLocaleString('en-GB', { maximumFractionDigits: 2 })} {d.currency}</Typography.Text>}>
        <Table<Item> size="small" pagination={false} rowKey="itemNo" dataSource={d.items} columns={[
          { title: 'Item', dataIndex: 'itemNo', width: 60 }, { title: 'SKU', key: 's', render: (_: unknown, i) => <>{i.material} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{i.description}</Typography.Text></> },
          { title: 'Specification', dataIndex: 'spec' },
          { title: 'Quantity', key: 'q', align: 'right', render: (_: unknown, i) => `${n(i.qty)} ${i.unit}` },
          { title: 'Price', key: 'p', align: 'right', render: (_: unknown, i) => `${i.unitPrice} ${i.currency}` },
          { title: 'Week', dataIndex: 'week', width: 95 }, { title: 'Confirmed ETD', dataIndex: 'confirmedEtd', width: 115 },
        ]} />
      </Card>

      <Row gutter={12}>
        <Col xs={24} lg={12}><Card size="small" title="Comments"><ThreadPanel entries={thread.data} loading={thread.isPending} canAdd={false} onAdd={async () => undefined} /></Card></Col>
        <Col xs={24} lg={12}><Card size="small" title="Evidence and attachments">
          <AttachmentsPanel entityType="PO_DRAFT" entityId={poDraftId} rows={files.data} loading={files.isPending} canUpload={d.actions.resolve || d.actions.validate}
            showOld={showOld} onShowOld={setShowOld} onChanged={() => void utils.po.attachments.invalidate({ poDraftId })} />
        </Card></Col>
      </Row>
      <ResolveModal open={resolving} draft={d} onClose={() => setResolving(false)} />
    </Space>
  );
}

function ResolveModal({ open, draft: d, onClose }: { open: boolean; draft: D; onClose: () => void }) {
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const resolve = trpc.po.resolve.useMutation();
  const [outcome, setOutcome] = useState<'CREATED' | 'NOT_CREATED'>('CREATED');
  const [po, setPo] = useState('');
  const [comment, setComment] = useState('');
  return (
    <Modal open={open} title={`Resolve the SAP outcome of ${d.poDraftNo}`} okText="Resolve" onCancel={onClose} destroyOnHidden
      okButtonProps={{ danger: true, disabled: !comment.trim() || (outcome === 'CREATED' && !po.trim()), loading: resolve.isPending }}
      onOk={async () => {
        try {
          await resolve.mutateAsync({ commandId: newCommandId(), poDraftId: d.poDraftId, rowVer: d.rowVer, outcome, sapPoNumber: po, comment });
          message.success('Resolved'); await utils.po.invalidate(); await utils.work.invalidate(); onClose();
        } catch (err) { message.error(errorText(err)); }
      }}>
      <Typography.Paragraph>Look in SAP for a PO with the reference <Typography.Text strong copyable>{d.poDraftNo}</Typography.Text>, attach the evidence (e.g. a screenshot) under “Evidence and attachments” first, then record what you found. SAP is asked again when it is reachable.</Typography.Paragraph>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Radio.Group value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <Space direction="vertical">
            <Radio value="CREATED">SAP has the PO — enter its number</Radio>
            <Radio value="NOT_CREATED">SAP has no PO — the quantity goes back to PO preparation</Radio>
          </Space>
        </Radio.Group>
        {outcome === 'CREATED' && <Input id="sapPo" placeholder="SAP PO number" maxLength={20} value={po} onChange={(e) => setPo(e.target.value)} style={{ width: 220 }} />}
        <Input.TextArea id="resolveComment" rows={2} maxLength={2000} placeholder="How you checked (required)" value={comment} onChange={(e) => setComment(e.target.value)} />
      </Space>
    </Modal>
  );
}
