import { useEffect } from 'react';
import { Select, Space } from 'antd';
import { trpc } from '../../lib/trpc';

export type Spec = { majorCategory: string; subMajorCategory: string; size: string; materialClass: string; originCode: string; materialCode: string | null; unit: string };
export const emptySpec: Spec = { majorCategory: '', subMajorCategory: '', size: '', materialClass: '', originCode: '', materialCode: null, unit: '' };
export const specComplete = (s: Spec) => !!(s.majorCategory && s.subMajorCategory && s.originCode && s.unit);
export const specLabel = (s: Spec) => [s.subMajorCategory, s.size || 'any size', s.materialClass || 'any class', s.originCode, s.materialCode].filter(Boolean).join(' ');

/**
 * One material specification (spec 19): category → sub-category → size → class → origin → unit,
 * each narrowing the next (the same choices as demand entry), and an optional SKU.
 */
export function SpecPicker({ value, onChange, idPrefix }: { value: Spec; onChange: (s: Spec) => void; idPrefix: string }) {
  const opts = trpc.demand.specOptions.useQuery({
    majorCategory: value.majorCategory || undefined, subMajorCategory: value.subMajorCategory || undefined,
    sizes: value.size ? [value.size] : undefined, classes: value.materialClass ? [value.materialClass] : undefined, originCode: value.originCode || undefined,
  }, { placeholderData: (p) => p });
  const skus = trpc.demand.composeOptions.useQuery({
    majorCategory: value.majorCategory, subMajorCategory: value.subMajorCategory, sizes: value.size ? [value.size] : [], classes: value.materialClass ? [value.materialClass] : [],
    originCode: value.originCode, unit: value.unit,
  }, { enabled: specComplete(value) });
  const set = (patch: Partial<Spec>) => onChange({ ...value, ...patch });
  const units = opts.data?.units ?? [];
  useEffect(() => { // the most common unit is the default
    if (value.originCode && !value.unit && units.length) onChange({ ...value, unit: units[0].unit });
  }, [value, units, onChange]);

  const list = (xs: string[] | undefined) => (xs ?? []).map((x) => ({ value: x, label: x }));
  return (
    <Space wrap size={6}>
      <Select id={`${idPrefix}Category`} showSearch placeholder="Category" style={{ width: 150 }} value={value.majorCategory || undefined} options={list(opts.data?.categories)}
        onChange={(v: string) => onChange({ ...emptySpec, majorCategory: v })} />
      <Select id={`${idPrefix}Sub`} showSearch placeholder="Sub-category" style={{ width: 200 }} value={value.subMajorCategory || undefined} options={list(opts.data?.subCategories)}
        disabled={!value.majorCategory} onChange={(v: string) => onChange({ ...emptySpec, majorCategory: value.majorCategory, subMajorCategory: v })} />
      <Select id={`${idPrefix}Size`} showSearch allowClear placeholder="Size" style={{ width: 110 }} value={value.size || undefined} options={list(opts.data?.sizes)}
        disabled={!value.subMajorCategory} onChange={(v?: string) => set({ size: v ?? '', materialClass: '', originCode: '', unit: '', materialCode: null })} />
      <Select id={`${idPrefix}Class`} showSearch allowClear placeholder="Class" style={{ width: 130 }} value={value.materialClass || undefined} options={list(opts.data?.classes)}
        disabled={!value.subMajorCategory} onChange={(v?: string) => set({ materialClass: v ?? '', originCode: '', unit: '', materialCode: null })} />
      <Select id={`${idPrefix}Origin`} showSearch placeholder="Origin" style={{ width: 110 }} value={value.originCode || undefined}
        options={(opts.data?.origins ?? []).map((o) => ({ value: o.code, label: `${o.code} · ${o.name}` }))} disabled={!value.subMajorCategory}
        onChange={(v: string) => set({ originCode: v, unit: '', materialCode: null })} />
      <Select id={`${idPrefix}Unit`} placeholder="Unit" style={{ width: 90 }} value={value.unit || undefined} options={units.map((u) => ({ value: u.unit, label: u.unit }))}
        disabled={!value.originCode} onChange={(v: string) => set({ unit: v, materialCode: null })} />
      <Select id={`${idPrefix}Sku`} allowClear placeholder="SKU (optional)" style={{ width: 220 }} value={value.materialCode ?? undefined} disabled={!specComplete(value)}
        options={(skus.data ?? []).flatMap((c) => c.skus).map((k) => ({ value: k.materialCode, label: `${k.materialCode} ${k.description}` }))}
        onChange={(v?: string) => set({ materialCode: v ?? null })} />
    </Space>
  );
}
