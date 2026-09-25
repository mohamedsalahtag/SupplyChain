import { useEffect, useState } from 'react';
import { Alert, App, Button, Descriptions, Input, InputNumber, List, Modal, Segmented, Skeleton, Space, Table, Tabs, Tag, Typography } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { AttachmentsPanel } from '../../components/AttachmentsPanel';
import { BackToWork } from '../../components/BackToWork';
import { ThreadPanel } from '../../components/ThreadPanel';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, qtyText } from '../../lib/workflow';
import { LoadError } from '../../components/LoadError';
import { countOf, TabLabel } from '../../components/TabLabel';

type Cr = RouterOutputs['cr']['get'];
type Item = Cr['items'][number];
type Choice = { decision: 'APPROVE' | 'PARTIAL' | 'REJECT'; count?: number; qty?: string };

export const CR_STATUS: Record<string, { label: string; color: string }> = {
  SUBMITTED: { label: 'Submitted', color: 'purple' },
  APPROVED: { label: 'Approved', color: 'green' },
  PARTIALLY_APPROVED: { label: 'Partially approved', color: 'lime' },
  REJECTED: { label: 'Rejected', color: 'red' },
  WITHDRAWN: { label: 'Withdrawn', color: 'default' },
  BLOCKED: { label: 'Blocked', color: 'volcano' },
};
export const APPLY_STATUS: Record<string, { label: string; color: string }> = {
  APPLIED: { label: 'Applied', color: 'green' },
  PARTIALLY_APPLIED: { label: 'Partially applied', color: 'gold' },
  NOT_REQUIRED: { label: '—', color: 'default' },
};
export const CR_TYPE: Record<string, string> = {
  CHANGE_CONTAINERS: 'Change containers', CANCEL_WEEK: 'Cancel week', CANCEL_DEMAND: 'Cancel demand', NOT_SOURCED: 'Not sourced',
  ADD_TO_DEMAND: 'Add to demand', WEEK_SHIFT: 'Week shift', MIX_CHANGE: 'Mix change',
};

