/** Master data for the workflow (spec 11): supplier usability, freshness, origin map, purchase history. */
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { closeInbox } from '../../src/modules/workflow/inbox.js';
import { assertMasterDataFresh, assertSupplierOrigin, assertVendorUsable, lastSuccessfulSyncs } from '../../src/modules/workflow/masterData.js';
import { addManualOrigin, rebuildSupplierOrigins, removeManualOrigin } from '../../src/modules/workflow/supplierOrigins.js';
import { listOrigins, refreshOrigins, setOrigin } from '../../src/modules/workflow/origins.js';
import { rebuildPurchaseHistory } from '../../src/modules/workflow/purchaseHistory.js';
import { count, db, uid } from './helpers.js';

afterAll(() => db.destroy());

async function supplier(code: string, over: Partial<{ Country: string; InSap: boolean; PurchasingIsBlocked: boolean; PostingIsBlocked: boolean }> = {}) {
  await db
    .insertInto('md.Supplier')
    .values({
      SupplierCode: code, Name: code, SupplierGroup: 'ZIMP', Country: over.Country ?? 'CL', Currency: 'USD', Street: '', HouseNumber: '',
      City: '', PostalCode: '', Region: '', Email: '', InSap: over.InSap ?? true, SapChangedAt: new Date(),
      PurchasingIsBlocked: over.PurchasingIsBlocked ?? false, PostingIsBlocked: over.PostingIsBlocked ?? false,
    })
    .execute();
}

async function material(code: string, origin: string, sub = 'Gala', size = '80-88') {
  await db
    .insertInto('md.Material')
    .values({
      MaterialCode: code, Description: code, MajorCategoryCode: 'AP', MajorCategory: 'Apple', SubMajorCategory: sub, MaterialGroupCode: '',
      MaterialGroup: '', MaterialType: 'ZTRD', BaseUnit: 'CTN', BaseUnitName: 'Carton', Origin: origin, Variety: '', Size: size,
      Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: '', InSap: true, SapChangedAt: new Date(),
    })
    .execute();
}

describe('assertVendorUsable (plan v5 §0.10)', () => {
  it('needs: in SAP, not blocked, company org set, supplier extended and not blocked there', async () => {
    const ok = uid('S');
    await supplier(ok);
    await db.insertInto('md.SupplierPurchasingOrg').values({ SupplierCode: ok, PurchasingOrg: '2000', IsBlocked: false }).execute();

    // Company 2000 has no purchasing org yet.
    await expect(assertVendorUsable(db, ok, '2000')).rejects.toMatchObject({ code: 'COMPANY_ORG_MISSING' });
    await db.updateTable('scm.Company').set({ PurchasingOrg: '2000' }).where('CompanyCode', '=', '2000').execute();
    await assertVendorUsable(db, ok, '2000');

    await db.updateTable('scm.Company').set({ PurchasingOrg: '9000' }).where('CompanyCode', '=', '3000').execute();
    await expect(assertVendorUsable(db, ok, '3000')).rejects.toMatchObject({ code: 'VENDOR_NOT_EXTENDED' });

    const blockedInOrg = uid('S');
    await supplier(blockedInOrg);
    await db.insertInto('md.SupplierPurchasingOrg').values({ SupplierCode: blockedInOrg, PurchasingOrg: '2000', IsBlocked: true }).execute();
    await expect(assertVendorUsable(db, blockedInOrg, '2000')).rejects.toMatchObject({ code: 'VENDOR_BLOCKED' });

    const blocked = uid('S');
    await supplier(blocked, { PostingIsBlocked: true });
    await expect(assertVendorUsable(db, blocked, '2000')).rejects.toMatchObject({ code: 'VENDOR_BLOCKED' });

    const gone = uid('S');
    await supplier(gone, { InSap: false });
    await expect(assertVendorUsable(db, gone, '2000')).rejects.toMatchObject({ code: 'VENDOR_UNKNOWN' });
    await expect(assertVendorUsable(db, uid('nope'), '2000')).rejects.toMatchObject({ code: 'VENDOR_UNKNOWN' });
  });

  it('supplier origins = SAP country + PO history + added by hand (spec 18)', async () => {
    const s = uid('S');
    await supplier(s, { Country: 'ZA' });
    await rebuildSupplierOrigins(db);
    await assertSupplierOrigin(db, s, 'ZA');
    await expect(assertSupplierOrigin(db, s, 'CL')).rejects.toMatchObject({ code: 'SUPPLIER_ORIGIN_MISMATCH' });
    await addManualOrigin(db, s, 'CL', 1);
    await assertSupplierOrigin(db, s, 'CL');
    await rebuildSupplierOrigins(db); // manual origins survive a rebuild
    await assertSupplierOrigin(db, s, 'CL');
    await removeManualOrigin(db, s, 'CL');
    await expect(assertSupplierOrigin(db, s, 'CL')).rejects.toMatchObject({ code: 'SUPPLIER_ORIGIN_MISMATCH' });
  });
});

