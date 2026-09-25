/** Stage 5 (spec 20) against a real database: award, availability, currency, guards, SKU, un-award, acknowledgement, CR cancellation, split week shift. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acknowledge, answerQuery, raiseQuery } from '../../src/modules/award/ack.js';
import { getBatch } from '../../src/modules/award/awardRead.js';
import { correctSku, createAward, unaward } from '../../src/modules/award/awardService.js';
import { decideCr } from '../../src/modules/cr/crApply.js';
import { getCr } from '../../src/modules/cr/crRead.js';
import { raiseContainerChange } from '../../src/modules/cr/crService.js';
import { raiseWeekShift } from '../../src/modules/cr/procCr.js';
import '../../src/modules/demand/access.js';
import { getDemand } from '../../src/modules/demand/demandRead.js';
import { acceptDemand, createDemand, submitDemand } from '../../src/modules/demand/demandService.js';
import { recordQuotes } from '../../src/modules/rfq/quotes.js';
import { getRfq } from '../../src/modules/rfq/rfqRead.js';
import { createRfq, sendRfq } from '../../src/modules/rfq/rfqService.js';
import { listWork } from '../../src/modules/workflow/inbox.js';
import { isoWeekMonday, isoWeekOf } from '../../src/modules/workflow/isoWeek.js';
import { refreshOrigins } from '../../src/modules/workflow/origins.js';
import { actor, db, makeUser, runInvariants, uid } from './helpers.js';

const cmd = () => randomUUID();
const wk = (n: number) => isoWeekOf(new Date(isoWeekMonday(isoWeekOf(new Date())).getTime() + n * 7 * 86_400_000));
let sales: ReturnType<typeof actor>;
let proc: ReturnType<typeof actor>;
const [A, B] = [uid('AWa'), uid('AWb')];
const SUB = 'Apples Gala AW';
const SKU: Record<string, string> = {};

beforeAll(async () => {
  for (const [size, n] of [['S-100', 2], ['S-113', 1]] as const) {
    for (let i = 0; i < n; i++) {
      const code = uid('AW');
      SKU[`${size}-${i}`] = code;
      await db.insertInto('md.Material').values({
        MaterialCode: code, Description: `${SUB} ${size}`, MajorCategoryCode: 'AP', MajorCategory: 'Apples', SubMajorCategory: SUB, MaterialGroupCode: '', MaterialGroup: '',
        MaterialType: 'ZTRD', BaseUnit: 'CT', BaseUnitName: 'Carton', Origin: 'Chile', Variety: '', Size: size, Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: 'Cat1',
        InSap: true, SapChangedAt: new Date(),
      }).execute();
    }
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
  sales = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.create', 'demand.submit', 'crs.open', 'cr.raise.sales', 'cr.decide.procurement', 'awards.open', 'ack.respond']), companies: new Set(['1000']) });
  proc = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.accept', 'rfqs.open', 'rfq.manage', 'crs.open', 'cr.raise.procurement', 'cr.decide.sales', 'cr.withdraw', 'awards.open', 'award.manage']), companies: new Set(['1000']) });
});
afterAll(() => db.destroy());

const spec = (size: string) => ({ majorCategory: 'Apples', subMajorCategory: SUB, size, materialClass: 'Cat1', originCode: 'CL', materialCode: null, share: '100' });

/** An accepted demand (week w: sizes × 1000 CT per container), all of it in a Sent RFQ with A and B. */
async function sourced(w: string, groups: [string, number][]) {
  const { demandId } = await createDemand(db, sales, cmd(), '1000');
  await submitDemand(db, sales, cmd(), demandId, (await getDemand(db, sales, demandId)).rowVer,
    { notes: '', weeks: [{ etdWeek: w, groups: groups.map(([size, n]) => ({ name: size, containerCount: n, capacity: '1000', unit: 'CT', items: [spec(size)] })) }] });
  await acceptDemand(db, proc, cmd(), demandId, (await getDemand(db, proc, demandId)).rowVer);
  const d = await getDemand(db, proc, demandId);
  const lines = d.weeks[0].lines.map((l) => ({ lineId: l.lineId, week: w, qty: String(Number(l.ledger.requested)) }));
  const { rfqId } = await createRfq(db, proc, cmd(), { demandId, weeks: [], lines, suppliers: [A, B] });
  await sendRfq(db, proc, cmd(), rfqId, (await getRfq(db, proc, rfqId)).rowVer);
  const rfq = await getRfq(db, proc, rfqId);
  return { demandId, rfqId, rfq, line: (size: string) => rfq.lines.find((l) => l.label.includes(size))!, row: (size: string) => rfq.supplierView.find((v) => v.label.includes(size))! };
}
const quote = (rfqId: string, s: string, w: string, key: string, price: string, available: string, currency = 'USD', sku: string | null = null) =>
  recordQuotes(db, proc, cmd(), rfqId, s, currency, [{ etdWeek: w, lineKey: key, unitPrice: price, availableQty: available, quotedSku: sku }], [{ etdWeek: w, containersOffered: 3 }]);
