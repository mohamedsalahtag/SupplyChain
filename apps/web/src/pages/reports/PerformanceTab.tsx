/** Reports → Performance (spec 24): the headline per unit with its stage times, and the CR / acknowledgement / handoff / SAP diagnostics. The search narrows every section to matching demand numbers. */
import { Alert, Button, Card, Col, Empty, Row, Space, Statistic, Table, Tooltip, Typography } from 'antd';
import { DownloadOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { downloadXlsx } from '../../lib/excel';
import { trpc } from '../../lib/trpc';
import { n } from '../rfq/rfqLabels';
import { aboutExport, hrs, pct, pctN, Small, Updating, type DashFilter } from './dashboardParts';

type Filter = DashFilter & { q?: string };
const today = () => new Date().toISOString().slice(0, 10);
/** Without dates the performance report covers the last 3 months: over years of history it is the heaviest query (database review 2026-09). */
const lastQuarter = () => new Date(Date.now() - 91 * 86_400_000).toISOString().slice(0, 10);
const nText = (count: number) => <Small>(n={count})</Small>;

export function PerformanceTab({ filter }: { filter: Filter }) {
  const defaulted = !filter.from && !filter.to;
  const input = defaulted ? { ...filter, from: lastQuarter() } : filter;
  const q = trpc.reports.performance.useQuery(input, { placeholderData: (p) => p });
  const p = q.data;
  if (q.error) return <Alert type="error" showIcon message={q.error.message} />;
  if (!p) return <Card loading />;
  const exportXlsx = () => downloadXlsx(`performance-${today()}`, [
    { name: 'Headline', numeric: ['Committed', 'Executed', 'Outstanding', 'Execution %', 'Execution n (demands)', 'Not sourced %', `On time % (≥ ${p.onTimeDays} days before ETD)`, 'On time n (demands)', 'Accepted → PO created (h)', 'Accepted → PO n (demands)', 'Procurement added', 'Procurement ordered'],
      header: ['Unit', 'Committed', 'Executed', 'Outstanding', 'Execution %', 'Execution n (demands)', 'Not sourced %', `On time % (≥ ${p.onTimeDays} days before ETD)`, 'On time n (demands)', 'Accepted → PO created (h)', 'Accepted → PO n (demands)', 'Procurement added', 'Procurement ordered'],
      rows: p.headline.map((u) => [u.unit, u.committed, u.executed, u.outstanding, u.executionRate ?? 'N/A', u.executionN, u.notSourcedRate ?? 'N/A', u.onTimeRate ?? 'N/A', u.onTimeN, u.endToEndHours ?? 'N/A', u.endToEndN, u.procApproved, u.procOrdered]) },
    { name: 'Stage times', numeric: ['Hours (quantity-weighted)', 'n (demands)'], header: ['Unit', 'Stage', 'Hours (quantity-weighted)', 'n (demands)'], rows: p.headline.flatMap((u) => u.stages.map((st) => [u.unit, st.label, st.hours ?? 'N/A', st.n])) },
    { name: 'Other KPIs', numeric: ['Value'], header: ['Area', 'Measure', 'Value'], rows: [
      ...p.crResponse.map((c) => ['Change requests', `Decided by ${c.decidedBy} · average hours (of ${c.decided})`, c.avgHours ?? 'N/A']),
      ['Acknowledgement', 'Award batches', p.acknowledgement.batches], ['Acknowledgement', 'Average hours to acknowledge', p.acknowledgement.avgHoursToAck ?? 'N/A'],
      ['Acknowledgement', 'Resets by award changes', p.acknowledgement.resets], ['Acknowledgement', 'Handed off without it', p.acknowledgement.handedOffWithoutAck],
      ['Handoffs', 'Handoffs', p.handoffs.handoffs], ['Handoffs', 'Returned by the PO team', p.handoffs.returnedByPoTeam], ['Handoffs', 'Return rate %', p.handoffs.returnRate ?? 'N/A'],
      ['Handoffs', 'Returned automatically', p.handoffs.returnedAutomatically], ['Handoffs', 'SKU issues', p.handoffs.skuIssues], ['Handoffs', 'Sent without acknowledgement', p.handoffs.sentWithoutAck],
      ['SAP', 'Submitted', p.sap.submitted], ['SAP', 'Created on the first reply', p.sap.createdFirstReply], ['SAP', 'First-reply rate %', p.sap.firstReplyRate ?? 'N/A'],
      ['SAP', 'Created after a lookup', p.sap.createdAfterReconcile], ['SAP', 'Resolved by hand', p.sap.manualResolutions], ['SAP', 'Rejected', p.sap.rejected], ['SAP', 'Unknown now', p.sap.unknownNow],
    ] },
  ], aboutExport('Performance', input, ['Headline and stage times cover demands accepted in the period (PO-created quantity for times and on time). n = number of demands measured.']));
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {defaulted && <Alert type="info" showIcon message={`Last 3 months (demands accepted since ${lastQuarter()}). Pick dates above for another period.`} />}
      {filter.q && <Alert type="info" showIcon message={<>Every section below is narrowed to demand numbers containing <b>{filter.q}</b>.</>} />}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
        <Updating show={q.isPlaceholderData} />
        <Button icon={<DownloadOutlined />} disabled={!p.headline.length} onClick={() => void exportXlsx()}>Export to Excel</Button>
      </div>
      {p.headline.length === 0 && <Empty description="No accepted demands in this period" />}
      {p.headline.map((u) => (
        <Card key={u.unit} size="small" title={<>Unit {u.unit} <Small>— rates are quantity-weighted; not combined with other units; n = demands measured</Small></>}>
          <Row gutter={[16, 8]}>
            <Col xs={12} md={4}><Statistic title="Committed" value={n(u.committed)} /></Col>
            <Col xs={12} md={4}><Statistic title="Executed (PO created)" value={n(u.executed)} /></Col>
            <Col xs={12} md={4}><Statistic title="Execution rate" valueRender={() => pctN(u.executionRate, u.executionN)} /></Col>
            <Col xs={12} md={4}><Statistic title="Not sourced" valueRender={() => pctN(u.notSourcedRate, u.executionN)} /></Col>
            <Col xs={12} md={4}><Statistic title={<>On time <Tooltip title={`PO created at least ${p.onTimeDays} days before the confirmed ETD (setting under Configuration → Workflow)`}><InfoCircleOutlined /></Tooltip></>} valueRender={() => pctN(u.onTimeRate, u.onTimeN)} /></Col>
            <Col xs={12} md={4}><Statistic title="Accepted → PO created" valueRender={() => <>{hrs(u.endToEndHours)} {u.endToEndHours != null && nText(u.endToEndN)}</>} /></Col>
          </Row>
          <Table size="small" style={{ marginTop: 8 }} pagination={false} rowKey="label" dataSource={u.stages} columns={[
            { title: 'Stage (average, weighted by quantity; PO-created quantity only)', dataIndex: 'label' },
            { title: 'Time', key: 'hours', align: 'right', render: (_: unknown, st: (typeof u.stages)[number]) => <>{hrs(st.hours)} {st.hours != null && nText(st.n)}</> },
          ]} />
          {Number(u.procApproved) > 0 && <Small>Procurement added {n(u.procApproved)} {u.unit}, ordered {n(u.procOrdered)} — outside the execution rate.</Small>}
        </Card>
      ))}
      <Row gutter={12}>
        <Col xs={24} md={12} xl={6}><Card size="small" title="Change requests — response">
          {p.crResponse.length ? p.crResponse.map((c) => <div key={c.decidedBy}>{c.decidedBy} decided {c.decided}, average {hrs(c.avgHours)}</div>) : <Typography.Text type="secondary">None decided</Typography.Text>}
        </Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="Sales acknowledgement">
          <div>{p.acknowledgement.batches} award batch(es), average {hrs(p.acknowledgement.avgHoursToAck)} to answer</div>
          <div>{p.acknowledgement.resets} reset(s) by award changes · {p.acknowledgement.handedOffWithoutAck} handed off without it</div>
        </Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="Handoffs">
          <div>{p.handoffs.handoffs} handoff(s), {p.handoffs.sentWithoutAck} without acknowledgement</div>
          <div>Returned by the PO team {p.handoffs.returnedByPoTeam} ({pct(p.handoffs.returnRate)}) · automatically {p.handoffs.returnedAutomatically} · SKU issues {p.handoffs.skuIssues}</div>
        </Card></Col>
        <Col xs={24} md={12} xl={6}><Card size="small" title="SAP">
          <div>{p.sap.submitted} submitted · created on the first reply {p.sap.createdFirstReply} ({pct(p.sap.firstReplyRate)})</div>
          <div>after a lookup {p.sap.createdAfterReconcile} · resolved by hand {p.sap.manualResolutions} · rejected {p.sap.rejected} · unknown now {p.sap.unknownNow}</div>
        </Card></Col>
      </Row>
    </Space>
  );
}
