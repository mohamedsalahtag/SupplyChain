import { useState } from 'react';
import { App, Button, Input, Modal, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { P } from '@supplychain/shared';
import { useCan } from '../../lib/auth';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf } from '../../lib/workflow';

type Merge = RouterOutputs['merge']['list'][number];

/** Merges in and out of one demand (spec 17), with Unmerge for Procurement. */
export function MergesTab({ demandId }: { demandId: string }) {
  const can = useCan();
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const list = trpc.merge.list.useQuery({ demandId });
  const undo = trpc.merge.unmerge.useMutation();
  const [undoing, setUndoing] = useState<Merge | null>(null);
  const [reason, setReason] = useState('');

  const onUnmerge = async () => {
    if (!undoing) return;
    try {
      await undo.mutateAsync({ commandId: newCommandId(), mergeId: undoing.mergeId, rowVer: undoing.rowVer, reason });
      message.success(`${undoing.mergeNo} undone`);
      setUndoing(null);
      await Promise.all([utils.demand.invalidate(), utils.merge.invalidate()]);
    } catch (err) {
      const p = problemsOf(err);
      message.error(p.length ? p.join(' · ') : errorText(err));
    }
  };

  return (
    <>
      <Table<Merge> size="small" bordered rowKey="mergeId" pagination={false} loading={list.isPending} dataSource={list.data} tableLayout="fixed" locale={{ emptyText: 'No merges' }}
        columns={[
          { title: 'Merge', dataIndex: 'mergeNo', width: 100 },
          { title: 'Direction', key: 'd', width: 90, render: (_: unknown, m) => (m.direction === 'IN' ? 'In from' : 'Out to') },
          { title: 'Other demand', key: 'o', width: 110, render: (_: unknown, m) => <Link to={`/demands/${m.other.demandId}`}>{m.other.demandNo}</Link> },
          { title: 'Weeks', key: 'w', render: (_: unknown, m) => m.weeks.join(', ') },
          { title: 'Containers', dataIndex: 'containers', width: 95, align: 'right' },
          { title: 'Quantity', dataIndex: 'quantity', width: 130, align: 'right' },
          { title: 'By / at', key: 'b', width: 190, ellipsis: true, render: (_: unknown, m) => <span title={m.comment}>{m.executedBy} · {formatDateTime(m.executedAt)}</span> },
          {
            title: 'Status', key: 's', width: 110,
            render: (_: unknown, m) => (m.status === 'EXECUTED' ? <Tag color="green">Executed</Tag>
              : <Tooltip title={`${m.unmergedBy} · ${formatDateTime(m.unmergedAt)}: ${m.unmergeReason}`}><Tag>Unmerged</Tag></Tooltip>),
          },
          {
            title: '', key: 'a', width: 110,
            render: (_: unknown, m) => m.status === 'EXECUTED' && can(P.demandUnmerge) && (
              m.unmerge.allowed
                ? <Button size="small" danger onClick={() => { setReason(''); setUndoing(m); }}>Unmerge…</Button>
                : <Tooltip title={<ul style={{ margin: 0, paddingInlineStart: 16 }}>{m.unmerge.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}><Button size="small" disabled>Unmerge…</Button></Tooltip>
            ),
          },
        ]} />
      <Modal open={!!undoing} title={`Unmerge ${undoing?.mergeNo}?`} okText="Unmerge" okButtonProps={{ danger: true, disabled: !reason.trim(), loading: undo.isPending }}
        onOk={onUnmerge} onCancel={() => setUndoing(null)} destroyOnClose>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Everything goes back: the merged quantity is Open again on the demand it came from, and its container groups return to their weeks. Both demands get a new version.
          </Typography.Text>
          <Input.TextArea id="unmergeReason" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" />
        </Space>
      </Modal>
    </>
  );
}
