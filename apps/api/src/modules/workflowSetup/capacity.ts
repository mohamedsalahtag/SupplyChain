/**
 * Container capacity (spec 32): the maximum payload per container per product, kept in Configuration → Container
 * capacity. The demand editor starts a group's "Capacity per container" from it (`capacityFor`); the saved demand keeps
 * its own number, so changing a row here never changes an existing demand.
 */
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '../workflow/errors.js';
import { isDuplicateKey, rowVerHex, updateWithRowVer, withTx, type Db } from '../workflow/tx.js';
import { capacityForGroup, capacityLabel, type CapacityItem } from './capacityMatch.js';

const name = (max: number) => z.string().trim().min(1).max(max);

export const capacityInput = z.object({
  /** null = a new row. */
  capacityId: z.number().int().positive().nullable(),
  majorCategory: name(80),
  /** null = any sub-major of the major. */
  subMajorCategory: name(80).nullable(),
  /** null = any size; a size needs a sub-major. */
  size: name(80).nullable(),
  unit: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/, 'Letters and digits only').transform((u) => u.toUpperCase()),
  capacity: z.number().int().min(1).max(99_999),
  isActive: z.boolean(),
  rowVer: z.string().nullable(),
}).refine((v) => v.size === null || v.subMajorCategory !== null, { message: 'Choose a sub-major before a size', path: ['size'] });
export type CapacityInput = z.infer<typeof capacityInput>;

export const capacityItemsInput = z.object({
  items: z.array(z.object({ majorCategory: z.string().max(80), subMajorCategory: z.string().max(80), size: z.string().max(80) })).min(1).max(100),
});

export async function listCapacities(db: Db) {
  const rows = await db
    .selectFrom('scm.ContainerCapacity as c')
    .leftJoin('app.User as u', 'u.UserId', 'c.UpdatedBy')
    .select(['c.CapacityId', 'c.MajorCategory', 'c.SubMajorCategory', 'c.Size', 'c.Unit', 'c.Capacity', 'c.IsActive', 'c.UpdatedAt', 'u.DisplayName', rowVerHex('c.RowVer').as('RowVer')])
    .orderBy('c.MajorCategory')
    .orderBy(sql`CASE WHEN c.SubMajorCategory IS NULL THEN 0 ELSE 1 END`)
    .orderBy('c.SubMajorCategory')
    .orderBy(sql`CASE WHEN c.Size IS NULL THEN 0 ELSE 1 END`)
    .orderBy('c.Size')
    .execute();
  return rows.map((r) => ({ ...r, CapacityId: Number(r.CapacityId), UpdatedAt: new Date(r.UpdatedAt).toISOString(), UpdatedByName: r.DisplayName ?? '' }));
}

/** Choices from the materials in SAP: majors, sub-majors with their major (the UI narrows by major), and the units in use. */
export async function capacityChoices(db: Db) {
  const [cats, units] = await Promise.all([
    db.selectFrom('md.Material').select(['MajorCategory', 'SubMajorCategory']).distinct()
      .where('InSap', '=', true).where('MajorCategory', '<>', '').where('SubMajorCategory', '<>', '')
      .orderBy('MajorCategory').orderBy('SubMajorCategory').execute(),
    db.selectFrom('md.Material').select('BaseUnit').select((eb) => eb.fn.countAll<number>().as('n'))
      .where('InSap', '=', true).where('BaseUnit', '<>', '').groupBy('BaseUnit').orderBy(sql`COUNT(*)`, 'desc').execute(),
  ]);
  return {
    majors: [...new Set(cats.map((c) => c.MajorCategory))],
    subMajors: cats.map((c) => ({ major: c.MajorCategory, subMajor: c.SubMajorCategory })),
    units: units.map((u) => u.BaseUnit),
  };
}

/** Sizes of one sub-major (asked when the sub-major is chosen: the full list would be large). */
export async function capacitySizes(db: Db, majorCategory: string, subMajorCategory: string) {
  const rows = await db.selectFrom('md.Material').select('Size').distinct()
    .where('InSap', '=', true).where('MajorCategory', '=', majorCategory).where('SubMajorCategory', '=', subMajorCategory).where('Size', '<>', '')
    .orderBy('Size').execute();
  return rows.map((r) => r.Size);
}

const duplicate = (v: { majorCategory: string; subMajorCategory: string | null; size: string | null }) =>
  new DomainError('DUPLICATE', `A capacity for ${capacityLabel(v)} already exists — edit that row instead.`, 409);
