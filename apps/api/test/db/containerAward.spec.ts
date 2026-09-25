/** Spec 20 revision 1 against a real database: award by containers — mixed award, above the offer (logged), + Add container, not priced, un-award by containers. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBatch } from '../../src/modules/award/awardRead.js';
import { awardContainers, unawardContainers } from '../../src/modules/award/containerAward.js';
import { containerGrid } from '../../src/modules/award/containerGrid.js';
import '../../src/modules/demand/access.js';
import { getDemand } from '../../src/modules/demand/demandRead.js';
import { acceptDemand, createDemand, submitDemand } from '../../src/modules/demand/demandService.js';
import { recordQuotes } from '../../src/modules/rfq/quotes.js';
import { getRfq } from '../../src/modules/rfq/rfqRead.js';
import { createRfq, sendRfq } from '../../src/modules/rfq/rfqService.js';
import { isoWeekMonday, isoWeekOf } from '../../src/modules/workflow/isoWeek.js';
import { refreshOrigins } from '../../src/modules/workflow/origins.js';
import { actor, db, makeUser, runInvariants, uid } from './helpers.js';

const cmd = () => randomUUID();
const wk = (n: number) => isoWeekOf(new Date(isoWeekMonday(isoWeekOf(new Date())).getTime() + n * 7 * 86_400_000));
let sales: ReturnType<typeof actor>;
let proc: ReturnType<typeof actor>;
const [A, B] = [uid('CAa'), uid('CAb')];
const SUB = 'Apples Gala CA';

beforeAll(async () => {
  for (const size of ['S-100', 'S-113']) {
    await db.insertInto('md.Material').values({
      MaterialCode: uid('CA'), Description: `${SUB} ${size}`, MajorCategoryCode: 'AP', MajorCategory: 'Apples', SubMajorCategory: SUB, MaterialGroupCode: '', MaterialGroup: '',
      MaterialType: 'ZTRD', BaseUnit: 'CT', BaseUnitName: 'Carton', Origin: 'Chile', Variety: '', Size: size, Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: 'Cat1',
      InSap: true, SapChangedAt: new Date(),
    }).execute();
  }
  await refreshOrigins(db);
  await db.updateTable('scm.Company').set({ PurchasingOrg: '1000' }).where('CompanyCode', '=', '1000').execute();
  for (const s of [A, B]) {
    await db.insertInto('md.Supplier').values({
      SupplierCode: s, Name: s, SupplierGroup: 'ZIMP', Country: 'CL', Currency: 'USD', Street: '', HouseNumber: '', City: '', PostalCode: '', Region: '', Email: '',
      InSap: true, SapChangedAt: new Date(), PurchasingIsBlocked: false, PostingIsBlocked: false,
    }).execute();
    await db.insertInto('md.SupplierPurchasingOrg').values({ SupplierCode: s, PurchasingOrg: '1000', IsBlocked: false }).execute();
    await db.insertInto('scm.SupplierOrigin').values({ SupplierCode: s, OriginCode: 'CL', Source: 'COUNTRY', AddedBy: null }).execute();
  }
  sales = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.create', 'demand.submit', 'awards.open', 'ack.respond']), companies: new Set(['1000']) });
  proc = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.accept', 'rfqs.open', 'rfq.manage', 'awards.open', 'award.manage']), companies: new Set(['1000']) });
});
afterAll(() => db.destroy());

const item = (size: string, share: string) => ({ majorCategory: 'Apples', subMajorCategory: SUB, size, materialClass: 'Cat1', originCode: 'CL', materialCode: null, share });

/** Week w: "Gala mix", 4 containers × 1,000 CT (S-100 40% = 400, S-113 60% = 600 per container), all in a Sent RFQ with A and B. */
async function sourced(w: string) {
  const { demandId } = await createDemand(db, sales, cmd(), '1000');
  await submitDemand(db, sales, cmd(), demandId, (await getDemand(db, sales, demandId)).rowVer,
    { notes: '', weeks: [{ etdWeek: w, groups: [{ name: 'Gala mix', containerCount: 4, capacity: '1000', unit: 'CT', items: [item('S-100', '40'), item('S-113', '60')] }] }] });
  await acceptDemand(db, proc, cmd(), demandId, (await getDemand(db, proc, demandId)).rowVer);
  const d = await getDemand(db, proc, demandId);
  const lines = d.weeks[0].lines.map((l) => ({ lineId: l.lineId, week: w, qty: String(Number(l.ledger.requested)) }));
  const { rfqId } = await createRfq(db, proc, cmd(), { demandId, weeks: [], lines, suppliers: [A, B] });
  await sendRfq(db, proc, cmd(), rfqId, (await getRfq(db, proc, rfqId)).rowVer);
  const rfq = await getRfq(db, proc, rfqId);
  const key = (size: string) => rfq.supplierView.find((v) => v.label.includes(size))!.key;
  return { demandId, rfqId, key };
}
const quote = (rfqId: string, s: string, w: string, prices: [string, string][], offered: number) =>
  recordQuotes(db, proc, cmd(), rfqId, s, 'USD', prices.map(([lineKey, unitPrice]) => ({ etdWeek: w, lineKey, unitPrice, availableQty: '4000', quotedSku: null })), [{ etdWeek: w, containersOffered: offered }]);
const grid = async (s: { rfqId: string; demandId: string }) => containerGrid(db, { RfqId: s.rfqId, DemandId: s.demandId });
const problemsOf = (e: { details?: { problems?: string[] } }) => e.details?.problems ?? [];

