/** Reports → Dashboard (spec 26), the first tab: the live cards D1–D5 here, the period cards in DashboardPeriod.tsx. */
import { useState, type CSSProperties } from 'react';
import { Alert, Button, Empty, Grid, Space, Table, Tag, Typography } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { Columns, Legend, StackBar } from '../../components/Charts';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { ChangeRequestsCard, FlowCard, HeadlineCard, StabilityCard, SuppliersCard } from './DashboardPeriod';
import { ageText, DashCard, dateText, defaultPeriod, fmtN, LIVE, liveFilter, Small, SmallPara, ViewSwitch, weekLabel, type DashFilter, type View } from './dashboardParts';

export function DashboardTab({ filter }: { filter: DashFilter }) {
  const period = defaultPeriod(filter);
  const live = liveFilter(filter);
  // A 12-column grid on wide screens (the tall "Who has the ball" card spans two rows beside D1 and D3); one column below.
  const wide = !!Grid.useBreakpoint().xl;
  const cell = (cols: number, rows = 1): CSSProperties => (wide ? { gridColumn: `span ${cols}`, gridRow: rows > 1 ? `span ${rows}` : undefined, minWidth: 0 } : { minWidth: 0 });
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {period.defaulted && <Alert type="info" showIcon message={`Period cards show the last 12 weeks (since ${dateText(period.from)}). Live cards ignore the dates. Pick dates above for another period.`} />}
      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(12, minmax(0, 1fr))' : 'minmax(0, 1fr)', gap: 12, alignItems: 'stretch' }}>
        <div style={cell(7)}><PipelineCard filter={live} /></div>
        <div style={cell(5, 2)}><QueuesCard filter={live} /></div>
        <div style={cell(7)}><WeeksCard filter={live} /></div>
        <div style={cell(7)}><AtRiskCard filter={live} /></div>
        <div style={cell(5)}><SuppliersCard filter={period} /></div>
        <div style={cell(12)}><RfqsWaitingCard filter={live} /></div>
        <div style={cell(12)}><HeadlineCard filter={period} /></div>
        <div style={cell(6)}><FlowCard filter={period} /></div>
        <div style={cell(6)}><StabilityCard filter={period} /></div>
        <div style={cell(12)}><ChangeRequestsCard filter={period} /></div>
      </div>
    </Space>
  );
}

/* ---------- D1 · Where the quantity is ---------- */
type Unit = RouterOutputs['reports']['dashboard']['pipeline']['units'][number];
/** The five classes and colours of the Demands list progress bar (spec 21), in its order. */
const CLASSES: { key: keyof Pick<Unit, 'onPo' | 'awarded' | 'inRfq' | 'open' | 'cancelled'>; label: string; short: string; color: string; darkText?: boolean }[] = [
  { key: 'onPo', label: 'On PO (submitted or created)', short: 'On PO', color: '#237804' },
  { key: 'awarded', label: 'Awarded · handed off · PO preparation', short: 'Awarded', color: '#52c41a', darkText: true },
  { key: 'inRfq', label: 'In RFQ or quoted', short: 'In RFQ', color: '#722ed1' },
  { key: 'open', label: 'Open — nothing sourced', short: 'Open', color: '#bfbfbf', darkText: true },
  { key: 'cancelled', label: 'Cancelled', short: 'Cancelled', color: '#ff7875', darkText: true },
];

