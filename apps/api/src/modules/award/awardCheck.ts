/**
 * The quote comparison and the award rules (spec 20, plan v5 §5 rule 3). The same
 * checks run for Check (dry run) and again, under locks, for Award.
 */
import { sql } from 'kysely';
import { incrementFor } from '../demand/content.js';
import { anyClass, anySize } from '../demand/lookups.js';
import { DomainError } from '../workflow/errors.js';
import { isoWeekOf } from '../workflow/isoWeek.js';
import { vendorProblems } from '../workflow/masterData.js';
import { formatQty, fromDb, parseQty, type Milli } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import { originsOf } from '../workflow/supplierOrigins.js';
import type { Db, Tx } from '../workflow/tx.js';

export type AwardInput = {
  awards: { rfqLineId: string; supplierCode: string; qty: string; overrideReason?: string | null }[];
  shipments: { supplierCode: string; etdWeek: string; containerCount: number; confirmedEtd?: string | null }[];
  releases: { rfqLineId: string; qty: string; reasonCode: string }[];
  comment: string;
};

export type LineRow = {
  RfqLineId: string; DemandLineId: string | null; ProposedEtdWeek: string; LineKey: string; Unit: string; OriginCode: string; IsCancelled: boolean;
  SubMajorCategory: string; Size: string; MaterialClass: string; MaterialCode: string | null; HoldCrNo: string | null; ShiftStatus: string | null; Quoted: string; InRfq: string;
};
export type QuoteRow = { QuoteId: string; SupplierCode: string; EtdWeek: string; LineKey: string; UnitPrice: string; Currency: string; AvailableQty: string; QuotedSku: string | null };

export const lineLabel = (l: Pick<LineRow, 'SubMajorCategory' | 'Size' | 'MaterialClass' | 'MaterialCode'>) =>
  [l.SubMajorCategory, anySize(l.Size), anyClass(l.MaterialClass), l.MaterialCode].filter(Boolean).join(' ');

export async function rfqLines(db: Db | Tx, rfqId: string): Promise<LineRow[]> {
  return (await sql<LineRow>`
    SELECT l.RfqLineId, l.DemandLineId, l.ProposedEtdWeek, l.LineKey, l.Unit, l.OriginCode, l.IsCancelled, l.SubMajorCategory, l.Size, l.MaterialClass, l.MaterialCode,
      hc.CrNo AS HoldCrNo, sc.Status AS ShiftStatus,
      ISNULL(SUM(CASE WHEN s.ExecState = 'QUOTED' THEN s.Qty END), 0) AS Quoted, ISNULL(SUM(CASE WHEN s.ExecState = 'IN_RFQ' THEN s.Qty END), 0) AS InRfq
    FROM scm.RfqLine l LEFT JOIN scm.QtySlice s ON s.RfqLineId = l.RfqLineId LEFT JOIN scm.DemandLine dl ON dl.LineId = l.DemandLineId
    LEFT JOIN scm.ChangeRequest hc ON hc.CrId = dl.ChangeHoldCrId LEFT JOIN scm.ChangeRequest sc ON sc.CrId = l.WeekShiftCrId
    WHERE l.RfqId = ${rfqId}
    GROUP BY l.RfqLineId, l.DemandLineId, l.ProposedEtdWeek, l.LineKey, l.Unit, l.OriginCode, l.IsCancelled, l.SubMajorCategory, l.Size, l.MaterialClass, l.MaterialCode, hc.CrNo, sc.Status
    ORDER BY l.ProposedEtdWeek, l.RfqLineId`.execute(db)).rows.map((l) => ({ ...l, RfqLineId: String(l.RfqLineId), DemandLineId: l.DemandLineId ? String(l.DemandLineId) : null }));
}

/** Why a line cannot be awarded now (null = it can). */
export function lineBlocker(l: LineRow): string | null {
  if (l.IsCancelled) return 'cancelled';
  if (!l.DemandLineId) return 'added quantity waiting for Sales';
  if (l.ShiftStatus === 'SUBMITTED') return 'week shift waiting for Sales';
  if (l.HoldCrNo) return `on hold in ${l.HoldCrNo}`;
  return null;
}

export const currentQuotes = async (db: Db | Tx, rfqId: string) =>
  (await db.selectFrom('scm.SupplierQuote').select(['QuoteId', 'SupplierCode', 'EtdWeek', 'LineKey', 'UnitPrice', 'Currency', 'AvailableQty', 'QuotedSku'])
    .where('RfqId', '=', rfqId).where('IsCurrent', '=', true).execute()).map((q) => ({ ...q, QuoteId: String(q.QuoteId), UnitPrice: String(q.UnitPrice), AvailableQty: String(q.AvailableQty) })) as QuoteRow[];

