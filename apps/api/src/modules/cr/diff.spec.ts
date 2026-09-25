import { describe, expect, it } from 'vitest';
import { crTypeOf, diffGroups, effectOf, finalAfter, type GroupState } from './diff.js';

const CT = 1000;
const inc = () => CT;
const item = (size: string, shareBp: number) => ({
  majorCategory: 'Apples', subMajorCategory: 'Apples Royal Gala', size, materialClass: 'Cat1', originCode: 'CL', materialCode: null,
  key: `Apples|Apples Royal Gala|${size}|Cat1|CL|`, shareBp,
});
const group = (id: string | null, week: string, count: number, items = [item('S-100', 4000), item('S-113', 6000)]): GroupState =>
  ({ groupId: id, etdWeek: week, name: '', containerCount: count, capacity: 1540 * CT, unit: 'CT', items });

describe('container change → items (spec 14)', () => {
  it('fewer containers: one GROUP_COUNT item with the whole-carton effect per material', () => {
    const items = diffGroups([group('1', '2026-W41', 3)], [group('1', '2026-W41', 2)], inc);
    expect(items.map((i) => i.kind)).toEqual(['GROUP_COUNT']);
    expect(items[0].effect.map((e) => [e.size, e.delta / CT])).toEqual([['S-100', -616], ['S-113', -924]]);
  });

  it('new group, removed group, changed composition, unchanged group', () => {
    const current = [group('1', '2026-W41', 3), group('2', '2026-W41', 1), group('3', '2026-W42', 1)];
    const proposed = [
      group('1', '2026-W41', 3, [item('S-100', 5000), item('S-113', 5000)]), // shares changed
      group('3', '2026-W42', 1), // unchanged
      group(null, '2026-W43', 2, [item('S-125', 10000)]), // new
    ];
    const items = diffGroups(current, proposed, inc);
    expect(items.map((i) => [i.kind, i.etdWeek, i.groupId])).toEqual([
      ['GROUP_REMOVE', '2026-W41', '2'], ['GROUP_COMPOSITION', '2026-W41', '1'], ['GROUP_ADD', '2026-W43', null],
    ]);
    // 3 × 1540 at 40/60 → 50/50: S-100 1848 → 2310 (+462), S-113 2772 → 2310 (−462)
    expect(items[1].effect.map((e) => [e.size, e.delta / CT])).toEqual([['S-100', 462], ['S-113', -462]]);
    expect(items[2].effect.map((e) => [e.size, e.delta / CT])).toEqual([['S-125', 3080]]);
  });

  it('a group moved to another week is removed there and added here', () => {
    const items = diffGroups([group('1', '2026-W41', 1)], [group('1', '2026-W42', 1)], inc);
    expect(items.map((i) => [i.kind, i.etdWeek])).toEqual([['GROUP_REMOVE', '2026-W41'], ['GROUP_ADD', '2026-W42']]);
  });

  it('a name change alone is not a change', () => {
    expect(diffGroups([group('1', '2026-W41', 1)], [{ ...group('1', '2026-W41', 1), name: 'Renamed' }], inc)).toEqual([]);
  });

  it('fewer containers approved: the effect follows the approved number', () => {
    const [add] = diffGroups([], [group(null, '2026-W41', 3)], inc);
    expect(effectOf(null, finalAfter(add, 1), inc).map((e) => e.delta / CT)).toEqual([616, 924]);
  });

  it('names the request after what it does', () => {
    const cur = [group('1', 'W1', 1), group('2', 'W2', 1)];
    expect(crTypeOf(diffGroups(cur, [], inc), 2)).toBe('CANCEL_DEMAND');
    expect(crTypeOf(diffGroups(cur, [cur[1]], inc), 2)).toBe('CANCEL_WEEK');
    expect(crTypeOf(diffGroups(cur, [cur[0], { ...cur[1], containerCount: 2 }], inc), 2)).toBe('CHANGE_CONTAINERS');
  });
});
