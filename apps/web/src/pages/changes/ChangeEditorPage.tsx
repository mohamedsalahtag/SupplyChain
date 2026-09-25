import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Empty, Input, Result, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, RollbackOutlined, SendOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf, weekLabel, weekOptions } from '../../lib/workflow';
import { GroupCard, sameMakeUp, type GroupDraft } from '../demands/GroupCard';
import { LoadError } from '../../components/LoadError';

type Demand = RouterOutputs['demand']['get'];
type WeekDraft = { uid: string; etdWeek: string; groups: GroupDraft[] };
type Preview = RouterOutputs['cr']['previewContainerChange'];

const uid = () => crypto.randomUUID();
const trim = (q: string) => q.replace(/\.?0+$/, '');

function fromDemand(d: Demand): WeekDraft[] {
  return d.weeks.map((w) => ({
    uid: uid(),
    etdWeek: w.etdWeek,
    groups: w.groups.map((g) => ({
      uid: uid(), groupId: g.groupId, name: g.name, containerCount: g.containerCount, capacity: trim(g.capacity), unit: g.unit,
      items: g.items.map((i) => ({ uid: uid(), majorCategory: i.majorCategory, subMajorCategory: i.subMajorCategory, size: i.size, materialClass: i.materialClass, originCode: i.originCode, materialCode: i.materialCode, share: i.share })),
    })),
  }));
}

const toProposal = (weeks: WeekDraft[]) => ({
  weeks: weeks.map((w) => ({
    etdWeek: w.etdWeek,
    groups: w.groups.map((g) => ({
      groupId: g.groupId ?? null, name: g.name.trim(), containerCount: g.containerCount, capacity: g.capacity.trim() || '0', unit: g.unit || 'CT',
      items: g.items.map((i) => ({ majorCategory: i.majorCategory, subMajorCategory: i.subMajorCategory, size: i.size, materialClass: i.materialClass, originCode: i.originCode, materialCode: i.materialCode, share: i.share })),
    })),
  })),
});

const KIND: Record<string, string> = { GROUP_COUNT: 'Number of containers', GROUP_ADD: 'New group', GROUP_REMOVE: 'Remove group', GROUP_COMPOSITION: 'Composition' };

/**
 * Request change → Change containers (spec 14): Sales edits the containers of an
 * accepted demand as they should be; the server turns the differences into items,
 * checks them, and sends them to Procurement to decide.
 */
