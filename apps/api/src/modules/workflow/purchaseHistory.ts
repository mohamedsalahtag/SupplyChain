/**
 * Purchase history summary (plan v5 §0.10, spec 11): one row per supplier ×
 * company × category × sub-category × size × origin, per material and for all
 * materials of the specification (MaterialCode ''). Rebuilt in one transaction
 * at the end of every successful purchase-order sync; feeds supplier ranking.
 */
import { sql } from 'kysely';
import type { Db } from './tx.js';

export async function rebuildPurchaseHistory(db: Db, lookbackMonths: number): Promise<number> {
  return db.transaction().execute(async (tx) => {
    await sql`DELETE FROM scm.PurchaseHistorySummary`.execute(tx);
    const r = await sql`
      WITH l AS (
        SELECT po.SupplierCode, po.CompanyCode, po.PurchaseOrder, po.OrderDate, po.Currency,
               m.MajorCategory, m.SubMajorCategory, m.Size, ISNULL(o.CountryCode, '') AS OriginCode,
               -- The PO API gives SAP's commercial unit codes (CAR, BAG, OCT…), the material API the ISO-style
               -- ones (CT, BG, CTO…) for the same unit: every PO unit pairs with exactly one base unit
               -- (checked 2026-09-24), so the history is kept in the material's base unit — the unit demands use.
               pl.Material, m.BaseUnit AS Unit,
               CAST(ROUND(pl.Quantity * 1000, 0) AS bigint) AS QtyMilli,
               CAST(pl.NetPrice / NULLIF(pl.PriceQuantity, 0) AS decimal(18, 4)) AS UnitPrice,
               ROW_NUMBER() OVER (PARTITION BY po.SupplierCode, po.CompanyCode, m.MajorCategory, m.SubMajorCategory, m.Size, o.CountryCode, pl.Material, m.BaseUnit
                                  ORDER BY po.OrderDate DESC, po.PurchaseOrder DESC, pl.ItemNo DESC) AS RnMat,
               ROW_NUMBER() OVER (PARTITION BY po.SupplierCode, po.CompanyCode, m.MajorCategory, m.SubMajorCategory, m.Size, o.CountryCode, m.BaseUnit
                                  ORDER BY po.OrderDate DESC, po.PurchaseOrder DESC, pl.ItemNo DESC) AS RnSpec
        FROM md.PurchaseOrderLine pl
        JOIN md.PurchaseOrder po ON po.PurchaseOrder = pl.PurchaseOrder
        JOIN md.Material m ON m.MaterialCode = pl.Material
        LEFT JOIN scm.RefOrigin o ON o.OriginName = m.Origin
        WHERE po.CompanyCode <> '' AND po.SupplierCode <> ''
          AND po.OrderDate >= DATEADD(month, ${-lookbackMonths}, CAST(SYSUTCDATETIME() AS date))
      )
      INSERT INTO scm.PurchaseHistorySummary
        (SupplierCode, CompanyCode, MajorCategory, SubMajorCategory, Size, OriginCode, MaterialCode, Unit,
         PoCount, TotalQtyMilli, FirstPoDate, LastPoDate, LastUnitPrice, LastCurrency)
      SELECT SupplierCode, CompanyCode, MajorCategory, SubMajorCategory, Size, OriginCode,
             CASE WHEN GROUPING(Material) = 1 THEN '' ELSE Material END,
             Unit,
             COUNT(DISTINCT PurchaseOrder), SUM(QtyMilli), MIN(OrderDate), MAX(OrderDate),
             CASE WHEN GROUPING(Material) = 1 THEN MAX(CASE WHEN RnSpec = 1 THEN UnitPrice END) ELSE MAX(CASE WHEN RnMat = 1 THEN UnitPrice END) END,
             CASE WHEN GROUPING(Material) = 1 THEN MAX(CASE WHEN RnSpec = 1 THEN Currency END) ELSE MAX(CASE WHEN RnMat = 1 THEN Currency END) END
      FROM l
      GROUP BY GROUPING SETS (
        (SupplierCode, CompanyCode, MajorCategory, SubMajorCategory, Size, OriginCode, Material, Unit),
        (SupplierCode, CompanyCode, MajorCategory, SubMajorCategory, Size, OriginCode, Unit)
      );`.execute(tx);
    return Number(r.numAffectedRows ?? 0);
  });
}
