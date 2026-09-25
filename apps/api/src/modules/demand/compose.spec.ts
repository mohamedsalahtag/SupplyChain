import { describe, expect, it } from 'vitest';
import { composeGroup, formatShare, parseShare } from './compose.js';

const CT = 1000; // whole cartons, in milli-units

describe('shares', () => {
  it('parses percentages with up to 2 decimals into basis points', () => {
    expect(parseShare('40')).toBe(4000);
    expect(parseShare('33.33')).toBe(3333);
    expect(parseShare('0.5')).toBe(50);
    expect(formatShare(3333)).toBe('33.33');
    expect(formatShare(4000)).toBe('40');
  });
  it('refuses 0, more than 100, 3 decimals and junk', () => {
    for (const bad of ['0', '100.01', '101', '33.333', '-5', 'x', '']) expect(() => parseShare(bad), bad).toThrow(/share/i);
  });
});

describe('composeGroup (spec 12)', () => {
  it('40 / 60 of 2 × 1,540 CT', () => {
    expect(composeGroup({ containerCount: 2, capacity: 1540 * CT, increment: CT, sharesBp: [4000, 6000] })).toEqual([1232 * CT, 1848 * CT]);
  });

  it('whole cartons per container: 3 × 1,000 CT at 33.33 / 33.33 / 33.34 gives 333 / 333 / 334 per container', () => {
    expect(composeGroup({ containerCount: 3, capacity: 1000 * CT, increment: CT, sharesBp: [3333, 3333, 3334] })).toEqual([999 * CT, 999 * CT, 1002 * CT]);
  });

  it('three thirds: the remainder goes to the largest share, the total is exact', () => {
    const q = composeGroup({ containerCount: 1, capacity: 1540 * CT, increment: CT, sharesBp: [3333, 3333, 3334] });
    expect(q).toEqual([513 * CT, 513 * CT, 514 * CT]);
    expect(q.reduce((a, b) => a + b, 0)).toBe(1540 * CT);
  });

  it('rounds to the unit\'s increment and keeps every total exact over many random compositions', () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rnd() * 6);
      const cuts = Array.from({ length: n - 1 }, () => 1 + Math.floor(rnd() * 9999)).sort((a, b) => a - b);
      const shares = [...cuts, 10_000].map((c, j, a) => c - (j ? a[j - 1] : 0)).filter((s) => s > 0);
      if (shares.reduce((a, b) => a + b, 0) !== 10_000 || shares.length === 0) continue;
      const containers = 1 + Math.floor(rnd() * 20);
      const capacity = (100 + Math.floor(rnd() * 3000)) * CT;
      const q = composeGroup({ containerCount: containers, capacity, increment: CT, sharesBp: shares });
      expect(q.reduce((a, b) => a + b, 0)).toBe(containers * capacity);
      // every container holds whole cartons: the group quantity divides exactly by the number of containers
      expect(q.every((x) => x >= 0 && x % containers === 0 && (x / containers) % CT === 0)).toBe(true);
    }
  });

  it('refuses shares that do not total 100%, no materials, a capacity off the increment', () => {
    expect(() => composeGroup({ containerCount: 1, capacity: 1540 * CT, increment: CT, sharesBp: [4000, 5000] })).toThrow(/total 90%/);
    expect(() => composeGroup({ containerCount: 1, capacity: 1540 * CT, increment: CT, sharesBp: [] })).toThrow(/at least one material/);
    expect(() => composeGroup({ containerCount: 1, capacity: 1540.5 * CT, increment: CT, sharesBp: [10_000] })).toThrow(/whole number/);
    expect(() => composeGroup({ containerCount: 0, capacity: 1540 * CT, increment: CT, sharesBp: [10_000] })).toThrow(/at least 1 container/);
  });
});
