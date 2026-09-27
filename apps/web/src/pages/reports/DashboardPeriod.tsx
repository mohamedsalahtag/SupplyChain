/** Reports → Dashboard (spec 26): the period cards D8, D10, D11, D12, D14. They follow the From – To dates (the last 12 weeks when empty). */
import { useState } from 'react';
import { Empty, Table, Tag, Typography } from 'antd';
import { Columns, HBars, Legend } from '../../components/Charts';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { ageText, DashCard, fmtN, hrs, pct, pctN, Small, SmallPara, Tile, Tiles, ViewSwitch, type DashFilter, type View } from './dashboardParts';

/* ---------- D8 · Headline KPIs per unit (the Performance tab's headline) ---------- */
export function HeadlineCard({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.performance.useQuery(filter, { placeholderData: (p) => p });
  const p = q.data;
  return (
    <DashCard title="Headline KPIs, per unit" mode="period" audience="everyone · management" loading={!p && q.isPending} updating={q.isPlaceholderData} error={q.error?.message}
      note={<>The same numbers the Performance tab leads with, for demands accepted in the period. Rates are quantity-weighted and never combined across units; N/A when there is nothing to divide by.</>}>
      {p && (p.headline.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No accepted demands in this period" /> : p.headline.map((u) => (
        <div key={u.unit} style={{ display: 'flex', gap: 10, alignItems: 'stretch', margin: '4px 0' }}>
          <Typography.Text strong style={{ width: 44, paddingTop: 8 }}>{u.unit}</Typography.Text>
          <Tiles>
            <Tile label="Committed" value={fmtN(u.committed)} sub="asked and not cancelled" />
            <Tile label="Executed" value={fmtN(u.executed)} sub="SAP PO created" />
            <Tile label="Outstanding" value={fmtN(u.outstanding)} sub="still in progress" />
            <Tile label="Execution rate" value={pctN(u.executionRate, u.executionN)} sub="executed ÷ committed" tone={u.executionRate == null ? 'dim' : u.executionRate >= 75 ? 'ok' : 'warn'} />
            <Tile label="Not sourced" value={pct(u.notSourcedRate)} sub="cancelled by Procurement" tone={u.notSourcedRate == null ? 'dim' : u.notSourcedRate > 5 ? 'warn' : undefined} />
            <Tile label="On time" value={pctN(u.onTimeRate, u.onTimeN)} sub={`PO ≥ ${p.onTimeDays} days before ETD`} tone={u.onTimeRate == null ? 'dim' : u.onTimeRate >= 85 ? 'ok' : 'warn'} />
            <Tile label="Accepted → PO created" value={hrs(u.endToEndHours)} sub={`quantity-weighted · n=${u.endToEndN}`} />
          </Tiles>
        </div>
      )))}
    </DashCard>
  );
}

