/** Reports → Trend (spec 28, M1): the Performance headline month by month, per unit, as lines and a table. */
import { useState } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Segmented, Space, Table, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { Legend, Lines } from '../../components/Charts';
import { downloadXlsx } from '../../lib/excel';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { aboutExport, fmtN, hrs, pct, pctN, Small, Updating, type DashFilter } from './dashboardParts';

type Month = RouterOutputs['reports']['trend']['months'][number];
/** A month clamped to the picked dates shows its days ("15–31 Jan 26"). */
const partial = (m: Month) => m.from.slice(8) !== '01' || m.to !== new Date(Date.UTC(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const monthText = (m: Month) => (partial(m) ? `${Number(m.from.slice(8))}–${Number(m.to.slice(8))} ${monthLabel(m.month)}` : monthLabel(m.month));
const monthLabel = (m: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
const days = (h: number | null) => (h == null ? null : Math.round((h / 24) * 10) / 10);
const today = () => new Date().toISOString().slice(0, 10);
const RATES = [{ key: 'executionRate', label: 'Execution rate', color: '#2a78d6' }, { key: 'notSourcedRate', label: 'Not sourced', color: '#eb6834' }, { key: 'onTimeRate', label: 'On time', color: '#1baf7a' }] as const;

export function TrendTab({ filter }: { filter: DashFilter }) {
  const q = trpc.reports.trend.useQuery(filter, { placeholderData: (p) => p });
  const d = q.data;
  const units = [...new Set((d?.months ?? []).flatMap((m) => m.units.map((u) => u.unit)))].sort();
  const [unitPick, setUnit] = useState<string>();
  const unit = unitPick && units.includes(unitPick) ? unitPick : units[0];
  if (q.error) return <Alert type="error" showIcon message={q.error.message} />;
  if (!d) {
    return (
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert type="info" showIcon message="The Performance headline per month of acceptance (the last 12 months when no dates are picked; at most the latest 24)." />
        <Card loading />
      </Space>
    );
  }
  const months = d.months;
  const of = (m: Month) => m.units.find((u) => u.unit === unit);
  const cats = months.map(monthText);
  const NUMERIC = ['Accepted demands', 'Committed', 'Executed', 'Outstanding', 'Execution %', 'Execution n (demands)', 'Not sourced %', 'On time n (demands)', 'Accepted → PO created (days)', 'Accept → RFQ (h)', 'RFQ → quote (h)', 'Quote → award (h)', 'Award → handoff (h)', 'Handoff → PO created (h)', 'Handoffs', 'Handoff return %', 'PO drafts submitted', 'SAP first-reply %'];
  const exportXlsx = () => downloadXlsx(`kpi-trend-${today()}`, units.map((u) => ({ name: `Unit ${u}`, numeric: [...NUMERIC, `On time % (≥ ${d.onTimeDays} days before ETD)`], header: ['Month', 'From', 'To', 'Accepted demands', 'Committed', 'Executed', 'Outstanding', 'Execution %', 'Execution n (demands)', 'Not sourced %', `On time % (≥ ${d.onTimeDays} days before ETD)`, 'On time n (demands)', 'Accepted → PO created (days)', 'Accept → RFQ (h)', 'RFQ → quote (h)', 'Quote → award (h)', 'Award → handoff (h)', 'Handoff → PO created (h)', 'Handoffs', 'Handoff return %', 'PO drafts submitted', 'SAP first-reply %'],
    rows: months.map((m) => { const x = m.units.find((v) => v.unit === u); return [m.month, m.from, m.to, m.accepted, x?.committed ?? '', x?.executed ?? '', x?.outstanding ?? '', x?.executionRate ?? 'N/A', x?.executionN ?? 0, x?.notSourcedRate ?? 'N/A', x?.onTimeRate ?? 'N/A', x?.onTimeN ?? 0, days(x?.endToEndHours ?? null) ?? 'N/A', ...(['Accept → RFQ', 'RFQ → quote', 'Quote → award', 'Award → handoff', 'Handoff → PO created'].map((s) => x?.stages.find((st) => st.label === s)?.hours ?? 'N/A')), m.handoffs.handoffs, m.handoffs.returnRate ?? 'N/A', m.sap.submitted, m.sap.firstReplyRate ?? 'N/A']; }) })),
    aboutExport('KPI trend (per month of acceptance)', { ...filter, from: months[0]?.from, to: months[months.length - 1]?.to }, [
      'One sheet per unit. A month covers the demands accepted in it; the first and last month are cut to the picked dates.',
      ...(d.truncated ? ['The period was longer than 24 months: only the latest 24 months are included.'] : []),
    ]));
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert type="info" showIcon message={<>The Performance headline per <b>month of acceptance</b>{months.length ? <>: {monthLabel(months[0].month)} – {monthLabel(months[months.length - 1].month)}</> : ''} (the last 12 months when no dates are picked; at most the latest 24; the first and last month are cut to the picked dates). A month's rates cover the demands accepted in it, however far they have come since — recent months are naturally lower. Rates are quantity-weighted per unit and never combined across units.</>} />
      {d.truncated && <Alert type="warning" showIcon message={`The period is longer than 24 months: showing the last 24 months (${monthText(months[0])} – ${monthText(months[months.length - 1])}).`} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {units.length > 1 && <Segmented size="small" value={unit} onChange={(v) => setUnit(String(v))} options={units} />}
        {units.length === 1 && <Typography.Text strong>Unit {unit}</Typography.Text>}
        <Updating show={q.isPlaceholderData} />
        <div style={{ flex: 1 }} />
        <Button icon={<DownloadOutlined />} disabled={!months.length} onClick={() => void exportXlsx()}>Export to Excel</Button>
      </div>
      {!units.length ? <Empty description="No accepted demands in this period" /> : (
        <>
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={14}>
              <Card size="small" title={`Rates · unit ${unit}`}>
                <Lines title={`Execution, not-sourced and on-time rates per month, unit ${unit}`} desc="Three lines in percent per month of acceptance; a gap means nothing to measure. The table below lists the same numbers."
                  categories={cats} yMax={100} suffix="%" series={RATES.map((r) => ({ key: r.key, label: r.label, color: r.color, values: months.map((m) => of(m)?.[r.key] ?? null) }))} />
                <Legend items={RATES.map((r) => ({ label: r.label, color: r.color }))} />
              </Card>
            </Col>
            <Col xs={24} xl={10}>
              <Card size="small" title={`Accepted → PO created, days · unit ${unit}`}>
                <Lines title={`Days from acceptance to PO created per month, unit ${unit}`} desc="One line, quantity-weighted days per month of acceptance; the table below lists the same numbers."
                  categories={cats} series={[{ key: 'e2e', label: 'Accepted → PO created (days)', color: '#1f6f43', values: months.map((m) => days(of(m)?.endToEndHours ?? null)) }]} />
                <Small>Quantity-weighted, PO-created quantity only; a gap means nothing of that month reached a PO yet.</Small>
              </Card>
            </Col>
          </Row>
          {/* Widths are shares (percent) so the table always fits the card, never scrolls sideways. */}
          <Table size="small" pagination={false} rowKey="month" dataSource={months} tableLayout="fixed" columns={[
            { title: 'Month', key: 'm', width: '6%', render: (_: unknown, m: Month) => monthText(m) },
            { title: 'Accepted', dataIndex: 'accepted', align: 'right', width: '6%' },
            { title: 'Committed', key: 'c', align: 'right', width: '8%', render: (_: unknown, m: Month) => fmtN(of(m)?.committed) },
            { title: 'Executed', key: 'e', align: 'right', width: '8%', render: (_: unknown, m: Month) => fmtN(of(m)?.executed) },
            { title: 'Execution', key: 'er', align: 'right', width: '7%', render: (_: unknown, m: Month) => pctN(of(m)?.executionRate, of(m)?.executionN) },
            { title: 'Not sourced', key: 'ns', align: 'right', width: '6%', render: (_: unknown, m: Month) => pct(of(m)?.notSourcedRate) },
            { title: 'On time', key: 'ot', align: 'right', width: '7%', render: (_: unknown, m: Month) => pctN(of(m)?.onTimeRate, of(m)?.onTimeN) },
            { title: 'Accepted → PO', key: 'e2e', align: 'right', width: '7%', render: (_: unknown, m: Month) => hrs(of(m)?.endToEndHours) },
            ...(['Accept → RFQ', 'RFQ → quote', 'Quote → award', 'Award → handoff', 'Handoff → PO'].map((s, i) => ({ title: s, key: s, align: 'right' as const, width: '6%', render: (_: unknown, m: Month) => hrs(of(m)?.stages[i]?.hours) }))),
            { title: 'Handoffs returned', key: 'hr', align: 'right', width: '7%', render: (_: unknown, m: Month) => (m.handoffs.handoffs ? <>{pct(m.handoffs.returnRate)} <Small>of {m.handoffs.handoffs}</Small></> : '—') },
            { title: 'SAP first reply', key: 'sap', align: 'right', width: '7%', render: (_: unknown, m: Month) => (m.sap.submitted ? <>{pct(m.sap.firstReplyRate)} <Small>of {m.sap.submitted}</Small></> : '—') },
          ]} />
        </>
      )}
    </Space>
  );
}
