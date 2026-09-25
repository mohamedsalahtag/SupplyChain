/**
 * Supplier shortlist (spec 18, plan v5 §4.4). Hard filter: usable for the
 * company and able to supply the origin. Ranking (a hint, not a rule): what the
 * supplier has supplied to us before — same SKU > same material and size >
 * same material — then PO count, last PO date, total quantity, name.
 */
import { sql } from 'kysely';
import { formatQty, fromDb, type Milli } from '../workflow/qty.js';
import type { Db, Tx } from '../workflow/tx.js';

export type ShortLine = { lineId: string; majorCategory: string; subMajorCategory: string; size: string; originCode: string; materialCode: string | null; unit: string };
export type HistRow = {
  SupplierCode: string; MajorCategory: string; SubMajorCategory: string; Size: string; OriginCode: string; MaterialCode: string; Unit: string;
  PoCount: number; TotalQtyMilli: string | number; FirstPoDate: Date; LastPoDate: Date; LastUnitPrice: number | null; LastCurrency: string | null;
};
export type Candidate = { supplierCode: string; name: string; origins: string[] };
export type MatchLevel = 'SKU' | 'SPEC' | 'SUBCATEGORY' | 'NONE';
export type Hint = {
  matchLevel: MatchLevel; poCount: number; totalQty: string; unit: string | null;
  firstPoDate: string | null; lastPoDate: string | null; lastPrice: string | null; lastCurrency: string | null;
};
export type Entry = Candidate & { lineIds: string[]; rank: number | null; hint: Hint };

const LEVEL: Record<MatchLevel, number> = { SKU: 3, SPEC: 2, SUBCATEGORY: 1, NONE: 0 };
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** The history rows of one supplier that match a line, at the best level available. */
function bestRows(line: ShortLine, rows: HistRow[]): { level: MatchLevel; rows: HistRow[] } {
  const same = rows.filter((r) => r.OriginCode === line.originCode && r.Unit === line.unit && r.MajorCategory === line.majorCategory && r.SubMajorCategory === line.subMajorCategory);
  const sku = line.materialCode ? same.filter((r) => r.MaterialCode === line.materialCode) : [];
  if (sku.length) return { level: 'SKU', rows: sku };
  const spec = same.filter((r) => r.MaterialCode === '' && r.Size === line.size);
  if (spec.length) return { level: 'SPEC', rows: spec };
  const sub = same.filter((r) => r.MaterialCode === '');
  return sub.length ? { level: 'SUBCATEGORY', rows: sub } : { level: 'NONE', rows: [] };
}

/** Ranks the candidates for the lines of ONE origin. Pure: no database. */
export function rankForOrigin(lines: ShortLine[], candidates: Candidate[], history: HistRow[]): Entry[] {
  const entries = candidates.map((c) => {
    const mine = history.filter((h) => h.SupplierCode === c.supplierCode);
    const perLine = lines.map((l) => bestRows(l, mine));
    const level = perLine.reduce<MatchLevel>((best, p) => (LEVEL[p.level] > LEVEL[best] ? p.level : best), 'NONE');
    const rows = perLine.filter((p) => p.level === level && level !== 'NONE').flatMap((p) => p.rows);
    const latest = rows.reduce<HistRow | null>((a, r) => (!a || r.LastPoDate > a.LastPoDate ? r : a), null);
    const total: Milli = rows.reduce((s, r) => s + fromDb(r.TotalQtyMilli), 0);
    const hint: Hint = {
      matchLevel: level, poCount: rows.reduce((m, r) => Math.max(m, Number(r.PoCount)), 0), totalQty: formatQty(total), unit: rows[0]?.Unit ?? null,
      firstPoDate: day(rows.reduce<Date | null>((a, r) => (!a || r.FirstPoDate < a ? r.FirstPoDate : a), null)), lastPoDate: day(latest?.LastPoDate ?? null),
      lastPrice: latest?.LastUnitPrice == null ? null : Number(latest.LastUnitPrice).toFixed(2), lastCurrency: latest?.LastCurrency ?? null,
    };
    return { ...c, lineIds: lines.map((l) => l.lineId), rank: null as number | null, hint, _total: total, _last: latest?.LastPoDate?.getTime() ?? 0 };
  });
  entries.sort((a, b) =>
    LEVEL[b.hint.matchLevel] - LEVEL[a.hint.matchLevel] || b.hint.poCount - a.hint.poCount || b._last - a._last || b._total - a._total || a.name.localeCompare(b.name));
  return entries.map(({ _total, _last, ...e }, i) => ({ ...e, rank: e.hint.matchLevel === 'NONE' ? null : i + 1 }));
}

export type OriginShortlist = { originCode: string; lineIds: string[]; entries: Entry[]; problem: string | null };

/** The shortlist per origin of the given lines, for a company. */
export async function supplierShortlist(db: Db | Tx, companyCode: string, lines: ShortLine[]): Promise<OriginShortlist[]> {
  const origins = [...new Set(lines.map((l) => l.originCode))].sort();
  if (!origins.length) return [];
  const company = await db.selectFrom('scm.Company').select('PurchasingOrg').where('CompanyCode', '=', companyCode).executeTakeFirst();
  const org = company?.PurchasingOrg ?? '';
  const [eligible, history] = await Promise.all([
    org ? sql<{ SupplierCode: string; Name: string; OriginCode: string }>`
      SELECT DISTINCT s.SupplierCode, s.Name, o.OriginCode
      FROM md.Supplier s
      JOIN scm.SupplierOrigin o ON o.SupplierCode = s.SupplierCode AND o.OriginCode IN (${sql.join(origins)})
      JOIN md.SupplierPurchasingOrg p ON p.SupplierCode = s.SupplierCode AND p.PurchasingOrg = ${org} AND p.IsBlocked = 0
      WHERE s.InSap = 1 AND s.PurchasingIsBlocked = 0 AND s.PostingIsBlocked = 0`.execute(db).then((r) => r.rows) : Promise.resolve([]),
    db.selectFrom('scm.PurchaseHistorySummary').selectAll().where('CompanyCode', '=', companyCode).where('OriginCode', 'in', origins)
      .where('SubMajorCategory', 'in', [...new Set(lines.map((l) => l.subMajorCategory))]).execute() as Promise<HistRow[]>,
  ]);
  const allOrigins = new Map<string, Set<string>>();
  for (const r of await db.selectFrom('scm.SupplierOrigin').select(['SupplierCode', 'OriginCode']).where('SupplierCode', 'in', eligible.length ? [...new Set(eligible.map((e) => e.SupplierCode))] : ['-']).execute()) {
    if (!allOrigins.has(r.SupplierCode)) allOrigins.set(r.SupplierCode, new Set());
    allOrigins.get(r.SupplierCode)!.add(r.OriginCode);
  }
  return origins.map((originCode) => {
    const ls = lines.filter((l) => l.originCode === originCode);
    const cands = eligible.filter((e) => e.OriginCode === originCode).map((e) => ({ supplierCode: e.SupplierCode, name: e.Name, origins: [...(allOrigins.get(e.SupplierCode) ?? [])].sort() }));
    const problem = !org ? `Company ${companyCode} has no purchasing organization (Configuration → Companies)`
      : cands.length ? null : `No supplier can supply origin ${originCode} for company ${companyCode}`;
    return { originCode, lineIds: ls.map((l) => l.lineId), entries: rankForOrigin(ls, cands, history), problem };
  });
}
