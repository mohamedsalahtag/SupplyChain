import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Empty, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons';
import type { RouterOutputs } from '../../lib/format';
import { trpc } from '../../lib/trpc';
import { errorText, newCommandId, problemsOf, qtyText, weekLabel, weekOptions } from '../../lib/workflow';
import { GroupCard, sameMakeUp, type GroupDraft } from './GroupCard';

type Demand = RouterOutputs['demand']['get'];
type WeekDraft = { uid: string; etdWeek: string; groups: GroupDraft[] };

const uid = () => crypto.randomUUID();
const trim = (q: string) => q.replace(/\.?0+$/, '');

function fromServer(d: Demand): WeekDraft[] {
  return d.weeks.map((w) => ({
    uid: uid(),
    etdWeek: w.etdWeek,
    groups: w.groups.map((g) => ({
      uid: uid(), name: g.name, containerCount: g.containerCount, capacity: trim(g.capacity), unit: g.unit,
      items: g.items.map((i) => ({
        uid: uid(), majorCategory: i.majorCategory, subMajorCategory: i.subMajorCategory, size: i.size, materialClass: i.materialClass,
        originCode: i.originCode, materialCode: i.materialCode, share: i.share,
      })),
    })),
  }));
}

const toInput = (notes: string, weeks: WeekDraft[]) => ({
  notes,
  weeks: weeks.map((w) => ({
    etdWeek: w.etdWeek,
    groups: w.groups.map((g) => ({
      name: g.name.trim(), containerCount: g.containerCount, capacity: g.capacity.trim() || '0', unit: g.unit || 'CT',
      items: g.items.map((i) => ({
        majorCategory: i.majorCategory, subMajorCategory: i.subMajorCategory, size: i.size, materialClass: i.materialClass,
        originCode: i.originCode, materialCode: i.materialCode, share: i.share,
      })),
    })),
  })),
});

const copyGroup = (g: GroupDraft): GroupDraft => ({ ...g, uid: uid(), items: g.items.map((i) => ({ ...i, uid: uid() })) });

