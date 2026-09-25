/** Spec 18 addition (2026-09-25): an RFQ to a supplier outside the shortlist — a new supplier's first contact. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../../src/modules/demand/access.js';
import { getDemand } from '../../src/modules/demand/demandRead.js';
import { acceptDemand, createDemand, submitDemand } from '../../src/modules/demand/demandService.js';
import { searchOutsideSuppliers } from '../../src/modules/rfq/outsideSuppliers.js';
import { recordQuotes } from '../../src/modules/rfq/quotes.js';
import { getRfq, shortlistFor } from '../../src/modules/rfq/rfqRead.js';
import { createRfq, sendRfq } from '../../src/modules/rfq/rfqService.js';
import { isoWeekMonday, isoWeekOf } from '../../src/modules/workflow/isoWeek.js';
import { refreshOrigins } from '../../src/modules/workflow/origins.js';
import { actor, db, makeUser, runInvariants, uid } from './helpers.js';

const cmd = () => randomUUID();
const wk = (n: number) => isoWeekOf(new Date(isoWeekMonday(isoWeekOf(new Date())).getTime() + n * 7 * 86_400_000));
const SUB = 'Apples Envy NEWSUP';
const tag = uid('NS');
const S = { fresh: `${tag}f`, blocked: `${tag}b`, notExt: `${tag}n` };
let sales: ReturnType<typeof actor>;
let proc: ReturnType<typeof actor>;

async function supplier(code: string, country: string, opts: { blocked?: boolean; org?: boolean } = {}) {
  await db.insertInto('md.Supplier').values({
    SupplierCode: code, Name: `New ${code}`, SupplierGroup: 'ZIMP', Country: country, Currency: 'USD', Street: '', HouseNumber: '', City: 'Auckland', PostalCode: '', Region: '', Email: '',
    InSap: true, SapChangedAt: new Date(), PurchasingIsBlocked: !!opts.blocked, PostingIsBlocked: false,
  }).execute();
  if (opts.org !== false) await db.insertInto('md.SupplierPurchasingOrg').values({ SupplierCode: code, PurchasingOrg: '1000', IsBlocked: false }).execute();
  await db.insertInto('scm.SupplierOrigin').values({ SupplierCode: code, OriginCode: country, Source: 'COUNTRY', AddedBy: null }).execute();
}

beforeAll(async () => {
  await db.insertInto('md.Material').values({
    MaterialCode: uid('NM'), Description: `${SUB} S-100`, MajorCategoryCode: 'AP', MajorCategory: 'Apples', SubMajorCategory: SUB, MaterialGroupCode: '', MaterialGroup: '',
    MaterialType: 'ZTRD', BaseUnit: 'CT', BaseUnitName: 'Carton', Origin: 'Chile', Variety: '', Size: 'S-100', Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: 'Cat1',
    InSap: true, SapChangedAt: new Date(),
  }).execute();
  await refreshOrigins(db);
  await db.updateTable('scm.Company').set({ PurchasingOrg: '1000' }).where('CompanyCode', '=', '1000').execute();
  await supplier(S.fresh, 'NZ'); // new supplier: registered in NZ, never supplied CL to us
  await supplier(S.blocked, 'NZ', { blocked: true });
  await supplier(S.notExt, 'NZ', { org: false });
  sales = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.create', 'demand.submit']), companies: new Set(['1000']) });
  proc = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.accept', 'rfqs.open', 'rfq.manage']), companies: new Set(['1000']) });
});
afterAll(() => db.destroy());

describe('RFQ to a supplier outside the shortlist (spec 18 addition)', () => {
  it('a new supplier is invited, recorded as supplying the origin, and can quote; blocked or not set up suppliers are refused', async () => {
    const { demandId } = await createDemand(db, sales, cmd(), '1000');
    const item = { majorCategory: 'Apples', subMajorCategory: SUB, size: 'S-100', materialClass: 'Cat1', originCode: 'CL', share: '100' };
    await submitDemand(db, sales, cmd(), demandId, (await getDemand(db, sales, demandId)).rowVer, { notes: '', weeks: [{ etdWeek: wk(4), groups: [{ name: 'Envy', containerCount: 2, capacity: '1000', unit: 'CT', items: [item] }] }] });
    await acceptDemand(db, proc, cmd(), demandId, (await getDemand(db, proc, demandId)).rowVer);
    const line = (await getDemand(db, proc, demandId)).weeks[0].lines[0];

    // not on the shortlist for CL
    const [cl] = await shortlistFor(db, proc, demandId, [line.lineId]);
    expect(cl.entries.some((e) => e.supplierCode === S.fresh)).toBe(false);

    // the search finds it with what inviting adds; unusable ones carry the reason
    const found = await searchOutsideSuppliers(db, proc, demandId, [line.lineId], tag);
    const by = (c: string) => found.rows.find((r) => r.supplierCode === c)!;
    expect([found.origins, by(S.fresh).adds, by(S.fresh).problem]).toEqual([['CL'], ['CL'], null]);
    expect(by(S.blocked).problem).toMatch(/blocked/);
    expect(by(S.notExt).problem).toMatch(/not set up for purchasing organization/);
    await expect(searchOutsideSuppliers(db, actor({ id: proc.id, permissions: proc.permissions, companies: new Set(['2000']) }), demandId, [], tag)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // refused: blocked; no supplier at all
    const ask = { demandId, weeks: [], lines: [{ lineId: line.lineId, week: wk(4), qty: '2000' }] };
    await expect(createRfq(db, proc, cmd(), { ...ask, suppliers: [], extraSuppliers: [S.blocked] })).rejects.toMatchObject({ code: 'VENDOR_BLOCKED' });
    await expect(createRfq(db, proc, cmd(), { ...ask, suppliers: [], extraSuppliers: [] })).rejects.toMatchObject({ code: 'NO_SUPPLIER' });

    // invited: origin recorded (source RFQ, by whom), marked as first contact, quotes like any supplier
    const { rfqId } = await createRfq(db, proc, cmd(), { ...ask, suppliers: [], extraSuppliers: [S.fresh] });
    const origin = await db.selectFrom('scm.SupplierOrigin').select(['Source', 'AddedBy']).where('SupplierCode', '=', S.fresh).where('OriginCode', '=', 'CL').executeTakeFirstOrThrow();
    expect([origin.Source, origin.AddedBy]).toEqual(['RFQ', proc.id]);
    const r = await getRfq(db, proc, rfqId);
    expect(r.suppliers.map((s) => [s.supplierCode, s.outsideShortlist, s.originsAtInvite])).toEqual([[S.fresh, true, ['CL', 'NZ']]]);
    await sendRfq(db, proc, cmd(), rfqId, r.rowVer);
    const key = (await getRfq(db, proc, rfqId)).supplierView[0].key;
    await recordQuotes(db, proc, cmd(), rfqId, S.fresh, 'USD', [{ etdWeek: wk(4), lineKey: key, unitPrice: '17.20', availableQty: '2000', quotedSku: null }], [{ etdWeek: wk(4), containersOffered: 2 }]);
    expect((await getRfq(db, proc, rfqId)).quotes.some((q) => q.supplierCode === S.fresh)).toBe(true);
    // next time it is on the shortlist for CL, as a supplier with no history yet
    const [again] = await shortlistFor(db, proc, demandId, [line.lineId]);
    expect(again.entries.find((e) => e.supplierCode === S.fresh)?.origins).toEqual(['CL', 'NZ']);
    expect(await runInvariants()).toEqual([]);
  });
});
