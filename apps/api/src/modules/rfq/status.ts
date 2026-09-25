/** Derived RFQ and RFQ line statuses (spec 18, plan v5 §4.2–4.3). Pure. */
import type { Milli } from '../workflow/qty.js';

export type RfqQty = { inRfq: Milli; quoted: Milli; awarded: Milli };
export type RfqStatus = 'DRAFT' | 'SENT' | 'QUOTING' | 'PARTIALLY_AWARDED' | 'FULLY_AWARDED' | 'CLOSED' | 'CANCELLED';
export type RfqLineStatus = 'PENDING_QUOTE' | 'QUOTED' | 'PARTIALLY_AWARDED' | 'AWARDED' | 'RELEASED' | 'CANCELLED';

export function rfqStatus(manual: 'DRAFT' | 'SENT' | 'CANCELLED', q: RfqQty): RfqStatus {
  if (manual === 'CANCELLED') return 'CANCELLED';
  const open = q.inRfq + q.quoted;
  if (open === 0 && q.awarded === 0) return 'CLOSED';
  if (manual === 'DRAFT') return 'DRAFT';
  if (open === 0) return 'FULLY_AWARDED';
  if (q.awarded > 0) return 'PARTIALLY_AWARDED';
  return q.quoted > 0 ? 'QUOTING' : 'SENT';
}

export function rfqLineStatus(isCancelled: boolean, q: RfqQty): RfqLineStatus {
  if (isCancelled) return 'CANCELLED';
  const live = q.inRfq + q.quoted + q.awarded;
  if (live === 0) return 'RELEASED';
  if (q.awarded === live) return 'AWARDED';
  if (q.awarded > 0) return 'PARTIALLY_AWARDED';
  return q.quoted > 0 ? 'QUOTED' : 'PENDING_QUOTE';
}
