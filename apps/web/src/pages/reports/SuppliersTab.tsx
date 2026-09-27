/** Reports → Suppliers (spec 28, P1): the supplier scorecard — invitations, quotes, price position, awards, changes, handoffs and POs per supplier. */
import { useState } from 'react';
import { Alert, Button, Drawer, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { AppTable, type AppColumn } from '../../components/AppTable';
import { downloadXlsx } from '../../lib/excel';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { useTablePrefs } from '../../lib/useTablePrefs';
import { aboutExport, dateText, fmtN, hrs, pct, Small, Updating, useFilterPage, type DashFilter } from './dashboardParts';

type Filter = DashFilter & { q?: string };
type Row = RouterOutputs['reports']['suppliers']['rows'][number];
const today = () => new Date().toISOString().slice(0, 10);
const moneyText = (values: { currency: string; value: number }[]) => values.map((v) => `${v.value.toLocaleString('en-GB', { maximumFractionDigits: 0 })} ${v.currency}`).join(' · ') || '—';

export function SuppliersTab({ filter }: { filter: Filter }) {
  const q = trpc.reports.suppliers.useQuery(filter, { placeholderData: (p) => p });
  const prefs = useTablePrefs('report-suppliers', ['country', 'quotes', 'outside', 'unawarded', 'skuCorrections', 'lastAward']);
  const [page, setPage] = useFilterPage(filter);
  const [open, setOpen] = useState<Row>();
  const d = q.data;
  const rows = d?.rows ?? [];
  const exportXlsx = () => downloadXlsx(`supplier-scorecard-${today()}`, [{ name: 'Suppliers', numeric: ['Invited', 'Quoted', 'Quote rate %', 'Quotes recorded', 'First contact invites', 'Hours to first quote recorded', 'Compared rows', 'Cheapest', 'Cheapest %', 'Award batches', 'Containers', 'Above offer', 'Un-awarded containers', 'SKU corrections', 'Handoffs', 'Returned', 'Return rate %', 'SKU issues', 'POs created'],
    header: ['Supplier', 'Code', 'Country', 'Blocked in SAP', 'Invited', 'Quoted', 'Quote rate %', 'Quotes recorded', 'First contact invites', 'Hours to first quote recorded', 'Compared rows', 'Cheapest', 'Cheapest %', 'Award batches', 'Containers', 'Value', 'Above offer', 'Un-awarded containers', 'SKU corrections', 'Handoffs', 'Returned', 'Return rate %', 'SKU issues', 'POs created', 'Last award'],
    rows: rows.map((r) => [r.name, r.supplierCode, r.country, r.blocked ? 'yes' : '', r.invited, r.quoted, r.quoteRate ?? 'N/A', r.quotes, r.outsideShortlist, r.avgResponseHours ?? 'N/A', r.compared, r.cheapest, r.cheapestRate ?? 'N/A', r.batches, r.containers, moneyText(r.values), r.aboveOffer, r.unawarded, r.skuCorrections, r.handoffs, r.returned, r.returnRate ?? 'N/A', r.skuIssues, r.posCreated, r.lastAwardAt?.slice(0, 10) ?? '']) }],
    aboutExport('Supplier scorecard', { ...filter, from: d?.from ?? filter.from, to: d?.to ?? filter.to }, [
      'Hours to first quote recorded: from the RFQ being sent to the first quote entered in the app for that supplier (a later revision does not move it). It is when Procurement recorded it, not when the supplier sent it.',
      'Returned: handoffs the PO team returned (not automatic returns). Value is per currency, never added across currencies.',
    ]));
  const columns: AppColumn<Row>[] = [
    { title: 'Supplier', key: 'name', width: 190, render: (_: unknown, r) => <><Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={(e) => { e.stopPropagation(); setOpen(r); }}>{r.name}</Button> <Small>{r.supplierCode}</Small>{r.blocked && <Tag color="red" style={{ marginInlineStart: 4, marginInlineEnd: 0 }}>blocked</Tag>}</> },
    { title: 'Country', key: 'country', dataIndex: 'country', width: 55 },
    { title: 'Invited', key: 'invited', dataIndex: 'invited', width: 60, align: 'right' },
    { title: 'Quoted', key: 'quoted', width: 90, align: 'right', render: (_: unknown, r) => <>{r.quoted} <Small>({pct(r.quoteRate)})</Small></> },
    { title: 'Quotes', key: 'quotes', dataIndex: 'quotes', width: 60, align: 'right' },
    { title: 'First contact', key: 'outside', dataIndex: 'outsideShortlist', width: 70, align: 'right' },
    { title: 'First quote after', key: 'response', width: 75, align: 'right', render: (_: unknown, r) => hrs(r.avgResponseHours) },
    { title: 'Cheapest', key: 'cheapest', width: 100, align: 'right', render: (_: unknown, r) => (r.compared ? <>{r.cheapest} of {r.compared} <Small>({pct(r.cheapestRate)})</Small></> : <Typography.Text type="secondary">not compared</Typography.Text>) },
    { title: 'Containers', key: 'containers', dataIndex: 'containers', width: 75, align: 'right' },
    { title: 'Awards', key: 'batches', dataIndex: 'batches', width: 60, align: 'right' },
    { title: 'Value', key: 'value', width: 130, align: 'right', render: (_: unknown, r) => moneyText(r.values) },
    { title: 'Above offer', key: 'aboveOffer', dataIndex: 'aboveOffer', width: 70, align: 'right' },
    { title: 'Un-awarded', key: 'unawarded', dataIndex: 'unawarded', width: 75, align: 'right' },
    { title: 'SKU corrections', key: 'skuCorrections', dataIndex: 'skuCorrections', width: 80, align: 'right' },
    { title: 'Handoffs', key: 'handoffs', dataIndex: 'handoffs', width: 65, align: 'right' },
    { title: 'Returned', key: 'returned', width: 90, align: 'right', render: (_: unknown, r) => (r.returned ? <Typography.Text type="danger">{r.returned} ({pct(r.returnRate)} of {r.handoffs})</Typography.Text> : r.handoffs ? '0' : '—') },
    { title: 'SKU issues', key: 'skuIssues', dataIndex: 'skuIssues', width: 65, align: 'right' },
    { title: 'POs created', key: 'posCreated', dataIndex: 'posCreated', width: 70, align: 'right' },
    { title: 'Last award', key: 'lastAward', width: 90, render: (_: unknown, r) => dateText(r.lastAwardAt) },
  ];
  return (
    <>
      {q.error && <Alert type="error" showIcon message={q.error.message} />}
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message={d ? <>Suppliers invited, awarded or handed off {d.from ? <>since <b>{dateText(d.from)}</b></> : 'in the period'}{d.to ? <> until <b>{dateText(d.to)}</b></> : ''} (the last 12 months when no dates are picked). Invitations, quotes, response and price position follow the RFQ's sent date; awards the award date; handoffs their sent date. <i>First quote after</i> = average hours from the RFQ being sent to the first quote <b>recorded</b> in the app (revisions do not move it). "Cheapest" counts rows where at least two suppliers quoted in the same currency. <i>Returned</i> = returned by the PO team. Click a supplier for its RFQs and handoffs.</> : 'Loading…'} action={<Updating show={q.isPlaceholderData} />} />
      <AppTable<Row> prefs={prefs} itemName="suppliers" rowKey="supplierCode" columns={columns} loading={!prefs.ready || q.isFetching}
        dataSource={rows.slice((page - 1) * prefs.pageSize, page * prefs.pageSize)} page={page} total={rows.length} onPageChange={setPage}
        onRow={(r) => ({ onClick: () => setOpen(r), style: { cursor: 'pointer' } })}
        toolbar={<Button icon={<DownloadOutlined />} disabled={!rows.length} onClick={() => void exportXlsx()}>Export to Excel</Button>} />
      <SupplierDrawer row={open} filter={filter} onClose={() => setOpen(undefined)} />
    </>
  );
}

function SupplierDrawer({ row, filter, onClose }: { row?: Row; filter: Filter; onClose: () => void }) {
  const q = trpc.reports.supplierDetail.useQuery({ company: filter.company, from: filter.from, to: filter.to, supplierCode: row?.supplierCode ?? '-' }, { enabled: !!row });
  const d = q.data;
  return (
    <Drawer open={!!row} onClose={onClose} width={Math.min(980, window.innerWidth - 40)} destroyOnHidden title={row ? <Space>{row.name}<Typography.Text type="secondary">{row.supplierCode} · {row.country}</Typography.Text></Space> : ''}>
      {q.error && <Alert type="error" showIcon message={q.error.message} />}
      {d && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text strong>RFQs the supplier was invited to ({d.rfqs.length})</Typography.Text>
          <Table size="small" pagination={false} rowKey="rfqId" dataSource={d.rfqs} columns={[
            { title: 'RFQ', key: 'r', render: (_: unknown, r: (typeof d.rfqs)[number]) => <Link to={`/rfqs/${r.rfqId}`}>{r.rfqNo}</Link> },
            { title: 'Demand', key: 'd', render: (_: unknown, r: (typeof d.rfqs)[number]) => <Link to={`/demands/${r.demandId}`}>{r.demandNo}</Link> },
            { title: 'Company', dataIndex: 'companyCode' }, { title: 'Sent', key: 's', render: (_: unknown, r: (typeof d.rfqs)[number]) => formatDateTime(r.sentAt) },
            { title: <Tooltip title="The first quote recorded in the app for this RFQ (a revision does not move it)">First quote recorded</Tooltip>, key: 'q', render: (_: unknown, r: (typeof d.rfqs)[number]) => (r.firstQuoteAt ? formatDateTime(r.firstQuoteAt) : <Typography.Text type="secondary">no quote</Typography.Text>) },
            { title: 'Containers awarded', dataIndex: 'containers', align: 'right' },
            { title: '', key: 'o', render: (_: unknown, r: (typeof d.rfqs)[number]) => (r.outsideShortlist ? <Tag>first contact</Tag> : null) },
          ]} />
          <Typography.Text strong>Handoffs ({d.handoffs.length})</Typography.Text>
          <Table size="small" pagination={false} rowKey="handoffId" dataSource={d.handoffs} columns={[
            { title: 'Handoff', key: 'h', render: (_: unknown, h: (typeof d.handoffs)[number]) => <Link to={`/handoffs/${h.handoffId}`}>{h.hoNo}</Link> },
            { title: 'Award', key: 'a', render: (_: unknown, h: (typeof d.handoffs)[number]) => <Link to={`/awards/${h.awardBatchId}`}>{h.abNo}</Link> },
            { title: 'Demand', dataIndex: 'demandNo' }, { title: 'Sent', key: 's', render: (_: unknown, h: (typeof d.handoffs)[number]) => formatDateTime(h.sentAt) },
            { title: 'Status', key: 'st', render: (_: unknown, h: (typeof d.handoffs)[number]) => (h.status === 'RETURNED' ? <Tag color="orange">Returned · {h.returnReason ?? ''}</Tag> : h.sapPoNumber ? <Tag color="green">PO {h.sapPoNumber}</Tag> : <Tag color="blue">{h.status === 'ACCEPTED' ? 'Accepted' : 'Handed off'}</Tag>) },
          ]} />
          <Small>{fmtN(row?.containers ?? 0)} container(s) awarded in the period.</Small>
        </Space>
      )}
    </Drawer>
  );
}
