/**
 * Master-data contract (plan v5 §0.8, §0.10), read-only and owned by SAP.
 * Suppliers, purchase orders and materials come from the SAP syncs; these
 * checks run at award, PO validation and PO submission (later stages).
 */
import { sql } from 'kysely';
import { assertSupplierCanSupply } from './supplierOrigins.js';
import { DomainError } from './errors.js';
import type { Db, Tx } from './tx.js';

export const MASTER_DATA_SOURCES = ['sap.materials', 'sap.suppliers', 'sap.purchaseOrders'] as const;
export type MasterDataSource = (typeof MASTER_DATA_SOURCES)[number];

/** Finish time of the last successful sync per source (null = never). */
export async function lastSuccessfulSyncs(db: Db | Tx): Promise<Record<MasterDataSource, Date | null>> {
  const rows = await db
    .selectFrom('integ.SyncRun')
    .select(['Source'])
    .select((eb) => eb.fn.max('FinishedAt').as('last'))
    .where('Status', '=', 'Succeeded')
    .where('Source', 'in', [...MASTER_DATA_SOURCES])
    .groupBy('Source')
    .execute();
  const out = Object.fromEntries(MASTER_DATA_SOURCES.map((s) => [s, null])) as Record<MasterDataSource, Date | null>;
  for (const r of rows) out[r.Source as MasterDataSource] = r.last ? new Date(r.last as unknown as string | Date) : null;
  return out;
}

/** Sources whose last success is older than maxAgeHours (or never), relative to `now`. */
export function staleSources(last: Record<MasterDataSource, Date | null>, maxAgeHours: number, now: Date): MasterDataSource[] {
  const limit = now.getTime() - maxAgeHours * 3_600_000;
  return MASTER_DATA_SOURCES.filter((s) => !last[s] || last[s]!.getTime() < limit);
}

/** Blocks PO submission when master data is too old (warning elsewhere). */
export async function assertMasterDataFresh(db: Db | Tx, maxAgeHours: number, now = new Date()): Promise<void> {
  const stale = staleSources(await lastSuccessfulSyncs(db), maxAgeHours, now);
  if (stale.length) {
    throw new DomainError('MASTER_DATA_STALE', `Master data older than ${maxAgeHours} h: ${stale.join(', ')}. Run the sync first.`, 422, { stale });
  }
}

/**
 * A supplier is usable for a company when it is in SAP, not blocked, and set up
 * (not blocked) in the company's purchasing organization.
 */
export async function assertVendorUsable(db: Db | Tx, supplierCode: string, companyCode: string): Promise<void> {
  const p = (await vendorProblems(db, [supplierCode], companyCode)).get(supplierCode);
  if (p) throw p;
}

/**
 * The same rules for several suppliers in one query: per supplier, the DomainError that assertVendorUsable
 * would throw, or null when it is usable (in SAP, not blocked, extended to the company's purchasing org).
 */
export async function vendorProblems(db: Db | Tx, supplierCodes: string[], companyCode: string): Promise<Map<string, DomainError | null>> {
  const out = new Map<string, DomainError | null>();
  if (!supplierCodes.length) return out;
  const rows = (await sql<{ SupplierCode: string; InSap: boolean | null; PurchasingIsBlocked: boolean | null; PostingIsBlocked: boolean | null; HasCompany: number; PurchasingOrg: string | null; Extended: number; OrgBlocked: boolean | null }>`
    SELECT x.SupplierCode, s.InSap, s.PurchasingIsBlocked, s.PostingIsBlocked, CASE WHEN c.CompanyCode IS NULL THEN 0 ELSE 1 END AS HasCompany, c.PurchasingOrg,
      CASE WHEN o.SupplierCode IS NULL THEN 0 ELSE 1 END AS Extended, o.IsBlocked AS OrgBlocked
    FROM (VALUES ${sql.join(supplierCodes.map((c) => sql`(${c})`))}) x (SupplierCode)
    LEFT JOIN md.Supplier s ON s.SupplierCode = x.SupplierCode
    LEFT JOIN scm.Company c ON c.CompanyCode = ${companyCode}
    LEFT JOIN md.SupplierPurchasingOrg o ON o.SupplierCode = x.SupplierCode AND o.PurchasingOrg = c.PurchasingOrg`.execute(db)).rows;
  for (const r of rows) {
    const code = r.SupplierCode;
    out.set(code,
      !r.InSap ? new DomainError('VENDOR_UNKNOWN', `Supplier ${code} is not in SAP`)
        : r.PurchasingIsBlocked || r.PostingIsBlocked ? new DomainError('VENDOR_BLOCKED', `Supplier ${code} is blocked in SAP`)
          : !r.HasCompany ? new DomainError('NOT_FOUND', `Company ${companyCode} not found`, 404)
            : !r.PurchasingOrg ? new DomainError('COMPANY_ORG_MISSING', `Company ${companyCode} has no purchasing organization (Configuration → Companies)`)
              : !r.Extended ? new DomainError('VENDOR_NOT_EXTENDED', `Supplier ${code} is not set up for purchasing organization ${r.PurchasingOrg}`)
                : r.OrgBlocked ? new DomainError('VENDOR_BLOCKED', `Supplier ${code} is blocked in purchasing organization ${r.PurchasingOrg}`) : null);
  }
  return out;
}

/** A supplier supplies an origin when it is its SAP country, in its PO history, or added by hand (spec 18). */
export async function assertSupplierOrigin(db: Db | Tx, supplierCode: string, originCode: string): Promise<void> {
  await assertSupplierCanSupply(db, supplierCode, originCode);
}
