/**
 * Suppliers from SAP API_BUSINESS_PARTNER (spec 08): which rows the app takes
 * and how they map to md.Supplier. Pure functions — unit tested.
 */

/** Only supplier groups starting with Z are ever offered or synced. */
export const Z_CODE = /^Z[A-Z0-9]{1,9}$/;

/** Currency comes from this purchasing organization, else the first one SAP returns. */
export const PREFERRED_PURCHASING_ORG = '1000';

type Row = Record<string, unknown>;
const text = (v: unknown): string => (v == null ? '' : String(v).trim());
const results = (v: unknown): Row[] => ((v as { results?: Row[] } | undefined)?.results ?? []);

export function assertGroups(groups: readonly string[]): void {
  if (groups.length === 0) throw new Error('Choose at least one supplier group');
  const bad = groups.filter((g) => !Z_CODE.test(g));
  if (bad.length) throw new Error(`Only supplier groups starting with Z are allowed: ${bad.join(', ')}`);
}

const anyOf = (field: string, values: readonly string[]) => '(' + values.map((v) => `${field} eq '${v}'`).join(' or ') + ')';

export const supplierFilter = (groups: readonly string[]) => (assertGroups(groups), anyOf('SupplierAccountGroup', groups));
export const businessPartnerFilter = (groups: readonly string[]) => (assertGroups(groups), anyOf('BusinessPartnerGrouping', groups));

export const SUPPLIER_QUERY = {
  select: 'Supplier,SupplierName,SupplierAccountGroup,to_SupplierPurchasingOrg/PurchasingOrganization,to_SupplierPurchasingOrg/PurchaseOrderCurrency',
  expand: 'to_SupplierPurchasingOrg',
  orderBy: 'Supplier',
};

const ADDRESS = 'to_BusinessPartnerAddress';
export const BUSINESS_PARTNER_QUERY = {
  select: ['BusinessPartner', ...['Country', 'CityName', 'StreetName', 'HouseNumber', 'PostalCode', 'Region'].map((f) => `${ADDRESS}/${f}`), `${ADDRESS}/to_EmailAddress/EmailAddress`].join(','),
  expand: `${ADDRESS},${ADDRESS}/to_EmailAddress`,
  orderBy: 'BusinessPartner',
};

export type SupplierRow = {
  SupplierCode: string;
  Name: string;
  SupplierGroup: string;
  Country: string;
  Currency: string;
  Street: string;
  HouseNumber: string;
  City: string;
  PostalCode: string;
  Region: string;
  Email: string;
};

/** Org 1000's currency, else the first organization's. */
export function pickCurrency(orgs: Row[]): string {
  const preferred = orgs.find((o) => text(o.PurchasingOrganization) === PREFERRED_PURCHASING_ORG);
  return text((preferred ?? orgs[0])?.PurchaseOrderCurrency);
}

/**
 * One SAP supplier (+ its business partner, for address and email) → a row.
 * Null when the supplier is not in a chosen Z group.
 */
export function mapSupplier(s: Row, bp: Row | undefined, groups: readonly string[]): SupplierRow | null {
  const code = text(s.Supplier);
  const group = text(s.SupplierAccountGroup);
  if (!code || !groups.includes(group)) return null;
  const address = results(bp?.[ADDRESS])[0] ?? {};
  const email = results(address.to_EmailAddress).map((e) => text(e.EmailAddress)).find(Boolean) ?? '';
  return {
    SupplierCode: code,
    Name: text(s.SupplierName),
    SupplierGroup: group,
    Country: text(address.Country),
    Currency: pickCurrency(results(s.to_SupplierPurchasingOrg)),
    Street: text(address.StreetName),
    HouseNumber: text(address.HouseNumber),
    City: text(address.CityName),
    PostalCode: text(address.PostalCode),
    Region: text(address.Region),
    Email: email,
  };
}

/** "Street 12, 21442 Jeddah, SA" — for display. */
export function formatAddress(r: Pick<SupplierRow, 'Street' | 'HouseNumber' | 'PostalCode' | 'City' | 'Country'>): string {
  const street = [r.Street, r.HouseNumber].filter(Boolean).join(' ');
  const city = [r.PostalCode, r.City].filter(Boolean).join(' ');
  return [street, city, r.Country].filter(Boolean).join(', ');
}
