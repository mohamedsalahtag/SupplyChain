import { useState } from 'react';
import { Alert, App, Button, Card, Input, Modal, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { CheckOutlined, RollbackOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { StatusTag as Tag2 } from '../../components/StatusTag';
import { DEMAND_STATUS, errorText, mondayText, newCommandId, qtyText } from '../../lib/workflow';

type Demand = RouterOutputs['demand']['get'];
type Week = Demand['weeks'][number];
type Line = Week['lines'][number];

const STATE_LABEL: Record<string, string> = {
  OPEN: 'Open', IN_RFQ: 'In RFQ', QUOTED: 'Quoted', AWARDED: 'Awarded', HANDED_OFF: 'Handed off', PO_PREPARATION: 'PO preparation',
  PO_SUBMITTED: 'PO submitted', PO_CREATED: 'PO created', CANCELLED: 'Cancelled', MERGED_OUT: 'Merged out',
};

/** A demand status with its explanation (spec 21): a draft is Sales'; a merged demand names where it went. */
export const StatusTag = ({ status, mergedInto }: { status: string; mergedInto?: { demandNo: string } | null }) => (
  <Tag2 def={DEMAND_STATUS[status]} chip={status === 'DRAFT' ? 'Sales' : undefined}
    label={status === 'MERGED' && mergedInto ? `Merged into ${mergedInto.demandNo}` : undefined} />
);

/** Column widths as shares of the page width, so the table always fits (no sideways scrolling, as AppTable). */
function fit<T extends { width?: number | string }>(cols: T[]): T[] {
  const sum = cols.reduce((a, c) => a + (typeof c.width === 'number' ? c.width : 0), 0);
  return cols.map((c) => (typeof c.width === 'number' ? { ...c, width: `${((c.width / sum) * 100).toFixed(2)}%` } : c));
}

const q = (s: string) => (Number(s) === 0 ? <Typography.Text type="secondary">—</Typography.Text> : qtyText(s));
const groupName = (g: Week['groups'][number]) => g.name || `Group ${g.groupNumber}`;

/** Where a line sits in the week's containers: its share and cartons per container, per group. */
function inContainers(w: Week, key: string) {
  return w.groups.flatMap((g) => g.items.filter((i) => i.key === key).map((i) => ({ group: g.mergedFrom ? `${groupName(g)} (${g.mergedFrom.demandNo})` : groupName(g), share: i.share, perContainer: i.perContainerQty, many: w.groups.length > 1 })));
}

/** One table per week (spec 12): each material once, with its container share and, after acceptance, where its quantity stands. */
function WeekTable({ week, accepted }: { week: Week; accepted: boolean }) {
  const ledgerCols = accepted
    ? [
        { title: 'Open', key: 'open', width: 80, align: 'right' as const, render: (_: unknown, l: Line) => q(l.ledger.open) },
        {
          title: 'In progress', key: 'prog', width: 85, align: 'right' as const,
          render: (_: unknown, l: Line) => (
            <Tooltip title={Object.entries(l.ledger.byState).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${STATE_LABEL[k]}: ${qtyText(v)}`).join(' · ')}>
              <span>{q(l.ledger.inProgress)}</span>
            </Tooltip>
          ),
        },
        { title: 'PO created', key: 'po', width: 80, align: 'right' as const, render: (_: unknown, l: Line) => q(l.ledger.poCreated) },
        { title: 'Cancelled', key: 'can', width: 88, align: 'right' as const, render: (_: unknown, l: Line) => q(l.ledger.cancelled) },
        { title: 'Merged out', key: 'mo', width: 80, align: 'right' as const, render: (_: unknown, l: Line) => q(l.ledger.mergedOut) },
        { title: 'Status', key: 'st', width: 120, render: (_: unknown, l: Line) => <StatusTag status={l.status} /> },
      ]
    : [];

  return (
    <Table<Line>
      size="small" bordered rowKey="lineId" pagination={false} dataSource={week.lines} tableLayout="fixed"
      columns={fit([
        { title: 'Material', key: 'm', width: 170, ellipsis: true, render: (_: unknown, l: Line) => <span title={`${l.majorCategory} · ${l.subMajorCategory}${l.hold ? ` · on hold (${l.hold.crNo})` : ''}`}>{l.hold && <Tag color="gold" style={{ marginInlineEnd: 4 }}>⏸</Tag>}{l.subMajorCategory}</span> },
        { title: 'Size', dataIndex: 'sizeLabel', width: 80 },
        { title: 'Class', dataIndex: 'classLabel', width: 100, ellipsis: true },
        { title: 'Origin', dataIndex: 'originCode', width: 60 },
        { title: 'SKU', key: 'k', width: 140, ellipsis: true, render: (_: unknown, l) => (l.materialCode ? <span title={l.materialDescription}>{l.materialCode}</span> : <Typography.Text type="secondary">—</Typography.Text>) },
        {
          title: 'Share', key: 'share', width: 95,
          render: (_: unknown, l) => {
            const where = inContainers(week, l.key);
            if (!where.length) return <Typography.Text type="secondary">—</Typography.Text>;
            return <Space direction="vertical" size={0}>{where.map((x) => <span key={x.group}>{x.share}%{x.many ? <Typography.Text type="secondary"> · {x.group}</Typography.Text> : null}</span>)}</Space>;
          },
        },
        {
          title: 'Per container', key: 'pc', width: 100, align: 'right',
          render: (_: unknown, l) => {
            const where = inContainers(week, l.key);
            return where.length ? <Space direction="vertical" size={0}>{where.map((x) => <span key={x.group}>{qtyText(x.perContainer)}</span>)}</Space> : '—';
          },
        },
        { title: `Requested (${week.lines[0]?.unit ?? ''})`, key: 'req', width: 110, align: 'right', render: (_: unknown, l) => <Typography.Text strong>{qtyText(l.ledger.requested)}</Typography.Text> },
        ...ledgerCols,
      ])}
    />
  );
}

/** Read-only mode of the Demand screen (spec 12): weeks, containers and quantities, and Procurement's decision. */
export function DemandView({ demand }: { demand: Demand }) {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const accept = trpc.demand.accept.useMutation();
  const ret = trpc.demand.return.useMutation();
  const [returning, setReturning] = useState(false);
  const [comment, setComment] = useState('');
  const accepted = demand.workflowStatus === 'ACCEPTED';
  const decides = demand.actions.accept || demand.actions.return;

  const refresh = () => Promise.all([utils.demand.invalidate(), utils.work.invalidate()]);

  const onAccept = () =>
    modal.confirm({
      title: `Accept ${demand.demandNo}?`,
      content: (
        <Space direction="vertical" size={4}>
          <span>Procurement takes the demand over:</span>
          <span>• every line's quantity becomes <b>Open</b>, ready to be sourced (RFQs from Stage 4);</span>
          <span>• the demand is locked for Sales — later changes need a change request;</span>
          <span>• it leaves your <i>Accept demand</i> list on My work.</span>
        </Space>
      ),
      okText: 'Accept',
      onOk: async () => {
        try {
          const r = await accept.mutateAsync({ demandId: demand.demandId, commandId: newCommandId(), rowVer: demand.rowVer });
          message.success(`${demand.demandNo} accepted: ${r.slices} line(s) now open for sourcing`);
          await refresh();
        } catch (err) {
          message.error(errorText(err));
        }
      },
    });
  const onReturn = async () => {
    try {
      await ret.mutateAsync({ demandId: demand.demandId, commandId: newCommandId(), rowVer: demand.rowVer, comment: comment.trim() });
      message.success(`${demand.demandNo} returned to Sales`);
      setReturning(false);
      await refresh();
      navigate('/work');
    } catch (err) {
      message.error(errorText(err));
    }
  };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {demand.workflowStatus === 'SUBMITTED' && (decides ? (
        <Alert type="info" showIcon message="Procurement decision: accept or return this demand"
          description={
            <Space direction="vertical" size={2}>
              <span><b>Accept</b> — you take it over: its quantities become open for sourcing and Sales can no longer edit it (changes need a change request).</span>
              <span><b>Return</b> — it goes back to Sales with your comment; they fix it and resubmit (a new version; the baseline stays version 1).</span>
            </Space>
          }
          action={
            <Space direction="vertical">
              {demand.actions.accept && <Button type="primary" icon={<CheckOutlined />} loading={accept.isPending} onClick={onAccept} block>Accept</Button>}
              {demand.actions.return && <Button danger icon={<RollbackOutlined />} onClick={() => { setComment(''); setReturning(true); }} block>Return…</Button>}
            </Space>
          } />
      ) : (
        <Alert type="info" showIcon message="Waiting for Procurement to accept or return this demand." />
      ))}
      {demand.notes && <Card size="small" title="Notes"><Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{demand.notes}</Typography.Text></Card>}
      {demand.weeks.map((w) => (
        <Card key={w.etdWeek} size="small"
          title={
            <Space wrap>
              <Typography.Text strong>{w.etdWeek}</Typography.Text>
              <Typography.Text type="secondary">{mondayText(w.etdWeek)}</Typography.Text>
              <Tag>{w.containerCount} container{w.containerCount === 1 ? '' : 's'}</Tag>
              {w.groups.map((g) => (
                <Typography.Text key={g.groupNumber} type="secondary">
                  {groupName(g)}: {g.containerCount} × {qtyText(g.capacity)} {g.unit}
                  {g.mergedFrom && <Tag color="purple" style={{ marginInlineStart: 4 }}><Link to={`/demands/${g.mergedFrom.demandId}`}>from {g.mergedFrom.demandNo}</Link> · {g.mergedFrom.mergeNo}</Tag>}
                </Typography.Text>
              ))}
              {w.mergedInto.map((m) => (
                <Tag key={m.mergeNo} color="purple">Merged into <Link to={`/demands/${m.demandId}`}>{m.demandNo}</Link> · {m.mergeNo}</Tag>
              ))}
              {accepted && <StatusTag status={w.status} />}
              {w.hold && <Tag color="gold">⏸ On hold · {w.hold.crNo}</Tag>}
            </Space>
          }>
          <WeekTable week={w} accepted={accepted} />
          {w.lines.flatMap((l) => [...l.mergedIn, ...l.approvedFor].map((t) => (
            <Typography.Text key={`${l.lineId}-${t}`} type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>ⓘ {l.subMajorCategory}: {t}</Typography.Text>
          )))}
        </Card>
      ))}
      <Modal open={returning} title={`Return ${demand.demandNo} to Sales?`} okText="Return" okButtonProps={{ danger: true, disabled: !comment.trim(), loading: ret.isPending }}
        onOk={onReturn} onCancel={() => setReturning(false)} destroyOnClose>
        <Typography.Paragraph type="secondary">Sales gets it back on their My work with your comment, changes it and resubmits.</Typography.Paragraph>
        <Typography.Text>What should Sales change? (required)</Typography.Text>
        <Input.TextArea id="returnComment" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginTop: 6 }} />
      </Modal>
    </Space>
  );
}
