/**
 * Suppliers sync (spec 08). Reads every supplier in the chosen Z groups plus
 * their business-partner addresses, then writes them in one transaction:
 * insert new, update changed, mark the rest "Not in SAP". Running it again
 * changes nothing — suppliers are keyed by their SAP code.
 *
 * "Delete all and sync fresh" (fresh = true) deletes every supplier in the same
 * transaction, after SAP has been read — so a failed read deletes nothing, and
 * suppliers of groups no longer chosen disappear instead of staying "Not in SAP".
 */
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/schema.js';
import { entityPath, fetchAllRows } from '../../sap/odata.js';
import type { SapConnection } from '../../settings/sapConnection.js';
import { readSetting, writeSetting } from '../../settings/store.js';
import { storeCodeCounts } from '../sync/codeList.js';
import { finishRun } from '../sync/syncRun.js';
import { rebuildSupplierOrigins } from '../workflow/supplierOrigins.js';
import {
  BUSINESS_PARTNER_QUERY, businessPartnerFilter, mapSupplier, mapSupplierOrgs, SUPPLIER_QUERY, supplierFilter, Z_CODE,
  type SupplierOrgRow, type SupplierRow,
} from './sapSupplier.js';

export const GROUPS_KEY = 'sap.suppliers.groups';
const INCLUDE_KEY = 'sap.suppliers.include';

export const supplierIncludeSchema = z.object({
  groups: z.array(z.string().regex(Z_CODE, 'Only groups starting with Z')).max(100),
});
export type SupplierInclude = z.infer<typeof supplierIncludeSchema>;

/** Nothing is chosen until the user picks groups. */
export async function loadSupplierInclude(db: Kysely<Database>): Promise<SupplierInclude> {
  const parsed = supplierIncludeSchema.safeParse(await readSetting(db, INCLUDE_KEY));
  return parsed.success ? parsed.data : { groups: [] };
}

export const saveSupplierInclude = (db: Kysely<Database>, input: SupplierInclude) =>
  writeSetting(db, INCLUDE_KEY, supplierIncludeSchema.parse({ groups: [...new Set(input.groups)].sort() }));

/** Reads every supplier's group from SAP and keeps the Z groups with their counts. */
export async function refreshSupplierGroups(db: Kysely<Database>, conn: SapConnection) {
  const rows = await fetchAllRows(conn, { path: entityPath(conn.suppliersPath, 'A_Supplier'), version: 'v2' }, { select: 'SupplierAccountGroup', orderBy: 'Supplier' });
  return storeCodeCounts(db, GROUPS_KEY, rows, 'SupplierAccountGroup', (c) => Z_CODE.test(c));
}

type Counts = { inserted: number; updated: number; missing: number };

/** The purchasing organizations of every supplier SAP returned replace what was stored. */
async function replaceOrgs(db: Kysely<Database>, orgs: SupplierOrgRow[]): Promise<void> {
  await sql`DELETE FROM md.SupplierPurchasingOrg`.execute(db);
  if (orgs.length === 0) return;
  await sql`
    INSERT INTO md.SupplierPurchasingOrg (SupplierCode, PurchasingOrg, IsBlocked, PaymentTerms, Incoterm, IncotermLocation)
    SELECT SupplierCode, PurchasingOrg, IsBlocked, ISNULL(PaymentTerms, ''), ISNULL(Incoterm, ''), ISNULL(LEFT(IncotermLocation, 80), '') FROM OPENJSON(${JSON.stringify(orgs)}) WITH (
      SupplierCode nvarchar(20), PurchasingOrg nvarchar(10), IsBlocked bit, PaymentTerms nvarchar(10), Incoterm nvarchar(10), IncotermLocation nvarchar(200))`.execute(db);
  // Spec 22: every payment-term code SAP uses is offered in Configuration (description filled in once there).
  await sql`INSERT INTO scm.PaymentTerm (Code) SELECT DISTINCT o.PaymentTerms FROM md.SupplierPurchasingOrg o
    WHERE o.PaymentTerms <> '' AND NOT EXISTS (SELECT 1 FROM scm.PaymentTerm p WHERE p.Code = o.PaymentTerms)`.execute(db);
}

