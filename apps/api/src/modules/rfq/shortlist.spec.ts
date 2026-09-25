import { describe, expect, it } from 'vitest';
import { rankForOrigin, type HistRow, type ShortLine } from './shortlist.js';

const line = (over: Partial<ShortLine> = {}): ShortLine => ({
  lineId: '1', majorCategory: 'Apples', subMajorCategory: 'Apples Royal Gala', size: 'S-100', originCode: 'CL', materialCode: null, unit: 'CT', ...over,
});
const h = (supplier: string, over: Partial<HistRow> = {}): HistRow => ({
  SupplierCode: supplier, MajorCategory: 'Apples', SubMajorCategory: 'Apples Royal Gala', Size: 'S-100', OriginCode: 'CL', MaterialCode: '', Unit: 'CT',
  PoCount: 1, TotalQtyMilli: 1_000_000, FirstPoDate: new Date('2025-01-01'), LastPoDate: new Date('2026-01-01'), LastUnitPrice: 18.5, LastCurrency: 'USD', ...over,
});
const c = (code: string, name = code) => ({ supplierCode: code, name, origins: ['CL'] });

describe('supplier shortlist ranking (spec 18)', () => {
  it('same SKU > same material and size > same material > no history (then by name)', () => {
    const hist = [
      h('SKU', { MaterialCode: 'M1', PoCount: 1 }),
      h('SPEC', { PoCount: 50 }),
      h('SUB', { Size: 'S-113', PoCount: 90 }),
    ];
    const r = rankForOrigin([line({ materialCode: 'M1' })], [c('B-none', 'Beta'), c('SUB'), c('A-none', 'Alpha'), c('SPEC'), c('SKU')], hist);
    expect(r.map((e) => [e.supplierCode, e.hint.matchLevel, e.rank])).toEqual([
      ['SKU', 'SKU', 1], ['SPEC', 'SPEC', 2], ['SUB', 'SUBCATEGORY', 3], ['A-none', 'NONE', null], ['B-none', 'NONE', null],
    ]);
  });

  it('ties at the same level: PO count, then last PO date, then total quantity', () => {
    const hist = [
      h('few', { PoCount: 2 }),
      h('old', { PoCount: 5, LastPoDate: new Date('2025-06-01') }),
      h('new', { PoCount: 5, LastPoDate: new Date('2026-03-01'), TotalQtyMilli: 1 }),
      h('big', { PoCount: 5, LastPoDate: new Date('2026-03-01'), TotalQtyMilli: 9_000_000 }),
    ];
    expect(rankForOrigin([line()], [c('few'), c('old'), c('new'), c('big')], hist).map((e) => e.supplierCode)).toEqual(['big', 'new', 'old', 'few']);
  });

  it('history of another origin or unit does not count; the hint shows the latest price', () => {
    const hist = [h('x', { OriginCode: 'ZA', PoCount: 99 }), h('x', { Unit: 'KG', PoCount: 99 }), h('y', { LastUnitPrice: 17.9, LastPoDate: new Date('2026-02-02') })];
    const [first, second] = rankForOrigin([line()], [c('x'), c('y')], hist);
    expect([first.supplierCode, first.hint]).toEqual(['y', expect.objectContaining({ matchLevel: 'SPEC', poCount: 1, lastPrice: '17.90', lastCurrency: 'USD', lastPoDate: '2026-02-02', totalQty: '1000.000' })]);
    expect(second.hint.matchLevel).toBe('NONE');
  });
});
