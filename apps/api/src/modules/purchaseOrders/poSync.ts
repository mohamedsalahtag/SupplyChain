/**
 * Purchase orders sync (spec 09). First run (or after the chosen types / start
 * date change, or "Re-sync everything"): every order of the chosen Z types on or
 * after the start date. Later runs: only orders SAP changed since the last
 * successful run (watermark), looking back one hour.
 *
 * Each page is written in its own transaction and every write is keyed by the
 * order number, so running again — or re-running after a failure — never
 * duplicates anything. The watermark only moves after a fully successful run.
 */
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/schema.js';
import { entityPath, fetchAllRows, forEachPage, type ODataTarget } from '../../sap/odata.js';
import type { SapConnection } from '../../settings/sapConnection.js';
import { readSetting, writeSetting } from '../../settings/store.js';
import { storeCodeCounts } from '../sync/codeList.js';
import { finishRun } from '../sync/syncRun.js';
import { buildPoFilter, ISO_DATE, mapPurchaseOrder, PO_QUERY, Z_CODE, type PoHeader, type PoLine } from './sapPurchaseOrder.js';

export const TYPES_KEY = 'sap.po.types';
const INCLUDE_KEY = 'sap.po.include';
const WATERMARK_KEY = 'sap.po.watermark';
const PAGE_SIZE = 1000; // orders per page, each with its lines

export const poIncludeSchema = z.object({
  orderTypes: z.array(z.string().regex(Z_CODE, 'Only order types starting with Z')).max(50),
  startDate: z.string().regex(ISO_DATE, 'Start date must be YYYY-MM-DD').nullable(),
});
export type PoInclude = z.infer<typeof poIncludeSchema>;

const target = (conn: SapConnection): ODataTarget => ({ path: entityPath(conn.purchaseOrdersPath, 'PurchaseOrder'), version: 'v4' });

export async function loadPoInclude(db: Kysely<Database>): Promise<PoInclude> {
  const parsed = poIncludeSchema.safeParse(await readSetting(db, INCLUDE_KEY));
  return parsed.success ? parsed.data : { orderTypes: [], startDate: null };
}

