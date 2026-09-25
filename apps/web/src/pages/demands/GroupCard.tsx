import { useState } from 'react';
import { App, Button, Card, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { trpc } from '../../lib/trpc';
import { qtyText, shareHundredths, weekLabel } from '../../lib/workflow';
import { AddMaterialsDrawer, type ItemDraft } from './AddMaterialsDrawer';

export type GroupDraft = { uid: string; groupId?: string | null; name: string; containerCount: number; capacity: string; unit: string; items: ItemDraft[] };

/** Same capacity, unit and composition: the containers are identical (the server merges these too). */
export function sameMakeUp(a: GroupDraft, b: GroupDraft): boolean {
  const sig = (g: GroupDraft) => g.items.map((i) => `${i.majorCategory}|${i.subMajorCategory}|${i.size}|${i.materialClass}|${i.originCode}|${i.materialCode ?? ''}=${shareHundredths(i.share)}`).sort().join(';');
  return Number(a.capacity) === Number(b.capacity) && a.unit === b.unit && a.items.length === b.items.length && sig(a) === sig(b);
}

/** SKU choice for one composed item: only materials matching its size, class, origin and unit. */
function SkuCell({ item, unit, onChange }: { item: ItemDraft; unit: string; onChange: (code: string | null) => void }) {
  const [opened, setOpened] = useState(false);
  const combos = trpc.demand.composeOptions.useQuery(
    { majorCategory: item.majorCategory, subMajorCategory: item.subMajorCategory, sizes: item.size ? [item.size] : [], classes: item.materialClass ? [item.materialClass] : [], originCode: item.originCode, unit },
    { enabled: opened || !!item.materialCode, staleTime: 60_000 },
  );
  const skus = combos.data?.[0]?.skus ?? [];
  return (
    <Select size="small" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} placeholder="Specification only"
      value={item.materialCode ?? undefined} onDropdownVisibleChange={(v) => v && setOpened(true)} loading={combos.isFetching}
      onChange={(v?: string) => onChange(v ?? null)} options={skus.map((s) => ({ value: s.materialCode, label: `${s.materialCode} · ${s.description}` }))} />
  );
}

/**
 * Whole cartons per container (same rule as the server): each material gets its
 * share of the capacity rounded down; at 100% the leftover goes to the largest
 * share, so each container holds exactly its capacity. null = no valid share.
 */
function splitWhole(capacity: string, shares: string[]): (number | null)[] {
  const cap = Number(capacity);
  const hs = shares.map(shareHundredths);
  if (!Number.isInteger(cap) || cap <= 0) return hs.map(() => null);
  const per = hs.map((h) => (h === null ? null : Math.floor((cap * h) / 10_000)));
  if (hs.every((h) => h !== null) && hs.reduce((a, b) => a! + b!, 0) === 10_000) {
    const largest = hs.indexOf(Math.max(...(hs as number[])));
    per[largest]! += cap - per.reduce((a, b) => a! + b!, 0)!;
  }
  return per;
}

/**
 * One container group in the editor (spec 12): a name, the capacity per container and
 * the number of identical containers, composed of materials by share. Identical
 * containers are never repeated: raise the number of containers instead.
 */
