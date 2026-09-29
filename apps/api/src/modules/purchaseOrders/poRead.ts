import { sql, type Kysely, type SqlBool } from 'kysely';
import type { Database } from '../../db/schema.js';

type Db = Kysely<Database>;
export const PO_SORT_FIELDS = ['PurchaseOrder', 'OrderDate', 'OrderType', 'SupplierCode'] as const;
export type PoListFilter = {
  page: number; pageSize: number; q?: string; type?: string[]; supplier?: string[]; major?: string[]; subMajor?: string[]; company?: string[];
  from?: string; to?: string; sortField: (typeof PO_SORT_FIELDS)[number]; sortOrder: 'asc' | 'desc';
};

const contains = (s: string) => `%${s.replace(/[[%_]/g, '[$&]')}%`;

/** The SAP purchase orders of the given companies, filtered and paged in SQL. */
export async function listPurchaseOrders(db: Db, companies: string[], f: PoListFilter) {
  if (!companies.length) return { total: 0, rows: [] };
  let q = db.selectFrom('md.PurchaseOrder as po').leftJoin('md.Supplier as s', 's.SupplierCode', 'po.SupplierCode').where('po.CompanyCode', 'in', companies);
  if (f.q) {
    const p = contains(f.q);
    q = q.where((eb) => eb.or([eb('po.PurchaseOrder', 'like', p), eb('po.SupplierCode', 'like', p), eb('s.Name', 'like', p)]));
  }
  if (f.type?.length) q = q.where('po.OrderType', 'in', f.type);
  if (f.supplier?.length) q = q.where('po.SupplierCode', 'in', f.supplier);
  if (f.company?.length) q = q.where('po.CompanyCode', 'in', f.company);
  // Materials of the order: any line whose material is in the chosen categories (col: a fixed name, never input).
  const lineHas = (col: 'MajorCategory' | 'SubMajorCategory', vals: string[]) =>
    sql<SqlBool>`EXISTS (SELECT 1 FROM md.PurchaseOrderLine fl JOIN md.Material fm ON fm.MaterialCode = fl.Material
      WHERE fl.PurchaseOrder = po.PurchaseOrder AND fm.${sql.raw(col)} IN (${sql.join(vals)}))`;
  if (f.major?.length) q = q.where(lineHas('MajorCategory', f.major));
  if (f.subMajor?.length) q = q.where(lineHas('SubMajorCategory', f.subMajor));
  if (f.from) q = q.where(sql<SqlBool>`po.OrderDate >= CAST(${f.from} AS date)`);
  if (f.to) q = q.where(sql<SqlBool>`po.OrderDate < DATEADD(day, 1, CAST(${f.to} AS date))`);
  let ordered = q
    .select(['po.PurchaseOrder', 'po.OrderType', 'po.SupplierCode', 'po.OrderDate', 'po.Currency', 'po.CompanyCode', 's.Name as SupplierName'])
    .select((eb) =>
      eb.selectFrom('md.PurchaseOrderLine as l').whereRef('l.PurchaseOrder', '=', 'po.PurchaseOrder').select((e) => e.fn.countAll<number>().as('n')).as('LineCount'),
    )
    .orderBy(`po.${f.sortField}`, f.sortOrder);
  if (f.sortField !== 'PurchaseOrder') ordered = ordered.orderBy('po.PurchaseOrder', 'desc');
  const [rows, count] = await Promise.all([
    ordered.offset((f.page - 1) * f.pageSize).fetch(f.pageSize).execute(),
    q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  return {
    total: Number(count.n),
    rows: rows.map((r) => ({ ...r, OrderDate: r.OrderDate.toISOString().slice(0, 10), LineCount: Number(r.LineCount ?? 0), SupplierName: r.SupplierName ?? '' })),
  };
}

/** Choices for the Purchase orders filter section: only values that occur in the user's companies' orders. */
export async function poFilterOptions(db: Db, companies: string[]) {
  if (!companies.length) return { types: [], suppliers: [], categories: [], companies: [] };
  const inCompanies = sql`po.CompanyCode IN (${sql.join(companies)})`;
  const [types, suppliers, cats, cos] = await Promise.all([
    sql<{ OrderType: string }>`SELECT DISTINCT po.OrderType FROM md.PurchaseOrder po WHERE ${inCompanies} ORDER BY po.OrderType`.execute(db).then((r) => r.rows),
    sql<{ SupplierCode: string; Name: string | null }>`SELECT po.SupplierCode, MIN(s.Name) AS Name FROM md.PurchaseOrder po
      LEFT JOIN md.Supplier s ON s.SupplierCode = po.SupplierCode WHERE ${inCompanies} AND po.SupplierCode <> '' GROUP BY po.SupplierCode ORDER BY po.SupplierCode`.execute(db).then((r) => r.rows),
    sql<{ MajorCategory: string; SubMajorCategory: string }>`SELECT DISTINCT m.MajorCategory, m.SubMajorCategory FROM md.PurchaseOrder po
      JOIN md.PurchaseOrderLine l ON l.PurchaseOrder = po.PurchaseOrder JOIN md.Material m ON m.MaterialCode = l.Material
      WHERE ${inCompanies} AND m.MajorCategory <> '' ORDER BY m.MajorCategory, m.SubMajorCategory`.execute(db).then((r) => r.rows),
    sql<{ CompanyCode: string; Name: string | null }>`SELECT DISTINCT po.CompanyCode, c.Name FROM md.PurchaseOrder po
      LEFT JOIN scm.Company c ON c.CompanyCode = po.CompanyCode WHERE ${inCompanies} ORDER BY po.CompanyCode`.execute(db).then((r) => r.rows),
  ]);
  return {
    types: types.map((t) => t.OrderType),
    suppliers: suppliers.map((s) => ({ code: s.SupplierCode, name: s.Name ?? '' })),
    categories: cats.map((c) => ({ major: c.MajorCategory, subMajor: c.SubMajorCategory })),
    companies: cos.map((c) => ({ code: c.CompanyCode, name: c.Name ?? '' })),
  };
}
