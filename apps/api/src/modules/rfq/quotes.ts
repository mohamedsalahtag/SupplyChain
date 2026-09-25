/**
 * Recording quotes (spec 18, plan v5 §4 rule 10): per supplier × week × material
 * row of the supplier view. A newer quote replaces the supplier's current one for
 * the row (kept in history); quotes do not expire. The first quote for a row
 * turns its quantity from In RFQ to Quoted.
 */
import { sql } from 'kysely';
import { incrementFor } from '../demand/content.js';
import { skuForCriteria } from '../demand/lookups.js';
import type { Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError } from '../workflow/errors.js';
import { recordEvent } from '../workflow/events.js';
import { parseQty } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import { transitionSlice } from '../workflow/slices.js';
import { originsOf } from '../workflow/supplierOrigins.js';
import { addThreadEntry } from '../workflow/threads.js';
import type { Db } from '../workflow/tx.js';
import { lockRfq, refreshQuoteTask } from './rfqService.js';

const PRICE = /^\d{1,14}(\.\d{1,4})?$/;

export type QuoteRow = { etdWeek: string; lineKey: string; unitPrice: string; availableQty: string; quotedSku?: string | null };
/** Containers are offered per week: one container can carry several sizes and grades (spec 18 revision). */
export type QuoteWeek = { etdWeek: string; containersOffered: number };

