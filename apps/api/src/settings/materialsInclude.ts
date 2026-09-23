/**
 * Which SAP material types the materials sync copies (Configuration →
 * Materials sync), and the list of types SAP offers, cached from the last check.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/schema.js';
import { DEFAULT_MATERIAL_TYPES, MATERIAL_TYPE_CODE } from '../modules/materials/sapMaterial.js';
import { fetchAllRows } from '../sap/odata.js';
import type { SapConnection } from './sapConnection.js';
import { readSetting, writeSetting } from './store.js';

const INCLUDE_KEY = 'sap.materials.include';
const TYPES_KEY = 'sap.materials.types';

export const includeSchema = z.object({
  materialTypes: z.array(z.string().regex(MATERIAL_TYPE_CODE, 'Invalid material type')).min(1, 'Choose at least one material type').max(50),
});
export type MaterialsInclude = z.infer<typeof includeSchema>;

const typesSchema = z.object({
  types: z.array(z.object({ code: z.string(), count: z.number() })),
  checkedAt: z.string(),
});
export type AvailableTypes = z.infer<typeof typesSchema>;

export async function loadInclude(db: Kysely<Database>): Promise<MaterialsInclude> {
  const parsed = includeSchema.safeParse(await readSetting(db, INCLUDE_KEY));
  return parsed.success ? parsed.data : { materialTypes: DEFAULT_MATERIAL_TYPES };
}

export const saveInclude = (db: Kysely<Database>, input: MaterialsInclude) =>
  writeSetting(db, INCLUDE_KEY, includeSchema.parse({ materialTypes: [...new Set(input.materialTypes)].sort() }));

export async function loadAvailableTypes(db: Kysely<Database>): Promise<AvailableTypes | null> {
  const parsed = typesSchema.safeParse(await readSetting(db, TYPES_KEY));
  return parsed.success ? parsed.data : null;
}

/** Reads every material's type from SAP (one small column) and stores the counts. */
export async function refreshAvailableTypes(db: Kysely<Database>, conn: SapConnection): Promise<AvailableTypes> {
  const rows = await fetchAllRows(conn, { path: conn.materialsPath, version: 'v2' }, { select: 'Material_Type', orderBy: 'MATERAIL' });
  const counts = new Map<string, number>();
  for (const r of rows) {
    const code = String(r.Material_Type ?? '').trim();
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const result: AvailableTypes = {
    types: [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    checkedAt: new Date().toISOString(),
  };
  await writeSetting(db, TYPES_KEY, result);
  return result;
}