function PipelineCard({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.dashboard.pipeline.useQuery(filter, { ...LIVE, placeholderData: (p) => p });
  const [view, setView] = useState<View>('Chart');
  const d = q.data;
  return (
    <DashCard title="Where the quantity is" mode="now" audience="everyone" extra={<ViewSwitch value={view} onChange={setView} />} loading={!d && q.isPending} updating={q.isPlaceholderData} error={q.error?.message}
      note={<>Demands still in progress (accepted, not closed): {d?.demands ?? '—'} demand(s). The same five classes and colours as the progress bar on the Demands list. Quantities are never added across units.</>}>
      {d && (d.units.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No demand in progress" /> : view === 'Chart' ? (
        <>
          {d.units.map((u) => (
            <div key={u.unit} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
              <Typography.Text strong style={{ width: 44 }}>{u.unit}</Typography.Text>
              <div style={{ flex: 1 }}><StackBar parts={CLASSES.map((c) => ({ ...c, value: Number(u[c.key]) }))} /></div>
              <span style={{ flex: '0 1 160px', minWidth: 0, textAlign: 'right' }}><Small>{fmtN(u.total)} {u.unit} · {u.demands} demand(s)</Small></span>
            </div>
          ))}
          <Legend items={CLASSES.map((c) => ({ label: c.label, color: c.color }))} />
        </>
      ) : (
        <Table size="small" pagination={false} rowKey="unit" dataSource={d.units} columns={[
          { title: 'Unit', dataIndex: 'unit', width: 60 },
          ...CLASSES.map((c) => ({ title: c.short, key: c.key, align: 'right' as const, render: (_: unknown, u: Unit) => fmtN(u[c.key]) })),
          { title: 'Total in progress', key: 't', align: 'right', render: (_: unknown, u: Unit) => fmtN(u.total) }, { title: 'Demands', dataIndex: 'demands', align: 'right', width: 80 },
        ]} />
      ))}
    </DashCard>
  );
}

/* ---------- D2 · Who has the ball ---------- */
type QueueRow = RouterOutputs['reports']['dashboard']['queues']['groups'][number]['rows'][number];
/** A table line is either a group title (the owner) or one step's row. */
type QueueLine = { key: string; group: string; row?: undefined } | { key: string; group?: undefined; row: QueueRow };

function QueuesCard({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.dashboard.queues.useQuery(filter, { ...LIVE, placeholderData: (p) => p });
  const navigate = useNavigate();
  const d = q.data;
  const lines: QueueLine[] = (d?.groups ?? []).flatMap((g) => [{ key: `g:${g.title}`, group: g.title }, ...g.rows.map((r) => ({ key: `${r.itemType}|${r.label}`, row: r }))]);
  // Tasks and exceptions are scaled apart: hundreds of aging exceptions must not flatten the task bars.
  const maxOf = (category: string) => Math.max(1, ...(d?.groups ?? []).flatMap((g) => g.rows.filter((r) => r.category === category).map((r) => r.open)));
  const maxTask = maxOf('TASK'), maxException = maxOf('EXCEPTION');
  const groupCell = (r: QueueLine) => ({ colSpan: r.row ? 1 : 5 });
  const dataCell = (r: QueueLine) => ({ colSpan: r.row ? 1 : 0 });
  return (
    <DashCard title="Who has the ball" mode="now" audience="everyone · management" loading={!d && q.isPending} updating={q.isPlaceholderData} error={q.error?.message}
      note="Open work items of your companies for every owner, by step: the bottleneck at a glance. My work shows only the items waiting on you; a row opens that My work tab.">
      {d && (d.open === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing is waiting anywhere" /> : (
        <>
          <SmallPara><b>{d.open} open</b>{d.overdue > 0 && <> · <Typography.Text type="danger" strong>{d.overdue} overdue</Typography.Text></>}</SmallPara>
          <Table<QueueLine> size="small" pagination={false} rowKey="key" dataSource={lines} showHeader
            onRow={(r) => (r.row ? { onClick: () => navigate(`/work?tab=${r.row.tab}`), style: { cursor: 'pointer' } } : {})}
            columns={[
              { title: 'Step', key: 'step', onCell: groupCell, render: (_: unknown, r) => (r.row ? <a>{r.row.label}</a> : <Small>{r.group}</Small>) },
              { title: '', key: 'bar', width: '24%', onCell: dataCell, render: (_: unknown, r) => r.row ? (
                <div style={{ height: 10, background: '#fafafa', borderRadius: 3, display: 'flex', overflow: 'hidden' }}>
                  <div style={{ width: `${((r.row.open - r.row.overdue) / (r.row.category === 'EXCEPTION' ? maxException : maxTask)) * 100}%`, background: r.row.category === 'EXCEPTION' ? '#8c8c8c' : '#1f6f43' }} />
                  <div style={{ width: `${(r.row.overdue / (r.row.category === 'EXCEPTION' ? maxException : maxTask)) * 100}%`, background: '#cf1322' }} />
                </div>) : null },
              { title: 'Open', key: 'open', align: 'right', width: 60, onCell: dataCell, render: (_: unknown, r) => r.row?.open ?? null },
              { title: 'Overdue', key: 'overdue', align: 'right', width: 70, onCell: dataCell, render: (_: unknown, r) => (r.row ? (r.row.overdue ? <Typography.Text type="danger" strong>{r.row.overdue}</Typography.Text> : '—') : null) },
              { title: 'Oldest', key: 'oldest', width: 70, onCell: dataCell, render: (_: unknown, r) => (r.row ? <Small>{ageText(r.row.oldestDueAt ?? r.row.oldestCreatedAt)}</Small> : null) },
            ]} />
        </>
      ))}
    </DashCard>
  );
}

