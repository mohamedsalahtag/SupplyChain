import { describe, expect, it } from 'vitest';
import { capacityForGroup, matchOne, type CapacityRow } from './capacityMatch.js';

let id = 0;
const row = (majorCategory: string, subMajorCategory: string | null, size: string | null, capacity: number, unit = 'CT', isActive = true): CapacityRow =>
  ({ capacityId: ++id, majorCategory, subMajorCategory, size, unit, capacity, isActive });

const rows = [
  row('Apples', null, null, 1000),
  row('Apples', 'Royal Gala', null, 1100),
  row('Apples', 'Royal Gala', '100', 1200),
  row('Apples', 'Granny Smith', null, 900, 'CT', false), // inactive
  row('Citrus', 'Oranges', null, 1500, 'KG'),
];
const item = (majorCategory: string, subMajorCategory: string, size = '') => ({ majorCategory, subMajorCategory, size });

describe('matchOne (spec 32): the most specific active row wins', () => {
  it('major + sub-major + size beats major + sub-major beats major', () => {
    expect(matchOne(rows, item('Apples', 'Royal Gala', '100'))?.capacity).toBe(1200);
    expect(matchOne(rows, item('Apples', 'Royal Gala', '113'))?.capacity).toBe(1100);
    expect(matchOne(rows, item('Apples', 'Fuji', '100'))?.capacity).toBe(1000);
  });
  it('"any size" on the demand never matches a row for one size', () => {
    expect(matchOne(rows, item('Apples', 'Royal Gala', ''))?.capacity).toBe(1100);
  });
  it('ignores inactive rows (falls back to the major)', () => {
    expect(matchOne(rows, item('Apples', 'Granny Smith'))?.capacity).toBe(1000);
  });
  it('compares like SQL Server: case and outer spaces do not matter', () => {
    expect(matchOne(rows, item('apples ', 'ROYAL GALA', '100'))?.capacity).toBe(1200);
  });
  it('null when nothing matches', () => {
    expect(matchOne(rows, item('Grapes', 'Red Globe'))).toBeNull();
  });
});

describe('capacityForGroup (spec 32): a mixed container takes its smallest capacity', () => {
  it('smallest across the products, with its source', () => {
    const r = capacityForGroup(rows, [item('Apples', 'Royal Gala', '100'), item('Apples', 'Fuji', '88')]);
    expect(r.capacity).toBe(1000);
    expect(r.unit).toBe('CT');
    expect(r.source?.label).toBe('Apples (all)');
    expect(r.note).toBeNull();
  });
  it('one product: its own row, labelled', () => {
    const r = capacityForGroup(rows, [item('Apples', 'Royal Gala', '100')]);
    expect(r.capacity).toBe(1200);
    expect(r.source?.label).toBe('Apples Royal Gala 100');
  });
  it('the label does not repeat a major that the sub-major already names', () => {
    const r = capacityForGroup([row('Apples', 'Apples Royal Gala', 'S-100', 1300)], [item('Apples', 'Apples Royal Gala', 'S-100')]);
    expect(r.source?.label).toBe('Apples Royal Gala S-100');
  });
  it('null when no product matches', () => {
    const r = capacityForGroup(rows, [item('Grapes', 'Red Globe')]);
    expect(r).toMatchObject({ capacity: null, unit: null, source: null });
    expect(r.unmatched).toHaveLength(1);
  });
  it('products without a capacity do not limit the group, but are named', () => {
    const r = capacityForGroup(rows, [item('Apples', 'Royal Gala'), item('Grapes', 'Red Globe', 'XL')]);
    expect(r.capacity).toBe(1100);
    expect(r.note).toMatch(/Red Globe XL/);
  });
  it('different units: the unit of the smallest, with a note', () => {
    const r = capacityForGroup(rows, [item('Apples', 'Fuji'), item('Citrus', 'Oranges')]);
    expect(r.capacity).toBe(1000);
    expect(r.unit).toBe('CT');
    expect(r.note).toMatch(/different units \(CT, KG\)/);
  });
  it('an inactive row is never the result, even when it is the smallest', () => {
    const r = capacityForGroup([row('Apples', 'Fuji', null, 10, 'CT', false), row('Apples', null, null, 1000)], [item('Apples', 'Fuji')]);
    expect(r.capacity).toBe(1000);
  });
});
