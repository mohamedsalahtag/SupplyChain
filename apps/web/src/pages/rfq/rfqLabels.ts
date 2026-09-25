/** Labels shared by the RFQ screens (spec 18). */
/** Spec 21: the wording lives in lib/statuses.ts. */
export { RFQ_STATUS } from '../../lib/statuses';

export const RFQ_LINE_STATUS: Record<string, { label: string; color: string }> = {
  PENDING_QUOTE: { label: 'Pending quote', color: 'gold' },
  QUOTED: { label: 'Quoted', color: 'green' },
  PARTIALLY_AWARDED: { label: 'Partially awarded', color: 'lime' },
  AWARDED: { label: 'Awarded', color: 'green' },
  RELEASED: { label: 'Released', color: 'default' },
  CANCELLED: { label: 'Cancelled', color: 'red' },
  PENDING_SALES: { label: 'Pending Sales', color: 'gold' },
};

export const MATCH_LABEL: Record<string, { label: string; color: string }> = {
  SKU: { label: 'same SKU', color: 'green' },
  SPEC: { label: 'same size', color: 'green' },
  SUBCATEGORY: { label: 'same material', color: 'default' },
  NONE: { label: 'no history', color: 'default' },
};

/** "7000.000" → "7,000" */
export const n = (s: string | number) => Number(s).toLocaleString('en-GB', { maximumFractionDigits: 3 });