/* ---------- D3 · Shipping soon ---------- */
const WEEK_SERIES = [
  { key: 'ordered', label: 'Ordered (SAP PO created)', color: '#237804' }, { key: 'awarded', label: 'Awarded', color: '#52c41a' },
  { key: 'inRfq', label: 'In RFQ or quoted', color: '#722ed1' }, { key: 'open', label: 'Open — not sourced', color: '#bfbfbf' },
] as const;

function WeeksCard({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.dashboard.weeks.useQuery(filter, { ...LIVE, placeholderData: (p) => p });
  const [view, setView] = useState<View>('Chart');
  const d = q.data;
  const w = d?.weeks ?? [];
  return (
    <DashCard title="Shipping soon — containers per ETD week" mode="now" audience="everyone" extra={<ViewSwitch value={view} onChange={setView} />} loading={!d && q.isPending} updating={q.isPlaceholderData} error={q.error?.message}
      note={<>The next 10 ETD weeks of accepted demands. Ordered and awarded are the shipments; containers not yet awarded are split between open and in RFQ by the week's quantity shares (an estimate).
        A red week is inside the {d?.agingWeeks ?? '…'}-week window with open containers — the <i>Open quantity near ETD</i> rule.</>}>
      {d && (view === 'Chart' ? (
        <>
          <Columns title="Containers per ETD week, the next 10 weeks" desc="Stacked columns: ordered, awarded, in RFQ and open containers per week; a black tick marks the version-1 baseline; red week labels are at risk. The Table view lists the same numbers."
            categories={w.map((x) => x.week)} labels={w.map((x) => weekLabel(x.week, x.monday))} stacked baseline={w.map((x) => x.baseline)} flagged={w.map((x) => x.atRisk)}
            series={WEEK_SERIES.map((s) => ({ ...s, values: w.map((x) => x[s.key]) }))} />
          <Legend items={[...WEEK_SERIES.map((s) => ({ label: s.label, color: s.color })), { label: 'Baseline (version 1 as accepted)', color: '#1f1f1f', line: true }]} />
        </>
      ) : (
        <Table size="small" pagination={false} rowKey="week" dataSource={w} columns={[
          { title: 'ETD week', key: 'w', render: (_: unknown, x: (typeof w)[number]) => <span style={{ color: x.atRisk ? '#cf1322' : undefined, fontWeight: x.atRisk ? 600 : 400 }}>{weekLabel(x.week, x.monday)}</span> },
          { title: 'Baseline', key: 'b', align: 'right', render: (_: unknown, x: (typeof w)[number]) => x.baseline ?? '—' }, { title: 'Now', dataIndex: 'now', align: 'right' },
          { title: 'Ordered', dataIndex: 'ordered', align: 'right' }, { title: 'Awarded', dataIndex: 'awarded', align: 'right' }, { title: 'In RFQ', dataIndex: 'inRfq', align: 'right' }, { title: 'Open', dataIndex: 'open', align: 'right' },
        ]} />
      ))}
    </DashCard>
  );
}

/* ---------- D4 · Not yet sourced, shipping soon ---------- */
type RiskRow = RouterOutputs['reports']['dashboard']['atRisk']['rows'][number];

function AtRiskCard({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.dashboard.atRisk.useQuery(filter, { ...LIVE, placeholderData: (p) => p });
  const d = q.data;
  return (
    <DashCard title="Not yet sourced, shipping soon" mode="now" audience="Sales · Procurement" loading={!d && q.isPending} updating={q.isPlaceholderData} error={q.error?.message}
      note={<>Open quantity whose ETD week is within {d?.agingWeeks ?? '…'} weeks (Configuration → Workflow) — the same rule as the <i>Open quantity near ETD</i> exception on Procurement's My work. Days count to the Monday of the ETD week; a past week is negative.</>}>
      {d && (d.lines === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Everything shipping soon is in an RFQ or further" /> : (
        <>
          <SmallPara>
            <b>{d.lines} line(s) · {d.demands} demand(s)</b> · {d.totals.map((t) => `${fmtN(t.open)} ${t.unit}`).join(' · ')} open{d.rows.length < d.lines && <> · the {d.rows.length} nearest shown</>}
          </SmallPara>
          <Table<RiskRow> size="small" pagination={false} rowKey="lineId" dataSource={d.rows} columns={[
            { title: 'Demand', key: 'd', width: 120, render: (_: unknown, r) => <><Link to={`/demands/${r.demandId}`}>{r.demandNo}</Link> <Small>{r.companyCode}</Small></> },
            { title: 'Week', key: 'w', width: 110, render: (_: unknown, r) => weekLabel(r.week, r.monday) },
            { title: 'Material', dataIndex: 'label', ellipsis: true },
            { title: 'Open', key: 'o', align: 'right', width: 110, render: (_: unknown, r) => `${fmtN(r.open)} ${r.unit}` },
            { title: 'Days', key: 'days', align: 'right', width: 60, render: (_: unknown, r) => <span style={{ color: r.daysLeft <= 7 ? '#cf1322' : undefined, fontWeight: r.daysLeft <= 7 ? 600 : 400 }}>{r.daysLeft}</span> },
          ]} />
        </>
      ))}
    </DashCard>
  );
}

/* ---------- D5 · RFQs out, waiting for quotes ---------- */
type RfqRow = RouterOutputs['reports']['dashboard']['rfqsWaiting']['rows'][number];

const RFQ_ROWS = 10;

function RfqsWaitingCard({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.dashboard.rfqsWaiting.useQuery(filter, { ...LIVE, placeholderData: (p) => p });
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const d = q.data;
  return (
    <DashCard title="RFQs out, waiting for quotes" mode="now" audience="Procurement · Sales reads" loading={!d && q.isPending} updating={q.isPlaceholderData} error={q.error?.message}
      note={<>Sent RFQs where an invited supplier has not quoted yet, oldest first. The app does not e-mail suppliers, so chasing is a manual step. Red = out longer than the <i>Record quotes</i> due time (Configuration → Workflow).</>}>
      {d && (d.rows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Every sent RFQ has all its quotes" /> : (
        <>
          <SmallPara>
            <b>{d.rows.length} RFQ(s) sent · {d.waitingSuppliers} supplier(s) have not answered</b>
            {d.rows.length > RFQ_ROWS && <Button type="link" size="small" onClick={() => setAll((v) => !v)}>{all ? `Show the ${RFQ_ROWS} oldest` : `Show all ${d.rows.length}`}</Button>}
          </SmallPara>
          <Table<RfqRow> size="small" pagination={false} rowKey="rfqId" dataSource={all ? d.rows : d.rows.slice(0, RFQ_ROWS)} columns={[
            { title: 'RFQ', key: 'r', width: 110, render: (_: unknown, r) => <Link to={`/rfqs/${r.rfqId}`}>{r.rfqNo}</Link> },
            { title: 'Demand', key: 'd', width: 130, render: (_: unknown, r) => <><Link to={`/demands/${r.demandId}`}>{r.demandNo}</Link> <Small>{r.companyCode}</Small></> },
            { title: 'Sent', key: 's', render: (_: unknown, r) => <Small type="default">{dateText(r.sentAt)}{r.sentBy ? ` · ${r.sentBy}` : ''}</Small> },
            { title: 'Days out', key: 'days', align: 'right', width: 90, render: (_: unknown, r) => (r.overdue ? <Tag color="red" style={{ marginInlineEnd: 0 }}>{r.daysOut}</Tag> : r.daysOut ?? '—') },
            { title: 'Quoted', key: 'q', width: 90, render: (_: unknown, r) => `${r.quoted} of ${r.invited}` },
            { title: 'Containers · weeks', key: 'c', render: (_: unknown, r) => <Small type="default">{r.containers} · {r.weeks}</Small> },
            { title: '', key: 'go', width: 130, render: (_: unknown, r) => <Button size="small" onClick={() => navigate(`/rfqs/${r.rfqId}`)}>Record quotes</Button> },
          ]} />
        </>
      ))}
    </DashCard>
  );
}