describe('award by containers (spec 20 revision 1)', () => {
  it('mixes suppliers per container, logs above the offer, adds a container, and un-awards by containers', async () => {
    const w = wk(14);
    const s = await sourced(w);
    await quote(s.rfqId, A, w, [[s.key('S-100'), '18.50'], [s.key('S-113'), '17.90']], 2);
    await quote(s.rfqId, B, w, [[s.key('S-100'), '18.10'], [s.key('S-113'), '17.60']], 3);

    const g0 = await grid(s);
    const grp = g0.weeks[0].groups[0];
    expect([grp.name, grp.containerCount, grp.available, grp.items.map((i) => i.perContainer)]).toEqual(['Gala mix', 4, 4, ['400.000', '600.000']]);
    expect([grp.prices[A], grp.prices[B]]).toEqual([['18.50', '17.90'], ['18.10', '17.60']]);
    expect(g0.weeks[0].offered).toEqual({ [A]: 2, [B]: 3 });

    // 3 containers to A (offered 2: allowed, logged) + 1 added container, 2 to B → 5 of 5.
    const rowVer = (await getRfq(db, proc, s.rfqId)).rowVer;
    const r = await awardContainers(db, proc, cmd(), s.rfqId, rowVer, {
      containers: [{ groupId: grp.groupId, supplierCode: A, count: 3 }, { groupId: grp.groupId, supplierCode: B, count: 2 }],
      added: [{ groupId: grp.groupId, count: 1 }], other: [], comment: 'mixed',
      shipments: [{ supplierCode: A, etdWeek: w, confirmedEtd: null, note: 'A called: one more' }],
    });
    const b = await getBatch(db, proc, r.awardBatchId);
    const items = b.items.map((i) => [i.supplierCode, i.label.includes('S-100') ? 'S-100' : 'S-113', i.qty, i.byContainers]).sort();
    expect(items).toEqual([[A, 'S-100', '1200.000', true], [A, 'S-113', '1800.000', true], [B, 'S-100', '800.000', true], [B, 'S-113', '1200.000', true]]);
    expect(b.shipments.map((x) => [x.supplierCode, x.containers]).sort()).toEqual([[A, 3], [B, 2]]);
    expect(b.containers.map((c) => [c.supplierCode, c.containers]).sort()).toEqual([[A, 3], [B, 2]]);
    expect(b.containerChanges.map((c) => [c.type, c.supplierCode, c.containers, c.offered]).sort()).toEqual([['ABOVE_OFFER', A, 3, 2], ['CONTAINERS_ADDED', null, 1, null]]);
    const d = await getDemand(db, sales, s.demandId);
    expect(d.weeks[0].lines.map((l) => [l.size, l.ledger.requested, l.ledger.byState.AWARDED])).toEqual([['S-100', '2000.000', '2000.000'], ['S-113', '3000.000', '3000.000']]);
    const g1 = await grid(s);
    expect([g1.weeks[0].groups[0].containerCount, g1.weeks[0].groups[0].available, g1.weeks[0].awardedBefore]).toEqual([5, 0, { [A]: 3, [B]: 2 }]);

    // More than open is refused.
    await expect(awardContainers(db, proc, cmd(), s.rfqId, (await getRfq(db, proc, s.rfqId)).rowVer, {
      containers: [{ groupId: grp.groupId, supplierCode: B, count: 1 }], added: [], other: [], shipments: [], comment: '',
    })).rejects.toSatisfy((e: { details?: { problems?: string[] } }) => problemsOf(e).some((p) => /1 container\(s\) picked, but only 0 are open/.test(p)));

    // Un-award 1 of A's containers (quotes kept): A's materials shrink by one container, the shipment too.
    const ac = b.containers.find((c) => c.supplierCode === A)!;
    await unawardContainers(db, proc, cmd(), ac.awardContainerId, ac.rowVer, 1, 'KEEP_QUOTES', 'SUPPLIER_OUT', '');
    const b2 = await getBatch(db, proc, r.awardBatchId);
    expect(b2.items.filter((i) => i.supplierCode === A).map((i) => i.qty).sort()).toEqual(['1200.000', '800.000']);
    expect(b2.shipments.find((x) => x.supplierCode === A)!.containers).toBe(2);
    expect(b2.ack!.status).toBe('PENDING');
    expect((await grid(s)).weeks[0].groups[0].available).toBe(1);
    expect(await runInvariants()).toEqual([]);
  });

  it('a supplier who did not price every material of the mix cannot win its containers', async () => {
    const w = wk(15);
    const s = await sourced(w);
    await quote(s.rfqId, A, w, [[s.key('S-100'), '18.50'], [s.key('S-113'), '17.90']], 4);
    await quote(s.rfqId, B, w, [[s.key('S-100'), '18.10']], 4); // no S-113 price
    const grp = (await grid(s)).weeks[0].groups[0];
    expect(grp.prices[B][1]).toBeNull();
    await expect(awardContainers(db, proc, cmd(), s.rfqId, (await getRfq(db, proc, s.rfqId)).rowVer, {
      containers: [{ groupId: grp.groupId, supplierCode: B, count: 1 }], added: [], other: [], shipments: [], comment: '',
    })).rejects.toSatisfy((e: { details?: { problems?: string[] } }) => problemsOf(e).some((p) => new RegExp(`${B}: not priced — .*S-113`).test(p)));
    expect(await runInvariants()).toEqual([]);
  });
});
