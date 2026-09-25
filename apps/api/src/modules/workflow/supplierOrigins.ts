/**
 * Origins a supplier can supply (spec 18, decision 2026-09-24): its SAP country,
 * every origin it has supplied to us (purchase history) and origins added by
 * hand. Country and history rows are rebuilt after each supplier / PO sync;
 * manual rows are kept.
 */
import { sql } from 'kysely';
import { DomainError } from './errors.js';
import type { Db, Tx } from './tx.js';

export async function rebuildSupplierOrigins(db: Db): Promise<number> {
  return db.transaction().execute(async (tx) => {
    await sql`DELETE FROM scm.SupplierOrigin WHERE Source IN ('COUNTRY', 'HISTORY')`.execute(tx);
    const a = await sql`INSERT INTO scm.SupplierOrigin (SupplierCode, OriginCode, Source)
      SELECT SupplierCode, Country, 'COUNTRY' FROM md.Supplier WHERE LEN(Country) = 2`.execute(tx);
    const b = await sql`INSERT INTO scm.SupplierOrigin (SupplierCode, OriginCode, Source)
      SELECT DISTINCT SupplierCode, OriginCode, 'HISTORY' FROM scm.PurchaseHistorySummary WHERE OriginCode <> ''`.execute(tx);
    return Number(a.numAffectedRows ?? 0) + Number(b.numAffectedRows ?? 0);
  });
}

/** Origins per supplier (sorted, distinct). */
export async function originsOf(db: Db | Tx, supplierCodes: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(supplierCodes.map((c) => [c, []]));
  if (!supplierCodes.length) return out;
  const rows = await db.selectFrom('scm.SupplierOrigin').select(['SupplierCode', 'OriginCode']).distinct()
    .where('SupplierCode', 'in', supplierCodes).orderBy('OriginCode').execute();
  for (const r of rows) out.get(r.SupplierCode)?.push(r.OriginCode);
  return out;
}

export async function assertSupplierCanSupply(db: Db | Tx, supplierCode: string, originCode: string): Promise<string[]> {
  const origins = (await originsOf(db, [supplierCode])).get(supplierCode) ?? [];
  if (!origins.includes(originCode)) {
    throw new DomainError('SUPPLIER_ORIGIN_MISMATCH', `Supplier ${supplierCode} supplies ${origins.join(', ') || 'no known origin'}; required ${originCode}`);
  }
  return origins;
}

/** Configuration → Supplier origins: suppliers with their origins and where each comes from. */
export async function listSupplierOrigins(db: Db, q: string | undefined, origin: string | undefined, page: number, pageSize: number) {
  let base = db.selectFrom('md.Supplier as s').where('s.InSap', '=', true);
  if (q) { const p = `%${q.replace(/[[%_]/g, '[$&]')}%`; base = base.where((eb) => eb.or([eb('s.SupplierCode', 'like', p), eb('s.Name', 'like', p)])); }
  if (origin) base = base.where((eb) => eb.exists(eb.selectFrom('scm.SupplierOrigin as o').select('o.OriginCode').whereRef('o.SupplierCode', '=', 's.SupplierCode').where('o.OriginCode', '=', origin)));
  const total = Number((await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
  const rows = await base.select(['s.SupplierCode', 's.Name', 's.Country']).orderBy('s.Name').offset((page - 1) * pageSize).fetch(pageSize).execute();
  const codes = rows.map((r) => r.SupplierCode);
  const origins = codes.length ? await db.selectFrom('scm.SupplierOrigin').select(['SupplierCode', 'OriginCode', 'Source']).where('SupplierCode', 'in', codes).orderBy('OriginCode').execute() : [];
  return {
    total,
    rows: rows.map((r) => ({
      supplierCode: r.SupplierCode, name: r.Name, country: r.Country,
      origins: origins.filter((o) => o.SupplierCode === r.SupplierCode).map((o) => ({ originCode: o.OriginCode, source: o.Source })),
    })),
  };
}

export async function addManualOrigin(db: Db, supplierCode: string, originCode: string, userId: number): Promise<void> {
  const s = await db.selectFrom('md.Supplier').select('SupplierCode').where('SupplierCode', '=', supplierCode).executeTakeFirst();
  if (!s) throw new DomainError('NOT_FOUND', `Supplier ${supplierCode} not found`, 404);
  const exists = await db.selectFrom('scm.SupplierOrigin').select('OriginCode').where('SupplierCode', '=', supplierCode).where('OriginCode', '=', originCode).where('Source', '=', 'MANUAL').executeTakeFirst();
  if (!exists) await db.insertInto('scm.SupplierOrigin').values({ SupplierCode: supplierCode, OriginCode: originCode, Source: 'MANUAL', AddedBy: userId }).execute();
}

export async function removeManualOrigin(db: Db, supplierCode: string, originCode: string): Promise<void> {
  // Added by hand or from an RFQ (a first contact); RFQs already sent keep what they recorded at invite.
  await db.deleteFrom('scm.SupplierOrigin').where('SupplierCode', '=', supplierCode).where('OriginCode', '=', originCode).where('Source', 'in', ['MANUAL', 'RFQ']).execute();
}