export async function recordQuotes(db: Db, actor: Actor, commandId: string, rfqId: string, supplierCode: string, currency: string, rows: QuoteRow[], weeks: QuoteWeek[] = []) {
  return runCommand(db, actor.id, commandId, 'rfq.quote', async (tx) => {
    const r = await lockRfq(tx, actor, rfqId);
    if (r.ManualStatus !== 'SENT') throw new DomainError('BAD_STATE', r.ManualStatus === 'DRAFT' ? `Send ${r.RfqNo} before recording quotes` : `${r.RfqNo} is cancelled`, 409);
    const invited = await tx.selectFrom('scm.RfqSupplier').select('SupplierCode').where('RfqId', '=', rfqId).where('SupplierCode', '=', supplierCode).executeTakeFirst();
    if (!invited) throw new DomainError('NOT_INVITED', `Supplier ${supplierCode} is not invited to ${r.RfqNo}`);
    if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError('BAD_CURRENCY', 'Currency is a 3-letter code, e.g. USD');
    if (!rows.length && !weeks.length) throw new DomainError('NOTHING_TO_SAVE', 'Enter at least one quote');
    const origins = (await originsOf(tx, [supplierCode])).get(supplierCode) ?? [];
    const settings = await loadWfSettings(tx);

    const problems: string[] = [];
    const valid: (QuoteRow & { lineIds: string[]; unit: string; originCode: string; available: number })[] = [];
    for (const q of rows) {
      const lines = await tx.selectFrom('scm.RfqLine').select(['RfqLineId', 'MajorCategory', 'SubMajorCategory', 'Size', 'MaterialClass', 'OriginCode', 'Unit'])
        .where('RfqId', '=', rfqId).where('ProposedEtdWeek', '=', q.etdWeek).where('LineKey', '=', q.lineKey).where('IsCancelled', '=', false).execute();
      const what = `${q.etdWeek} · ${lines[0]?.SubMajorCategory ?? q.lineKey}`;
      if (!lines.length) { problems.push(`${what}: not on this RFQ`); continue; }
      const l = lines[0];
      if (!origins.includes(l.OriginCode)) { problems.push(`${what}: supplier ${supplierCode} does not supply origin ${l.OriginCode}`); continue; }
      if (!PRICE.test(q.unitPrice) || Number(q.unitPrice) <= 0) { problems.push(`${what}: unit price must be above 0 (up to 4 decimals)`); continue; }
      let available: number;
      try { available = parseQty(q.availableQty, incrementFor(settings, l.Unit)); } catch { problems.push(`${what}: available quantity must be whole ${l.Unit}`); continue; }
      if (q.quotedSku && !(await skuForCriteria(tx, q.quotedSku, { majorCategory: l.MajorCategory, subMajorCategory: l.SubMajorCategory, size: l.Size, materialClass: l.MaterialClass, originCode: l.OriginCode, unit: l.Unit }))) {
        problems.push(`${what}: SKU ${q.quotedSku} does not match this material`); continue;
      }
      valid.push({ ...q, lineIds: lines.map((x) => String(x.RfqLineId)), unit: l.Unit, originCode: l.OriginCode, available });
    }
    const rfqWeeks = new Set((await tx.selectFrom('scm.RfqWeek').select('EtdWeek').where('RfqId', '=', rfqId).execute()).map((w) => w.EtdWeek));
    for (const w of weeks) {
      if (!rfqWeeks.has(w.etdWeek)) problems.push(`${w.etdWeek}: not a week of this RFQ`);
      if (!Number.isInteger(w.containersOffered) || w.containersOffered < 0) problems.push(`${w.etdWeek}: containers must be a whole number`);
    }
    // No quote without the containers offered for its week (at least 1) — given now or recorded before (user rule 2026-09-24).
    const known = new Map((await tx.selectFrom('scm.SupplierQuoteWeek').select(['EtdWeek', 'ContainersOffered']).where('RfqId', '=', rfqId).where('SupplierCode', '=', supplierCode).execute())
      .map((w) => [w.EtdWeek, w.ContainersOffered]));
    for (const w of weeks) known.set(w.etdWeek, w.containersOffered);
    for (const wk of [...new Set(valid.map((q) => q.etdWeek))]) {
      if (!((known.get(wk) ?? 0) >= 1)) problems.push(`${wk}: enter the containers offered for this week (at least 1) to save its quotes`);
    }
    if (problems.length) {
      if (problems.some((p) => p.includes('does not supply origin'))) throw new DomainError('SUPPLIER_ORIGIN_MISMATCH', problems.join('; '), 422, { problems });
      throw new DomainError('BAD_QUOTE', 'Some quotes cannot be saved', 422, { problems });
    }

    let replaced = 0;
    for (const q of valid) {
      const prev = await tx.selectFrom('scm.SupplierQuote').select('QuoteId').where('RfqId', '=', rfqId).where('SupplierCode', '=', supplierCode)
        .where('EtdWeek', '=', q.etdWeek).where('LineKey', '=', q.lineKey).where('IsCurrent', '=', true).executeTakeFirst();
      if (prev) await tx.updateTable('scm.SupplierQuote').set({ IsCurrent: false }).where('QuoteId', '=', prev.QuoteId).execute();
      const id = String((await tx.insertInto('scm.SupplierQuote').values({
        RfqId: rfqId, SupplierCode: supplierCode, EtdWeek: q.etdWeek, LineKey: q.lineKey, OriginCode: q.originCode, Unit: q.unit, QuotedSku: q.quotedSku || null,
        UnitPrice: q.unitPrice, Currency: currency, AvailableQty: q.available, ContainersOffered: null,
        OriginsAtQuote: origins.join(','), SupersededBy: null, RecordedBy: actor.id,
      }).output('inserted.QuoteId').executeTakeFirstOrThrow()).QuoteId);
      if (prev) { replaced++; await tx.updateTable('scm.SupplierQuote').set({ SupersededBy: id }).where('QuoteId', '=', prev.QuoteId).execute(); }
      // The row's quantity that was still waiting for a quote is now Quoted.
      const waiting = await sql<{ SliceId: string }>`SELECT SliceId FROM scm.QtySlice WITH (UPDLOCK)
        WHERE RfqLineId IN (${sql.join(q.lineIds)}) AND ExecState = 'IN_RFQ' ORDER BY SliceId`.execute(tx);
      for (const s of waiting.rows) await transitionSlice(tx, String(s.SliceId), 'QUOTE_RECORDED', { actorUserId: actor.id, docType: 'RFQ', docId: rfqId, comment: `Quoted by ${supplierCode}` });
    }
    for (const w of weeks) { // the latest entry per supplier × week counts
      await tx.deleteFrom('scm.SupplierQuoteWeek').where('RfqId', '=', rfqId).where('SupplierCode', '=', supplierCode).where('EtdWeek', '=', w.etdWeek).execute();
      await tx.insertInto('scm.SupplierQuoteWeek').values({ RfqId: rfqId, SupplierCode: supplierCode, EtdWeek: w.etdWeek, ContainersOffered: w.containersOffered, RecordedBy: actor.id }).execute();
    }
    const name = (await tx.selectFrom('md.Supplier').select('Name').where('SupplierCode', '=', supplierCode).executeTakeFirst())?.Name ?? supplierCode;
    const eventId = await recordEvent(tx, { type: 'QUOTES_RECORDED', entityType: 'RFQ', entityId: rfqId, demandId: r.DemandId, payload: { supplierCode, rows: valid.length, replaced }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'RFQ', entityId: rfqId, kind: 'SYSTEM', body: `Quotes from ${name}: ${valid.length} row(s)${replaced ? `, ${replaced} replacing earlier quotes` : ''}`, authorUserId: actor.id, eventId });
    await refreshQuoteTask(tx, r, actor.id);
    return { saved: valid.length, replaced };
  });
}
