import { useMemo, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Empty, Input, Result, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { MergeCellsOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatDateTime, type RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf, qtyText, weekLabel } from '../../lib/workflow';

type Plan = RouterOutputs['merge']['plan'];
type Row = { key: string; week: string; what: React.ReactNode; now: string; adds: string; after: string; kind: 'line' | 'containers' };

function previewRows(plan: Plan, picked: string[]): Row[] {
  return plan.weeks.filter((w) => picked.includes(w.etdWeek)).flatMap((w) => [
    ...w.lines.map((l) => ({
      key: `${w.etdWeek}-${l.label}`, week: w.etdWeek, kind: 'line' as const,
      what: <>{l.label} {l.newLine && <Tag color="green">new line</Tag>}</>,
      now: l.newLine ? '—' : `${qtyText(l.now)} ${l.unit}`, adds: `+${qtyText(l.adds)}`, after: `${qtyText(l.after)} ${l.unit}`,
    })),
    {
      key: `${w.etdWeek}-containers`, week: w.etdWeek, kind: 'containers' as const,
      what: <>Containers{!w.targetWeekExists && <Tag color="green" style={{ marginInlineStart: 4 }}>new week</Tag>} · {w.groups.map((g) => `${g.name || 'group'} ${g.containerCount} × ${qtyText(g.capacity)} ${g.unit}`).join(', ') || 'no groups'} moves</>,
      now: String(w.targetContainers), adds: `+${w.containers}`, after: String(w.targetContainers + w.containers),
    },
  ]);
}

/**
 * Merge another demand into this one (spec 17): step 1 the source, step 2 its weeks
 * with a preview from the server; the server checks everything again on Merge.
 */
export function MergePage() {
  const { demandId = '' } = useParams();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const utils = trpc.useUtils();
  const [sourceId, setSourceId] = useState<string>();
  const [picked, setPicked] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const candidates = trpc.merge.candidates.useQuery({ targetDemandId: demandId }, { retry: false });
  const plan = trpc.merge.plan.useQuery({ targetDemandId: demandId, sourceDemandId: sourceId ?? '0' }, { enabled: !!sourceId, retry: false });
  const execute = trpc.merge.execute.useMutation();
  const rows = useMemo(() => (plan.data ? previewRows(plan.data, picked) : []), [plan.data, picked]);

  if (candidates.error) return <Result status="warning" title="No merge possible here" subTitle={candidates.error.message} extra={<Link to={`/demands/${demandId}`}>Back to the demand</Link>} />;
  if (!candidates.data) return <Skeleton active />;
  const p = plan.data;
  const free = p ? p.weeks.filter((w) => w.blockers.length === 0).map((w) => w.etdWeek) : [];
  const entire = !!p && p.weeks.length > 0 && free.length === p.weeks.length && picked.length === p.weeks.length;
  const choose = (id: string) => { setSourceId(id); setPicked([]); setProblems([]); };

  const onMerge = () => {
    if (!p) return;
    modal.confirm({
      title: `Merge ${entire ? 'all of' : `${picked.length} week(s) of`} ${p.source.demandNo} into ${p.target.demandNo}?`,
      content: 'The quantities and container groups move now. It can be undone from the Merges tab while the merged quantity is still Open.',
      okText: 'Merge',
      onOk: async () => {
        setProblems([]);
        try {
          const r = await execute.mutateAsync({
            commandId: newCommandId(), targetDemandId: p.target.demandId, targetRowVer: p.target.rowVer, sourceDemandId: p.source.demandId,
            weeks: entire ? 'ALL' : picked, comment,
          });
          await Promise.all([utils.demand.invalidate(), utils.merge.invalidate()]);
          message.success(`${r.mergeNo}: ${p.source.demandNo} merged into ${p.target.demandNo}`);
          navigate(`/demands/${p.target.demandId}`);
        } catch (err) {
          const pr = problemsOf(err);
          if (pr.length) setProblems(pr);
          else message.error(errorText(err));
        }
      },
    });
  };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Link to={`/demands/${demandId}`}><Typography.Text type="secondary">← Back to the demand</Typography.Text></Link>
      {!sourceId ? (
        <>
          <Typography.Title level={5} style={{ margin: 0 }}>Merge into this demand · Step 1 of 2: which demand?</Typography.Title>
          <Alert type="info" showIcon message="Only accepted demands of the same company with Open quantity are listed. Their weeks move into the same weeks of this demand." />
          <Table size="small" bordered rowKey="demandId" pagination={false} dataSource={candidates.data} locale={{ emptyText: <Empty description="No other accepted demand with Open quantity" /> }}
            onRow={(r) => ({ onClick: () => choose(r.demandId), style: { cursor: 'pointer' } })}
            columns={[
              { title: 'Demand', dataIndex: 'demandNo', width: 110 },
              { title: 'Created by', key: 'c', render: (_: unknown, r) => `${r.createdBy}${r.submittedAt ? ` · submitted ${formatDateTime(r.submittedAt)}` : ''}` },
              { title: 'Weeks', key: 'w', render: (_: unknown, r) => r.weeks.join(', ') },
              { title: 'Containers', dataIndex: 'containers', width: 100, align: 'right' },
              { title: 'Open', dataIndex: 'open', width: 160, align: 'right' },
              { title: '', key: 'a', width: 90, render: (_: unknown, r) => <Button size="small" onClick={() => choose(r.demandId)}>Choose</Button> },
            ]} />
        </>
      ) : !p ? (plan.error ? <Alert type="error" showIcon message={plan.error.message} /> : <Skeleton active />) : (
        <>
          <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
            <Typography.Title level={5} style={{ margin: 0 }}>Merge {p.source.demandNo} into {p.target.demandNo} · Step 2 of 2: which weeks?</Typography.Title>
            <Button onClick={() => setSourceId(undefined)}>Choose another demand</Button>
          </Space>
          <Card size="small">
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Checkbox id="mergeEntire" checked={entire} disabled={free.length !== p.weeks.length} onChange={(e) => setPicked(e.target.checked ? free : [])}>
                <b>Entire demand</b>{free.length !== p.weeks.length && <Typography.Text type="secondary"> (not possible: a week is blocked)</Typography.Text>}
              </Checkbox>
              {p.weeks.map((w) => (
                <Space key={w.etdWeek} wrap size={6}>
                  <Checkbox checked={picked.includes(w.etdWeek)} disabled={w.blockers.length > 0} aria-label={`Week ${w.etdWeek}`}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, w.etdWeek] : picked.filter((x) => x !== w.etdWeek))}>
                    {weekLabel(w.etdWeek)} · {w.containers} container{w.containers === 1 ? '' : 's'} · {w.lines.map((l) => `${l.label.split(' ').slice(1, 2).join('')} ${qtyText(l.adds)} ${l.unit}`).join(', ')}
                  </Checkbox>
                  {w.blockers.map((b) => <Tag key={b} color="gold">{b}</Tag>)}
                </Space>
              ))}
            </Space>
          </Card>
          {picked.length > 0 && (
            <Card size="small" title="Preview">
              <Table<Row> size="small" bordered pagination={false} rowKey="key" dataSource={rows} tableLayout="fixed"
                rowClassName={(r) => (r.kind === 'containers' ? 'ant-table-row-selected' : '')}
                columns={[
                  { title: 'Week', dataIndex: 'week', width: 95 },
                  { title: 'Material / containers', dataIndex: 'what' },
                  { title: `${p.target.demandNo} now`, dataIndex: 'now', width: 130, align: 'right' },
                  { title: 'Adds', dataIndex: 'adds', width: 110, align: 'right' },
                  { title: 'After', dataIndex: 'after', width: 130, align: 'right', render: (v: string) => <b>{v}</b> },
                ]} />
              {problems.length > 0 && <Alert type="error" showIcon style={{ marginTop: 8 }} message="The merge is blocked" description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((x) => <li key={x}>{x}</li>)}</ul>} />}
              <Space wrap style={{ marginTop: 8 }}>
                <Input id="mergeComment" style={{ width: 520, maxWidth: '100%' }} placeholder="Comment (optional)" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
                <Button type="primary" icon={<MergeCellsOutlined />} loading={execute.isPending} onClick={onMerge}>Merge</Button>
              </Space>
            </Card>
          )}
        </>
      )}
    </Space>
  );
}
