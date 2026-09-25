import { useState } from 'react';
import { Button, Empty, List, Space, Table, Tabs, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { CR_STATUS, CR_TYPE, APPLY_STATUS } from '../changes/ChangeRequestPage';
import { AwardsTab } from '../award/AwardsListPage';
import { MergesTab } from '../merge/MergesTab';
import { AttachmentsPanel } from '../../components/AttachmentsPanel';
import { ThreadPanel } from '../../components/ThreadPanel';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { newCommandId } from '../../lib/workflow';

type Demand = RouterOutputs['demand']['get'];

const EVENT_TEXT: Record<string, string> = {
  DEMAND_CREATED: 'Created', DEMAND_SUBMITTED: 'Submitted (baseline)', DEMAND_RESUBMITTED: 'Resubmitted', DEMAND_RETURNED: 'Returned to Sales',
  DEMAND_ACCEPTED: 'Accepted', DEMAND_RECALLED: 'Taken back by Sales to change', MERGE_EXECUTED: 'Merged', MERGE_UNDONE: 'Merge undone', ATTACHMENT_UPLOADED: 'Attachment uploaded', ATTACHMENT_DOWNLOADED: 'Attachment downloaded',
};

function VersionsTab({ demandId }: { demandId: string }) {
  const versions = trpc.demand.versions.useQuery({ demandId });
  const [open, setOpen] = useState<number | null>(null);
  const shown = versions.data?.find((v) => v.versionNo === open);
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Table size="small" bordered rowKey="versionNo" pagination={false} loading={versions.isPending} dataSource={versions.data} locale={{ emptyText: 'Not submitted yet' }}
        columns={[
          { title: 'Version', dataIndex: 'versionNo', width: 80 },
          { title: 'Reason', key: 'r', width: 200, render: (_: unknown, v) => <Space>{v.reason}{v.versionNo === 1 && <Tag color="green">Baseline</Tag>}</Space> },
          { title: 'When', key: 'w', width: 170, render: (_: unknown, v) => formatDateTime(v.createdAt) },
          { title: 'By', dataIndex: 'createdBy', width: 160 },
          { title: '', key: 'a', render: (_: unknown, v) => v.versionNo > 1 && <Button size="small" type="link" onClick={() => setOpen(v.versionNo)}>Compare with baseline ({v.diffFromBaseline.length} change{v.diffFromBaseline.length === 1 ? '' : 's'})</Button> },
        ]} />
      {shown && (
        <Table size="small" bordered rowKey="what" pagination={false} dataSource={shown.diffFromBaseline}
          title={() => <Typography.Text strong>Version {shown.versionNo} compared with the baseline (version 1)</Typography.Text>}
          locale={{ emptyText: 'No differences' }}
          columns={[
            { title: 'Week / line', dataIndex: 'what' },
            { title: 'Baseline', key: 'b', width: 180, render: (_: unknown, r) => r.before ?? '—' },
            { title: `Version ${shown.versionNo}`, key: 'a', width: 180, render: (_: unknown, r) => <Typography.Text type={r.after === null ? 'danger' : 'warning'} strong>{r.after ?? 'removed'}</Typography.Text> },
          ]} />
      )}
    </Space>
  );
}

function HistoryTab({ demandId }: { demandId: string }) {
  const history = trpc.demand.history.useQuery({ demandId });
  return (
    <List size="small" bordered loading={history.isPending} dataSource={history.data ?? []} locale={{ emptyText: <Empty description="No history yet" /> }}
      renderItem={(h) => (
        <List.Item>
          <Space wrap size={6}>
            <Typography.Text type="secondary">{formatDateTime(h.at)}</Typography.Text>
            <Typography.Text>{h.by}</Typography.Text>
            {h.kind === 'quantity' ? <Tag color="blue">Quantity</Tag> : null}
            <Typography.Text strong={h.kind === 'event'}>{h.kind === 'event' ? (EVENT_TEXT[h.text] ?? h.text) : h.text}</Typography.Text>
            {h.kind === 'event' && h.payload?.comment && <Typography.Text type="secondary">“{h.payload.comment}”</Typography.Text>}
          </Space>
        </List.Item>
      )} />
  );
}

function ChangeRequestsTab({ demandId }: { demandId: string }) {
  const navigate = useNavigate();
  const list = trpc.cr.list.useQuery({ mine: false, demandId, page: 1, pageSize: 100 });
  return (
    <Table size="small" bordered rowKey="crId" pagination={false} loading={list.isPending} dataSource={list.data?.rows} locale={{ emptyText: 'No change requests' }}
      onRow={(r) => ({ onClick: () => navigate(`/change-requests/${r.crId}`), style: { cursor: 'pointer' } })}
      columns={[
        { title: 'Number', dataIndex: 'crNo', width: 110 },
        { title: 'Type', key: 't', width: 150, render: (_: unknown, r) => CR_TYPE[r.crType] },
        { title: 'Raised by', key: 'b', render: (_: unknown, r) => `${r.raisedBy} · ${formatDateTime(r.raisedAt)}` },
        { title: 'Status', key: 's', width: 170, render: (_: unknown, r) => <Space size={4}><Tag color={CR_STATUS[r.status].color}>{CR_STATUS[r.status].label}</Tag>{r.applyStatus !== 'NOT_REQUIRED' && <Tag color={APPLY_STATUS[r.applyStatus].color}>{APPLY_STATUS[r.applyStatus].label}</Tag>}</Space> },
      ]} />
  );
}

/** Versions · History · Comments · Attachments of one demand (spec 12). */
export function DemandTabs({ demand }: { demand: Demand }) {
  const utils = trpc.useUtils();
  const [showOld, setShowOld] = useState(false);
  const thread = trpc.demand.thread.useQuery({ demandId: demand.demandId });
  const attachments = trpc.demand.attachments.useQuery({ demandId: demand.demandId, includeOld: showOld });
  const comment = trpc.demand.comment.useMutation();

  return (
    <Tabs
      items={[
        { key: 'comments', label: `Comments${thread.data?.length ? ` (${thread.data.length})` : ''}`, children: (
          <ThreadPanel entries={thread.data} loading={thread.isPending} canAdd={demand.actions.comment}
            onAdd={async (body) => { await comment.mutateAsync({ demandId: demand.demandId, commandId: newCommandId(), body }); await utils.demand.thread.invalidate({ demandId: demand.demandId }); }} />
        ) },
        { key: 'attachments', label: `Attachments${attachments.data?.length ? ` (${attachments.data.filter((a) => a.isCurrent).length})` : ''}`, children: (
          <AttachmentsPanel entityType="DEMAND" entityId={demand.demandId} rows={attachments.data} loading={attachments.isPending} canUpload={demand.actions.attach}
            showOld={showOld} onShowOld={setShowOld} onChanged={() => void utils.demand.attachments.invalidate({ demandId: demand.demandId })} />
        ) },
        ...(demand.workflowStatus === 'ACCEPTED' ? [
          { key: 'crs', label: 'Change requests', children: <ChangeRequestsTab demandId={demand.demandId} /> },
          { key: 'merges', label: 'Merges', children: <MergesTab demandId={demand.demandId} /> },
          { key: 'awards', label: 'Awards', children: <AwardsTab demandId={demand.demandId} /> },
        ] : []),
        { key: 'versions', label: 'Versions', children: <VersionsTab demandId={demand.demandId} /> },
        { key: 'history', label: 'History', children: <HistoryTab demandId={demand.demandId} /> },
      ]}
    />
  );
}