/* ---------- D10 · Flow in and out ---------- */
export function FlowCard({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.dashboard.flow.useQuery(filter, { placeholderData: (p) => p });
  const [view, setView] = useState<View>('Chart');
  const d = q.data;
  const w = d?.weeks ?? [];
  return (
    <DashCard title="Flow in and out" mode="period" audience="everyone · management" extra={<ViewSwitch value={view} onChange={setView} />} loading={!d && q.isPending} updating={q.isPlaceholderData} error={q.error?.message}
      note="Containers accepted into the pipeline (as accepted: the version-1 baseline, so later changes do not rewrite past weeks) vs containers ordered (SAP PO created), per ISO week. When accepted outruns ordered for weeks, the backlog grows. Containers are the one measure that adds up across units.">
      {d && (
        <>
          <SmallPara>Backlog now: <b>{fmtN(d.backlog)} container(s)</b> accepted and not yet ordered (all demands in progress).</SmallPara>
          {view === 'Chart' ? (
            <>
              <Columns title="Containers accepted and ordered per ISO week" desc="Side-by-side columns per week: containers as accepted (version-1 baseline) and containers ordered (SAP PO created). The Table view lists the same numbers."
                categories={w.map((x) => x.week)} labels={w.map((x) => x.week.slice(5))} stacked={false} height={200}
                series={[{ key: 'accepted', label: 'Accepted (as accepted)', color: '#2a78d6', values: w.map((x) => x.accepted) }, { key: 'ordered', label: 'Ordered (PO created)', color: '#eb6834', values: w.map((x) => x.ordered) }]} />
              <Legend items={[{ label: 'Accepted (version 1 as accepted)', color: '#2a78d6' }, { label: 'Ordered (PO created)', color: '#eb6834' }]} />
            </>
          ) : (
            <Table size="small" pagination={false} rowKey="week" dataSource={w} columns={[
              { title: 'Week', dataIndex: 'week' }, { title: 'Accepted', dataIndex: 'accepted', align: 'right' }, { title: 'Ordered (PO created)', dataIndex: 'ordered', align: 'right' },
              { title: 'Difference', key: 'd', align: 'right', render: (_: unknown, x: (typeof w)[number]) => (x.accepted - x.ordered > 0 ? '+' : '') + (x.accepted - x.ordered) },
            ]} />
          )}
        </>
      )}
    </DashCard>
  );
}

/* ---------- D11 · Change requests ---------- */
type Reason = RouterOutputs['reports']['dashboard']['changeRequests']['reasons'][number];

export function ChangeRequestsCard({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.dashboard.changeRequests.useQuery(filter, { placeholderData: (p) => p });
  const d = q.data;
  const reasons = (dept: string) => (d?.reasons ?? []).filter((r) => r.raisedBy === dept);
  const bars = (rows: Reason[]) => rows.map((r) => ({ key: r.code, label: `${r.description}${r.countsAgainstProcurement ? ' ⚑' : ''}`, value: r.count, color: r.countsAgainstProcurement ? '#cf1322' : undefined }));
  const max = Math.max(1, ...(d?.reasons ?? []).map((r) => r.count));
  const wait = (by: string) => d?.waiting.find((w) => w.decidedBy === by);
  const dec = (by: string) => d?.decided.find((x) => x.decidedBy === by);
  return (
    <DashCard title="Change requests" mode="period" audience="Sales · Procurement · management" loading={!d && q.isPending} updating={q.isPlaceholderData} error={q.error?.message}
      note={<>Waiting and blocked counts are live; decisions and reasons follow the period (by the date the request was submitted; withdrawn ones left out). <Tag color="red" bordered={false} style={{ marginInlineEnd: 0 }}>⚑ counts against Procurement</Tag> marks the reasons behind the not-sourced rate.</>}>
      {d && (
        <>
          <Tiles>
            <Tile label="Waiting for Sales to decide" value={wait('Sales')?.count ?? 0} sub={`raised by Procurement${wait('Sales')?.oldestAt ? ` · oldest ${ageText(wait('Sales')?.oldestAt)}` : ''}`} tone={(wait('Sales')?.count ?? 0) > 0 ? 'warn' : undefined} />
            <Tile label="Waiting for Procurement to decide" value={wait('Procurement')?.count ?? 0} sub={`raised by Sales${wait('Procurement')?.oldestAt ? ` · oldest ${ageText(wait('Procurement')?.oldestAt)}` : ''}`} tone={(wait('Procurement')?.count ?? 0) > 0 ? 'warn' : undefined} />
            <Tile label="Decided in the period" value={(dec('Sales')?.count ?? 0) + (dec('Procurement')?.count ?? 0)} sub={`Sales answers in ${hrs(dec('Sales')?.avgHours)} · Procurement in ${hrs(dec('Procurement')?.avgHours)}`} />
            <Tile label="Blocked at pre-check" value={d.blocked} sub="quantity already too far along" tone={d.blocked > 0 ? 'bad' : undefined} />
          </Tiles>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 10 }}>
            <div>
              <SmallPara style={{ margin: '0 0 4px' }}><b>Why Sales changes demands</b> · {reasons('Sales').reduce((s, r) => s + r.count, 0)} request(s)</SmallPara>
              {reasons('Sales').length ? <HBars label="Why Sales changes demands" rows={bars(reasons('Sales'))} max={max} /> : <Small>None in the period</Small>}
            </div>
            <div>
              <SmallPara style={{ margin: '0 0 4px' }}><b>Why Procurement asks for changes</b> · {reasons('Procurement').reduce((s, r) => s + r.count, 0)} request(s)</SmallPara>
              {reasons('Procurement').length ? <HBars label="Why Procurement asks for changes" rows={bars(reasons('Procurement'))} max={max} /> : <Small>None in the period</Small>}
            </div>
          </div>
        </>
      )}
    </DashCard>
  );
}
/* ---------- D12 · Demand stability ---------- */
type StabilityUnit = RouterOutputs['reports']['dashboard']['stability']['units'][number];

