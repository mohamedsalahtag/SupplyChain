/** Reports → Arrivals (spec 28, S1): what is coming — one row per awarded material with its shipment, progress and SAP PO. */
import { Alert, Button, Tag, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { downloadXlsx } from '../../lib/excel';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { aboutExport, fmtN, Updating, useFilterPage, weekLabel, type DashFilter } from './dashboardParts';

type Filter = DashFilter & { q?: string };
type Row = RouterOutputs['reports']['arrivals']['rows'][number];
const STATUS_COLOR: Record<string, string> = { 'PO created': 'green', 'Sent to SAP': 'purple', 'PO being prepared': 'geekblue', 'Handed off': 'blue', Awarded: 'gold' };
const today = () => new Date().toISOString().slice(0, 10);

export function ArrivalsTab({ filter }: { filter: Filter }) {
  const q = trpc.reports.arrivals.useQuery(filter, { placeholderData: (p) => p });
  const prefs = useTablePrefs('report-arrivals', ['country', 'abNo', 'skus', 'value', 'poDraft']);
  const [page, setPage] = useFilterPage(filter);
  const d = q.data;
  const rows = d?.rows ?? [];
  const exportXlsx = () => downloadXlsx(`arrivals-${today()}`, [{ name: 'Arrivals', numeric: ['Quantity', 'Price', 'Value', 'Containers (shipment)'], header: ['ETD week', 'Monday', 'Confirmed ETD', 'Company', 'Demand', 'Award', 'Supplier', 'Supplier code', 'Country', 'Material', 'SKU', 'Quantity', 'Unit', 'Price', 'Currency', 'Value', 'Containers (shipment)', 'Status', 'Handoff', 'PO draft', 'SAP PO'],
    rows: rows.map((r) => [r.week, r.monday, r.confirmedEtd ?? '', r.companyCode, r.demandNo, r.abNo, r.supplierName, r.supplierCode, r.country, r.material, r.skus, r.qty, r.unit, r.unitPrice, r.currency, r.value, r.containers ?? '', r.status, r.hoNo ?? '', r.poDraftNo ?? '', r.sapPoNumber ?? '']) }],
    aboutExport('Arrivals schedule', filter, [`ETD weeks ${d?.fromWeek ?? ''}${d?.toWeek ? ` to ${d.toWeek}` : ' onward'}.`, 'Containers are per shipment (supplier × week) and repeat on each of its materials: do not add them down the column.', 'Value is per currency, never added across currencies.']));
  const columns: AppColumn<Row>[] = [
    { title: 'ETD week', key: 'week', width: 95, render: (_: unknown, r) => weekLabel(r.week, r.monday) },
    { title: 'Confirmed ETD', key: 'etd', width: 90, render: (_: unknown, r) => r.confirmedEtd ?? <Typography.Text type="secondary">—</Typography.Text> },
    { title: 'Company', key: 'co', dataIndex: 'companyCode', width: 60 },
    { title: 'Demand', key: 'demand', width: 85, render: (_: unknown, r) => <Link to={`/demands/${r.demandId}`}>{r.demandNo}</Link> },
    { title: 'Award', key: 'abNo', width: 85, render: (_: unknown, r) => <Link to={`/awards/${r.awardBatchId}`}>{r.abNo}</Link> },
    { title: 'Supplier', key: 'supplier', width: 150, render: (_: unknown, r) => r.supplierName },
    { title: 'Country', key: 'country', dataIndex: 'country', width: 55 },
    { title: 'Material', key: 'material', dataIndex: 'material', width: 200 },
    { title: 'SKU', key: 'skus', dataIndex: 'skus', width: 130 },
    { title: 'Quantity', key: 'qty', width: 90, align: 'right', render: (_: unknown, r) => `${fmtN(r.qty)} ${r.unit}` },
    { title: 'Price', key: 'price', width: 85, align: 'right', render: (_: unknown, r) => `${r.unitPrice.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${r.currency}` },
    { title: 'Value', key: 'value', width: 95, align: 'right', render: (_: unknown, r) => `${r.value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${r.currency}` },
    { title: 'Containers', key: 'containers', width: 75, align: 'right', render: (_: unknown, r) => r.containers ?? '—' },
    { title: 'Status', key: 'status', width: 120, render: (_: unknown, r) => <Tag color={STATUS_COLOR[r.status] ?? 'default'} style={{ marginInlineEnd: 0 }}>{r.status}</Tag> },
    { title: 'Handoff', key: 'handoff', width: 85, render: (_: unknown, r) => (r.handoffId ? <Link to={`/handoffs/${r.handoffId}`}>{r.hoNo}</Link> : '—') },
    { title: 'PO draft', key: 'poDraft', width: 90, render: (_: unknown, r) => (r.poDraftId ? <Link to={`/po-drafts/${r.poDraftId}`}>{r.poDraftNo}</Link> : '—') },
    { title: 'SAP PO', key: 'sapPo', width: 90, render: (_: unknown, r) => r.sapPoNumber ?? '—' },
  ];
  return (
    <>
      {q.error && <Alert type="error" showIcon message={q.error.message} />}
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message={d ? <>Shipments from week <b>{d.fromWeek}</b>{d.toWeek ? <> to <b>{d.toWeek}</b></> : ' onward'} — {d.totals.shipments} shipment(s) · {fmtN(d.totals.containers)} container(s) · {d.totals.units.map((u) => `${fmtN(u.qty)} ${u.unit}`).join(' · ') || 'no quantity'} · {d.totals.values.map((v) => `${v.value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${v.currency}`).join(' · ') || 'no value'}. The dates above filter on the ETD week; containers are per shipment (supplier × week) and repeat on each of its materials.</> : 'Loading…'} action={<Updating show={q.isPlaceholderData} />} />
      <AppTable<Row> prefs={prefs} itemName="awarded materials" rowKey="awardItemId" columns={columns} loading={!prefs.ready || q.isFetching}
        dataSource={rows.slice((page - 1) * prefs.pageSize, page * prefs.pageSize)} page={page} total={rows.length} onPageChange={setPage}
        toolbar={<Button icon={<DownloadOutlined />} disabled={!rows.length} onClick={() => void exportXlsx()}>Export to Excel</Button>} />
    </>
  );
}