describe('master data freshness', () => {
  it('uses the last successful run per source; stale data blocks', async () => {
    await sql`DELETE FROM integ.SyncRun`.execute(db);
    await expect(assertMasterDataFresh(db, 26)).rejects.toMatchObject({ code: 'MASTER_DATA_STALE' });
    for (const source of ['sap.materials', 'sap.suppliers', 'sap.purchaseOrders']) {
      await sql`INSERT INTO integ.SyncRun (Source, Status, StartedBy, StartedAt, FinishedAt) VALUES (${source}, 'Succeeded', 't', SYSUTCDATETIME(), SYSUTCDATETIME())`.execute(db);
    }
    await assertMasterDataFresh(db, 26);
    await sql`UPDATE integ.SyncRun SET FinishedAt = DATEADD(hour, -30, SYSUTCDATETIME()), StartedAt = DATEADD(hour, -30, SYSUTCDATETIME()) WHERE Source = 'sap.suppliers'`.execute(db);
    await expect(assertMasterDataFresh(db, 26)).rejects.toMatchObject({ code: 'MASTER_DATA_STALE', details: { stale: ['sap.suppliers'] } });
    expect((await lastSuccessfulSyncs(db))['sap.materials']).toBeInstanceOf(Date);
  });
});

describe('origin map (spec 11)', () => {
  it('matches names automatically, keeps manual choices, and keeps the exception in step', async () => {
    await material(uid('M'), 'Chile');
    await material(uid('M'), 'USA');
    await material(uid('M'), 'Gulf');
    await refreshOrigins(db);
    const byName = async () => Object.fromEntries((await listOrigins(db, false)).map((o) => [o.OriginName, o]));

    let o = await byName();
    expect([o.Chile.Source, o.Chile.CountryCode]).toEqual(['Auto', 'CL']);
    expect([o.USA.Source, o.USA.CountryCode]).toEqual(['Unmatched', null]);
    expect(await count('scm.InboxItem', sql`ItemType = 'ORIGIN_UNMATCHED' AND IsOpen = 1`)).toBe(1);

    await setOrigin(db, 'USA', 'US', o.USA.RowVer);
    await expect(setOrigin(db, 'USA', 'CA', o.USA.RowVer)).rejects.toMatchObject({ code: 'STALE_WRITE' });
    await setOrigin(db, 'Gulf', null, o.Gulf.RowVer);
    await refreshOrigins(db); // must not overwrite manual choices
    o = await byName();
    expect([o.USA.Source, o.USA.CountryCode]).toEqual(['Manual', 'US']);
    expect([o.Gulf.Source, o.Gulf.CountryCode]).toEqual(['NotCountry', null]);
    expect(await count('scm.InboxItem', sql`ItemType = 'ORIGIN_UNMATCHED' AND IsOpen = 1`)).toBe(0);
    await closeInbox(db, 'ORIGIN_UNMATCHED', 'REF_ORIGIN', 'ALL', null);
  });
});

describe('purchase history summary (plan v5 §0.10)', () => {
  it('summarises per material and per specification, with the last price; skips old and company-less orders', async () => {
    const s = uid('S');
    const [m1, m2] = [uid('M'), uid('M')];
    await supplier(s);
    await material(m1, 'Chile');
    await material(m2, 'Chile');
    await refreshOrigins(db);
    const po = async (no: string, date: string, company: string, lines: [string, number, number, number][]) => {
      await sql`INSERT INTO md.PurchaseOrder (PurchaseOrder, OrderType, SupplierCode, OrderDate, Currency, CompanyCode, PurchasingOrg)
                VALUES (${no}, 'ZTFP', ${s}, ${date}, 'USD', ${company}, '2000')`.execute(db);
      let item = 10;
      for (const [mat, qty, price, per] of lines) {
        await sql`INSERT INTO md.PurchaseOrderLine (PurchaseOrder, ItemNo, Material, Quantity, Unit, NetPrice, PriceQuantity)
                  VALUES (${no}, ${item}, ${mat}, ${qty}, 'CTN', ${price}, ${per})`.execute(db);
        item += 10;
      }
    };
    const recent = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    await po(uid('P'), recent(60), '1000', [[m1, 1000, 12.4, 1]]);
    await po(uid('P'), recent(10), '1000', [[m1, 500, 25, 2]]);
    await po(uid('P'), recent(30), '1000', [[m2, 200, 10, 1]]);
    await po(uid('P'), '2019-01-01', '1000', [[m1, 9999, 1, 1]]); // outside the look-back
    await po(uid('P'), recent(5), '', [[m1, 9999, 1, 1]]); // no company code yet

    expect(await rebuildPurchaseHistory(db, 36)).toBeGreaterThanOrEqual(3);
    const rows = await db.selectFrom('scm.PurchaseHistorySummary').selectAll().where('SupplierCode', '=', s).orderBy('MaterialCode').execute();
    const pick = (mat: string) => rows.find((r) => r.MaterialCode === mat)!;
    expect(rows).toHaveLength(3);
    expect([pick('').PoCount, Number(pick('').TotalQtyMilli), Number(pick('').LastUnitPrice), pick('').OriginCode]).toEqual([3, 1_700_000, 12.5, 'CL']);
    expect([pick(m1).PoCount, Number(pick(m1).TotalQtyMilli), Number(pick(m1).LastUnitPrice), pick(m1).LastCurrency]).toEqual([2, 1_500_000, 12.5, 'USD']);
    expect([pick(m2).PoCount, Number(pick(m2).TotalQtyMilli), Number(pick(m2).LastUnitPrice)]).toEqual([1, 200_000, 10]);
  });
});
