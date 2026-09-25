import { Alert, Button, Card, Col, Empty, List, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { CheckCircleTwoTone, ReloadOutlined, WarningTwoTone } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { formatDateTime } from '../../lib/format';
import { trpc } from '../../lib/trpc';

const ok = (good: boolean) => (good ? <CheckCircleTwoTone twoToneColor="#52c41a" aria-label="OK" /> : <WarningTwoTone twoToneColor="#faad14" aria-label="Needs attention" />);
const SOURCE: Record<string, string> = { 'sap.materials': 'Materials', 'sap.suppliers': 'Suppliers', 'sap.purchaseOrders': 'Purchase orders' };
const mins = (m: number | null) => (m === null ? '—' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`);

/** Administration → Operations status (spec 25): the morning check. Refreshes every minute. */
export function OpsStatusPage() {
  const q = trpc.ops.status.useQuery(undefined, { refetchInterval: 60_000 });
  const s = q.data;
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={10} align="baseline" wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>Operations status</Typography.Title>
          <Typography.Text type="secondary">{s ? `Checked ${formatDateTime(s.checkedAt)} · the runbooks are in docs/operations` : 'Checking…'}</Typography.Text>
        </Space>
        <Button icon={<ReloadOutlined />} loading={q.isFetching} onClick={() => void q.refetch()}>Check now</Button>
      </Space>
      {q.error && <Alert type="error" showIcon message={q.error.message} />}
      {s && (s.switches.viewAs || s.switches.testLogin) && (
        <Alert type={s.switches.production ? 'error' : 'warning'} showIcon message="Test switches are on"
          description={`${[s.switches.viewAs && 'View as (ALLOW_VIEW_AS)', s.switches.testLogin && 'test sign-in (ALLOW_TEST_LOGIN)'].filter(Boolean).join(' and ')} — must be off on the live server.`} />
      )}
      {s && (
        <>
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={12}>
              <Card size="small" title={<>{ok(s.sap.unknown + s.sap.manual === 0 && (s.sap.oldestPendingMinutes ?? 0) < 10)} SAP outbox <Tag>{s.sap.adapter === 'stub' ? 'simulated SAP (stub)' : 'SAP'}</Tag></>}
                extra={<Link to="/po-drafts">PO drafts &amp; SAP</Link>}>
                <Row gutter={12}>
                  <Col span={6}><Statistic title="Waiting to send" value={s.sap.pending} /></Col>
                  <Col span={6}><Statistic title="Sending" value={s.sap.inFlight} /></Col>
                  <Col span={6}><Statistic title="Outcome unknown" value={s.sap.unknown} valueStyle={s.sap.unknown ? { color: '#d48806' } : undefined} /></Col>
                  <Col span={6}><Statistic title="Needs a person" value={s.sap.manual} valueStyle={s.sap.manual ? { color: '#cf1322' } : undefined} /></Col>
                </Row>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Oldest waiting: {mins(s.sap.oldestPendingMinutes)} · last call to SAP: {mins(s.sap.lastAttemptMinutes)} · the worker runs every 30 seconds.
                  {s.sap.manual > 0 && ' Follow the runbook “SAP outcome unknown”.'}</Typography.Text>
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title={<>{ok(s.masterData.sources.every((x) => !x.stale))} Master data from SAP</>} extra={<Link to="/settings">Configuration</Link>}>
                <Table size="small" pagination={false} rowKey="source" dataSource={s.masterData.sources} columns={[
                  { title: 'Sync', key: 's', render: (_: unknown, r) => SOURCE[r.source] ?? r.source },
                  { title: 'Last success', key: 'l', render: (_: unknown, r) => (r.lastSuccess ? formatDateTime(r.lastSuccess) : 'never') },
                  { title: '', key: 'x', width: 150, render: (_: unknown, r) => (r.stale ? <Tag color="orange">older than {s.masterData.maxAgeHours} h</Tag> : <Tag color="green">fresh</Tag>) },
                ]} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Stale master data blocks PO submission.</Typography.Text>
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title={<>{ok(s.overdue.length === 0)} Overdue work</>} extra={<Link to="/work">My work</Link>}>
                {s.overdue.length ? <Table size="small" pagination={false} rowKey={(r) => r.itemType} dataSource={s.overdue} columns={[
                  { title: 'Item', dataIndex: 'itemType', render: (v: string) => v.toLowerCase().replace(/_/g, ' ') },
                  { title: 'Kind', dataIndex: 'category', render: (v: string) => (v === 'EXCEPTION' ? <Tag color="red">exception</Tag> : <Tag>task</Tag>) },
                  { title: 'Overdue', dataIndex: 'count', align: 'right' }, { title: 'Oldest due', key: 'o', render: (_: unknown, r) => formatDateTime(r.oldestDueAt) },
                ]} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing overdue" />}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title={<>{ok(s.separationOfDuties.length === 0 && s.usersWithoutCompany.length === 0)} Users and roles</>} extra={<Link to="/users">Users</Link>}>
                <Typography.Text strong>Separation of duties</Typography.Text>
                {s.separationOfDuties.length ? <List size="small" dataSource={s.separationOfDuties} renderItem={(u) => (
                  <List.Item><Typography.Text>{u.name}</Typography.Text>&nbsp;<Typography.Text type="secondary">{u.conflicts.join('; ')}</Typography.Text></List.Item>)} />
                  : <div><Typography.Text type="secondary">No user holds conflicting permissions (administrators excepted).</Typography.Text></div>}
                <Typography.Text strong>Users with roles but no company</Typography.Text>
                {s.usersWithoutCompany.length ? <div>{s.usersWithoutCompany.map((u) => <Tag key={u.userId}>{u.name}</Tag>)}</div>
                  : <div><Typography.Text type="secondary">None — everyone with a role works for at least one company.</Typography.Text></div>}
              </Card>
            </Col>
          </Row>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>Attachments stored: {s.attachments.files} file(s), {s.attachments.megabytes} MB. Back up the attachments folder together with the database (runbook “Backup and restore”).</Typography.Text>
        </>
      )}
    </Space>
  );
}
