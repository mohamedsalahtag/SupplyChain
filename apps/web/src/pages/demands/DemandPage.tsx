import { Alert, Descriptions, Result, Skeleton, Space, Typography } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { BackToWork } from '../../components/BackToWork';
import { formatDateTime } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { DemandEditor } from './DemandEditor';
import { DemandStatus } from './DemandStatus';
import { DemandTabs } from './DemandTabs';
import { DemandView, StatusTag } from './DemandView';
import { RequestChangePanel } from '../changes/RequestChangePanel';

/** One demand (spec 12): editable while Draft/Returned for Sales, read-only (Demand 360) otherwise. */
export function DemandPage() {
  const { demandId = '' } = useParams();
  const demand = trpc.demand.get.useQuery({ demandId }, { enabled: /^\d+$/.test(demandId), retry: false });

  if (demand.error) {
    return demand.error.data?.code === 'NOT_FOUND'
      ? <Result status="404" title="Demand not found" subTitle="It does not exist, or it belongs to a company you do not work for." extra={<Link to="/demands">Demands</Link>} />
      : <Alert type="error" showIcon message="The demand could not be loaded" description={demand.error.message} />;
  }
  if (!demand.data) return <Skeleton active />;
  const d = demand.data;

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={12}>
        <BackToWork />
        <Link to="/demands"><Typography.Text type="secondary">Demands</Typography.Text></Link>
      </Space>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space size={10} align="baseline" wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>{d.demandNo}</Typography.Title>
          <StatusTag status={d.status} mergedInto={d.mergedIntoDemand} />
          <Typography.Text type="secondary">{d.companyCode} · {d.companyName}</Typography.Text>
        </Space>
      </Space>
      <DemandStatus demand={d} />
      <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} bordered items={[
        { label: 'Created by', children: `${d.createdBy} · ${formatDateTime(d.createdAt)}` },
        { label: 'Submitted (baseline v1)', children: formatDateTime(d.submittedAt) },
        { label: 'Accepted', children: d.acceptedAt ? `${formatDateTime(d.acceptedAt)} · ${d.acceptedBy}` : '—' },
        { label: 'Version', children: d.currentVersion || '—' },
      ]} />
      {d.weeks.some((w) => w.hold) && (
        <Alert type="warning" showIcon message={<>On hold: {d.weeks.filter((w) => w.hold).map((w) => <span key={w.etdWeek}>{w.etdWeek} in <Link to={`/change-requests/${w.hold!.crId}`}>{w.hold!.crNo}</Link> </span>)}</>}
          description="Waiting for a decision. No other change request can touch these weeks and materials until it is decided." />
      )}
      {d.workflowStatus === 'RETURNED' && <Alert type="warning" showIcon message="Returned by Procurement — see Comments for what to change, then resubmit." />}
      <RequestChangePanel demand={d} />
      {d.actions.edit ? <DemandEditor demand={d} /> : <DemandView demand={d} />}
      <DemandTabs demand={d} />
    </Space>
  );
}