const award = async (rfqId: string, awards: { rfqLineId: string; supplierCode: string; qty: string; overrideReason?: string }[], w: string, extra: { releases?: { rfqLineId: string; qty: string; reasonCode: string }[]; dryRun?: boolean } = {}) =>
  createAward(db, proc, cmd(), rfqId, (await getRfq(db, proc, rfqId)).rowVer, {
    awards, releases: extra.releases ?? [], comment: 'test',
    shipments: [...new Set(awards.map((a) => a.supplierCode))].map((s) => ({ supplierCode: s, etdWeek: w, containerCount: 2, confirmedEtd: null })),
  }, extra.dryRun);
const ledgerOf = async (demandId: string) => (await getDemand(db, sales, demandId)).weeks[0].lines.map((l) => [l.size, l.ledger.byState.QUOTED, l.ledger.byState.AWARDED, l.ledger.open]);
const problemsOf = (e: { details?: { problems?: string[] } }) => e.details?.problems ?? [];

describe('award (spec 20)', () => {
  it('awards 5,000 to A and 1,600 to B (over its availability: needs a reason), releases 400; Sales is asked', async () => {
    const w = wk(12);
    const s = await sourced(w, [['S-100', 7]]);
    const key = s.row('S-100').key;
    await quote(s.rfqId, A, w, key, '18.10', '5000', 'USD', SKU['S-100-0']);
    await quote(s.rfqId, B, w, key, '18.95', '1500');
    const rl = s.line('S-100').rfqLineId;

    const check = await award(s.rfqId, [{ rfqLineId: rl, supplierCode: A, qty: '5000' }, { rfqLineId: rl, supplierCode: B, qty: '1600' }], w, { dryRun: true });
    expect('dryRun' in check && check.problems).toEqual([expect.stringMatching(new RegExp(`^${B} quoted 1500\\.000 available .* would total 1600\\.000`))]);
    const noBox = await createAward(db, proc, cmd(), s.rfqId, (await getRfq(db, proc, s.rfqId)).rowVer, { awards: [{ rfqLineId: rl, supplierCode: A, qty: '100' }], shipments: [], releases: [], comment: '' }, true);
    expect('dryRun' in noBox && noBox.problems).toContainEqual(expect.stringMatching(/enter the containers of this shipment/));

    const r = await award(s.rfqId, [{ rfqLineId: rl, supplierCode: A, qty: '5000' }, { rfqLineId: rl, supplierCode: B, qty: '1600', overrideReason: 'confirmed by phone' }], w,
      { releases: [{ rfqLineId: rl, qty: '400', reasonCode: 'QTY_NOT_NEEDED' }] });
    if ('dryRun' in r) throw new Error('not awarded');
    expect(await ledgerOf(s.demandId)).toEqual([['S-100', '0.000', '6600.000', '400.000']]);
    const b = await getBatch(db, proc, r.awardBatchId);
    expect(b.items.map((i) => [i.supplierCode, i.qty, i.unitPrice, i.skuStatus, i.skus, !!i.overrideReason])).toEqual(expect.arrayContaining([
      [A, '5000.000', '18.10', 'RESOLVED_AT_RFQ', [SKU['S-100-0']], false], [B, '1600.000', '18.95', 'PENDING', [], true],
    ]));
    expect(b.shipments.map((x) => [x.supplierCode, x.containers])).toEqual(expect.arrayContaining([[A, 2], [B, 2]]));
    expect([b.ack?.status, b.ack?.revision]).toEqual(['PENDING', 1]);
    expect((await listWork(db, sales, { tab: 'ACK_PENDING', q: b.abNo, page: 1, pageSize: 25 })).rows).toHaveLength(1);
    expect(await runInvariants()).toEqual([]);

    // A re-quotes: the next award uses the new quote; the earlier item keeps its price. Cumulative availability counts batch 1.
    await quote(s.rfqId, A, w, key, '17.50', '6000');
    const second = await award(s.rfqId, [{ rfqLineId: rl, supplierCode: A, qty: '1' }], w, { dryRun: true });
    expect('dryRun' in second && second.problems).toContainEqual(expect.stringMatching(/only 0\.000 is quoted and unawarded/));
  });

  it('guards: one currency per supplier, a pending week shift, SKU correction within the spec, un-award, acknowledgement', async () => {
    const w = wk(13);
    const s = await sourced(w, [['S-100', 2], ['S-113', 1]]);
    await quote(s.rfqId, A, w, s.row('S-100').key, '18', '2000');
    await recordQuotes(db, proc, cmd(), s.rfqId, A, 'EUR', [{ etdWeek: w, lineKey: s.row('S-113').key, unitPrice: '16', availableQty: '1000' }], [{ etdWeek: w, containersOffered: 3 }]);
    const [l100, l113] = [s.line('S-100').rfqLineId, s.line('S-113').rfqLineId];
    const cur = await award(s.rfqId, [{ rfqLineId: l100, supplierCode: A, qty: '2000' }, { rfqLineId: l113, supplierCode: A, qty: '1000' }], w, { dryRun: true });
    expect('dryRun' in cur && cur.problems).toContainEqual(`${A}: all its items in one award must be in one currency (USD, EUR)`);

    const shift = await raiseWeekShift(db, proc, cmd(), s.rfqId, { rfqLineId: l113, toWeek: wk(14), containers: 1, reasonCode: 'WEEK_AVAIL', comment: 'test' });
    if ('dryRun' in shift) throw new Error('not raised');
    const held = await award(s.rfqId, [{ rfqLineId: l113, supplierCode: A, qty: '1000' }], wk(14), { dryRun: true });
    expect('dryRun' in held && held.problems).toContainEqual(expect.stringMatching(/week shift waiting for Sales/));

    const r = await award(s.rfqId, [{ rfqLineId: l100, supplierCode: A, qty: '2000' }], w);
    if ('dryRun' in r) throw new Error('not awarded');
    let b = await getBatch(db, proc, r.awardBatchId);
    const item = b.items[0];
    expect((await correctSku(db, proc, cmd(), item.awardItemId, item.rowVer, SKU['S-113-0'], 'test').catch((e) => e)).code).toBe('SKU_MISMATCH'); // another size
    await correctSku(db, proc, cmd(), item.awardItemId, item.rowVer, SKU['S-100-1'], 'supplier packs this SKU');
    b = await getBatch(db, proc, r.awardBatchId);
    expect([b.items[0].skus, b.items[0].skuStatus, b.ack?.revision]).toEqual([[SKU['S-100-1']], 'RESOLVED_AT_RFQ', 2]);

    // Acknowledgement: a stale revision is refused; the current one is stored with what was acknowledged.
    expect((await acknowledge(db, sales, cmd(), b.ack!.ackId, '0000000000000000', '').catch((e) => e)).status).toBe(409);
    await raiseQuery(db, sales, cmd(), b.ack!.ackId, b.ack!.rowVer, 'Why this SKU?');
    expect((await listWork(db, proc, { tab: 'EXCEPTIONS', q: b.abNo, page: 1, pageSize: 25 })).rows.map((x) => x.itemType)).toContain('ACK_QUERY');
    b = await getBatch(db, proc, r.awardBatchId);
    await answerQuery(db, proc, cmd(), b.ack!.ackId, b.ack!.rowVer, 'It is the size-100 carton');
    b = await getBatch(db, proc, r.awardBatchId);
    await acknowledge(db, sales, cmd(), b.ack!.ackId, b.ack!.rowVer, 'ok');
    b = await getBatch(db, proc, r.awardBatchId);
    expect([b.ack?.status, b.ackHistory[0].snapshot]).toEqual(['ACKNOWLEDGED', true]);

    // Un-award 500 (keep the quotes), then the rest (release): the item goes, its shipment becomes inactive; Sales is asked again.
    const it2 = b.items[0];
    await unaward(db, proc, cmd(), it2.awardItemId, it2.rowVer, '500', 'KEEP_QUOTES', 'SUPPLIER_OUT', '');
    b = await getBatch(db, proc, r.awardBatchId);
    expect([b.items[0].qty, b.ack?.status, b.ack?.revision]).toEqual(['1500.000', 'PENDING', 3]);
    await unaward(db, proc, cmd(), b.items[0].awardItemId, b.items[0].rowVer, 'ALL', 'RELEASE', 'SUPPLIER_OUT', '');
    b = await getBatch(db, proc, r.awardBatchId);
    expect([b.items[0].isActive, b.shipments[0].isActive]).toEqual([false, false]);
    expect((await ledgerOf(s.demandId)).find((x) => x[0] === 'S-100')).toEqual(['S-100', '500.000', '0.000', '1500.000']);
    expect(await runInvariants()).toEqual([]);
  });

  it('a Sales change request cancelling awarded quantity shrinks the award and tells Procurement; a week shift splits a partly awarded line', async () => {
    const w = wk(15);
    const s = await sourced(w, [['S-100', 3]]);
    await quote(s.rfqId, A, w, s.row('S-100').key, '18', '3000');
    const rl = s.line('S-100').rfqLineId;
    const r = await award(s.rfqId, [{ rfqLineId: rl, supplierCode: A, qty: '2000' }], w);
    if ('dryRun' in r) throw new Error('not awarded');

    // Week shift on the partly awarded line: the unawarded 1,000 moves to a new RFQ line for the new week
    const sh = await raiseWeekShift(db, proc, cmd(), s.rfqId, { rfqLineId: rl, toWeek: wk(16), containers: 1, reasonCode: 'WEEK_AVAIL', comment: 'test' });
    if ('dryRun' in sh) throw new Error('not raised');
    let rfq = await getRfq(db, proc, s.rfqId);
    expect(rfq.lines.map((l) => [l.week, l.quoted, l.awarded])).toEqual([[w, '0.000', '2000.000'], [wk(16), '1000.000', '0.000']]);
    expect(await runInvariants()).toEqual([]);
    const c1 = await getCr(db, sales, sh.crId);
    await decideCr(db, sales, cmd(), sh.crId, c1.rowVer, c1.items.map((i) => ({ crItemId: i.crItemId, decision: 'APPROVE' as const })), 'ok');

    // Sales cancels one container (1,000): least progressed first — the 1,000 quoted in W+16, then 0 awarded… so reduce 2 containers
    const d = await getDemand(db, sales, s.demandId);
    const g = d.weeks[0].groups[0];
    const cr = await raiseContainerChange(db, sales, cmd(), s.demandId, {
      weeks: [{ etdWeek: w, groups: [{ groupId: g.groupId, name: g.name, containerCount: 1, capacity: '1000', unit: 'CT', items: [spec('S-100')] }] }], reasonCode: 'CUST_CANCEL', comment: 'test',
    });
    const c2 = await getCr(db, proc, cr.crId);
    await decideCr(db, proc, cmd(), cr.crId, c2.rowVer, c2.items.map((i) => ({ crItemId: i.crItemId, decision: 'APPROVE' as const })), 'ok');
    const b = await getBatch(db, proc, r.awardBatchId);
    expect([b.items[0].qty, b.changes[0].type, b.changes[0].crNo, b.ack?.revision]).toEqual(['1000.000', 'CANCELLED_BY_CR', cr.crNo, 2]);
    expect((await listWork(db, proc, { tab: 'SUPPLIER_CHANGE', q: b.abNo, page: 1, pageSize: 25 })).rows).toHaveLength(1);
    rfq = await getRfq(db, proc, s.rfqId);
    expect(await runInvariants()).toEqual([]);
    const cancelled = (await sql<{ n: string }>`SELECT SUM(s.Qty) AS n FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId WHERE l.DemandId = ${s.demandId} AND s.ExecState = 'CANCELLED'`.execute(db)).rows[0].n;
    expect(Number(cancelled)).toBe(2_000_000);
  });
});
