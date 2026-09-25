/**
 * Purchase orders from SAP API_PURCHASEORDER_2 (OData v4, spec 09): the filter
 * and how an order maps to md.PurchaseOrder + md.PurchaseOrderLine. Pure — unit tested.
 */
import { Z_CODE } from '../suppliers/sapSupplier.js';

export { Z_CODE };
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Later syncs look back this far before the last change seen, so nothing slips between runs. */
export const OVERLAP_MS = 60 * 60 * 1000;

type Row = Record<string, unknown>;
const text = (v: unknown): string => (v == null ? '' : String(v).trim());
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function assertTypes(types: readonly string[]): void {
  if (types.length === 0) throw new Error('Choose at least one order type');
  const bad = types.filter((t) => !Z_CODE.test(t));
  if (bad.length) throw new Error(`Only order types starting with Z are allowed: ${bad.join(', ')}`);
}

/** The v4 $filter: chosen types, on/after the start date, and (later syncs) changed since the watermark minus the overlap. */
export function buildPoFilter(types: readonly string[], startDate: string, changedSince?: Date | null): string {
  assertTypes(types);
  if (!ISO_DATE.test(startDate) || Number.isNaN(Date.parse(startDate))) throw new Error('Invalid start date');
  const parts = [`(${types.map((t) => `PurchaseOrderType eq '${t}'`).join(' or ')})`, `PurchaseOrderDate ge ${startDate}`];
  if (changedSince) parts.push(`LastChangeDateTime ge ${new Date(changedSince.getTime() - OVERLAP_MS).toISOString()}`);
  return parts.join(' and ');
}

export const PO_QUERY = {
  select: 'PurchaseOrder,PurchaseOrderType,Supplier,PurchaseOrderDate,DocumentCurrency,CompanyCode,PurchasingOrganization,PurchasingGroup,LastChangeDateTime,PurchaseOrderDeletionCode',
  expand:
    '_PurchaseOrderItem($select=PurchaseOrderItem,Material,OrderQuantity,PurchaseOrderQuantityUnit,NetPriceAmount,NetPriceQuantity,PurchasingDocumentDeletionCode)',
  orderBy: 'PurchaseOrder',
};

export type PoHeader = {
  PurchaseOrder: string;
  OrderType: string;
  SupplierCode: string;
  OrderDate: string; // YYYY-MM-DD
  Currency: string;
  CompanyCode: string;
  PurchasingOrg: string;
  PurchasingGroup: string;
  SapLastChangedAt: string | null; // ISO without zone, UTC, for datetime2
};
export type PoLine = {
  PurchaseOrder: string;
  ItemNo: number;
  Material: string;
  Quantity: number;
  Unit: string;
  NetPrice: number;
  PriceQuantity: number;
};
/** keep: write header + lines. remove: the order must not be in the app (deleted in SAP, or no material lines left). */
export type MappedPo = { kind: 'keep'; header: PoHeader; lines: PoLine[]; changedAt: Date | null } | { kind: 'remove'; purchaseOrder: string; changedAt: Date | null };

export function mapPurchaseOrder(r: Row): MappedPo | null {
  const po = text(r.PurchaseOrder);
  if (!po) return null;
  const changed = text(r.LastChangeDateTime) ? new Date(text(r.LastChangeDateTime)) : null;
  const changedAt = changed && !Number.isNaN(changed.getTime()) ? changed : null;
  if (text(r.PurchaseOrderDeletionCode)) return { kind: 'remove', purchaseOrder: po, changedAt };

  // Only material lines without a deletion flag.
  const lines: PoLine[] = ((r._PurchaseOrderItem as Row[] | undefined) ?? [])
    .filter((i) => text(i.Material) && !text(i.PurchasingDocumentDeletionCode))
    .map((i) => ({
      PurchaseOrder: po,
      ItemNo: Number(text(i.PurchaseOrderItem)),
      Material: text(i.Material),
      Quantity: num(i.OrderQuantity),
      Unit: text(i.PurchaseOrderQuantityUnit),
      NetPrice: num(i.NetPriceAmount),
      PriceQuantity: num(i.NetPriceQuantity) || 1,
    }))
    .filter((l) => Number.isInteger(l.ItemNo));
  if (lines.length === 0) return { kind: 'remove', purchaseOrder: po, changedAt };

  return {
    kind: 'keep',
    header: {
      PurchaseOrder: po,
      OrderType: text(r.PurchaseOrderType),
      SupplierCode: text(r.Supplier),
      OrderDate: text(r.PurchaseOrderDate).slice(0, 10),
      Currency: text(r.DocumentCurrency),
      CompanyCode: text(r.CompanyCode),
      PurchasingOrg: text(r.PurchasingOrganization),
      PurchasingGroup: text(r.PurchasingGroup),
      SapLastChangedAt: changedAt ? changedAt.toISOString().slice(0, 23) : null,
    },
    lines,
    changedAt,
  };
}
