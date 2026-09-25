import { describe, expect, it } from 'vitest';
import { assertGroups, businessPartnerFilter, formatAddress, mapSupplier, mapSupplierOrgs, pickCurrency, supplierFilter } from './sapSupplier.js';

const supplier = {
  Supplier: ' 10000000 ',
  SupplierName: 'Al Ateeq Trading',
  SupplierAccountGroup: 'ZAMS',
  to_SupplierPurchasingOrg: { results: [{ PurchasingOrganization: '2000', PurchaseOrderCurrency: 'USD' }, { PurchasingOrganization: '1000', PurchaseOrderCurrency: 'SAR' }] },
};
const bp = {
  BusinessPartner: '10000000',
  to_BusinessPartnerAddress: {
    results: [
      { Country: 'SA', CityName: 'Jeddah', StreetName: 'Al Ateeq', HouseNumber: '12', PostalCode: '21442', Region: '02', to_EmailAddress: { results: [{ EmailAddress: '' }, { EmailAddress: 'info@example.com' }] } },
      { Country: 'EG', CityName: 'Cairo' },
    ],
  },
};

describe('supplier mapping', () => {
  it('maps code, group, first address, first email, org 1000 currency', () => {
    expect(mapSupplier(supplier, bp, ['ZAMS'])).toEqual({
      SupplierCode: '10000000', Name: 'Al Ateeq Trading', SupplierGroup: 'ZAMS', Country: 'SA', Currency: 'SAR',
      Street: 'Al Ateeq', HouseNumber: '12', City: 'Jeddah', PostalCode: '21442', Region: '02', Email: 'info@example.com',
      PurchasingIsBlocked: false, PostingIsBlocked: false,
    });
  });

  it('falls back to the first purchasing org, and to blanks without a business partner', () => {
    expect(pickCurrency([{ PurchasingOrganization: '3000', PurchaseOrderCurrency: 'EUR' }])).toBe('EUR');
    expect(pickCurrency([])).toBe('');
    expect(mapSupplier(supplier, undefined, ['ZAMS'])).toMatchObject({ Country: '', Email: '', Currency: 'SAR' });
  });

  it('skips suppliers outside the chosen groups', () => {
    expect(mapSupplier(supplier, bp, ['ZE'])).toBeNull();
    expect(mapSupplier({ ...supplier, SupplierAccountGroup: 'KRED' }, bp, ['ZAMS'])).toBeNull();
  });

  it('formats the address for display', () => {
    expect(formatAddress({ Street: 'Al Ateeq', HouseNumber: '12', PostalCode: '21442', City: 'Jeddah', Country: 'SA' })).toBe('Al Ateeq 12, 21442 Jeddah, SA');
    expect(formatAddress({ Street: '', HouseNumber: '', PostalCode: '', City: '', Country: 'SA' })).toBe('SA');
  });
});

describe('supplier filters', () => {
  it('builds filters only from Z groups', () => {
    expect(supplierFilter(['ZE', 'ZAMS'])).toBe("(SupplierAccountGroup eq 'ZE' or SupplierAccountGroup eq 'ZAMS')");
    expect(businessPartnerFilter(['ZE'])).toBe("(BusinessPartnerGrouping eq 'ZE')");
  });
  it('refuses empty, non-Z or unsafe groups', () => {
    expect(() => assertGroups([])).toThrow();
    expect(() => assertGroups(['KRED'])).toThrow();
    expect(() => assertGroups(["ZE' or 1 eq 1"])).toThrow();
  });
});

describe('supplier blocks and purchasing organizations (spec 11)', () => {
  it('reads the supplier-level blocks', () => {
    expect(mapSupplier({ ...supplier, PurchasingIsBlocked: true, PostingIsBlocked: false }, bp, ['ZAMS'])).toMatchObject({ PurchasingIsBlocked: true, PostingIsBlocked: false });
  });
  it('lists purchasing orgs with their own block, skipping deleted ones and duplicates', () => {
    const s = {
      Supplier: '10000000',
      to_SupplierPurchasingOrg: { results: [
        { PurchasingOrganization: '1000', PurchasingIsBlockedForSupplier: false },
        { PurchasingOrganization: '2000', PurchasingIsBlockedForSupplier: true },
        { PurchasingOrganization: '3000', DeletionIndicator: true },
        { PurchasingOrganization: '1000', PurchasingIsBlockedForSupplier: false, PaymentTerms: 'N030', IncotermsClassification: 'FCA', IncotermsLocation1: 'Jeddah' },
      ] },
    };
    expect(mapSupplierOrgs(s)).toEqual([
      { SupplierCode: '10000000', PurchasingOrg: '1000', IsBlocked: false, PaymentTerms: 'N030', Incoterm: 'FCA', IncotermLocation: 'Jeddah' }, // the later duplicate wins
      { SupplierCode: '10000000', PurchasingOrg: '2000', IsBlocked: true, PaymentTerms: '', Incoterm: '', IncotermLocation: '' },
    ]);
  });
});
