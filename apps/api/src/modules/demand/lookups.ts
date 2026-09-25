/**
 * Choices for composing a container (spec 12). Only combinations that exist
 * among materials in SAP whose origin is mapped to a country (spec 11) are
 * offered. An empty size or class means "any size" / "any class".
 */
import { sql } from 'kysely';
import { countryName } from '../workflow/origins.js';
import type { Db, Tx } from '../workflow/tx.js';

export type SpecFilter = { majorCategory?: string; subMajorCategory?: string; sizes?: string[]; classes?: string[]; originCode?: string; unit?: string };

/** Materials usable on a demand: in SAP, origin mapped to a country. */
function usable(db: Db | Tx) {
  return db
    .selectFrom('md.Material as m')
    .innerJoin('scm.RefOrigin as o', 'o.OriginName', 'm.Origin')
    .where('m.InSap', '=', true)
    .where('o.CountryCode', 'is not', null);
}

function filtered(db: Db | Tx, f: SpecFilter) {
  let q = usable(db);
  if (f.majorCategory !== undefined) q = q.where('m.MajorCategory', '=', f.majorCategory);
  if (f.subMajorCategory !== undefined) q = q.where('m.SubMajorCategory', '=', f.subMajorCategory);
  const sizes = (f.sizes ?? []).filter(Boolean);
  if (sizes.length) q = q.where('m.Size', 'in', sizes);
  const classes = (f.classes ?? []).filter(Boolean);
  if (classes.length) q = q.where('m.MaterialClass', 'in', classes);
  if (f.originCode) q = q.where('o.CountryCode', '=', f.originCode);
  if (f.unit) q = q.where('m.BaseUnit', '=', f.unit);
  return q;
}

const distinct = async (db: Db, col: 'm.MajorCategory' | 'm.SubMajorCategory' | 'm.Size' | 'm.MaterialClass', f: SpecFilter) =>
  (await filtered(db, f).select(col).distinct().where(col, '<>', '').orderBy(col).execute()).map((r) => Object.values(r)[0] as string);

/** Each level narrows the next: category → sub-category → sizes → classes → origin → unit. */
export async function specOptions(db: Db, f: SpecFilter) {
  const base = { majorCategory: f.majorCategory, subMajorCategory: f.subMajorCategory };
  const [categories, subCategories, sizes, classes, origins, units] = await Promise.all([
    distinct(db, 'm.MajorCategory', {}),
    f.majorCategory ? distinct(db, 'm.SubMajorCategory', { majorCategory: f.majorCategory }) : [],
    f.subMajorCategory ? distinct(db, 'm.Size', base) : [],
    f.subMajorCategory ? distinct(db, 'm.MaterialClass', { ...base, sizes: f.sizes }) : [],
    f.subMajorCategory
      ? filtered(db, { ...base, sizes: f.sizes, classes: f.classes }).select('o.CountryCode').distinct().orderBy('o.CountryCode').execute()
      : [],
    f.originCode
      ? filtered(db, { ...base, sizes: f.sizes, classes: f.classes, originCode: f.originCode })
          .select(['m.BaseUnit', 'm.BaseUnitName']).select((eb) => eb.fn.countAll<number>().as('n'))
          .groupBy(['m.BaseUnit', 'm.BaseUnitName']).orderBy(sql`COUNT(*)`, 'desc').execute()
      : [],
  ]);
  return {
    categories,
    subCategories,
    sizes,
    classes,
    origins: origins.map((o) => ({ code: o.CountryCode!, name: countryName(o.CountryCode) })),
    /** Most common first: the default. */
    units: units.map((u) => ({ unit: u.BaseUnit, name: u.BaseUnitName, materials: Number(u.n) })),
  };
}

export type ComposeCriteria = { majorCategory: string; subMajorCategory: string; sizes: string[]; classes: string[]; originCode: string; unit: string };