export function ChangeEditorPage() {
  const { demandId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const utils = trpc.useUtils();
  const demand = trpc.demand.get.useQuery({ demandId });
  const reasons = trpc.cr.reasons.useQuery({ context: 'CR_SALES' });
  const raise = trpc.cr.raiseContainerChange.useMutation();
  const [weeks, setWeeks] = useState<WeekDraft[] | null>(null);
  const [reason, setReason] = useState<string>();
  const [comment, setComment] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const allWeeks = useMemo(() => weekOptions(52), []);

  const original = useMemo(() => (demand.data ? fromDemand(demand.data) : []), [demand.data]);
  useEffect(() => {
    if (demand.data && weeks === null) {
      const start = fromDemand(demand.data);
      // Cancel demand / Cancel week start with those containers removed.
      const cancel = params.get('cancel');
      setWeeks(cancel === 'all' ? start.map((w) => ({ ...w, groups: [] })) : cancel ? start.map((w) => (w.etdWeek === cancel ? { ...w, groups: [] } : w)) : start);
    }
  }, [demand.data, weeks, params]);

  if (demand.error) return <LoadError error={demand.error} what="Demand" onRetry={() => void demand.refetch()} />;
  if (!demand.data || !weeks) return <Skeleton active />;
  const d = demand.data;
  if (!d.actions.changeContainers) return <Result status="403" title="No change request possible" subTitle="Only an accepted demand can be changed, by Sales, through a change request." />;

  const change = (next: WeekDraft[]) => {
    setWeeks([...next].sort((a, b) => a.etdWeek.localeCompare(b.etdWeek)));
    setPreview(null);
  };
  const setWeek = (id: string, patch: Partial<WeekDraft>) => change(weeks.map((w) => (w.uid === id ? { ...w, ...patch } : w)));
  const originalGroup = (groupId?: string | null) => original.flatMap((w) => w.groups).find((g) => g.groupId && g.groupId === groupId);
  const stateOf = (g: GroupDraft): { color: string; label: string } | null => {
    const o = originalGroup(g.groupId);
    if (!o) return { color: 'green', label: 'New' };
    if (!sameMakeUp(o, g)) return { color: 'gold', label: 'Composition changed' };
    if (o.containerCount !== g.containerCount) return { color: 'gold', label: `Containers ${o.containerCount} → ${g.containerCount}` };
    return null;
  };
  const kept = new Set(weeks.flatMap((w) => w.groups.map((g) => g.groupId)).filter(Boolean));
  const removed = original.flatMap((w) => w.groups.filter((g) => !kept.has(g.groupId)).map((g) => ({ week: w.etdWeek, group: g })));
  const restore = (week: string, g: GroupDraft) => {
    const w = weeks.find((x) => x.etdWeek === week);
    change(w ? weeks.map((x) => (x.uid === w.uid ? { ...x, groups: [...x.groups, g] } : x)) : [...weeks, { uid: uid(), etdWeek: week, groups: [g] }]);
  };
  const copyTo = (g: GroupDraft, target: string) => {
    const copy = { ...g, uid: uid(), groupId: null, items: g.items.map((i) => ({ ...i, uid: uid() })) };
    const w = weeks.find((x) => x.etdWeek === target);
    change(w ? weeks.map((x) => (x.uid === w.uid ? { ...x, groups: [...x.groups, copy] } : x)) : [...weeks, { uid: uid(), etdWeek: target, groups: [copy] }]);
  };

  const check = async () => {
    setChecking(true);
    try {
      setPreview(await utils.client.cr.previewContainerChange.query({ demandId, proposal: toProposal(weeks) }));
    } catch (err) {
      message.error(errorText(err));
    } finally {
      setChecking(false);
    }
  };
  const send = async () => {
    if (!reason) return;
    try {
      const r = await raise.mutateAsync({ commandId: newCommandId(), demandId, proposal: toProposal(weeks), reasonCode: reason, comment });
      await Promise.all([utils.demand.invalidate(), utils.cr.invalidate(), utils.work.invalidate()]);
      if (r.status === 'BLOCKED') message.warning(`${r.crNo} was saved as Blocked — see the reasons`);
      else message.success(`${r.crNo} sent to Procurement`);
      navigate(`/change-requests/${r.crId}`);
    } catch (err) {
      const p = problemsOf(err);
      message.error(p.length ? p.join(' · ') : errorText(err));
    }
  };

  const weeksOnDemand = new Set(original.map((w) => w.etdWeek));
  const used = new Set(weeks.map((w) => w.etdWeek));
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Link to={`/demands/${demandId}`}><Typography.Text type="secondary">← {d.demandNo}</Typography.Text></Link>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>Request change · {d.demandNo} · Containers</Typography.Title>
        <Space>
          <Button danger icon={<DeleteOutlined />} onClick={() => change(weeks.map((w) => ({ ...w, groups: [] })))}>Cancel whole demand</Button>
          <Button onClick={() => { setWeeks(fromDemand(d)); setPreview(null); }}>Start again</Button>
        </Space>
      </Space>
      <Alert type="info" showIcon message="How to ask for this change — nothing changes until Procurement approves"
        description={
          <ol style={{ margin: 0, paddingInlineStart: 18 }}>
            <li>Below, edit the containers as they should be: change the number, add a group (also in a new week), remove a group, or change a make-up. Changes are tagged.</li>
            <li>Under <b>Why</b>, choose a reason and write a comment for Procurement.</li>
            <li>Press <b>Check</b> to see what changes and whether it can be sent.</li>
            <li>Press <b>Send to Procurement</b>. The weeks involved go on hold and the request appears on Procurement's My work; you follow it under Purchasing → Change requests.</li>
          </ol>
        } />

      {weeks.map((w) => (
        <Card key={w.uid} size="small"
          title={
            <Space wrap>
              <Typography.Text strong>ETD week</Typography.Text>
              {weeksOnDemand.has(w.etdWeek) ? <Typography.Text>{weekLabel(w.etdWeek)}</Typography.Text> : (
                <Select size="small" value={w.etdWeek} style={{ width: 210 }} onChange={(v) => setWeek(w.uid, { etdWeek: v })}
                  options={allWeeks.map((x) => ({ value: x, label: weekLabel(x), disabled: used.has(x) && x !== w.etdWeek }))} aria-label="ETD week" />
              )}
              <Tag>{w.groups.reduce((s, g) => s + g.containerCount, 0)} containers</Tag>
              {w.groups.length === 0 && <Tag color="red">Week cancelled</Tag>}
            </Space>
          }
          extra={
            <Space>
              <Button size="small" icon={<PlusOutlined />} onClick={() => setWeek(w.uid, { groups: [...w.groups, { uid: uid(), groupId: null, name: '', containerCount: 1, capacity: w.groups[0]?.capacity ?? '', unit: '', items: [] }] })}>Add container group</Button>
              {w.groups.length > 0 && <Button size="small" danger onClick={() => setWeek(w.uid, { groups: [] })}>Cancel this week</Button>}
            </Space>
          }>
          {w.groups.map((g, gi) => {
            const st = stateOf(g);
            return (
              <div key={g.uid}>
                {st && <Tag color={st.color} style={{ marginBottom: 4 }}>{st.label}</Tag>}
                <GroupCard group={g} index={gi} week={w.etdWeek} copyTargets={allWeeks.filter((x) => x !== w.etdWeek)}
                  onChange={(ng) => setWeek(w.uid, { groups: w.groups.map((x) => (x.uid === g.uid ? ng : x)) })}
                  onRemove={() => setWeek(w.uid, { groups: w.groups.filter((x) => x.uid !== g.uid) })}
                  onCopy={(target) => copyTo(g, target)} />
              </div>
            );
          })}
          {w.groups.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No containers in this week" />}
        </Card>
      ))}
      <Button icon={<PlusOutlined />} onClick={() => { const free = allWeeks.find((x) => !used.has(x)); if (free) change([...weeks, { uid: uid(), etdWeek: free, groups: [] }]); }}>Add week</Button>

      {removed.length > 0 && (
        <Card size="small" title="Removed containers">
          {removed.map(({ week, group }) => (
            <Space key={group.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
              <Typography.Text delete>{week} · {group.name || 'Group'}: {group.containerCount} × {group.capacity} {group.unit}</Typography.Text>
              <Button size="small" icon={<RollbackOutlined />} onClick={() => restore(week, group)}>Undo</Button>
            </Space>
          ))}
        </Card>
      )}

      <Card size="small" title="Why">
        <Space wrap style={{ width: '100%' }}>
          <Select id="crReason" style={{ width: 380 }} placeholder="Reason (required)" value={reason} onChange={setReason}
            options={(reasons.data ?? []).map((r) => ({ value: r.ReasonCode, label: `${r.ReasonCode} · ${r.Description}` }))} />
          <Input id="crComment" style={{ width: 520, maxWidth: '100%' }} placeholder="Comment for Procurement (required)" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          <Button loading={checking} onClick={check}>Check</Button>
        </Space>
      </Card>

      {preview && (
        <Card size="small" title={`Pre-check: ${preview.items.length} item(s)`}>
          {preview.problems.length > 0 ? (
            <Alert type="error" showIcon message="This request would be Blocked" description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>} />
          ) : (
            <Alert type="success" showIcon message="OK — the week and its materials go on hold until Procurement decides." />
          )}
          <Table size="small" bordered pagination={false} rowKey={(r, i) => `${r.etdWeek}-${i}`} dataSource={preview.items} style={{ marginTop: 8 }}
            columns={[
              { title: 'Week', dataIndex: 'etdWeek', width: 95 },
              { title: 'Change', key: 'k', width: 260, render: (_: unknown, r) => `${KIND[r.kind]}${r.name ? ` · ${r.name}` : ''}${r.before != null && r.after != null ? `: ${r.before} → ${r.after} containers` : r.after != null ? `: ${r.after} containers` : ''}` },
              { title: 'Quantity effect', key: 'e', render: (_: unknown, r) => <Space direction="vertical" size={0}>{r.effect.map((e) => <span key={e}>{e}</span>)}</Space> },
            ]} />
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" icon={<SendOutlined />} disabled={!reason || !comment.trim() || preview.items.length === 0} loading={raise.isPending} onClick={send}>
              {preview.problems.length ? 'Save as Blocked' : 'Send to Procurement'}
            </Button>
            {(!reason || !comment.trim()) && <Typography.Text type="secondary">Choose a reason and write a comment first.</Typography.Text>}
          </Space>
        </Card>
      )}
    </Space>
  );
}
