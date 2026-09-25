/**
 * Applying and undoing the Procurement change-request items (spec 19): add quantity,
 * extra containers, week shift, mix reduce / add. Called by decideCr (all items in
 * one transaction) and by withdraw.
 */
import { sql } from 'kysely';
import { formatQty, fromDb, parseQty, type Milli } from '../workflow/qty.js';
import { takeQty, transitionSlice, type SliceCtx } from '../workflow/slices.js';
import type { Tx } from '../workflow/tx.js';
import { addQty, adjustWeek, weekId } from './crApply.js';
import type { Effect } from './diff.js';

export const PROC_KINDS = ['ADD_QTY', 'ADD_CONTAINERS', 'WEEK_SHIFT', 'MIX_REDUCE', 'MIX_ADD'];
/** Kinds whose quantity Sales may approve less of. */
export const QTY_PARTIAL_KINDS = ['ADD_QTY', 'MIX_ADD', 'MIX_REDUCE'];

type Cr = { CrId: string; CrNo: string; DemandId: string; ReasonCode: string };
type Item = { CrItemId: string; ItemKind: string; EtdWeek: string; LineId: string | null; AfterJson: string | null; EffectJson: string; RequestedCount: number | null; RequestedQty: string | null };
type Decision = { decision: 'APPROVE' | 'PARTIAL' | 'REJECT'; approvedCount?: number; approvedQty?: string };
const after = (it: Item) => (it.AfterJson ? JSON.parse(it.AfterJson) : {}) as { rfqLineId?: string; toWeek?: string; splitFrom?: string };

/** The approved quantity of a quantity item. */
function approvedQty(it: Item, d: Decision): Milli {
  return d.decision === 'PARTIAL' ? parseQty(d.approvedQty ?? '0', 1000) : fromDb(it.RequestedQty);
}

export async function applyProcItem(tx: Tx, cr: Cr, it: Item, d: Decision, actorUserId: number): Promise<{ applied: Milli | null; message: string | null }> {
  const ctx: SliceCtx = { actorUserId, docType: 'CR', docId: cr.CrId, reasonCode: cr.ReasonCode };
  const a = after(it);
  switch (it.ItemKind) {
    case 'ADD_QTY': { // Procurement quantity, straight into the RFQ it was offered in (Quoted if already quoted)
      const q = approvedQty(it, d);
      if (q === 0) { await cancelProposedLine(tx, a.rfqLineId); return { applied: 0, message: null }; }
      const e = (JSON.parse(it.EffectJson) as Effect[])[0];
      const { lineId, sliceId } = await addQty(tx, cr, it.EtdWeek, e, q, actorUserId, 'PROCUREMENT');
      const rl = a.rfqLineId ? await tx.selectFrom('scm.RfqLine as l').innerJoin('scm.Rfq as r', 'r.RfqId', 'l.RfqId')
        .select(['l.RfqId', 'l.LineKey', 'l.ProposedEtdWeek', 'l.IsCancelled', 'r.ManualStatus']).where('l.RfqLineId', '=', a.rfqLineId).executeTakeFirst() : undefined;
      if (!rl || rl.IsCancelled || rl.ManualStatus === 'CANCELLED') {
        await cancelProposedLine(tx, a.rfqLineId);
        return { applied: q, message: 'The RFQ was cancelled meanwhile: the quantity is Open on the demand' };
      }
      await tx.updateTable('scm.RfqLine').set({ DemandLineId: lineId, AskedQty: q }).where('RfqLineId', '=', a.rfqLineId!).execute();
      await transitionSlice(tx, sliceId, 'ADD_TO_RFQ', ctx, sql`RfqLineId = ${a.rfqLineId!}`);
      const quoted = await tx.selectFrom('scm.SupplierQuote').select('QuoteId').where('RfqId', '=', String(rl.RfqId)).where('EtdWeek', '=', rl.ProposedEtdWeek)
        .where('LineKey', '=', rl.LineKey).where('IsCurrent', '=', true).executeTakeFirst();
      if (quoted) await transitionSlice(tx, sliceId, 'QUOTE_RECORDED', ctx);
      return { applied: q, message: null };
    }
    case 'ADD_CONTAINERS': {
      const n = d.decision === 'PARTIAL' ? d.approvedCount ?? 0 : it.RequestedCount ?? 0;
      await weekId(tx, cr.DemandId, it.EtdWeek); // the week may be new (its quantity may have been rejected)
      await adjustWeek(tx, cr.DemandId, it.EtdWeek, n);
      return { applied: null, message: null };
    }
    case 'WEEK_SHIFT': // the quantity is approved for the new week; it stays on its demand line
      await sql`UPDATE scm.QtySlice SET ApprovedEtdWeek = ${a.toWeek!} WHERE RfqLineId = ${a.rfqLineId!} AND ExecState IN ('IN_RFQ', 'QUOTED')`.execute(tx);
      return { applied: fromDb(it.RequestedQty), message: null };
    case 'MIX_REDUCE': { // cancelled from the RFQ, origin Change (not counted against Procurement)
      const want = approvedQty(it, d);
      const live = fromDb((await sql<{ q: string }>`SELECT ISNULL(SUM(Qty), 0) AS q FROM scm.QtySlice WHERE RfqLineId = ${a.rfqLineId!} AND ExecState IN ('IN_RFQ', 'QUOTED')`.execute(tx)).rows[0].q);
      const q = Math.min(want, live);
      if (q > 0) {
        for (const s of await takeQty(tx, { lineId: it.LineId!, qty: q, states: ['IN_RFQ', 'QUOTED'], where: sql`RfqLineId = ${a.rfqLineId!}`, ctx })) {
          await transitionSlice(tx, s, 'CR_CANCEL', ctx, sql`CancelOrigin = 'CHANGE', CancelCrId = ${cr.CrId}`);
        }
      }
      return { applied: q, message: q < want ? `Only ${formatQty(q)} of ${formatQty(want)} was still in the RFQ` : null };
    }
    case 'MIX_ADD': { // Change quantity, Open on the demand (Procurement adds it to an RFQ)
      const q = approvedQty(it, d);
      if (q > 0) await addQty(tx, cr, it.EtdWeek, (JSON.parse(it.EffectJson) as Effect[])[0], q, actorUserId, 'CHANGE');
      return { applied: q, message: null };
    }
    default:
      throw new Error(`Not a Procurement item: ${it.ItemKind}`);
  }
}

