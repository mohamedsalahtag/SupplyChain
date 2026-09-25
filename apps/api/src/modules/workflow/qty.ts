/**
 * Exact quantities (plan v5 §0.3). Stored as BIGINT thousandths of the unit
 * ("milli", 1 CTN = 1000); in TypeScript a safe integer; in APIs a decimal
 * string such as "3000.000". No floating point anywhere.
 */
import { DomainError } from './errors.js';

export type Milli = number;

export function assertMilli(v: number, label = 'quantity'): Milli {
  if (!Number.isSafeInteger(v)) throw new DomainError('BAD_QTY', `${label} must be an exact quantity`);
  return v;
}

/** The driver returns BIGINT as a string: convert exactly. */
export function fromDb(v: string | number | bigint | null | undefined): Milli {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string' && !/^-?\d+$/.test(v.trim())) throw new DomainError('BAD_QTY', `Not a whole milli-unit value: "${v}"`);
  return assertMilli(Number(v));
}

/** "3000.5" → 3000500. Positive, at most 3 decimals, a multiple of the increment. */
export function parseQty(s: string, minIncrementMilli = 1): Milli {
  const m = /^(\d{1,15})(?:\.(\d{1,3}))?$/.exec(String(s).trim());
  if (!m) throw new DomainError('BAD_QTY', `Invalid quantity "${s}"`);
  const v = assertMilli(Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0')));
  if (v <= 0) throw new DomainError('BAD_QTY', 'Quantity must be greater than zero');
  if (minIncrementMilli > 1 && v % minIncrementMilli !== 0) {
    throw new DomainError('BAD_QTY', `Quantity must be a multiple of ${formatQty(minIncrementMilli)}`);
  }
  return v;
}

export function formatQty(v: Milli): string {
  assertMilli(v);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  return `${sign}${Math.trunc(a / 1000)}.${String(a % 1000).padStart(3, '0')}`;
}

export const sumQty = (xs: Milli[]): Milli => assertMilli(xs.reduce((a, b) => a + b, 0));
