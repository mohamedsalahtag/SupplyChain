/**
 * Exceptions for Procurement (spec 18): Open quantity whose ETD is near
 * (setting "weeks before ETD"), and an origin no supplier can supply.
 * Run hourly and after RFQ commands; items open and close themselves.
 */
import { sql } from 'kysely';
import { closeInbox, openInbox } from '../workflow/inbox.js';
import { isoWeekOf } from '../workflow/isoWeek.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import type { Db, Tx } from '../workflow/tx.js';
import { P_RFQ } from './rfqService.js';
import { supplierShortlist } from './shortlist.js';

export async function refreshAging(db: Db, now = new Date()): Promise<{ opened: number; closed: number }> {
  const weeks = (await loadWfSettings(db)).agingWeeksBeforeEtd;
  const until = isoWeekOf(new Date(now.getTime() + weeks * 7 * 86_400_000));
  const due = (await sql<{ LineId: string; DemandId: string; DemandNo: string; CompanyCode: string; SubMajorCategory: string; Week: string; Unit: string; Qty: string }>`
    SELECT l.LineId, d.DemandId, d.DemandNo, d.CompanyCode, l.SubMajorCategory, MIN(s.ApprovedEtdWeek) AS Week, l.Unit, SUM(s.Qty) AS Qty
    FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId JOIN scm.Demand d ON d.DemandId = l.DemandId
    WHERE s.ExecState = 'OPEN' AND d.WorkflowStatus = 'ACCEPTED' AND l.IsActive = 1 AND s.ApprovedEtdWeek <= ${until} -- weeks already past are the most urgent: kept
    GROUP BY l.LineId, d.DemandId, d.DemandNo, d.CompanyCode, l.SubMajorCategory, l.Unit`.execute(db)).rows;
  const open = await db.selectFrom('scm.InboxItem').select('EntityId').where('ItemType', '=', 'OPEN_QTY_AGING').where('IsOpen', '=', true).execute();
  const dueIds = new Set(due.map((r) => String(r.LineId)));
  let closed = 0;
  for (const o of open.filter((x) => !dueIds.has(x.EntityId))) closed += await closeInbox(db, 'OPEN_QTY_AGING', 'LINE', o.EntityId, null);
  const already = new Set(open.map((o) => o.EntityId));
  for (const r of due) {
    await openInbox(db, {
      itemType: 'OPEN_QTY_AGING', permission: P_RFQ.manage, companyCode: r.CompanyCode, entityType: 'LINE', entityId: String(r.LineId),
      number: r.DemandNo, title: `${r.SubMajorCategory} · ${formatQty(fromDb(r.Qty)).replace(/\.000$/, '')} ${r.Unit} Open for ${r.Week}`,
      note: `ETD within ${weeks} week(s) and not yet in an RFQ`, link: `/rfqs/new?demand=${r.DemandId}`, raisedBy: null,
    });
  }
  // Origins that had no supplier: closed as soon as one can supply them.
  const missing = await db.selectFrom('scm.InboxItem').select(['EntityId', 'CompanyCode']).where('ItemType', '=', 'SUPPLIER_MISSING_ORIGIN').where('IsOpen', '=', true).execute();
  for (const m of missing) {
    const origin = m.EntityId.split(':')[1];
    const [g] = await supplierShortlist(db, m.CompanyCode ?? '', [{ lineId: '0', majorCategory: '', subMajorCategory: '', size: '', originCode: origin, materialCode: null, unit: '' }]);
    if (g && !g.problem) closed += await closeInbox(db, 'SUPPLIER_MISSING_ORIGIN', 'ORIGIN', m.EntityId, null);
  }
  return { opened: due.filter((r) => !already.has(String(r.LineId))).length, closed };
}

/** Opened by the builder when an origin of the chosen lines has no supplier (one item per company × origin). */
export async function flagMissingOrigin(db: Db | Tx, companyCode: string, originCode: string, demandNo: string, userId: number): Promise<void> {
  await openInbox(db, {
    itemType: 'SUPPLIER_MISSING_ORIGIN', permission: P_RFQ.manage, companyCode, entityType: 'ORIGIN', entityId: `${companyCode}:${originCode}`,
    number: originCode, title: `No supplier can supply ${originCode} for company ${companyCode}`,
    note: `Seen while building an RFQ for ${demandNo}. Add the origin to a supplier (Configuration → Supplier origins) or extend a supplier to the company in SAP.`,
    link: '/settings?tab=supplier-origins', raisedBy: userId,
  });
}
