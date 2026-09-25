import { useState } from 'react';
import { Alert, App, Button, Card, Input, InputNumber, Result, Select, Skeleton, Space, Table, Typography } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf, qtyText } from '../../lib/workflow';
import { LoadError } from '../../components/LoadError';

type Line = RouterOutputs['demand']['get']['weeks'][number]['lines'][number] & { etdWeek: string };

/** Request change → Not sourced (spec 14): Procurement marks Open quantity it cannot source; Sales decides. */
export function NotSourcedPage() {
  const { demandId = '' } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const demand = trpc.demand.get.useQuery({ demandId });
  const reasons = trpc.cr.reasons.useQuery({ context: 'CR_PROC' });
  const raise = trpc.cr.raiseNotSourced.useMutation();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [weekCounts, setWeekCounts] = useState<Record<string, number | null>>({});
  const [reason, setReason] = useState<string>();
  const [comment, setComment] = useState('');

  if (demand.error) return <LoadError error={demand.error} what="Demand" onRetry={() => void demand.refetch()} />;
  if (!demand.data) return <Skeleton active />;
  const d = demand.data;
  if (!d.actions.notSourced) return <Result status="403" title="No change request possible" subTitle="Only Procurement can mark quantity of an accepted demand as not sourced." />;

  const lines: Line[] = d.weeks.flatMap((w) => w.lines.map((l) => ({ ...l, etdWeek: w.etdWeek })));
  const chosen = lines.filter((l) => (qty[l.lineId] ?? '').trim() && Number(qty[l.lineId]) > 0);
  const weeks = d.weeks.filter((w) => weekCounts[w.etdWeek] != null && weekCounts[w.etdWeek] !== w.containerCount);

  const send = async () => {
    if (!reason) return;
    try {
      const r = await raise.mutateAsync({
        commandId: newCommandId(), demandId, reasonCode: reason, comment,
        lines: chosen.map((l) => ({ lineId: l.lineId, qty: qty[l.lineId].trim() })),
        weeks: weeks.map((w) => ({ etdWeek: w.etdWeek, containerCount: weekCounts[w.etdWeek]! })),
      });
      await Promise.all([utils.demand.invalidate(), utils.cr.invalidate(), utils.work.invalidate()]);
      if (r.status === 'BLOCKED') message.warning(`${r.crNo} was saved as Blocked — see the reasons`);
      else message.success(`${r.crNo} sent to Sales`);
      navigate(`/change-requests/${r.crId}`);
    } catch (err) {
      const p = problemsOf(err);
      message.error(p.length ? p.join(' · ') : errorText(err));
    }
  };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Link to={`/demands/${demandId}`}><Typography.Text type="secondary">← {d.demandNo}</Typography.Text></Link>
      <Typography.Title level={5} style={{ margin: 0 }}>Request change · {d.demandNo} · Not sourced</Typography.Title>
      <Alert type="info" showIcon message="Only quantity that is still Open can be marked not sourced. Sales decides; approved quantity is cancelled as not sourced (it counts against Procurement)." />
      <Table<Line>
        size="small" bordered rowKey="lineId" pagination={false} dataSource={lines} tableLayout="fixed"
        columns={[
          { title: 'Week', dataIndex: 'etdWeek', width: 90 },
          { title: 'Material', key: 'm', ellipsis: true, render: (_: unknown, l) => `${l.subMajorCategory} · ${l.sizeLabel} · ${l.classLabel} · ${l.originCode}${l.materialCode ? ` · ${l.materialCode}` : ''}` },
          { title: 'Open', key: 'o', width: 110, align: 'right', render: (_: unknown, l) => `${qtyText(l.ledger.open)} ${l.unit}` },
          {
            title: 'Not sourced', key: 'n', width: 150,
            render: (_: unknown, l) => l.onHold ? <Typography.Text type="secondary">On hold ({l.hold?.crNo})</Typography.Text> : (
              <Input size="small" inputMode="numeric" value={qty[l.lineId] ?? ''} placeholder="0" style={{ textAlign: 'right' }} aria-label="Not sourced"
                onChange={(e) => setQty({ ...qty, [l.lineId]: e.target.value.replace(/[^\d]/g, '') })} />
            ),
          },
        ]}
      />
      <Card size="small" title="Containers (optional)">
        <Space wrap>
          {d.weeks.map((w) => (
            <Space key={w.etdWeek} size={4}>
              <Typography.Text>{w.etdWeek}: lower from {w.containerCount} to</Typography.Text>
              <InputNumber size="small" min={0} max={Math.max(0, w.containerCount - 1)} value={weekCounts[w.etdWeek] ?? null} placeholder="—"
                onChange={(v) => setWeekCounts({ ...weekCounts, [w.etdWeek]: v })} style={{ width: 70 }} aria-label={`Containers ${w.etdWeek}`} />
            </Space>
          ))}
        </Space>
      </Card>
      <Card size="small" title="Why">
        <Space wrap style={{ width: '100%' }}>
          <Select id="nsReason" style={{ width: 380 }} placeholder="Reason (required)" value={reason} onChange={setReason}
            options={(reasons.data ?? []).map((r) => ({ value: r.ReasonCode, label: `${r.ReasonCode} · ${r.Description}` }))} />
          <Input id="nsComment" style={{ width: 520, maxWidth: '100%' }} placeholder="Comment for Sales (required)" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          <Button type="primary" icon={<SendOutlined />} disabled={!reason || !comment.trim() || (chosen.length === 0 && weeks.length === 0)} loading={raise.isPending} onClick={send}>
            Check &amp; send to Sales
          </Button>
        </Space>
      </Card>
    </Space>
  );
}
