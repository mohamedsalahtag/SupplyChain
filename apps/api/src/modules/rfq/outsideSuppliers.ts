/**
 * Suppliers outside the shortlist (spec 18 addition, 2026-09-25). A new supplier's first contact is often the RFQ, so
 * it has no recorded origin and no history yet. Procurement may invite any supplier that is in SAP and usable for the
 * company; inviting it records that it supplies the RFQ's origin(s) (Source 'RFQ', who, when) — visible and removable
 * under Configuration → Supplier origins — so quotes, award and the origin invariants work as for any supplier.
 */
import { sql } from 'kysely';
import { assertCan, hasPermission, type Actor } from '../workflow/access.js';
import { NotFoundError } from '../workflow/errors.js';
import { vendorProblems } from '../workflow/masterData.js';
import { originsOf } from '../workflow/supplierOrigins.js';
import type { Db, Tx } from '../workflow/tx.js';

const P_MANAGE = 'rfq.manage';

/** Suppliers matching a search, with what inviting them would add and why one cannot be invited — for a new RFQ (demand lines). */
export async function searchOutsideSuppliers(db: Db, actor: Actor, demandId: string, lineIds: string[], q: string) {
  const d = await db.selectFrom('scm.Demand').select(['CompanyCode']).where('DemandId', '=', demandId).executeTakeFirst();
  if (!d || !actor.companies.has(d.CompanyCode) || !hasPermission(actor, P_MANAGE)) throw new NotFoundError(`Demand ${demandId}`);
  const needed = lineIds.length
    ? [...new Set((await db.selectFrom('scm.DemandLine').select('OriginCode').where('DemandId', '=', demandId).where('LineId', 'in', lineIds).execute()).map((l) => l.OriginCode))].sort()
    : [];
  return searchFor(db, d.CompanyCode, needed, q);
}

/** The same search for an RFQ that exists (invite more suppliers): the origins are the RFQ's live lines. */
export async function searchOutsideSuppliersForRfq(db: Db, actor: Actor, rfqId: string, q: string) {
  const r = await db.selectFrom('scm.Rfq').select(['CompanyCode']).where('RfqId', '=', rfqId).executeTakeFirst();
  if (!r || !actor.companies.has(r.CompanyCode) || !hasPermission(actor, P_MANAGE)) throw new NotFoundError(`RFQ ${rfqId}`);
  const needed = [...new Set((await db.selectFrom('scm.RfqLine').select('OriginCode').where('RfqId', '=', rfqId).where('IsCancelled', '=', false).execute()).map((l) => l.OriginCode))].sort();
  return searchFor(db, r.CompanyCode, needed, q);
}

async function searchFor(db: Db, companyCode: string, needed: string[], q: string) {
  const d = { CompanyCode: companyCode };
  const term = q.trim();
  if (term.length < 2) return { origins: needed, rows: [] };
  const like = `%${term.replace(/[[%_]/g, '[$&]')}%`;
  const found = (await sql<{ SupplierCode: string; Name: string; Country: string; City: string }>`
    SELECT TOP (20) SupplierCode, Name, Country, City FROM md.Supplier
    WHERE InSap = 1 AND (SupplierCode LIKE ${like} OR Name LIKE ${like})
    ORDER BY CASE WHEN SupplierCode = ${term} THEN 0 ELSE 1 END, Name`.execute(db)).rows;
  const codes = found.map((s) => s.SupplierCode);
  const [origins, problems] = await Promise.all([originsOf(db, codes), vendorProblems(db, codes, d.CompanyCode)]);
  return {
    origins: needed,
    rows: found.map((s) => {
      const has = origins.get(s.SupplierCode) ?? [];
      return {
        supplierCode: s.SupplierCode, name: s.Name, country: s.Country, city: s.City, origins: has,
        adds: needed.filter((o) => !has.includes(o)), // origins recorded for it when the RFQ is created
        problem: problems.get(s.SupplierCode)?.message ?? null,
      };
    }),
  };
}

/** In createRfq's transaction: records the missing origins of an outside supplier; returns its origins afterwards. */
export async function recordRfqOrigins(tx: Tx, actor: Actor, companyCode: string, supplierCode: string, needed: string[]): Promise<{ origins: string[]; added: string[] }> {
  assertCan(actor, P_MANAGE, companyCode);
  const has = (await originsOf(tx, [supplierCode])).get(supplierCode) ?? [];
  const added = needed.filter((o) => !has.includes(o));
  if (added.length) {
    await tx.insertInto('scm.SupplierOrigin').values(added.map((o) => ({ SupplierCode: supplierCode, OriginCode: o, Source: 'RFQ' as const, AddedBy: actor.id }))).execute();
  }
  return { origins: [...new Set([...has, ...added])].sort(), added };
}