const stale = () => new DomainError('STALE_WRITE', 'This capacity was changed or removed by someone else. Reload and try again.', 409);

export async function saveCapacity(db: Db, userId: number, v: CapacityInput): Promise<number> {
  try {
    return await withTx(db, async (tx) => {
      // Friendly message first; the unique key still decides when two saves race.
      const same = await tx.selectFrom('scm.ContainerCapacity').select('CapacityId')
        .where('MajorCategory', '=', v.majorCategory)
        .where((eb) => (v.subMajorCategory === null ? eb('SubMajorCategory', 'is', null) : eb('SubMajorCategory', '=', v.subMajorCategory)))
        .where((eb) => (v.size === null ? eb('Size', 'is', null) : eb('Size', '=', v.size)))
        .where('CapacityId', '<>', v.capacityId ?? 0)
        .executeTakeFirst();
      if (same) throw duplicate(v);
      if (v.capacityId === null) {
        const r = await sql<{ CapacityId: number }>`
          INSERT INTO scm.ContainerCapacity (MajorCategory, SubMajorCategory, Size, Unit, Capacity, IsActive, UpdatedBy)
          OUTPUT INSERTED.CapacityId
          VALUES (${v.majorCategory}, ${v.subMajorCategory}, ${v.size}, ${v.unit}, ${v.capacity}, ${v.isActive}, ${userId})`.execute(tx);
        return Number(r.rows[0].CapacityId);
      }
      if (v.rowVer === null) throw stale();
      await updateWithRowVer(tx, 'scm.ContainerCapacity', 'CapacityId', v.capacityId, v.rowVer, sql`
        MajorCategory = ${v.majorCategory}, SubMajorCategory = ${v.subMajorCategory}, Size = ${v.size}, Unit = ${v.unit},
        Capacity = ${v.capacity}, IsActive = ${v.isActive}, UpdatedBy = ${userId}, UpdatedAt = SYSUTCDATETIME()`);
      return v.capacityId;
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw duplicate(v);
    if (err instanceof DomainError && err.code === 'STALE_WRITE') throw stale();
    throw err;
  }
}

export async function setCapacityActive(db: Db, userId: number, capacityId: number, rowVer: string, isActive: boolean): Promise<void> {
  try {
    await withTx(db, (tx) => updateWithRowVer(tx, 'scm.ContainerCapacity', 'CapacityId', capacityId, rowVer, sql`
      IsActive = ${isActive}, UpdatedBy = ${userId}, UpdatedAt = SYSUTCDATETIME()`));
  } catch (err) {
    if (err instanceof DomainError && err.code === 'STALE_WRITE') throw stale();
    throw err;
  }
}

/** Removed outright: demands keep their own number, so nothing refers to a capacity row. Returns what was removed (for the audit). */
export async function deleteCapacity(db: Db, capacityId: number, rowVer: string) {
  if (!/^[0-9A-Fa-f]{16}$/.test(rowVer)) throw stale();
  const r = await sql<{ MajorCategory: string; SubMajorCategory: string | null; Size: string | null; Capacity: number; Unit: string }>`
    DELETE FROM scm.ContainerCapacity
    OUTPUT DELETED.MajorCategory, DELETED.SubMajorCategory, DELETED.Size, DELETED.Capacity, DELETED.Unit
    WHERE CapacityId = ${capacityId} AND RowVer = CONVERT(binary(8), ${rowVer}, 2)`.execute(db);
  if (!r.rows.length) throw stale();
  return r.rows[0];
}

/** For the demand editor: the capacity of a container group made of these products (see capacityMatch.ts). */
export async function capacityFor(db: Db, items: CapacityItem[]) {
  const majors = [...new Set(items.map((i) => i.majorCategory.trim()).filter(Boolean))];
  if (!majors.length) return capacityForGroup([], items);
  const rows = await db.selectFrom('scm.ContainerCapacity')
    .select(['CapacityId', 'MajorCategory', 'SubMajorCategory', 'Size', 'Unit', 'Capacity'])
    .where(sql<boolean>`IsActive = 1`)
    .where('MajorCategory', 'in', majors)
    .execute();
  return capacityForGroup(
    rows.map((r) => ({ capacityId: Number(r.CapacityId), majorCategory: r.MajorCategory, subMajorCategory: r.SubMajorCategory, size: r.Size, unit: r.Unit, capacity: Number(r.Capacity), isActive: true })),
    items,
  );
}
