import { describe, expect, it } from 'vitest';
import { formatQty, fromDb, parseQty, sumQty } from './qty.js';

describe('exact quantities (plan v5 §0.3)', () => {
  it('parses decimal strings into milli-units without floating point', () => {
    expect(parseQty('3000')).toBe(3_000_000);
    expect(parseQty('0.001')).toBe(1);
    expect(parseQty('3000.5')).toBe(3_000_500);
    expect(parseQty(' 12.34 ')).toBe(12_340);
  });

  it('rejects more than 3 decimals, negatives, zero, and junk', () => {
    for (const bad of ['1.2345', '-1', '0', '0.000', 'abc', '', '1e3', '1,000']) {
      expect(() => parseQty(bad), bad).toThrow(/quantity|Quantity/);
    }
  });

  it('enforces the minimum increment per unit', () => {
    expect(parseQty('5', 1000)).toBe(5000);
    expect(() => parseQty('5.5', 1000)).toThrow(/multiple of 1.000/);
  });

  it('formats with exactly 3 decimals', () => {
    expect(formatQty(3_000_000)).toBe('3000.000');
    expect(formatQty(1)).toBe('0.001');
    expect(formatQty(-1500)).toBe('-1.500');
  });

  it('reads BIGINT strings from the driver exactly', () => {
    expect(fromDb('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(fromDb(null)).toBe(0);
    expect(() => fromDb('9007199254740993')).toThrow(/exact/);
    expect(() => fromDb('1.5')).toThrow(/milli/);
  });

  it('keeps totals exact over 10,000 random splits', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 10_000; i++) {
      const total = 1 + Math.floor(rnd() * 10_000_000);
      const parts: number[] = [];
      let left = total;
      while (left > 0) {
        const take = Math.min(left, 1 + Math.floor(rnd() * total));
        parts.push(take);
        left -= take;
      }
      expect(sumQty(parts)).toBe(total);
    }
  });
});
