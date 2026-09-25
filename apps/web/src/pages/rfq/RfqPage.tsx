import { useState } from 'react';
import { App, Button, Descriptions, Input, InputNumber, List, Modal, Select, Skeleton, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DownloadOutlined, EditOutlined, PlusOutlined, SendOutlined, StopOutlined, SwapOutlined, TrophyOutlined, UserAddOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AwardsTab } from '../award/AwardsListPage';
import { StatusTag } from '../../components/StatusTag';
import { RfqStatus } from './RfqStatus';
import { AttachmentsPanel } from '../../components/AttachmentsPanel';
import { BackToWork } from '../../components/BackToWork';
import { ThreadPanel } from '../../components/ThreadPanel';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { downloadXlsx } from '../../lib/excel';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf } from '../../lib/workflow';
import { MATCH_LABEL, n, RFQ_LINE_STATUS, RFQ_STATUS } from './rfqLabels';
import { RecordQuotesDrawer } from './RecordQuotesDrawer';
import { AddQuantityModal, MixChangeDrawer, WeekShiftModal } from './ProcRequests';
import { LoadError } from '../../components/LoadError';
import { countOf, TabLabel } from '../../components/TabLabel';
import { InviteSuppliersModal } from './InviteSuppliersModal';

type Rfq = RouterOutputs['rfq']['get'];
type Line = Rfq['lines'][number];

/** The supplier view as an Excel file (spec 18): week, material, origin, quantity, containers — no demand numbers. */
function downloadSupplierView(r: Rfq) {
  void downloadXlsx(`${r.rfqNo}-supplier-view`, [{ name: 'Supplier view', title: `${r.rfqNo} — request for quotation`, header: ['ETD week', 'Material', 'Origin', 'Quantity', 'Unit', 'Containers in the week'],
    rows: r.supplierView.map((v) => [v.week, v.label, v.originCode, Number(v.qty), v.unit, v.weekContainers]) }]);
}