async function applySuppliers(db: Kysely<Database>, rows: SupplierRow[], orgs: SupplierOrgRow[], fresh: boolean): Promise<Counts & { deleted: number }> {
  const deleted = fresh ? Number((await sql`DELETE FROM md.Supplier`.execute(db)).numAffectedRows ?? 0) : 0;
  const json = JSON.stringify(rows);
  const cols = 'Name, SupplierGroup, Country, Currency, Street, HouseNumber, City, PostalCode, Region, Email, PurchasingIsBlocked, PostingIsBlocked';
  const src = (p: string) => cols.split(', ').map((c) => `${p}.${c}`).join(', ');
  const set = cols.split(', ').map((c) => `${c} = s.${c}`).join(', ');
  const result = await sql<Counts>`
    SET NOCOUNT ON;
    DECLARE @out TABLE (Act nvarchar(10), InSap bit);
    MERGE md.Supplier AS t
    USING (SELECT * FROM OPENJSON(${json}) WITH (
      SupplierCode nvarchar(20), Name nvarchar(200), SupplierGroup nvarchar(10), Country nvarchar(3), Currency nvarchar(5),
      Street nvarchar(200), HouseNumber nvarchar(40), City nvarchar(100), PostalCode nvarchar(20), Region nvarchar(10), Email nvarchar(250),
      PurchasingIsBlocked bit, PostingIsBlocked bit)) AS s
    ON t.SupplierCode = s.SupplierCode
    WHEN MATCHED AND (t.InSap = 0 OR EXISTS (SELECT ${sql.raw(src('s'))} EXCEPT SELECT ${sql.raw(src('t'))})) THEN
      UPDATE SET ${sql.raw(set)}, InSap = 1, SapChangedAt = SYSUTCDATETIME()
    WHEN NOT MATCHED BY TARGET THEN
      INSERT (SupplierCode, ${sql.raw(cols)}) VALUES (s.SupplierCode, ${sql.raw(src('s'))})
    WHEN NOT MATCHED BY SOURCE AND t.InSap = 1 THEN
      UPDATE SET InSap = 0, SapChangedAt = SYSUTCDATETIME()
    OUTPUT $action, inserted.InSap INTO @out;
    SELECT ISNULL(SUM(CASE WHEN Act = 'INSERT' THEN 1 ELSE 0 END), 0) AS inserted,
           ISNULL(SUM(CASE WHEN Act = 'UPDATE' AND InSap = 1 THEN 1 ELSE 0 END), 0) AS updated,
           ISNULL(SUM(CASE WHEN Act = 'UPDATE' AND InSap = 0 THEN 1 ELSE 0 END), 0) AS missing
    FROM @out;`.execute(db);
  const r = result.rows[0];
  await replaceOrgs(db, orgs);
  return { inserted: Number(r.inserted), updated: Number(r.updated), missing: Number(r.missing), deleted };
}

/** Reads SAP, writes the suppliers, and records the result. Never throws. */
export async function runSupplierSync(db: Kysely<Database>, conn: SapConnection, groups: readonly string[], runId: number, fresh = false): Promise<void> {
  let read: number | null = null;
  try {
    const [suppliers, partners] = await Promise.all([
      fetchAllRows(conn, { path: entityPath(conn.suppliersPath, 'A_Supplier'), version: 'v2' }, { ...SUPPLIER_QUERY, filter: supplierFilter(groups) }),
      fetchAllRows(conn, { path: entityPath(conn.suppliersPath, 'A_BusinessPartner'), version: 'v2' }, { ...BUSINESS_PARTNER_QUERY, filter: businessPartnerFilter(groups) }),
    ]);
    read = suppliers.length;
    const bpByCode = new Map(partners.map((p) => [String(p.BusinessPartner ?? '').trim(), p]));
    const byCode = new Map<string, SupplierRow>();
    const orgs: SupplierOrgRow[] = [];
    for (const s of suppliers) {
      const row = mapSupplier(s, bpByCode.get(String(s.Supplier ?? '').trim()), groups);
      if (row && !byCode.has(row.SupplierCode)) orgs.push(...mapSupplierOrgs(s));
      if (row) byCode.set(row.SupplierCode, row);
    }
    const { deleted, ...counts } = await db.transaction().execute((trx) => applySuppliers(trx, [...byCode.values()], orgs, fresh));
    const blocked = [...byCode.values()].filter((r) => r.PurchasingIsBlocked || r.PostingIsBlocked).length;
    const noAddress = [...byCode.values()].filter((r) => !r.Country).length;
    const notes = [
      fresh ? `Fresh copy: all ${deleted.toLocaleString('en-GB')} stored supplier(s) were deleted first.` : null,
      noAddress ? `${noAddress} supplier(s) have no address in SAP.` : null,
      `${orgs.length} purchasing-organization link(s); ${blocked} supplier(s) blocked in SAP.`,
    ].filter(Boolean);
    // spec 18: a supplier's SAP country is one of its origins for the RFQ shortlist
    notes.push(await rebuildSupplierOrigins(db).then((n) => `Supplier origins: ${n.toLocaleString('en-GB')}.`, (e: unknown) => `Supplier origins not rebuilt: ${e instanceof Error ? e.message : String(e)}.`));
    await finishRun(db, runId, 'Succeeded', { read, ...counts }, notes.length ? notes.join(' ') : null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishRun(db, runId, 'Failed', { read }, fresh ? `${msg} — nothing was deleted.` : msg);
  }
}
