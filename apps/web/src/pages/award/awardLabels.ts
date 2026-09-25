/** Labels shared by the award screens (spec 20). */
/** Spec 21: the wording lives in lib/statuses.ts. */
export { ACK_STATUS } from '../../lib/statuses';

export const SKU_STATUS: Record<string, { label: string; color: string }> = {
  RESOLVED_AT_DEMAND: { label: 'from the demand', color: 'green' },
  RESOLVED_AT_RFQ: { label: 'from the quote', color: 'green' },
  PENDING: { label: 'pending (PO team)', color: 'default' },
  RESOLVED_AT_PO: { label: 'set at PO', color: 'blue' },
  PENDING_MASTER_DATA: { label: 'waiting for SAP', color: 'orange' },
};

export const CHANGE_TYPE: Record<string, string> = {
  UNAWARD_KEEP_QUOTES: 'Un-awarded (quotes kept)', UNAWARD_RELEASE: 'Un-awarded (released)', CANCELLED_BY_CR: 'Cancelled by change request', SKU_CORRECTED: 'SKU corrected',
};

export const ACK_CAUSE: Record<string, string> = {
  CREATED: 'Awarded', ACKNOWLEDGED: 'Acknowledged', QUERY: 'Query raised', ANSWERED: 'Query answered', RESET_UNAWARD: 'Changed: un-award',
  RESET_CANCEL: 'Changed: cancellation', RESET_SKU: 'Changed: SKU', RESET_SHIPMENT: 'Changed: shipment', LATE: 'Acknowledged after handoff',
};

export const CONTAINER_CHANGE: Record<string, string> = {
  ABOVE_OFFER: 'Above the offer', CONTAINERS_ADDED: 'Containers added', UNAWARD_KEEP_QUOTES: 'Containers un-awarded (quotes kept)', UNAWARD_RELEASE: 'Containers un-awarded (released)',
};