export function GroupCard({ group, index, week, copyTargets, onChange, onRemove, onCopy }: {
  group: GroupDraft;
  index: number;
  week: string;
  /** Other weeks the group can be copied to. */
  copyTargets: string[];
  onChange: (g: GroupDraft) => void;
  onRemove: () => void;
  onCopy: (targetWeek: string) => void;
}) {
  const { message } = App.useApp();
  const [adding, setAdding] = useState(false);
  const [copying, setCopying] = useState(false);
  const [target, setTarget] = useState<string>();
  const total = group.items.reduce((s, i) => s + (shareHundredths(i.share) ?? 0), 0);

  /** Shares never exceed 100%: a share is capped at what the other materials leave. */
  const setShare = (uid: string, value: string) => {
    const h = shareHundredths(value);
    const others = group.items.filter((i) => i.uid !== uid).reduce((s, i) => s + (shareHundredths(i.share) ?? 0), 0);
    let share = value;
    if (h !== null && others + h > 10_000) {
      share = String((10_000 - others) / 100);
      message.warning(`Shares cannot exceed 100% — capped at ${share}%`);
    }
    onChange({ ...group, items: group.items.map((i) => (i.uid === uid ? { ...i, share } : i)) });
  };
  const setItem = (uid: string, patch: Partial<ItemDraft>) => onChange({ ...group, items: group.items.map((i) => (i.uid === uid ? { ...i, ...patch } : i)) });
  const label = group.name.trim() || `Group ${index + 1}`;
  const split = splitWhole(group.capacity, group.items.map((i) => i.share));
  const perOf = (uid: string) => split[group.items.findIndex((i) => i.uid === uid)];

  return (
    <Card size="small" type="inner" style={{ marginBottom: 8 }}
      title={
        <Space wrap size={[12, 4]}>
          <Space size={4}>
            <Typography.Text type="secondary">Container group</Typography.Text>
            <Input size="small" value={group.name} placeholder={`Group ${index + 1}`} maxLength={60} onChange={(e) => onChange({ ...group, name: e.target.value })} style={{ width: 150 }} aria-label="Container group" />
          </Space>
          <Space size={4}>
            <Typography.Text type="secondary">Capacity per container</Typography.Text>
            <InputNumber size="small" min={1} max={99_999} precision={0} value={group.capacity === '' ? null : Number(group.capacity)}
              onChange={(v) => onChange({ ...group, capacity: v == null ? '' : String(Math.trunc(v)) })} style={{ width: 90 }} aria-label="Capacity" />
            <Typography.Text>{group.unit || '(unit from the first material)'}</Typography.Text>
          </Space>
          <Space size={4}>
            <Typography.Text type="secondary">Number of containers</Typography.Text>
            <InputNumber size="small" min={1} max={999} value={group.containerCount} onChange={(v) => onChange({ ...group, containerCount: v ?? 1 })} style={{ width: 70 }} aria-label="Containers" />
          </Space>
          <Tag color={total === 10_000 ? 'green' : 'orange'}>Shares {total / 100}%{total < 10_000 ? ` · ${(10_000 - total) / 100}% left` : ''}</Tag>
        </Space>
      }
      extra={
        <Space size={4}>
          <Button size="small" icon={<PlusOutlined />} disabled={total >= 10_000 && group.items.length > 0} onClick={() => setAdding(true)}>Add materials</Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => { setTarget(undefined); setCopying(true); }}>Copy to week…</Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={onRemove}>Remove</Button>
        </Space>
      }>
      <Table<ItemDraft>
        size="small" bordered rowKey="uid" pagination={false} dataSource={group.items} tableLayout="fixed" locale={{ emptyText: 'Add materials to compose these containers' }}
        columns={[
          { title: 'Material', key: 'm', ellipsis: true, render: (_: unknown, i) => i.subMajorCategory },
          { title: 'Size', key: 's', width: 80, render: (_: unknown, i) => i.size || 'any' },
          { title: 'Class', key: 'c', width: 100, ellipsis: true, render: (_: unknown, i) => i.materialClass || 'any' },
          { title: 'Origin', dataIndex: 'originCode', width: 60 },
          { title: 'SKU', key: 'k', width: 240, render: (_: unknown, i) => <SkuCell item={i} unit={group.unit} onChange={(code) => setItem(i.uid, { materialCode: code })} /> },
          {
            title: 'Share %', key: 'p', width: 90,
            render: (_: unknown, i) => (
              <Input size="small" value={i.share} inputMode="decimal" status={shareHundredths(i.share) === null ? 'error' : undefined} style={{ textAlign: 'right' }}
                aria-label="Share" onChange={(e) => setShare(i.uid, e.target.value)} />
            ),
          },
          { title: 'Per container', key: 'pc', width: 100, align: 'right', render: (_: unknown, i) => { const p = perOf(i.uid); return p == null ? '—' : qtyText(String(p)); } },
          { title: `All ${group.containerCount}`, key: 'gt', width: 100, align: 'right', render: (_: unknown, i) => { const p = perOf(i.uid); return p == null ? '—' : qtyText(String(p * group.containerCount)); } },
          { title: '', key: 'x', width: 70, render: (_: unknown, i) => <Button size="small" type="link" danger onClick={() => onChange({ ...group, items: group.items.filter((x) => x.uid !== i.uid) })}>Remove</Button> },
        ]}
      />
      <AddMaterialsDrawer open={adding} title={`Add materials to ${week} · ${label}`} unit={group.items.length ? group.unit : null}
        remainingShare={Math.max(0, (10_000 - total) / 100)} onClose={() => setAdding(false)}
        onAdd={(items, unit) => onChange({ ...group, unit, items: [...group.items, ...items] })} />
      <Modal open={copying} title={`Copy ${label} to…`} okText="Copy" okButtonProps={{ disabled: !target }} onCancel={() => setCopying(false)}
        onOk={() => { if (target) onCopy(target); setCopying(false); }}>
        <Select id="copyTarget" showSearch style={{ width: '100%' }} value={target} onChange={setTarget} placeholder="ETD week"
          options={copyTargets.map((w) => ({ value: w, label: weekLabel(w) }))} />
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          A week not yet on the demand is added. If that week already has identical containers, their number goes up instead of adding a second group.
          To add identical containers in this week, raise the number of containers.
        </Typography.Paragraph>
      </Modal>
    </Card>
  );
}
