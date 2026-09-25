/**
 * Container composition (spec 12): a group of identical containers, each with a
 * capacity, shared between materials by percentage. Pure and exact — shares are
 * basis points (1/100 of a percent), quantities milli-units.
 */
import { DomainError } from '../workflow/errors.js';
import { assertMilli, type Milli } from '../workflow/qty.js';

export const FULL_BP = 10_000;

/** "40" → 4000, "33.33" → 3333. Positive, at most 2 decimals, at most 100. */
export function parseShare(s: string): number {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(s).trim());
  if (!m) throw new DomainError('BAD_SHARE', `Invalid share "${s}" (a percentage with up to 2 decimals)`);
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (bp <= 0 || bp > FULL_BP) throw new DomainError('BAD_SHARE', `A share must be above 0% and at most 100% (got ${s}%)`);
  return bp;
}

export const formatShare = (bp: number) => {
  const whole = Math.trunc(bp / 100);
  const dec = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return dec ? `${whole}.${dec}` : String(whole);
};

/**
 * Quantity of each item for the whole group, in whole units (cartons cannot be
 * split). The split is made per container: each item gets its share of the
 * capacity rounded down to the increment, and the leftover goes to the item with
 * the largest share (the first on a tie), so every container holds exactly its
 * capacity. The group quantity is that × the number of containers. Shares must
 * total exactly 100%.
 */
export function composeGroup(g: { containerCount: number; capacity: Milli; increment: Milli; sharesBp: number[] }): Milli[] {
  return perContainer(g).map((q) => assertMilli(q * g.containerCount));
}

/** The split of one container (same rules as composeGroup). */
export function perContainer(g: { containerCount: number; capacity: Milli; increment: Milli; sharesBp: number[] }): Milli[] {
  if (!Number.isInteger(g.containerCount) || g.containerCount < 1) throw new DomainError('BAD_CONTAINERS', 'A group needs at least 1 container');
  assertMilli(g.capacity);
  if (g.capacity <= 0) throw new DomainError('BAD_CAPACITY', 'Capacity must be above zero');
  if (g.capacity % g.increment !== 0) throw new DomainError('BAD_CAPACITY', 'Capacity must be a whole number of units');
  if (g.sharesBp.length === 0) throw new DomainError('NO_ITEMS', 'Add at least one material to the group');
  const totalBp = g.sharesBp.reduce((a, b) => a + b, 0);
  if (totalBp !== FULL_BP) throw new DomainError('SHARES_NOT_100', `Shares total ${formatShare(totalBp)}%, not 100%`);

  const qty = g.sharesBp.map((bp) => Math.floor(assertMilli(g.capacity * bp) / FULL_BP / g.increment) * g.increment);
  const remainder = g.capacity - qty.reduce((a, b) => a + b, 0);
  qty[g.sharesBp.indexOf(Math.max(...g.sharesBp))] += remainder;
  return qty;
}