export async function loadWatermark(db: Kysely<Database>): Promise<Date | null> {
  const v = await readSetting(db, WATERMARK_KEY);
  const d = typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
const saveWatermark = (db: Kysely<Database>, d: Date | null) => writeSetting(db, WATERMARK_KEY, d ? d.toISOString() : null);

/** Saves the choice. A different choice clears the watermark, so the next sync is a full one. */
export async function savePoInclude(db: Kysely<Database>, input: PoInclude): Promise<{ fullNext: boolean }> {
  const next = poIncludeSchema.parse({ orderTypes: [...new Set(input.orderTypes)].sort(), startDate: input.startDate });
  const prev = await loadPoInclude(db);
  const changed = prev.startDate !== next.startDate || prev.orderTypes.join() !== next.orderTypes.join();
  await writeSetting(db, INCLUDE_KEY, next);
  if (changed) await saveWatermark(db, null);
  return { fullNext: changed };
}

/** Reads every order's type from SAP (~60 pages, under a minute) and keeps the Z types with their counts. */
export async function refreshPoTypes(db: Kysely<Database>, conn: SapConnection) {
  const rows = await fetchAllRows(conn, target(conn), { select: 'PurchaseOrderType', orderBy: 'PurchaseOrder', pageSize: 5000 });
  return storeCodeCounts(db, TYPES_KEY, rows, 'PurchaseOrderType', (c) => Z_CODE.test(c));
}

type PageCounts = { inserted: number; updated: number; removed: number; lines: number };

/** Writes one page: upsert headers, replace their lines, remove orders that must not be kept. */
async function applyPage(db: Kysely<Database>, headers: PoHeader[], lines: PoLine[], remove: string[]): Promise<PageCounts> {
  return db.transaction().execute(async (trx) => {
    let inserted = 0;
    let updated = 0;
    if (headers.length) {
      const r = await sql<{ inserted: number; updated: number }>`
        SET NOCOUNT ON;
        DECLARE @out TABLE (Act nvarchar(10));
        MERGE md.PurchaseOrder AS t
        USING (SELECT * FROM OPENJSON(${JSON.stringify(headers)}) WITH (
          PurchaseOrder nvarchar(20), OrderType nvarchar(10), SupplierCode nvarchar(20), OrderDate date,
          Currency nvarchar(5), SapLastChangedAt datetime2(3))) AS s
        ON t.PurchaseOrder = s.PurchaseOrder
        WHEN MATCHED AND EXISTS (SELECT s.OrderType, s.SupplierCode, s.OrderDate, s.Currency, s.SapLastChangedAt
                                 EXCEPT SELECT t.OrderType, t.SupplierCode, t.OrderDate, t.Currency, t.SapLastChangedAt) THEN
          UPDATE SET OrderType = s.OrderType, SupplierCode = s.SupplierCode, OrderDate = s.OrderDate, Currency = s.Currency,
                     SapLastChangedAt = s.SapLastChangedAt, SapChangedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (PurchaseOrder, OrderType, SupplierCode, OrderDate, Currency, SapLastChangedAt)
          VALUES (s.PurchaseOrder, s.OrderType, s.SupplierCode, s.OrderDate, s.Currency, s.SapLastChangedAt)
        OUTPUT $action INTO @out;
        SELECT ISNULL(SUM(CASE WHEN Act = 'INSERT' THEN 1 ELSE 0 END), 0) AS inserted,
               ISNULL(SUM(CASE WHEN Act = 'UPDATE' THEN 1 ELSE 0 END), 0) AS updated FROM @out;`.execute(trx);
      inserted = Number(r.rows[0].inserted);
      updated = Number(r.rows[0].updated);

      // The order's current lines replace whatever was stored: no duplicates, and lines deleted in SAP disappear.
      const pos = JSON.stringify(headers.map((h) => h.PurchaseOrder));
      await sql`DELETE FROM md.PurchaseOrderLine WHERE PurchaseOrder IN (SELECT value FROM OPENJSON(${pos}))`.execute(trx);
      if (lines.length) {
        await sql`
          INSERT INTO md.PurchaseOrderLine (PurchaseOrder, ItemNo, Material, Quantity, Unit, NetPrice, PriceQuantity)
          SELECT PurchaseOrder, ItemNo, Material, Quantity, Unit, NetPrice, PriceQuantity FROM OPENJSON(${JSON.stringify(lines)}) WITH (
            PurchaseOrder nvarchar(20), ItemNo int, Material nvarchar(40), Quantity decimal(18, 3), Unit nvarchar(10),
            NetPrice decimal(18, 4), PriceQuantity decimal(18, 3))`.execute(trx);
      }
    }
    let removed = 0;
    if (remove.length) {
      const r = await sql`DELETE FROM md.PurchaseOrder WHERE PurchaseOrder IN (SELECT value FROM OPENJSON(${JSON.stringify(remove)}))`.execute(trx);
      removed = Number(r.numAffectedRows ?? 0); // lines go with them (ON DELETE CASCADE)
    }
    return { inserted, updated, removed, lines: lines.length };
  });
}

/** After a full run: drop orders outside the rule, and orders SAP no longer returned. */
async function removeOutsideRule(db: Kysely<Database>, include: { orderTypes: string[]; startDate: string }, seen: Set<string>): Promise<number> {
  const r = await sql`
    DELETE FROM md.PurchaseOrder
    WHERE OrderType NOT IN (SELECT value FROM OPENJSON(${JSON.stringify(include.orderTypes)}))
       OR OrderDate < ${include.startDate}
       OR PurchaseOrder NOT IN (SELECT value FROM OPENJSON(${JSON.stringify([...seen])}))`.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

/** Reads SAP page by page, writes each page, records the result. Never throws. */
export async function runPoSync(
  db: Kysely<Database>,
  conn: SapConnection,
  include: { orderTypes: string[]; startDate: string },
  runId: number,
  forceFull: boolean,
): Promise<void> {
  const totals = { read: 0, inserted: 0, updated: 0, removed: 0, lines: 0 };
  try {
    const watermark = forceFull ? null : await loadWatermark(db);
    const full = !watermark;
    let newest = watermark;
    const seen = new Set<string>();

    await forEachPage(conn, target(conn), { ...PO_QUERY, filter: buildPoFilter(include.orderTypes, include.startDate, watermark), pageSize: PAGE_SIZE, maxPages: 2000 }, async (rows) => {
      const headers: PoHeader[] = [];
      const lines: PoLine[] = [];
      const remove: string[] = [];
      for (const r of rows) {
        const m = mapPurchaseOrder(r);
        if (!m) continue;
        if (m.changedAt && (!newest || m.changedAt > newest)) newest = m.changedAt;
        if (m.kind === 'keep') {
          headers.push(m.header);
          lines.push(...m.lines);
          seen.add(m.header.PurchaseOrder);
        } else {
          remove.push(m.purchaseOrder);
        }
      }
      totals.read += rows.length;
      const c = await applyPage(db, headers, lines, remove);
      totals.inserted += c.inserted;
      totals.updated += c.updated;
      totals.removed += c.removed;
      totals.lines += c.lines;
    });

    if (full) totals.removed += await removeOutsideRule(db, include, seen);
    await saveWatermark(db, newest); // only now: a failed run is simply repeated next time
    const mode = full ? 'Full sync' : `Changes since ${watermark!.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    await finishRun(db, runId, 'Succeeded', { read: totals.read, inserted: totals.inserted, updated: totals.updated, missing: totals.removed },
      `${mode}: ${totals.lines.toLocaleString('en-GB')} order lines written.`);
  } catch (err) {
    await finishRun(db, runId, 'Failed', { read: totals.read, inserted: totals.inserted, updated: totals.updated, missing: totals.removed },
      `${err instanceof Error ? err.message : String(err)} — pages already written are kept; the next sync repeats this one safely.`);
  }
}