async function cancelProposedLine(tx: Tx, rfqLineId: string | undefined) {
  if (rfqLineId) await tx.updateTable('scm.RfqLine').set({ IsCancelled: true }).where('RfqLineId', '=', rfqLineId).where('DemandLineId', 'is', null).execute();
}

/** A rejected (or withdrawn) item leaves no trace: the proposed RFQ line is cancelled, a proposed week reverts. */
export async function undoProcItem(tx: Tx, it: Item): Promise<void> {
  const a = after(it);
  if (it.ItemKind === 'ADD_QTY') await cancelProposedLine(tx, a.rfqLineId);
  if (it.ItemKind === 'WEEK_SHIFT' && a.rfqLineId && a.splitFrom) { // split off a partly awarded line: its quantity goes back
    await sql`UPDATE scm.QtySlice SET RfqLineId = ${a.splitFrom} WHERE RfqLineId = ${a.rfqLineId} AND ExecState IN ('IN_RFQ', 'QUOTED')`.execute(tx);
    await tx.updateTable('scm.RfqLine').set({ IsCancelled: true, PreviousEtdWeek: null }).where('RfqLineId', '=', a.rfqLineId).execute();
  } else if (it.ItemKind === 'WEEK_SHIFT' && a.rfqLineId) {
    await sql`UPDATE scm.RfqLine SET ProposedEtdWeek = PreviousEtdWeek, PreviousEtdWeek = NULL WHERE RfqLineId = ${a.rfqLineId} AND PreviousEtdWeek IS NOT NULL`.execute(tx);
  }
}

export async function undoProcRequest(tx: Tx, crId: string): Promise<void> {
  const items = await tx.selectFrom('scm.ChangeRequestItem').select(['CrItemId', 'ItemKind', 'EtdWeek', 'LineId', 'AfterJson', 'EffectJson', 'RequestedCount', 'RequestedQty'])
    .where('CrId', '=', crId).execute();
  for (const it of items) await undoProcItem(tx, { ...it, CrItemId: String(it.CrItemId), LineId: it.LineId ? String(it.LineId) : null, RequestedQty: it.RequestedQty == null ? null : String(it.RequestedQty) });
}
