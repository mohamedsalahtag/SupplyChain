import type { Kysely, SelectQueryBuilder } from 'kysely';
import type { Database } from '../../db/schema.js';
import type { MaterialListInput } from './router.js';

type Q = SelectQueryBuilder<Database, 'md.Material', object>;

/** LIKE pattern with SQL Server wildcards escaped. */
const contains = (s: string) => `%${s.replace(/[[%_]/g, '[$&]')}%`;

function applyFilters(q: Q, f: MaterialListInput): Q {
  if (f.q) {
    const p = contains(f.q);
    q = q.where((eb) => eb.or([eb('MaterialCode', 'like', p), eb('Description', 'like', p)]));
  }
  if (f.major?.length) q = q.where('MajorCategory', 'in', f.major);
  if (f.subMajor?.length) q = q.where('SubMajorCategory', 'in', f.subMajor);
  if (f.group?.length) q = q.where('MaterialGroup', 'in', f.group);
  if (f.origin?.length) q = q.where('Origin', 'in', f.origin);
  return q;
}

export async function listMaterials(db: Kysely<Database>, f: MaterialListInput) {
  const base = applyFilters(db.selectFrom('md.Material'), f);
  let ordered = base.selectAll().orderBy(f.sortField, f.sortOrder);
  // Stable paging when the sort column has ties (SQL Server rejects a repeated column).
  if (f.sortField !== 'MaterialCode') ordered = ordered.orderBy('MaterialCode');
  const [rows, count] = await Promise.all([
    ordered
      .offset((f.page - 1) * f.pageSize)
      .fetch(f.pageSize)
      .execute(),
    base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  return { rows, total: Number(count.n) };
}

/** Distinct values for the filter dropdowns. Sub-majors carry their major so the UI can narrow them. */
export async function filterOptions(db: Kysely<Database>) {
  const distinct = (col: 'MaterialGroup' | 'Origin') =>
    db.selectFrom('md.Material').select(col).distinct().where(col, '<>', '').orderBy(col).execute();
  const [cats, groups, origins] = await Promise.all([
    db
      .selectFrom('md.Material')
      .select(['MajorCategory', 'SubMajorCategory'])
      .distinct()
      .orderBy('MajorCategory')
      .orderBy('SubMajorCategory')
      .execute(),
    distinct('MaterialGroup'),
    distinct('Origin'),
  ]);
  return {
    majors: [...new Set(cats.map((c) => c.MajorCategory))],
    subMajors: cats.filter((c) => c.SubMajorCategory !== ''),
    groups: groups.map((g) => g.MaterialGroup),
    origins: origins.map((o) => o.Origin),
  };
}