/** One RFQ (spec 18): lines by week, quotes, suppliers, and its actions. */
export function RfqPage() {
  const { rfqId = '' } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const rfq = trpc.rfq.get.useQuery({ rfqId }, { retry: false });
  const thread = trpc.rfq.thread.useQuery({ rfqId });
  const history = trpc.rfq.history.useQuery({ rfqId });
  const [showOld, setShowOld] = useState(false);
  const attachments = trpc.rfq.attachments.useQuery({ rfqId, includeOld: showOld });
  const [inviting, setInviting] = useState(false);
  const awards = trpc.award.list.useQuery({ rfqId, page: 1, pageSize: 100 }); // same query as the Awards tab: its count
  const releaseReasons = trpc.rfq.reasons.useQuery({ context: 'RELEASE' });
  const cancelReasons = trpc.rfq.reasons.useQuery({ context: 'RFQ_CANCEL' });
  const send = trpc.rfq.send.useMutation();
  const release = trpc.rfq.release.useMutation();
  const cancel = trpc.rfq.cancel.useMutation();
  const [quoting, setQuoting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [mixing, setMixing] = useState(false);
  const [shifting, setShifting] = useState<Line | null>(null);
  const [releasing, setReleasing] = useState<Line | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [qty, setQty] = useState<number | null>(null);
  const [reason, setReason] = useState<string>();
  const [comment, setComment] = useState('');

  if (rfq.error) return <LoadError error={rfq.error} what="RFQ" onRetry={() => void rfq.refetch()} extra={<Link to="/rfqs">RFQs</Link>} />;
  if (!rfq.data) return <Skeleton active />;
  const r = rfq.data;
  const refresh = () => Promise.all([utils.rfq.invalidate(), utils.work.invalidate(), utils.demand.invalidate()]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); message.success(ok); await refresh(); return true; } catch (err) { const p = problemsOf(err); message.error(p.length ? p.join(' · ') : errorText(err)); return false; }
  };
  const openDialog = (l: Line | null) => { setReleasing(l); setQty(l ? Number(l.inRfq) + Number(l.quoted) : null); setReason(undefined); setComment(''); };

  const weeks = [...new Set(r.lines.map((l) => l.week))];
  const suppliersByCode = new Map(r.suppliers.map((s) => [s.supplierCode, s]));
  const lowest = (week: string, key: string) => {
    const qs = r.quotes.filter((q) => q.week === week && q.key === key);
    const sameCurrency = new Set(qs.map((q) => q.currency)).size === 1; // compare prices only in one currency
    return sameCurrency && qs.length > 1 ? Math.min(...qs.map((q) => Number(q.unitPrice))) : null;
  };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={12}>
        <BackToWork />
        <Link to={`/demands/${r.demandId}`}><Typography.Text type="secondary">{r.demandNo}</Typography.Text></Link>
        <Link to="/rfqs"><Typography.Text type="secondary">RFQs</Typography.Text></Link>
      </Space>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>{r.rfqNo}</Typography.Title>
          <StatusTag def={RFQ_STATUS[r.status]} />
          <Typography.Text type="secondary">{r.demandNo} · {r.companyCode} · {r.suppliers.length} supplier(s)</Typography.Text>
        </Space>
        <Space wrap>
          <Button icon={<DownloadOutlined />} onClick={() => downloadSupplierView(r)} disabled={!r.supplierView.length}>Download supplier view</Button>
          {r.actions.send && <Button type="primary" icon={<SendOutlined />} loading={send.isPending} onClick={() => run(() => send.mutateAsync({ commandId: newCommandId(), rfqId, rowVer: r.rowVer }), `${r.rfqNo} sent`)}>Send</Button>}
          {r.actions.addQuantity && <Button icon={<PlusOutlined />} onClick={() => setAdding(true)}>Add quantity…</Button>}
          {r.actions.mixChange && <Button icon={<SwapOutlined />} onClick={() => setMixing(true)}>Propose mix change…</Button>}
          {r.actions.recordQuotes && <Button type="primary" icon={<EditOutlined />} onClick={() => setQuoting(true)}>Record quotes…</Button>}
          {r.actions.award && <Button type="primary" icon={<TrophyOutlined />} onClick={() => navigate(`/rfqs/${rfqId}/award`)}>Award…</Button>}
          {r.actions.cancel && <Button danger icon={<StopOutlined />} onClick={() => { openDialog(null); setCancelling(true); }}>Cancel RFQ…</Button>}
        </Space>
      </Space>
      <RfqStatus rfq={r} />
      <Descriptions size="small" bordered column={{ xs: 1, md: 3 }} items={[
        { label: 'Created', children: `${r.createdBy} · ${formatDateTime(r.createdAt)}` },
        { label: 'Sent', children: r.sentAt ? `${r.sentBy} · ${formatDateTime(r.sentAt)}` : 'Not yet — download the supplier view, then Send' },
        { label: 'Containers', children: r.weeks.map((w) => `${w.etdWeek}: ${w.containerCount}${w.containerCount !== w.defaultCount ? ` (default ${w.defaultCount})` : ''}`).join(' · ') },
        ...(r.cancelled ? [{ label: 'Cancelled', children: `${r.cancelled.by} · ${formatDateTime(r.cancelled.at)} · ${r.cancelled.reason}${r.cancelled.comment ? ` — ${r.cancelled.comment}` : ''}`, span: 3 }] : []),
      ]} />

      <Tabs items={[
        { key: 'lines', label: <TabLabel text="Lines" count={r.lines.length} />, children: weeks.map((w) => (
          <Table<Line> key={w} size="small" bordered pagination={false} rowKey="rfqLineId" dataSource={r.lines.filter((l) => l.week === w)} tableLayout="fixed" style={{ marginBottom: 10 }}
            title={() => <Space><Typography.Text strong>{w}</Typography.Text><Tag>{r.weeks.find((x) => x.etdWeek === w)?.containerCount ?? 0} containers</Tag></Space>}
            columns={[
              { title: 'Material', key: 'label', ellipsis: true, render: (_: unknown, l) => <>{l.label}{l.origin === 'PROCUREMENT' && <Tag color="blue" style={{ marginInlineStart: 4 }}>{l.status === 'PENDING_SALES' ? 'proposed' : 'Procurement'}</Tag>}
                {l.pending && <Link to={`/change-requests/${l.pending.crId}`}><Tag color="gold" style={{ marginInlineStart: 4 }}>⏸ {l.pending.fromWeek ? `from ${l.pending.fromWeek} · ` : ''}{l.pending.crNo}</Tag></Link>}</> },
              { title: 'Origin', key: 'o', width: 70, render: (_: unknown, l) => <Tag color="blue">{l.originCode}</Tag> },
              { title: 'Asked', key: 'a', width: 100, align: 'right', render: (_: unknown, l) => (Number(l.proposed) ? `${n(l.proposed)} proposed` : n(l.asked)) },
              { title: 'In RFQ', key: 'i', width: 100, align: 'right', render: (_: unknown, l) => (Number(l.inRfq) ? n(l.inRfq) : '—') },
              { title: 'Quoted', key: 'q', width: 100, align: 'right', render: (_: unknown, l) => (Number(l.quoted) ? n(l.quoted) : '—') },
              { title: 'Released', key: 'r', width: 100, align: 'right', render: (_: unknown, l) => (Number(l.released) ? n(l.released) : '—') },
              { title: 'Status', key: 's', width: 120, render: (_: unknown, l) => <Tag color={RFQ_LINE_STATUS[l.status].color}>{RFQ_LINE_STATUS[l.status].label}</Tag> },
              { title: '', key: 'x', width: 170, render: (_: unknown, l) => <Space size={0}>
                {r.actions.release && l.canRelease && <Button size="small" type="link" onClick={() => openDialog(l)}>Release…</Button>}
                {r.actions.weekShift && l.canShift && <Button size="small" type="link" onClick={() => setShifting(l)}>Week shift…</Button>}</Space> },
            ]} />
        )) },
        { key: 'quotes', label: <TabLabel text="Quotes" count={r.quotes.length} />, children: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Table size="small" bordered pagination={false} rowKey={(v) => `${v.week}|${v.key}`} dataSource={r.supplierView} tableLayout="fixed"
              columns={[
                { title: 'Row', key: 'row', width: 260, ellipsis: true, render: (_: unknown, v) => `${v.week} · ${v.label} ${v.originCode} · ${n(v.qty)} ${v.unit}` },
                ...r.suppliers.map((s) => ({
                  title: s.name, key: s.supplierCode, ellipsis: true,
                  render: (_: unknown, v: Rfq['supplierView'][number]) => {
                    if (!s.originsAtInvite.includes(v.originCode)) return <Typography.Text type="secondary">cannot quote (origin)</Typography.Text>;
                    const q = r.quotes.find((x) => x.supplierCode === s.supplierCode && x.week === v.week && x.key === v.key);
                    if (!q) return <Typography.Text type="secondary">waiting</Typography.Text>;
                    const best = lowest(v.week, v.key) === Number(q.unitPrice);
                    return <Tooltip title={`${q.recordedBy} · ${formatDateTime(q.recordedAt)}${q.quotedSku ? ` · SKU ${q.quotedSku}` : ''}`}>
                      <span style={best ? { background: '#f6ffed', padding: '0 4px' } : undefined}>{q.unitPrice} {q.currency} · {n(q.available)} avail.</span></Tooltip>;
                  },
                })),
              ]} />
            {r.weekOffers.length > 0 && (
              <Table size="small" bordered pagination={false} rowKey="week" tableLayout="fixed" title={() => <Typography.Text strong>Containers offered per week</Typography.Text>}
                dataSource={r.weeks.map((w) => ({ week: w.etdWeek, asked: w.containerCount }))}
                columns={[
                  { title: 'Week', dataIndex: 'week', width: 260 },
                  { title: 'Asked', dataIndex: 'asked', width: 90, align: 'right' },
                  ...r.suppliers.map((s) => ({
                    title: s.name, key: s.supplierCode, ellipsis: true,
                    render: (_: unknown, w: { week: string; asked: number }) => r.weekOffers.find((o) => o.supplierCode === s.supplierCode && o.week === w.week)?.containers ?? <Typography.Text type="secondary">—</Typography.Text>,
                  })),
                ]} />
            )}
            {r.replacedQuotes.length > 0 && (
              <List size="small" bordered header={<Typography.Text strong>Replaced quotes</Typography.Text>} dataSource={r.replacedQuotes}
                renderItem={(q) => <List.Item><Typography.Text type="secondary">{formatDateTime(q.recordedAt)} · {suppliersByCode.get(q.supplierCode)?.name} · {q.week} · {q.unitPrice} {q.currency} · {n(q.available)} available</Typography.Text></List.Item>} />
            )}
          </Space>
        ) },
        { key: 'suppliers', label: <TabLabel text="Suppliers" count={r.suppliers.length} />, children: (<>
          {r.actions.invite && <Button icon={<UserAddOutlined />} style={{ marginBottom: 8 }} onClick={() => setInviting(true)}>Invite more suppliers…</Button>}
          <Table size="small" bordered pagination={false} rowKey="supplierCode" dataSource={r.suppliers} tableLayout="fixed"
            columns={[
              { title: 'Supplier', key: 's', width: 280, ellipsis: true, render: (_: unknown, s) => <>{s.supplierCode} · {s.name}{s.outsideShortlist && <Tag color="purple" style={{ marginInlineStart: 6 }}>first contact</Tag>}</> },
              { title: 'Origins when invited', key: 'o', width: 160, render: (_: unknown, s) => s.originsAtInvite.join(', ') },
              { title: 'Rank', key: 'r', width: 70, render: (_: unknown, s) => s.rank ?? '—' },
              { title: 'History shown when invited', key: 'h', render: (_: unknown, s) => Object.entries(s.hints).map(([o, h]) => (
                <div key={o}><Tag color="blue">{o}</Tag>{h.matchLevel === 'NONE' ? 'no history' : <><Tag color={MATCH_LABEL[h.matchLevel].color}>{MATCH_LABEL[h.matchLevel].label}</Tag>{h.poCount} POs · last {h.lastPoDate}{h.lastPrice ? ` at ${h.lastPrice} ${h.lastCurrency}` : ''}</>}</div>
              )) },
              { title: 'Quoted rows', dataIndex: 'quotedRows', width: 110, align: 'right' },
            ]} />
          <InviteSuppliersModal open={inviting} onClose={() => setInviting(false)} rfqId={rfqId} rfqNo={r.rfqNo} rowVer={r.rowVer} sent={r.manualStatus === 'SENT'} />
        </>) },
        { key: 'awards', label: <TabLabel text="Awards" count={countOf(awards.data)} />, children: <AwardsTab rfqId={rfqId} /> },
        { key: 'comments', label: <TabLabel text="Comments" count={countOf(thread.data)} />, children: <ThreadPanel entries={thread.data} loading={thread.isPending} canAdd={false} onAdd={async () => undefined} /> },
        { key: 'attachments', label: <TabLabel text="Attachments" count={attachments.data?.filter((a) => a.isCurrent).length} />, children: (
          <AttachmentsPanel entityType="RFQ" entityId={rfqId} rows={attachments.data} loading={attachments.isPending} canUpload={r.manualStatus !== 'CANCELLED'}
            showOld={showOld} onShowOld={setShowOld} onChanged={() => void utils.rfq.attachments.invalidate({ rfqId })} />
        ) },
        { key: 'history', label: <TabLabel text="History" count={countOf(history.data)} />, children: (
          <List size="small" bordered dataSource={history.data ?? []} loading={history.isPending}
            renderItem={(h) => <List.Item><Space wrap><Typography.Text type="secondary">{formatDateTime(h.at)}</Typography.Text><span>{h.by}</span><Typography.Text strong>{h.event.replace('RFQ_', '').replace('_', ' ').toLowerCase()}</Typography.Text></Space></List.Item>} />
        ) },
      ]} />

      <RecordQuotesDrawer rfq={r} open={quoting} onClose={() => setQuoting(false)} />
      {adding && <AddQuantityModal rfq={r} open={adding} onClose={() => setAdding(false)} />}
      {mixing && <MixChangeDrawer rfq={r} open={mixing} onClose={() => setMixing(false)} />}
      <WeekShiftModal rfq={r} line={shifting} onClose={() => setShifting(null)} />
      <Modal open={!!releasing} title={`Release from ${r.rfqNo}`} okText="Release" okButtonProps={{ disabled: !reason || !qty, loading: release.isPending }} onCancel={() => setReleasing(null)} destroyOnHidden
        onOk={async () => { if (releasing && await run(() => release.mutateAsync({ commandId: newCommandId(), rfqLineId: releasing.rfqLineId, qty: String(qty), reasonCode: reason!, comment }), 'Released back to Open')) setReleasing(null); }}>
        {releasing && <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>{releasing.week} · {releasing.label}: {n(Number(releasing.inRfq) + Number(releasing.quoted))} {releasing.unit} still in this RFQ</Typography.Text>
          <InputNumber id="releaseQty" min={1} max={Number(releasing.inRfq) + Number(releasing.quoted)} precision={0} value={qty ?? undefined} onChange={setQty} addonAfter={releasing.unit} />
          <Select id="releaseReason" style={{ width: '100%' }} placeholder="Reason (required)" value={reason} onChange={setReason} options={(releaseReasons.data ?? []).map((x) => ({ value: x.ReasonCode, label: `${x.ReasonCode} · ${x.Description}` }))} />
          <Input.TextArea rows={2} maxLength={2000} placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Space>}
      </Modal>
      <Modal open={cancelling} title={`Cancel ${r.rfqNo}?`} okText="Cancel RFQ" okButtonProps={{ danger: true, disabled: !reason, loading: cancel.isPending }} onCancel={() => setCancelling(false)} destroyOnHidden
        onOk={async () => { if (await run(() => cancel.mutateAsync({ commandId: newCommandId(), rfqId, rowVer: r.rowVer, reasonCode: reason!, comment }), `${r.rfqNo} cancelled`)) setCancelling(false); }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">All its quantity goes back to Open on the demand; quotes stay in history.</Typography.Text>
          <Select id="cancelReason" style={{ width: '100%' }} placeholder="Reason (required)" value={reason} onChange={setReason} options={(cancelReasons.data ?? []).map((x) => ({ value: x.ReasonCode, label: `${x.ReasonCode} · ${x.Description}` }))} />
          <Input.TextArea rows={2} maxLength={2000} placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Space>
      </Modal>
    </Space>
  );
}