/** Every size × class combination, whether SAP has it, and its matching SKUs (spec 12: "3 sizes × 2 classes = 6 materials"). */
export async function composeOptions(db: Db, c: ComposeCriteria) {
  const sizes = c.sizes.length ? c.sizes : [''];
  const classes = c.classes.length ? c.classes : [''];
  const materials = await filtered(db, { majorCategory: c.majorCategory, subMajorCategory: c.subMajorCategory, sizes: c.sizes, classes: c.classes, originCode: c.originCode, unit: c.unit })
    .select(['m.MaterialCode', 'm.Description', 'm.Size', 'm.MaterialClass'])
    .orderBy('m.MaterialCode')
    .execute();
  return sizes.flatMap((size) =>
    classes.map((materialClass) => {
      const skus = materials
        .filter((m) => (!size || m.Size === size) && (!materialClass || m.MaterialClass === materialClass))
        .map((m) => ({ materialCode: m.MaterialCode, description: m.Description }));
      return { size, materialClass, available: skus.length > 0, skus };
    }),
  );
}

export async function searchMaterials(db: Db, q: string) {
  const p = `%${q.replace(/[[%_]/g, '[$&]')}%`;
  const rows = await usable(db)
    .select(['m.MaterialCode', 'm.Description', 'm.MajorCategory', 'm.SubMajorCategory', 'm.Size', 'm.MaterialClass', 'm.BaseUnit', 'o.CountryCode'])
    .where((eb) => eb.or([eb('m.MaterialCode', 'like', p), eb('m.Description', 'like', p)]))
    .orderBy('m.MaterialCode')
    .top(25)
    .execute();
  return rows.map((r) => ({ ...r, CountryCode: r.CountryCode! }));
}

/** The material, if usable and matching the item's criteria (an empty size/class matches any). */
export async function skuForCriteria(
  db: Db | Tx,
  materialCode: string,
  c: { majorCategory: string; subMajorCategory: string; size: string; materialClass: string; originCode: string; unit: string },
) {
  const m = await usable(db)
    .select(['m.MaterialCode', 'm.Description', 'm.MajorCategory', 'm.SubMajorCategory', 'm.Size', 'm.MaterialClass', 'm.BaseUnit', 'o.CountryCode'])
    .where('m.MaterialCode', '=', materialCode)
    .executeTakeFirst();
  if (!m) return null;
  const ok = m.MajorCategory === c.majorCategory && m.SubMajorCategory === c.subMajorCategory && m.CountryCode === c.originCode && m.BaseUnit === c.unit
    && (!c.size || m.Size === c.size) && (!c.materialClass || m.MaterialClass === c.materialClass);
  return ok ? m : null;
}

/** Usable materials (SKUs) of one specification and unit, e.g. for a quoted SKU (spec 18). */
export async function skusForSpec(db: Db | Tx, c: { majorCategory: string; subMajorCategory: string; size: string; materialClass: string; originCode: string; unit: string }) {
  return filtered(db, { majorCategory: c.majorCategory, subMajorCategory: c.subMajorCategory, sizes: c.size ? [c.size] : [], classes: c.materialClass ? [c.materialClass] : [], originCode: c.originCode, unit: c.unit })
    .select(['m.MaterialCode', 'm.Description']).orderBy('m.MaterialCode').top(50).execute();
}

/** Does at least one usable material match this specification and unit? */
export async function specExists(db: Db | Tx, c: { majorCategory: string; subMajorCategory: string; size: string; materialClass: string; originCode: string; unit: string }): Promise<boolean> {
  const r = await filtered(db, { majorCategory: c.majorCategory, subMajorCategory: c.subMajorCategory, sizes: [c.size], classes: [c.materialClass], originCode: c.originCode, unit: c.unit })
    .select('m.MaterialCode').top(1).executeTakeFirst();
  return !!r;
}

export const anySize = (size: string) => size || 'any size';
export const anyClass = (cls: string) => cls || 'any class';
export const specLabel = (l: { MajorCategory: string; SubMajorCategory: string; Size: string; MaterialClass?: string }) =>
  `${l.MajorCategory} · ${l.SubMajorCategory} · ${anySize(l.Size)} · ${anyClass(l.MaterialClass ?? '')}`;
