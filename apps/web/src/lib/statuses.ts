/**
 * Status wording (spec 21): every status says what it means, who has the record and what happens next.
 * `step` is the position in the process steps shown on the page header (-1 = off the path).
 */
export type StatusDef = { label: string; color: string; tip: string; who: string; next: string; step: number };

export const DEMAND_STEPS = ['Sales prepares', 'Procurement review', 'Accepted', 'Sourcing (RFQ)', 'Awarded', 'Ordered (PO)', 'Closed'];
export const RFQ_STEPS = ['Prepared', 'Sent to suppliers', 'Quotes in', 'Awarded', 'Handed off', 'Closed'];

export const DEMAND_STATUS: Record<string, StatusDef> = {
  DRAFT: { label: 'Draft', color: 'default', step: 0, who: 'Sales', next: 'Sales submits it to Procurement',
    tip: 'Sales is still preparing it. Procurement cannot see it yet. Next: Sales submits it to Procurement.' },
  SUBMITTED: { label: 'Waiting for Procurement to accept', color: 'purple', step: 1, who: 'Procurement', next: 'Procurement accepts it, or returns it to Sales with a reason',
    tip: 'Sales submitted it. Next: Procurement accepts it, or returns it to Sales with a reason. Sales can still take it back to change it.' },
  RETURNED: { label: 'Returned to Sales', color: 'orange', step: 0, who: 'Sales', next: 'Sales changes it and submits it again',
    tip: 'Procurement returned it with a reason. Next: Sales changes it and submits it again.' },
  NOT_STARTED: { label: 'Accepted · nothing sourced yet', color: 'blue', step: 2, who: 'Procurement', next: 'Procurement creates an RFQ',
    tip: 'Procurement accepted it. None of its quantity is in an RFQ yet. Next: Procurement creates an RFQ.' },
  PARTIALLY_IN_EXECUTION: { label: 'Partly in sourcing', color: 'cyan', step: 3, who: 'Procurement', next: 'Procurement sources the open part',
    tip: 'Some quantity is in an RFQ or awarded; the rest is still open on the demand. Next: Procurement sources the open part (Create RFQ…).' },
  FULLY_IN_EXECUTION: { label: 'All in sourcing', color: 'geekblue', step: 3, who: 'Procurement', next: 'Quote, award, hand off',
    tip: 'Every quantity is in an RFQ, awarded or further; nothing is open. Next: the RFQs are quoted and awarded, then handed off.' },
  CLOSED_FULLY_EXECUTED: { label: 'Closed · all ordered', color: 'green', step: 6, who: 'Nobody — finished', next: 'Nothing',
    tip: 'All quantity reached a purchase order. Nothing more to do.' },
  CLOSED_PARTIALLY_EXECUTED: { label: 'Closed · partly ordered, rest cancelled', color: 'lime', step: 6, who: 'Nobody — finished', next: 'Nothing',
    tip: 'Part reached a purchase order; the rest was cancelled (change request or not sourced). Nothing more to do.' },
  CANCELLED: { label: 'Cancelled', color: 'red', step: -1, who: 'Nobody — finished', next: 'Nothing',
    tip: 'The demand was cancelled. Who cancelled it and why is in the last step.' },
  MERGED: { label: 'Merged', color: 'default', step: -1, who: 'The other demand', next: 'Continue on the other demand',
    tip: 'Its weeks were merged into another demand, which carries on. Nothing more to do here.' },
};

export const RFQ_STATUS: Record<string, StatusDef> = {
  DRAFT: { label: 'Draft · not sent to suppliers', color: 'default', step: 0, who: 'Procurement', next: 'Download the supplier view, send it to the suppliers, press Send',
    tip: 'Procurement is preparing it. Next: download the supplier view, send it to the suppliers (e-mail, outside the app) and press Send.' },
  SENT: { label: 'Sent · waiting for quotes', color: 'blue', step: 1, who: 'The suppliers (to quote), then Procurement', next: 'Record each supplier’s quote',
    tip: 'Procurement sent it to the invited suppliers (outside the app) and marked it Sent. Next: record each supplier’s quote.' },
  QUOTING: { label: 'Quotes in · ready to award', color: 'purple', step: 2, who: 'Procurement', next: 'Record the other quotes, or award',
    tip: 'At least one supplier has quoted. Next: record the other quotes, or award (Award…).' },
  PARTIALLY_AWARDED: { label: 'Partly awarded', color: 'lime', step: 3, who: 'Procurement', next: 'Award the rest, or release it back to the demand',
    tip: 'Part of the quoted containers is awarded; the rest is still quoted. Next: award the rest, or release it back to the demand.' },
  FULLY_AWARDED: { label: 'Fully awarded', color: 'green', step: 3, who: 'Procurement', next: 'Hand the award off to the PO team (Stage 6)',
    tip: 'Everything in this RFQ is awarded. Next: handoff to the PO team (Stage 6), from the award.' },
  CLOSED: { label: 'Closed · nothing left (all released)', color: 'default', step: 5, who: 'Nobody — this RFQ is finished', next: 'Nothing in this RFQ',
    tip: 'The RFQ holds no quantity any more: everything was released or un-awarded back to the demand, where it is open again. Nothing more to do in this RFQ.' },
  CANCELLED: { label: 'Cancelled', color: 'red', step: -1, who: 'Nobody — finished', next: 'Nothing in this RFQ',
    tip: 'Procurement cancelled it; its quantity went back to the demand. The reason is shown.' },
};

