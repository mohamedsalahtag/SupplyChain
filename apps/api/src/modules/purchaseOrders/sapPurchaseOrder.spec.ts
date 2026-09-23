import { describe, expect, it } from 'vitest';
import { buildPoFilter, mapPurchaseOrder, OVERLAP_MS } from './sapPurchaseOrder.js';

const po = {
  PurchaseOrder: '4100000000',
  PurchaseOrderType: 'ZTFP',
  Supplier: '80000214',
  PurchaseOrderDate: '2026-02-04',
  DocumentCurrency: 'USD',
  LastChangeDateTime: '2026-02-17T11:49:54.630329Z',
  PurchaseOrderDeletionCode: '',
  _PurchaseOrderItem: [
    { PurchaseOrderItem: '10', Material: 'SBGGGGEG04025CAFDEF', OrderQuantity: 4480, PurchaseOrderQuantityUnit: 'CAR', NetPriceAmount: 4.25, NetPriceQuantity: 1, PurchasingDocumentDeletionCode: '' },
    { PurchaseOrderItem: '20', Material: 'X', OrderQuantity: 1, PurchaseOrderQuantityUnit: 'CAR', NetPriceAmount: 1, NetPriceQuantity: 1, PurchasingDocumentDeletionCode: 'L' }, // deleted
    { PurchaseOrderItem: '30', Material: '', OrderQuantity: 1, PurchaseOrderQuantityUnit: 'EA', NetPriceAmount: 9, NetPriceQuantity: 1, PurchasingDocumentDeletionCode: '' }, // no material
  ],
};

describe('mapPurchaseOrder', () => {
  it('keeps the header and only material lines without a deletion flag', () => {
    const m = mapPurchaseOrder(po);
    expect(m?.kind).toBe('keep');
    if (m?.kind !== 'keep') return;
    expect(m.header).toEqual({
      PurchaseOrder: '4100000000', OrderType: 'ZTFP', SupplierCode: '80000214', OrderDate: '2026-02-04', Currency: 'USD',
      SapLastChangedAt: '2026-02-17T11:49:54.630',
    });
    expect(m.lines).toEqual([
      { PurchaseOrder: '4100000000', ItemNo: 10, Material: 'SBGGGGEG04025CAFDEF', Quantity: 4480, Unit: 'CAR', NetPrice: 4.25, PriceQuantity: 1 },
    ]);
  });

  it('removes an order deleted in SAP, or one with no material lines left', () => {
    expect(mapPurchaseOrder({ ...po, PurchaseOrderDeletionCode: 'L' })?.kind).toBe('remove');
    expect(mapPurchaseOrder({ ...po, _PurchaseOrderItem: [po._PurchaseOrderItem[1], po._PurchaseOrderItem[2]] })?.kind).toBe('remove');
  });
});

describe('buildPoFilter', () => {
  it('filters by chosen Z types and the start date', () => {
    expect(buildPoFilter(['ZFLP', 'ZSUB'], '2026-01-01')).toBe(
      "(PurchaseOrderType eq 'ZFLP' or PurchaseOrderType eq 'ZSUB') and PurchaseOrderDate ge 2026-01-01",
    );
  });
  it('asks only for orders changed since the watermark, looking back one hour', () => {
    const since = new Date('2026-09-24T10:00:00.000Z');
    expect(OVERLAP_MS).toBe(3_600_000);
    expect(buildPoFilter(['ZFLP'], '2026-01-01', since)).toMatch(/and LastChangeDateTime ge 2026-09-24T09:00:00\.000Z$/);
  });
  it('refuses non-Z types, unsafe codes and bad dates', () => {
    expect(() => buildPoFilter([], '2026-01-01')).toThrow();
    expect(() => buildPoFilter(['NB'], '2026-01-01')).toThrow();
    expect(() => buildPoFilter(["ZFLP' or 1 eq 1"], '2026-01-01')).toThrow();
    expect(() => buildPoFilter(['ZFLP'], '01/01/2026')).toThrow();
    expect(() => buildPoFilter(['ZFLP'], "2026-01-01' or true")).toThrow();
  });
});