/** One change request (spec 14): what is asked, and the other department's decision per item. */
export function ChangeRequestPage() {
  const { crId = '' } = useParams();
  const { message, modal } = App.useApp();
  const utils = trpc.useUtils();
  const cr = trpc.cr.get.useQuery({ crId }, { retry: false });
  const thread = trpc.cr.thread.useQuery({ crId });
  const history = trpc.cr.history.useQuery({ crId });
  const [showOld, setShowOld] = useState(false);
  const attachments = trpc.cr.attachments.useQuery({ crId, includeOld: showOld });
  const decide = trpc.cr.decide.useMutation();
  const withdraw = trpc.cr.withdraw.useMutation();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [comment, setComment] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawText, setWithdrawText] = useState('');

  useEffect(() => {
    if (cr.data) setChoices(Object.fromEntries(cr.data.items.map((i) => [i.crItemId, { decision: 'APPROVE' as const }])));
  }, [cr.data]);

  if (cr.error) return <LoadError error={cr.error} what="Change request" onRetry={() => void cr.refetch()} extra={<Link to="/change-requests">Change requests</Link>} />;
  if (!cr.data) return <Skeleton active />;
  const c = cr.data;
  const refresh = () => Promise.all([utils.cr.invalidate(), utils.demand.invalidate(), utils.work.invalidate()]);
  const decider = c.raisedByDept === 'SALES' ? 'Procurement' : 'Sales';

  const onDecide = async () => {
    try {
      const r = await decide.mutateAsync({
        crId, commandId: newCommandId(), rowVer: c.rowVer, comment,
        decisions: c.items.map((i) => {
          const ch = choices[i.crItemId];
          return { crItemId: i.crItemId, decision: ch.decision, approvedCount: ch.decision === 'PARTIAL' ? ch.count : undefined, approvedQty: ch.decision === 'PARTIAL' ? ch.qty : undefined };
        }),
      });
      message.success(`${c.crNo}: ${CR_STATUS[r.status].label} · ${APPLY_STATUS[r.applyStatus].label}`);
      await refresh();
    } catch (err) {
      message.error(errorText(err));
    }
  };
  /** A decision is applied at once and cannot be undone: say what will happen first. */
  const confirmDecide = () => {
    const n = (d: Choice['decision']) => c.items.filter((i) => choices[i.crItemId]?.decision === d).length;
    const parts = [n('APPROVE') && `approve ${n('APPROVE')}`, n('PARTIAL') && `approve part of ${n('PARTIAL')}`, n('REJECT') && `reject ${n('REJECT')}`].filter(Boolean);
    modal.confirm({
      title: `Decide ${c.crNo}?`, okText: 'Decide',
      content: `You ${parts.join(', ')} of ${c.items.length} item(s). Approved changes are applied to the demand straight away and cannot be undone.`,
      onOk: onDecide,
    });
  };
  const onWithdraw = async () => {
    try {
      await withdraw.mutateAsync({ crId, commandId: newCommandId(), rowVer: c.rowVer, comment: withdrawText });
      message.success(`${c.crNo} withdrawn`);
      setWithdrawing(false);
      await refresh();
    } catch (err) {
      message.error(errorText(err));
    }
  };

  const decisionCell = (i: Item) => {
    const ch = choices[i.crItemId] ?? { decision: 'APPROVE' };
    const options = [{ value: 'APPROVE', label: 'Approve' }, ...(i.partial ? [{ value: 'PARTIAL', label: i.partial.type === 'count' ? 'Fewer' : 'Less' }] : []), { value: 'REJECT', label: 'Reject' }];
    return (
      <Space size={4} wrap>
        <Segmented size="small" value={ch.decision} options={options} onChange={(v) => setChoices({ ...choices, [i.crItemId]: { ...ch, decision: v as Choice['decision'] } })} />
        {ch.decision === 'PARTIAL' && i.partial?.type === 'count' && (
          <InputNumber size="small" min={i.partial.min} max={i.partial.max} value={ch.count} placeholder={`${i.partial.min}–${i.partial.max}`} style={{ width: 80 }}
            onChange={(v) => setChoices({ ...choices, [i.crItemId]: { ...ch, count: v ?? undefined } })} aria-label="Approved containers" />
        )}
        {ch.decision === 'PARTIAL' && i.partial?.type === 'qty' && (
          <Input size="small" inputMode="numeric" value={ch.qty} placeholder={`< ${qtyText(i.partial.max)}`} style={{ width: 100 }}
            onChange={(e) => setChoices({ ...choices, [i.crItemId]: { ...ch, qty: e.target.value.replace(/[^\d]/g, '') } })} aria-label="Approved quantity" />
        )}
      </Space>
    );
  };
  const resultCell = (i: Item) => (
    <Space direction="vertical" size={0}>
      <span>{i.decision === 'APPROVE' ? 'Approved' : i.decision === 'REJECT' ? 'Rejected' : i.decision === 'PARTIAL' ? `Approved ${i.approvedCount ?? i.approvedQty}` : '—'}</span>
      {i.applyMessage && <Typography.Text type="warning">{i.applyMessage}</Typography.Text>}
    </Space>
  );

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={12}>
        <BackToWork />
        <Link to={`/demands/${c.demandId}`}><Typography.Text type="secondary">{c.demandNo}</Typography.Text></Link>
        {c.rfq && <Link to={`/rfqs/${c.rfq.rfqId}`}><Typography.Text type="secondary">{c.rfq.rfqNo}</Typography.Text></Link>}
        <Link to="/change-requests"><Typography.Text type="secondary">Change requests</Typography.Text></Link>
      </Space>
      <Space size={10} align="baseline" wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>{c.crNo}</Typography.Title>
        <Tag color={CR_STATUS[c.status].color}>{CR_STATUS[c.status].label}</Tag>
        {c.applyStatus !== 'NOT_REQUIRED' && <Tag color={APPLY_STATUS[c.applyStatus].color}>{APPLY_STATUS[c.applyStatus].label}</Tag>}
        <Typography.Text type="secondary">{CR_TYPE[c.crType]} · {c.demandNo} · {c.companyCode}</Typography.Text>
      </Space>
      <Descriptions size="small" bordered column={{ xs: 1, md: 2 }} items={[
        { label: 'Raised by', children: `${c.raisedBy} · ${formatDateTime(c.raisedAt)} (${c.raisedByDept === 'SALES' ? 'Sales' : 'Procurement'})` },
        { label: 'Reason', children: `${c.reasonCode} · ${c.reasonText}` },
        { label: 'Comment', children: c.comment, span: 2 },
        ...(c.decidedAt ? [{ label: 'Decided by', children: `${c.decidedBy} · ${formatDateTime(c.decidedAt)}` }, { label: 'Decision comment', children: c.decisionComment }] : []),
      ]} />

      {c.status === 'BLOCKED' && (
        <Alert type="error" showIcon message="Blocked by the pre-check — nothing was held or changed"
          description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{c.problems.map((p) => <li key={p}>{p}</li>)}</ul>} />
      )}
      {c.status === 'SUBMITTED' && (c.actions.decide ? (
        <Alert type="info" showIcon message={`${decider} decision: decide each item`}
          description={`Approve applies it at once; Reject leaves it unchanged${c.items.some((i) => i.partial) ? '; for extra containers or quantity you may approve less' : ''}. Everything is applied together, or nothing.`} />
      ) : (
        <Alert type="info" showIcon message={`Waiting for ${decider} to decide.${c.mine ? ' You raised it, so you cannot decide it.' : ''}`}
          action={c.actions.withdraw && <Button danger size="small" onClick={() => { setWithdrawText(''); setWithdrawing(true); }}>Withdraw…</Button>} />
      ))}

      <Table<Item>
        size="small" bordered rowKey="crItemId" pagination={false} dataSource={c.items} tableLayout="fixed"
        columns={[
          { title: '#', dataIndex: 'itemNo', width: 40 },
          { title: 'Week', dataIndex: 'etdWeek', width: 90 },
          { title: 'Change', dataIndex: 'what', ellipsis: { showTitle: true } },
          { title: 'Quantity effect', key: 'e', width: 330, render: (_: unknown, i) => (i.effect.length ? <Space direction="vertical" size={0}>{i.effect.map((e) => <span key={e}>{e}</span>)}</Space> : '—') },
          c.actions.decide
            ? { title: 'Decision', key: 'd', width: 250, render: (_: unknown, i) => decisionCell(i) }
            : { title: 'Result', key: 'r', width: 220, render: (_: unknown, i) => resultCell(i) },
        ]}
      />
      {c.actions.decide && (
        <Space wrap style={{ width: '100%' }}>
          <Input id="decisionComment" style={{ width: 560, maxWidth: '100%' }} placeholder="Decision comment (required)" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          <Button type="primary" icon={<CheckOutlined />} disabled={!comment.trim()} loading={decide.isPending} onClick={confirmDecide}>Decide</Button>
        </Space>
      )}

      <Tabs items={[
        { key: 'comments', label: <TabLabel text="Comments" count={countOf(thread.data)} />, children: (
          <ThreadPanel entries={thread.data} loading={thread.isPending} canAdd={false} onAdd={async () => undefined} />
        ) },
        { key: 'attachments', label: <TabLabel text="Attachments" count={attachments.data?.filter((a) => a.isCurrent).length} />, children: (
          <AttachmentsPanel entityType="CR" entityId={crId} rows={attachments.data} loading={attachments.isPending} canUpload={c.status === 'SUBMITTED'}
            showOld={showOld} onShowOld={setShowOld} onChanged={() => void utils.cr.attachments.invalidate({ crId })} />
        ) },
        { key: 'history', label: <TabLabel text="History" count={countOf(history.data)} />, children: (
          <List size="small" bordered dataSource={history.data ?? []} loading={history.isPending}
            renderItem={(h) => <List.Item><Space wrap><Typography.Text type="secondary">{formatDateTime(h.at)}</Typography.Text><span>{h.by}</span><Typography.Text strong>{h.event.replace('CR_', '').toLowerCase()}</Typography.Text></Space></List.Item>} />
        ) },
      ]} />

      <Modal open={withdrawing} title={`Withdraw ${c.crNo}?`} okText="Withdraw" okButtonProps={{ danger: true, disabled: !withdrawText.trim(), loading: withdraw.isPending }}
        onOk={onWithdraw} onCancel={() => setWithdrawing(false)} destroyOnClose>
        <Typography.Paragraph type="secondary">Nothing changes; the holds are released and the request leaves {decider}'s My work.</Typography.Paragraph>
        <Input.TextArea rows={3} maxLength={2000} value={withdrawText} onChange={(e) => setWithdrawText(e.target.value)} placeholder="Why (required)" />
      </Modal>
    </Space>
  );
}