export const ACK_STATUS: Record<string, StatusDef> = {
  PENDING: { label: 'Waiting for Sales to acknowledge', color: 'gold', step: 1, who: 'Sales', next: 'Sales acknowledges, or asks a question',
    tip: 'Procurement awarded containers from this demand. Next: Sales acknowledges or asks a question. It never blocks the handoff.' },
  QUERY_RAISED: { label: 'Sales asked a question', color: 'volcano', step: 1, who: 'Procurement', next: 'Procurement answers; then Sales is asked again',
    tip: 'Sales asked a question instead of acknowledging. Next: Procurement answers; then Sales is asked again.' },
  ACKNOWLEDGED: { label: 'Acknowledged by Sales', color: 'green', step: 2, who: 'Procurement', next: 'Hand off to the PO team (Stage 6)',
    tip: 'Sales saw the award and acknowledged it. Any later change asks Sales again. Next: handoff to the PO team (Stage 6).' },
  ACKNOWLEDGED_LATE: { label: 'Acknowledged by Sales after handoff', color: 'lime', step: 2, who: 'Procurement', next: 'Nothing for Sales',
    tip: 'Sales acknowledged it after it was already handed off to the PO team.' },
};

export const HANDOFF_STATUS: Record<string, StatusDef> = {
  HANDED_OFF: { label: 'Waiting for the PO team to accept', color: 'purple', step: 4, who: 'PO team', next: 'The PO team accepts it, or returns it to Procurement',
    tip: 'Procurement handed this supplier’s award to the PO team. Next: the PO team accepts it (the PO is prepared) or returns it with a reason.' },
  ACCEPTED: { label: 'Accepted — PO being prepared', color: 'green', step: 4, who: 'PO team', next: 'The PO team prepares the PO (Stage 7)',
    tip: 'The PO team accepted it; the quantity is in PO preparation. It can still be returned until the PO is submitted.' },
  RETURNED: { label: 'Returned to Procurement', color: 'orange', step: 3, who: 'Procurement', next: 'Procurement fixes it and hands off again',
    tip: 'The PO team (or a change request, automatically) sent it back. The quantity is Awarded again; Procurement fixes it and hands off again — a new handoff number.' },
};

export const PO_STATUS: Record<string, StatusDef> = {
  DRAFT: { label: 'Draft — not validated', color: 'default', step: 0, who: 'PO team', next: 'Validate it',
    tip: 'Built from the handoff (one PO per supplier award). Next: validate it — every check must pass before it can go to SAP.' },
  VALIDATED: { label: 'Validated — ready to submit', color: 'blue', step: 1, who: 'PO team', next: 'Submit it to SAP',
    tip: 'Every check passed. Next: submit it; the checks run again at submit.' },
  SUBMITTED: { label: 'Submitted — waiting for SAP', color: 'purple', step: 2, who: 'SAP (the outbox sends it)', next: 'Nothing — SAP answers within minutes',
    tip: 'The payload is frozen and queued for SAP. The quantity is locked until SAP answers.' },
  UNKNOWN: { label: 'SAP outcome unknown', color: 'gold', step: 2, who: 'The outbox, then the PO team', next: 'The outbox asks SAP; if it cannot, resolve it with evidence',
    tip: 'SAP did not answer clearly (timeout, lost reply). The quantity stays locked; the outbox asks SAP whether the PO exists and never sends it twice.' },
  CREATED: { label: 'Created in SAP', color: 'green', step: 3, who: 'Nobody — done', next: 'Nothing',
    tip: 'SAP created the purchase order; its number is shown. The quantity is final.' },
  REJECTED: { label: 'Not created in SAP', color: 'red', step: 1, who: 'PO team', next: 'Fix it (SKUs) and build a new draft, or return the handoff',
    tip: 'SAP refused it (or it was confirmed not created). The quantity is back in PO preparation. A new draft gets a new number.' },
  VOID: { label: 'Void', color: 'default', step: -1, who: 'Nobody', next: 'Nothing',
    tip: 'Replaced before it was submitted (SKU changed, handoff returned).' },
};
export const PO_STEPS = ['Draft', 'Validated', 'Submitted to SAP', 'Created in SAP'];