export function StabilityCard({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.dashboard.stability.useQuery(filter, { placeholderData: (p) => p });
  const d = q.data;
  return (
    <DashCard title="Demand stability" mode="period" audience="management" loading={!d && q.isPending} updating={q.isPlaceholderData} error={q.error?.message}
      note="For demands accepted in the period: how many changed afterwards (an applied change request, a merge or an addition), and how the quantity moved — per unit, never combined.">
      {d && (d.accepted === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No accepted demands in this period" /> : (
        <>
          <Tiles>
            <Tile label="Accepted demands" value={d.accepted} />
            <Tile label="Changed after acceptance" value={pct(d.changedRate)} sub={`${d.changed} demand(s)`} tone={(d.changedRate ?? 0) > 30 ? 'warn' : undefined} />
            <Tile label="Merges" value={d.merges} sub="weeks merged into other demands" />
          </Tiles>
          <Table<StabilityUnit> size="small" pagination={false} rowKey="unit" style={{ marginTop: 10 }} dataSource={d.units} columns={[
            { title: 'Unit', dataIndex: 'unit', width: 60 },
            { title: 'Committed', key: 'c', align: 'right', render: (_: unknown, u) => fmtN(u.committed) },
            { title: 'Cancelled by Sales or a change', key: 's', align: 'right', render: (_: unknown, u) => <>{fmtN(u.salesCancelled)} <Small>({pct(u.salesCancelledRate)})</Small></> },
            { title: 'Not sourced', key: 'n', align: 'right', render: (_: unknown, u) => fmtN(u.notSourced) },
            { title: 'Added by Procurement', key: 'p', align: 'right', render: (_: unknown, u) => fmtN(u.procAdded) },
            { title: 'Merged in', key: 'mi', align: 'right', render: (_: unknown, u) => fmtN(u.mergedIn) },
          ]} />
        </>
      ))}
    </DashCard>
  );
}

/* ---------- D14 · Top suppliers ---------- */
type SupplierRow = RouterOutputs['reports']['dashboard']['suppliers']['rows'][number];

export function SuppliersCard({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.dashboard.suppliers.useQuery(filter, { placeholderData: (p) => p });
  const [view, setView] = useState<View>('Chart');
  const d = q.data;
  return (
    <DashCard title="Top suppliers" mode="period" audience="Procurement · management" extra={<ViewSwitch value={view} onChange={setView} />} loading={!d && q.isPending} updating={q.isPlaceholderData} error={q.error?.message}
      note="Containers awarded in the period (active shipments of award batches created in it), the share of each supplier, and handoffs the PO team returned for that supplier.">
      {d && (d.total === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No containers awarded in this period" /> : (
        <>
          <SmallPara><b>{fmtN(d.total)} container(s) · {d.suppliers} supplier(s)</b>{d.rows[0] && <> · top supplier {pct(d.rows[0].share)}</>}</SmallPara>
          {view === 'Chart' ? (
            <HBars label="Top suppliers by containers awarded" rows={d.rows.map((r) => ({ key: r.supplierCode || 'other', label: r.country ? `${r.name} · ${r.country}` : r.name, value: r.containers, color: r.supplierCode ? undefined : '#8c8c8c',
              text: `${r.containers} · ${r.share ?? 0}%${r.returned ? ` · ${r.returned} returned` : ''}` }))} />
          ) : (
            <Table<SupplierRow> size="small" pagination={false} rowKey={(r) => r.supplierCode || 'other'} dataSource={d.rows} columns={[
              { title: 'Supplier', key: 's', render: (_: unknown, r) => r.supplierCode ? <>{r.name} <Small>{r.supplierCode}</Small></> : r.name },
              { title: 'Country', dataIndex: 'country', width: 80 }, { title: 'Containers', dataIndex: 'containers', align: 'right', width: 100 },
              { title: 'Share', key: 'sh', align: 'right', width: 80, render: (_: unknown, r) => pct(r.share) }, { title: 'Handoffs returned', dataIndex: 'returned', align: 'right', width: 130 },
            ]} />
          )}
        </>
      ))}
    </DashCard>
  );
}