/** Active awarded quantity per supplier × week × key of an RFQ (all batches). */
export async function awardedSoFar(db: Db | Tx, rfqId: string): Promise<Map<string, Milli>> {
  const rows = await sql<{ SupplierCode: string; EtdWeek: string; LineKey: string; Q: string }>`
    SELECT i.SupplierCode, i.EtdWeek, i.LineKey, SUM(i.Qty) AS Q FROM scm.AwardItem i JOIN scm.AwardBatch b ON b.AwardBatchId = i.AwardBatchId
    WHERE b.RfqId = ${rfqId} AND i.IsActive = 1 GROUP BY i.SupplierCode, i.EtdWeek, i.LineKey`.execute(db);
  return new Map(rows.rows.map((r) => [`${r.SupplierCode}|${r.EtdWeek}|${r.LineKey}`, fromDb(r.Q)]));
}

export type Checked = {
  problems: string[]; warnings: string[];
  awards: (AwardInput['awards'][number] & { milli: Milli; line: LineRow; quote: QuoteRow })[];
  releases: (AwardInput['releases'][number] & { milli: Milli; line: LineRow })[];
};

/** `byContainers`: items worked out from awarded containers — their limit is the offered containers (logged), not the quoted available quantity. */
export async function checkAward(tx: Db | Tx, rfq: { RfqId: string; CompanyCode: string; ManualStatus: string }, input: AwardInput,
  opts: { byContainers?: (rfqLineId: string, supplierCode: string) => boolean; lines?: LineRow[]; quotes?: QuoteRow[] } = {}): Promise<Checked> {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (rfq.ManualStatus !== 'SENT') problems.push(rfq.ManualStatus === 'DRAFT' ? 'Send the RFQ and record quotes first' : 'The RFQ is cancelled');
  if (!input.awards.length) problems.push('Award at least one quantity');
  const settings = await loadWfSettings(tx);
  const lines = new Map((opts.lines ?? await rfqLines(tx, rfq.RfqId)).map((l) => [l.RfqLineId, l])); // already loaded by the caller: one round trip less
  const quotes = opts.quotes ?? await currentQuotes(tx, rfq.RfqId);
  const soFar = input.awards.some((a) => !opts.byContainers?.(a.rfqLineId, a.supplierCode)) ? await awardedSoFar(tx, rfq.RfqId) : new Map<string, Milli>(); // containers: not needed
  const invited = new Set((await tx.selectFrom('scm.RfqSupplier').select('SupplierCode').where('RfqId', '=', rfq.RfqId).execute()).map((s) => s.SupplierCode));
  const origins = await originsOf(tx, [...new Set(input.awards.map((a) => a.supplierCode))]);
  const qtyOf = (text: string, unit: string, what: string) => {
    try { return parseQty(text, incrementFor(settings, unit)); } catch { problems.push(`${what}: the quantity must be whole ${unit}`); return 0; }
  };

  const out: Checked = { problems, warnings, awards: [], releases: [] };
  const vendorChecked = new Set<string>();
  const vendors = await vendorProblems(tx, [...new Set(input.awards.map((a) => a.supplierCode))], rfq.CompanyCode); // one query for every supplier
  for (const a of input.awards) {
    const l = lines.get(a.rfqLineId);
    if (!l) { problems.push(`RFQ line ${a.rfqLineId} is not on this RFQ`); continue; }
    const what = `${l.ProposedEtdWeek} · ${lineLabel(l)} · ${a.supplierCode}`;
    const milli = qtyOf(a.qty, l.Unit, what);
    if (milli <= 0) continue;
    const blocker = lineBlocker(l);
    if (blocker) { problems.push(`${what}: ${blocker}`); continue; }
    if (!invited.has(a.supplierCode)) { problems.push(`${what}: the supplier is not invited`); continue; }
    if (!vendorChecked.has(a.supplierCode)) {
      vendorChecked.add(a.supplierCode);
      const p = vendors.get(a.supplierCode);
      if (p) problems.push(`${a.supplierCode}: ${p.message}`);
    }
    if (!(origins.get(a.supplierCode) ?? []).includes(l.OriginCode)) { problems.push(`${what}: the supplier does not supply origin ${l.OriginCode}`); continue; }
    const quote = quotes.find((q) => q.SupplierCode === a.supplierCode && q.EtdWeek === l.ProposedEtdWeek && q.LineKey === l.LineKey);
    if (!quote) { problems.push(`${what}: no quote from this supplier`); continue; }
    out.awards.push({ ...a, milli, line: l, quote });
  }
  // Per line: at most what is Quoted (every supplier in this batch together).
  for (const [id, l] of lines) {
    const total = out.awards.filter((a) => a.rfqLineId === id).reduce((s, a) => s + a.milli, 0);
    if (total > fromDb(l.Quoted)) problems.push(`${l.ProposedEtdWeek} · ${lineLabel(l)}: ${formatQty(total)} awarded, but only ${formatQty(fromDb(l.Quoted))} is quoted and unawarded`);
  }
  // Per supplier: one currency in the batch.
  for (const s of new Set(out.awards.map((a) => a.supplierCode))) {
    const cur = new Set(out.awards.filter((a) => a.supplierCode === s).map((a) => a.quote.Currency));
    if (cur.size > 1) problems.push(`${s}: all its items in one award must be in one currency (${[...cur].join(', ')})`);
  }
  // Cumulative availability per supplier × week × key: every batch + this one ≤ the quoted available, unless an override reason is given.
  for (const g of new Set(out.awards.map((a) => `${a.supplierCode}|${a.line.ProposedEtdWeek}|${a.line.LineKey}`))) {
    const mine = out.awards.filter((a) => `${a.supplierCode}|${a.line.ProposedEtdWeek}|${a.line.LineKey}` === g && !opts.byContainers?.(a.rfqLineId, a.supplierCode));
    if (!mine.length) continue;
    const total = (soFar.get(g) ?? 0) + mine.reduce((s, a) => s + a.milli, 0);
    const available = fromDb(mine[0].quote.AvailableQty);
    if (total > available && !mine.every((a) => a.overrideReason?.trim())) {
      problems.push(`${mine[0].supplierCode} quoted ${formatQty(available)} available for ${mine[0].line.ProposedEtdWeek} · ${lineLabel(mine[0].line)}; awards would total ${formatQty(total)} — give an override reason to go ahead`);
    }
  }
  // Shipments: every supplier × week awarded has containers (≥ 1); a confirmed ETD is a date.
  for (const k of new Set(out.awards.map((a) => `${a.supplierCode}|${a.line.ProposedEtdWeek}`))) {
    const [s, w] = k.split('|');
    const sh = input.shipments.find((x) => x.supplierCode === s && x.etdWeek === w);
    if (!sh || !Number.isInteger(sh.containerCount) || sh.containerCount < 1) problems.push(`${s} · ${w}: enter the containers of this shipment (at least 1)`);
    if (sh?.confirmedEtd) {
      const d = new Date(`${sh.confirmedEtd}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) problems.push(`${s} · ${w}: the confirmed ETD is not a date`);
      else if (isoWeekOf(d) !== w) warnings.push(`${s} · ${w}: the confirmed ETD ${sh.confirmedEtd} is in ${isoWeekOf(d)}`);
    }
  }
  // Releases: what is left after the awards, back to Open.
  for (const r of input.releases) {
    const l = lines.get(r.rfqLineId);
    if (!l) { problems.push(`RFQ line ${r.rfqLineId} is not on this RFQ`); continue; }
    const milli = qtyOf(r.qty, l.Unit, `${l.ProposedEtdWeek} · ${lineLabel(l)} release`);
    if (milli <= 0) continue;
    const awarded = out.awards.filter((a) => a.rfqLineId === r.rfqLineId).reduce((s, a) => s + a.milli, 0);
    const left = fromDb(l.Quoted) + fromDb(l.InRfq) - awarded;
    if (milli > left) problems.push(`${l.ProposedEtdWeek} · ${lineLabel(l)}: ${formatQty(milli)} to release, but only ${formatQty(left)} is left after the awards`);
    const reason = await tx.selectFrom('scm.ReasonCode').select('ReasonCode').where('ReasonCode', '=', r.reasonCode).where('Context', '=', 'RELEASE').where('IsActive', '=', true).executeTakeFirst();
    if (!reason) problems.push(`${l.ProposedEtdWeek} · ${lineLabel(l)}: choose a release reason`);
    out.releases.push({ ...r, milli, line: l });
  }
  out.problems = [...new Set(problems)];
  return out;
}
