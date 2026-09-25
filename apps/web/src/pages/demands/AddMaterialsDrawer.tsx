import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Drawer, Form, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { trpc } from '../../lib/trpc';

/** One material of a container group, as the editor holds it until Save. */
export type ItemDraft = {
  uid: string;
  majorCategory: string;
  subMajorCategory: string;
  size: string; // '' = any size
  materialClass: string; // '' = any class
  originCode: string;
  materialCode: string | null;
  share: string; // percent, up to 2 decimals
};

type Combo = { size: string; materialClass: string; available: boolean; skus: { materialCode: string; description: string }[] };

/** Splits `remaining` percent evenly over n rows, in hundredths; the last row takes the rest. */
export function evenShares(remaining: number, n: number): string[] {
  if (n <= 0) return [];
  const hundredths = Math.max(0, Math.round(remaining * 100));
  const each = Math.floor(hundredths / n);
  return Array.from({ length: n }, (_, i) => ((i === n - 1 ? hundredths - each * (n - 1) : each) / 100).toString());
}

/**
 * Adds materials to one container group (spec 12). Several sizes × several
 * classes compose into one item each (3 sizes × 2 classes = 6 items), with an
 * optional SKU per combination and a share of the container.
 */
export function AddMaterialsDrawer({ open, title, unit, remainingShare, onClose, onAdd }: {
  open: boolean;
  title: string;
  /** The group's unit, once it has one: new materials must use it. */
  unit: string | null;
  remainingShare: number;
  onClose: () => void;
  onAdd: (items: ItemDraft[], unit: string) => void;
}) {
  const [cat, setCat] = useState<string>();
  const [sub, setSub] = useState<string>();
  const [sizes, setSizes] = useState<string[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [origin, setOrigin] = useState<string>();
  const [chosenUnit, setChosenUnit] = useState<string>();
  const [rows, setRows] = useState<Record<string, { sku: string | null; share: string }>>({});

  useEffect(() => {
    if (!open) return;
    setCat(undefined); setSub(undefined); setSizes([]); setClasses([]); setOrigin(undefined); setChosenUnit(unit ?? undefined); setRows({});
  }, [open, unit]);

  const options = trpc.demand.specOptions.useQuery(
    { majorCategory: cat, subMajorCategory: sub, sizes, classes, originCode: origin },
    { enabled: open, placeholderData: (p) => p },
  );
  const o = options.data;
  const units = o?.units ?? [];
  useEffect(() => {
    if (!unit && origin && units.length && !units.some((u) => u.unit === chosenUnit)) setChosenUnit(units[0].unit);
  }, [units, origin, unit, chosenUnit]);

  const ready = !!(cat && sub && origin && chosenUnit);
  const combos = trpc.demand.composeOptions.useQuery(
    { majorCategory: cat ?? '', subMajorCategory: sub ?? '', sizes, classes, originCode: origin ?? 'XX', unit: chosenUnit ?? '' },
    { enabled: open && ready },
  );
  const comboKey = (c: Pick<Combo, 'size' | 'materialClass'>) => `${c.size}|${c.materialClass}`;
  const available = useMemo(() => (combos.data ?? []).filter((c) => c.available), [combos.data]);

  // New combinations get an even split of what is left of the container.
  useEffect(() => {
    const shares = evenShares(remainingShare, available.length);
    setRows(Object.fromEntries(available.map((c, i) => [comboKey(c), { sku: null, share: shares[i] }])));
  }, [available, remainingShare]);

  const unitMismatch = !!unit && ready && chosenUnit !== unit;
  // Shares never exceed 100%: the new materials may use only what the group has left.
  const newTotal = available.reduce((s, c) => s + (Number(rows[comboKey(c)]?.share) || 0), 0);
  const overLimit = Math.round(newTotal * 100) > Math.round(remainingShare * 100);
  const full = remainingShare <= 0;
  const add = () => {
    if (!cat || !sub || !origin || !chosenUnit) return;
    onAdd(
      available.map((c) => ({
        uid: crypto.randomUUID(), majorCategory: cat, subMajorCategory: sub, size: c.size, materialClass: c.materialClass, originCode: origin,
        materialCode: rows[comboKey(c)]?.sku ?? null, share: rows[comboKey(c)]?.share ?? '0',
      })),
      chosenUnit,
    );
    onClose();
  };

  return (
    <Drawer open={open} onClose={onClose} width={720} title={title} destroyOnClose>
      <Form layout="vertical">
        <Space wrap align="start" size={12}>
          <Form.Item label="Category" style={{ width: 200 }}>
            <Select id="matCategory" showSearch value={cat} placeholder="Choose" options={(o?.categories ?? []).map((c) => ({ value: c, label: c }))}
              onChange={(v) => { setCat(v); setSub(undefined); setSizes([]); setClasses([]); setOrigin(undefined); }} />
          </Form.Item>
          <Form.Item label="Sub-category" style={{ width: 240 }}>
            <Select id="matSub" showSearch value={sub} placeholder="Choose" disabled={!cat} options={(o?.subCategories ?? []).map((c) => ({ value: c, label: c }))}
              onChange={(v) => { setSub(v); setSizes([]); setClasses([]); setOrigin(undefined); }} />
          </Form.Item>
        </Space>
        <Space wrap align="start" size={12}>
          <Form.Item label="Sizes" extra="None chosen = any size" style={{ width: 240 }}>
            <Select id="matSizes" mode="multiple" allowClear showSearch value={sizes} disabled={!sub} placeholder="Any size"
              options={(o?.sizes ?? []).map((c) => ({ value: c, label: c }))} onChange={(v: string[]) => { setSizes(v); setClasses([]); setOrigin(undefined); }} />
          </Form.Item>
          <Form.Item label="Classes" extra="Only classes that exist for the sizes" style={{ width: 240 }}>
            <Select id="matClasses" mode="multiple" allowClear showSearch value={classes} disabled={!sub} placeholder="Any class"
              options={(o?.classes ?? []).map((c) => ({ value: c, label: c }))} onChange={(v: string[]) => { setClasses(v); setOrigin(undefined); }} />
          </Form.Item>
        </Space>
        <Space wrap align="start" size={12}>
          <Form.Item label="Origin" style={{ width: 240 }}>
            <Select id="matOrigin" showSearch optionFilterProp="label" value={origin} placeholder="Choose" disabled={!sub}
              options={(o?.origins ?? []).map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} onChange={setOrigin} />
          </Form.Item>
          <Form.Item label="Unit" extra={unit ? `The group is in ${unit}` : 'Most common first'} style={{ width: 240 }}>
            <Select id="matUnit" value={chosenUnit} disabled={!origin || !!unit} onChange={setChosenUnit}
              options={(unit ? [{ unit, name: unit }] : units).map((u) => ({ value: u.unit, label: `${u.unit} · ${u.name}` }))} />
          </Form.Item>
        </Space>
        {full && <Alert type="warning" showIcon message="This group's shares are already at 100%. Lower a share first, or add another container group." style={{ marginBottom: 8 }} />}
        {ready && !full && (
          <Alert type={overLimit ? 'error' : 'info'} showIcon style={{ marginBottom: 8 }}
            message={`New shares: ${Math.round(newTotal * 100) / 100}% of the ${remainingShare}% left in this group${overLimit ? ' — too much: shares cannot exceed 100%' : ''}`} />
        )}
        {unitMismatch && <Alert type="warning" showIcon message={`This group is in ${unit}; choose materials that come in ${unit}.`} />}

        {ready && (
          <Table<Combo>
            size="small" bordered rowKey={comboKey} pagination={false} loading={combos.isFetching} dataSource={combos.data ?? []}
            title={() => <Typography.Text strong>{(combos.data ?? []).length} combination(s) · {available.length} in SAP</Typography.Text>}
            columns={[
              { title: 'Size', key: 's', width: 110, render: (_: unknown, c) => c.size || 'any size' },
              { title: 'Class', key: 'c', width: 130, render: (_: unknown, c) => c.materialClass || 'any class' },
              {
                title: 'SKU (optional)', key: 'k',
                render: (_: unknown, c) => c.available ? (
                  <Select size="small" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} placeholder="Specification only"
                    value={rows[comboKey(c)]?.sku ?? undefined}
                    onChange={(v?: string) => setRows({ ...rows, [comboKey(c)]: { ...rows[comboKey(c)], sku: v ?? null } })}
                    options={c.skus.map((s) => ({ value: s.materialCode, label: `${s.materialCode} · ${s.description}` }))} />
                ) : <Tag>Not in SAP — skipped</Tag>,
              },
              {
                title: 'Share %', key: 'p', width: 100,
                render: (_: unknown, c) => c.available && (
                  <Input size="small" value={rows[comboKey(c)]?.share} inputMode="decimal" style={{ textAlign: 'right' }} aria-label="Share"
                    onChange={(e) => setRows({ ...rows, [comboKey(c)]: { ...rows[comboKey(c)], share: e.target.value } })} />
                ),
              },
            ]}
          />
        )}
        <Space style={{ marginTop: 12 }}>
          <Button type="primary" disabled={!ready || available.length === 0 || unitMismatch || full || overLimit} onClick={add}>
            Add {available.length || ''} material{available.length === 1 ? '' : 's'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </Space>
      </Form>
    </Drawer>
  );
}