/** Edit mode of the Demand screen (spec 12): ETD weeks, container groups with their composition, Save, Submit. */
export function DemandEditor({ demand }: { demand: Demand }) {
  const { message, modal } = App.useApp();
  const utils = trpc.useUtils();
  const save = trpc.demand.save.useMutation();
  const submit = trpc.demand.submit.useMutation();
  const [notes, setNotes] = useState(demand.notes);
  const [weeks, setWeeks] = useState<WeekDraft[]>(() => fromServer(demand));
  const [dirty, setDirty] = useState(false);
  /** The version the edits started from: a refetch while editing must not make a stale save look current. */
  const [baseRowVer, setBaseRowVer] = useState(demand.rowVer);
  const [problems, setProblems] = useState<string[]>([]);
  /** Saving or submitting, including the reload after it: no second action until the demand is current. */
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);
  const allWeeks = useMemo(() => weekOptions(52), []);

  useEffect(() => {
    if (!dirty) {
      setNotes(demand.notes);
      setWeeks(fromServer(demand));
      setBaseRowVer(demand.rowVer);
    }
  }, [demand, dirty]);

  const change = (next: WeekDraft[]) => {
    setWeeks([...next].sort((a, b) => a.etdWeek.localeCompare(b.etdWeek)));
    setDirty(true);
  };
  const setWeek = (id: string, patch: Partial<WeekDraft>) => change(weeks.map((w) => (w.uid === id ? { ...w, ...patch } : w)));
  const used = new Set(weeks.map((w) => w.etdWeek));
  const addWeek = () => {
    const free = allWeeks.find((w) => !used.has(w));
    if (free) change([...weeks, { uid: uid(), etdWeek: free, groups: [{ uid: uid(), name: '', containerCount: 1, capacity: '', unit: '', items: [] }] }]);
  };
  /**
   * Copies a group into another week, adding the week when it is not there yet.
   * Identical containers are never a second group: their number goes up instead.
   */
  const copyTo = (g: GroupDraft, target: string) => {
    const existing = weeks.find((w) => w.etdWeek === target);
    const twin = existing?.groups.find((x) => sameMakeUp(x, g));
    if (existing && twin) {
      change(weeks.map((w) => (w.uid === existing.uid ? { ...w, groups: w.groups.map((x) => (x.uid === twin.uid ? { ...x, containerCount: x.containerCount + g.containerCount } : x)) } : w)));
      message.success(`${target} already had identical containers: now ${twin.containerCount + g.containerCount}`);
    } else if (existing) {
      change(weeks.map((w) => (w.uid === existing.uid ? { ...w, groups: [...w.groups, copyGroup(g)] } : w)));
      message.success(`Copied to ${target}`);
    } else {
      change([...weeks, { uid: uid(), etdWeek: target, groups: [copyGroup(g)] }]);
      message.success(`Copied to ${target} (week added)`);
    }
  };

  const run = async (what: 'save' | 'submit') => {
    setProblems([]);
    setBusy(what);
    try {
      const args = { demandId: demand.demandId, commandId: newCommandId(), rowVer: baseRowVer, content: toInput(notes, weeks) };
      const done = what === 'save'
        ? (await save.mutateAsync(args), 'Draft saved')
        : ((v: number) => `${v > 1 ? 'Resubmitted' : 'Submitted'} to Procurement (version ${v})`)((await submit.mutateAsync(args)).version);
      // Reload first, then leave edit state: resetting earlier would refill the editor from the
      // copy loaded before this save, and a quick Submit would send that stale content.
      await Promise.all([utils.demand.get.invalidate({ demandId: demand.demandId }), utils.demand.list.invalidate(), utils.work.invalidate(), utils.demand.versions.invalidate()]);
      setDirty(false);
      message.success(done);
    } catch (err) {
      const p = problemsOf(err);
      if (p.length) setProblems(p);
      else message.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const confirmSubmit = () =>
    modal.confirm({
      title: `Submit ${demand.demandNo} to Procurement?`,
      content: demand.baselineVersion ? 'This creates a new version; the baseline stays version 1.' : 'The first submission is frozen as version 1: the baseline for KPIs.',
      okText: 'Submit',
      onOk: () => run('submit'),
    });

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space wrap style={{ justifyContent: 'flex-end', width: '100%' }}>
        {dirty && <Tag color="gold">Unsaved changes</Tag>}
        <Button icon={<SaveOutlined />} loading={busy === 'save'} disabled={busy === 'submit'} onClick={() => run('save')}>Save</Button>
        {demand.actions.submit && <Button type="primary" icon={<SendOutlined />} loading={busy === 'submit'} disabled={busy === 'save'} onClick={confirmSubmit}>Submit to Procurement</Button>}
      </Space>
      {problems.length > 0 && (
        <Alert type="warning" showIcon closable onClose={() => setProblems([])} message="Please fix these first"
          description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />
      )}
      <Card size="small" title="Notes">
        <Input.TextArea id="demandNotes" rows={2} maxLength={2000} value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} />
      </Card>

      {weeks.length === 0 && <Empty description="No ETD weeks yet" />}
      {weeks.map((w) => {
        const saved = demand.weeks.find((x) => x.etdWeek === w.etdWeek);
        const containers = w.groups.reduce((s, g) => s + g.containerCount, 0);
        return (
          <Card key={w.uid} size="small"
            title={
              <Space wrap>
                <Typography.Text strong>ETD week</Typography.Text>
                <Select size="small" showSearch value={w.etdWeek} style={{ width: 210 }} aria-label="ETD week" onChange={(v) => setWeek(w.uid, { etdWeek: v })}
                  options={allWeeks.map((x) => ({ value: x, label: weekLabel(x), disabled: used.has(x) && x !== w.etdWeek }))} />
                <Tag>{containers} container{containers === 1 ? '' : 's'}</Tag>
              </Space>
            }
            extra={
              <Space>
                <Button size="small" icon={<PlusOutlined />} onClick={() => setWeek(w.uid, { groups: [...w.groups, { uid: uid(), name: '', containerCount: 1, capacity: w.groups[0]?.capacity ?? '', unit: '', items: [] }] })}>
                  Add container group
                </Button>
                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => change(weeks.filter((x) => x.uid !== w.uid))}>Remove week</Button>
              </Space>
            }>
            {w.groups.map((g, gi) => (
              <GroupCard key={g.uid} group={g} index={gi} week={w.etdWeek}
                copyTargets={allWeeks.filter((x) => x !== w.etdWeek)}
                onChange={(ng) => setWeek(w.uid, { groups: w.groups.map((x) => (x.uid === g.uid ? ng : x)) })}
                onRemove={() => setWeek(w.uid, { groups: w.groups.filter((x) => x.uid !== g.uid) })}
                onCopy={(target) => copyTo(g, target)} />
            ))}
            {saved && saved.lines.length > 0 && (
              <Table size="small" bordered rowKey="lineId" pagination={false} dataSource={saved.lines} tableLayout="fixed"
                title={() => <Typography.Text type="secondary">Resulting lines (as last saved){dirty ? ' — save to update' : ''}</Typography.Text>}
                columns={[
                  { title: 'Material', key: 'm', ellipsis: true, render: (_: unknown, l) => (l.materialCode ? `${l.materialCode} · ${l.materialDescription}` : l.subMajorCategory) },
                  { title: 'Size', dataIndex: 'sizeLabel', width: 90 },
                  { title: 'Class', dataIndex: 'classLabel', width: 110 },
                  { title: 'Origin', dataIndex: 'originCode', width: 60 },
                  { title: 'Quantity', key: 'q', width: 120, align: 'right', render: (_: unknown, l) => `${qtyText(l.ledger.requested)} ${l.unit}` },
                ]} />
            )}
          </Card>
        );
      })}
      <Button icon={<PlusOutlined />} onClick={addWeek}>Add week</Button>
    </Space>
  );
}
