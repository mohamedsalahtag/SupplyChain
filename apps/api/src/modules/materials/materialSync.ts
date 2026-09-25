/**
 * Materials sync (spec 02). Started only by a user; runs in the background and
 * records every run in integ.SyncRun. All SAP pages are read before anything is
 * written, and the write is one transaction — a failure leaves md.Material as it was.
 */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { fetchAllRows } from '../../sap/odata.js';
import { finishRun } from '../sync/syncRun.js';
import { refreshOrigins } from '../workflow/origins.js';
import type { SapConnection } from '../../settings/sapConnection.js';
import { buildSapFilter, mapSapMaterial, SAP_ORDER_BY, type MaterialRow } from './sapMaterial.js';

type Counts = { inserted: number; updated: number; missing: number };

/** Upserts the full list and marks rows SAP no longer returns as Not in SAP. */
async function applyMaterials(db: Kysely<Database>, rows: MaterialRow[]): Promise<Counts> {
  const json = JSON.stringify(rows);
  const result = await sql<Counts>`
    SET NOCOUNT ON;
    DECLARE @out TABLE (Act nvarchar(10), InSap bit);
    MERGE md.Material AS t
    USING (SELECT * FROM OPENJSON(${json}) WITH (
      MaterialCode nvarchar(40), Description nvarchar(200), MajorCategoryCode nvarchar(10), MajorCategory nvarchar(80),
      SubMajorCategory nvarchar(80), MaterialGroupCode nvarchar(20), MaterialGroup nvarchar(80), MaterialType nvarchar(10),
      BaseUnit nvarchar(10), BaseUnitName nvarchar(40), Origin nvarchar(80), Variety nvarchar(80), Size nvarchar(80),
      Weight decimal(18, 3), WeightUnit nvarchar(10), MaterialClassCode nvarchar(20), MaterialClass nvarchar(80))) AS s
    ON t.MaterialCode = s.MaterialCode
    WHEN MATCHED AND (t.InSap = 0 OR EXISTS (
        SELECT s.Description, s.MajorCategoryCode, s.MajorCategory, s.SubMajorCategory, s.MaterialGroupCode, s.MaterialGroup,
               s.MaterialType, s.BaseUnit, s.BaseUnitName, s.Origin, s.Variety, s.Size, s.Weight, s.WeightUnit,
               s.MaterialClassCode, s.MaterialClass
        EXCEPT
        SELECT t.Description, t.MajorCategoryCode, t.MajorCategory, t.SubMajorCategory, t.MaterialGroupCode, t.MaterialGroup,
               t.MaterialType, t.BaseUnit, t.BaseUnitName, t.Origin, t.Variety, t.Size, t.Weight, t.WeightUnit,
               t.MaterialClassCode, t.MaterialClass)) THEN
      UPDATE SET Description = s.Description, MajorCategoryCode = s.MajorCategoryCode, MajorCategory = s.MajorCategory,
                 SubMajorCategory = s.SubMajorCategory, MaterialGroupCode = s.MaterialGroupCode, MaterialGroup = s.MaterialGroup,
                 MaterialType = s.MaterialType, BaseUnit = s.BaseUnit, BaseUnitName = s.BaseUnitName, Origin = s.Origin,
                 Variety = s.Variety, Size = s.Size, Weight = s.Weight, WeightUnit = s.WeightUnit,
                 MaterialClassCode = s.MaterialClassCode, MaterialClass = s.MaterialClass,
                 InSap = 1, SapChangedAt = SYSUTCDATETIME()
    WHEN NOT MATCHED BY TARGET THEN
      INSERT (MaterialCode, Description, MajorCategoryCode, MajorCategory, SubMajorCategory, MaterialGroupCode, MaterialGroup,
              MaterialType, BaseUnit, BaseUnitName, Origin, Variety, Size, Weight, WeightUnit, MaterialClassCode, MaterialClass)
      VALUES (s.MaterialCode, s.Description, s.MajorCategoryCode, s.MajorCategory, s.SubMajorCategory, s.MaterialGroupCode,
              s.MaterialGroup, s.MaterialType, s.BaseUnit, s.BaseUnitName, s.Origin, s.Variety, s.Size, s.Weight, s.WeightUnit,
              s.MaterialClassCode, s.MaterialClass)
    WHEN NOT MATCHED BY SOURCE AND t.InSap = 1 THEN
      UPDATE SET InSap = 0, SapChangedAt = SYSUTCDATETIME()
    OUTPUT $action, inserted.InSap INTO @out;
    SELECT ISNULL(SUM(CASE WHEN Act = 'INSERT' THEN 1 ELSE 0 END), 0) AS inserted,
           ISNULL(SUM(CASE WHEN Act = 'UPDATE' AND InSap = 1 THEN 1 ELSE 0 END), 0) AS updated,
           ISNULL(SUM(CASE WHEN Act = 'UPDATE' AND InSap = 0 THEN 1 ELSE 0 END), 0) AS missing
    FROM @out;`.execute(db);
  return result.rows[0];
}

/** Reads SAP, applies the list, and closes the run as Succeeded or Failed. Never throws. */
export async function runMaterialSync(
  db: Kysely<Database>,
  conn: SapConnection,
  materialTypes: readonly string[],
  runId: number,
): Promise<void> {
  let rowsRead: number | null = null;
  try {
    const sapRows = await fetchAllRows(conn, { path: conn.materialsPath, version: 'v2' }, { filter: buildSapFilter(materialTypes), orderBy: SAP_ORDER_BY });
    rowsRead = sapRows.length;
    // One row per material code (last wins), so MERGE never sees a duplicate.
    const byCode = new Map<string, MaterialRow>();
    for (const r of sapRows) {
      const m = mapSapMaterial(r, materialTypes);
      if (m) byCode.set(m.MaterialCode, m);
    }
    const counts = await db.transaction().execute((trx) => applyMaterials(trx, [...byCode.values()]));
    const numericCodes = sapRows.filter((r) => /^\d/.test(String(r.MATERAIL ?? '').trim())).length;
    const otherSkipped = rowsRead - byCode.size - numericCodes;
    const notes = [
      numericCodes > 0 ? `${numericCodes} skipped because the code starts with a number` : '',
      otherSkipped > 0 ? `${otherSkipped} skipped as duplicate or outside the include rule` : '',
    ].filter(Boolean);
    // Logged step (spec 11): new origin names are added to the origin map and matched to countries.
    // The materials are already saved, so a failure here is reported in the note, not as a failed run.
    const originNote = await refreshOrigins(db).then(
      (o) => `Origins: ${o.total} names, ${o.unmatched} not mapped to a country.`,
      (err: unknown) => `Origin map not refreshed: ${err instanceof Error ? err.message : String(err)}.`,
    );
    const note = [notes.length ? `SAP rows: ${notes.join('; ')}.` : '', originNote].filter(Boolean).join(' ');
    await finishRun(db, runId, 'Succeeded', { read: rowsRead, ...counts }, note);
  } catch (err) {
    await finishRun(db, runId, 'Failed', { read: rowsRead }, err instanceof Error ? err.message : String(err));
  }
}
