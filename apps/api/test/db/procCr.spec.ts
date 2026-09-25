/** Stage 4b (spec 19) against a real database: add quantity, week shift, mix change — raised by Procurement, decided by Sales. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideCr, type ItemDecision } from '../../src/modules/cr/crApply.js';
import { getCr } from '../../src/modules/cr/crRead.js';
import { withdrawCr } from '../../src/modules/cr/crService.js';
import { raiseAddQuantity, raiseMixChange, raiseWeekShift, type SpecInput } from '../../src/modules/cr/procCr.js';
import '../../src/modules/demand/access.js';
import type { DraftInput } from '../../src/modules/demand/content.js';
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
const SUP = uid('PCc');
const SUB = 'Apples Gala PC';

beforeAll(async () => {
  for (const size of ['S-100', 'S-113', 'S-125']) {
    await db.insertInto('md.Material').values({
      MaterialCode: uid('PC'), Description: `${SUB} ${size}`, MajorCategoryCode: 'AP', MajorCategory: 'Apples', SubMajorCategory: SUB, MaterialGroupCode: '', MaterialGroup: '',
      MaterialType: 'ZTRD', BaseUnit: 'CT', BaseUnitName: 'Carton', Origin: 'Chile', Variety: '', Size: size, Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: 'Cat1',
      InSap: true, SapChangedAt: new Date(),
    }).execute();
  }
  await refreshOrigins(db);
  await db.updateTable('scm.Company').set({ PurchasingOrg: '1000' }).where('CompanyCode', '=', '1000').execute();
  await db.insertInto('md.Supplier').values({
    SupplierCode: SUP, Name: SUP, SupplierGroup: 'ZIMP', Country: 'CL', Currency: 'USD', Street: '', HouseNumber: '', City: '', PostalCode: '', Region: '', Email: '',
    InSap: true, SapChangedAt: new Date(), PurchasingIsBlocked: false, PostingIsBlocked: false,
  }).execute();
  await db.insertInto('md.SupplierPurchasingOrg').values({ SupplierCode: SUP, PurchasingOrg: '1000', IsBlocked: false }).execute();
  await db.insertInto('scm.SupplierOrigin').values({ SupplierCode: SUP, OriginCode: 'CL', Source: 'COUNTRY', AddedBy: null }).execute();
  sales = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.create', 'demand.submit', 'crs.open', 'cr.decide.procurement']), companies: new Set(['1000']) });
  proc = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.accept', 'rfqs.open', 'rfq.manage', 'crs.open', 'cr.raise.procurement', 'cr.withdraw']), companies: new Set(['1000']) });
});
afterAll(() => db.destroy());

const spec = (size: string): SpecInput => ({ majorCategory: 'Apples', subMajorCategory: SUB, size, materialClass: 'Cat1', originCode: 'CL', materialCode: null, unit: 'CT' });
const item = (size: string): DraftInput['weeks'][number]['groups'][number]['items'][number] => ({ ...spec(size), share: '100' });

/** An accepted demand of 3 × 1000 CT S-100 in week w, all of it in a Sent RFQ with one supplier. */
async function sourced(w: string) {
  const { demandId } = await createDemand(db, sales, cmd(), '1000');
  await submitDemand(db, sales, cmd(), demandId, (await getDemand(db, sales, demandId)).rowVer,
    { notes: '', weeks: [{ etdWeek: w, groups: [{ name: 'Gala', containerCount: 3, capacity: '1000', unit: 'CT', items: [item('S-100')] }] }] });
  await acceptDemand(db, proc, cmd(), demandId, (await getDemand(db, proc, demandId)).rowVer);
  const line = (await getDemand(db, proc, demandId)).weeks[0].lines[0];
  const { rfqId } = await createRfq(db, proc, cmd(), { demandId, weeks: [], lines: [{ lineId: line.lineId, week: w, qty: '3000' }], suppliers: [SUP] });
  await sendRfq(db, proc, cmd(), rfqId, (await getRfq(db, proc, rfqId)).rowVer);
  return { demandId, rfqId, lineId: line.lineId };
}
const decide = async (crId: string, pick: (kind: string) => Omit<ItemDecision, 'crItemId'>, who = sales) => {
  const cr = await getCr(db, who, crId);
  return decideCr(db, who, cmd(), crId, cr.rowVer, cr.items.map((i) => ({ crItemId: i.crItemId, ...pick(i.kind) })), 'test');
};
const lines = async (demandId: string) => (await getDemand(db, sales, demandId)).weeks.flatMap((w) => w.lines.map((l) => [w.etdWeek, l.size, l.ledger.requested, l.ledger.open, l.ledger.byState.IN_RFQ, l.ledger.byState.QUOTED, l.ledger.cancelled]));
const why = { reasonCode: 'MARKET_OPP', comment: 'test' };

describe('add quantity (spec 19)', () => {
  it('proposed line joins the RFQ at once; Sales approves less and rejects the containers; quoted stays quoted', async () => {
    const w = wk(6);
    const { demandId, rfqId } = await sourced(w);
    const check = await raiseAddQuantity(db, proc, cmd(), rfqId, { etdWeek: wk(-2), spec: spec('S-113'), qty: '1000', extraContainers: 1, ...why }, true);
    expect('dryRun' in check && check.problems).toEqual([expect.stringMatching(/is in the past/)]);

    const r = await raiseAddQuantity(db, proc, cmd(), rfqId, { etdWeek: w, spec: spec('S-113'), qty: '1000', extraContainers: 1, ...why });
    if ('dryRun' in r) throw new Error('not saved');
    expect(r.status).toBe('SUBMITTED');
    let rfq = await getRfq(db, proc, rfqId);
    const pending = rfq.lines.find((l) => l.status === 'PENDING_SALES')!;
    expect([pending.proposed, pending.pending?.crNo]).toEqual(['1000.000', r.crNo]);
    const row = rfq.supplierView.find((v) => v.label.includes('S-113'))!;
    expect(row.qty).toBe('1000.000'); // suppliers see it and can quote it
    await recordQuotes(db, proc, cmd(), rfqId, SUP, 'USD', [{ etdWeek: w, lineKey: row.key, unitPrice: '18.1', availableQty: '1000' }], [{ etdWeek: w, containersOffered: 1 }]);
    expect(await runInvariants()).toEqual([]);

    expect((await decide(r.crId, () => ({ decision: 'APPROVE' }), proc).catch((e) => e)).status).toBe(403); // the raiser never decides
    await decide(r.crId, (k) => (k === 'ADD_QTY' ? { decision: 'PARTIAL', approvedQty: '600' } : { decision: 'REJECT' }));
    expect(await lines(demandId)).toEqual([[w, 'S-100', '3000.000', '0.000', '3000.000', '0.000', '0.000'], [w, 'S-113', '600.000', '0.000', '0.000', '600.000', '0.000']]);
    const origin = (await sql<{ BusinessOrigin: string }>`SELECT s.BusinessOrigin FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId WHERE l.DemandId = ${demandId} AND l.Size = 'S-113'`.execute(db)).rows;
    expect(origin.map((o) => o.BusinessOrigin)).toEqual(['PROCUREMENT']);
    expect((await getDemand(db, sales, demandId)).weeks[0].containerCount).toBe(3); // containers rejected
    rfq = await getRfq(db, proc, rfqId);
    expect(rfq.lines.find((l) => l.label.includes('S-113'))).toMatchObject({ status: 'QUOTED', asked: '600.000', pending: null });
    expect(await runInvariants()).toEqual([]);
  });

  it('quantity rejected but containers approved: the proposed line is cancelled, the week gets the container', async () => {
    const w = wk(7);
    const { demandId, rfqId } = await sourced(w);
    const r = await raiseAddQuantity(db, proc, cmd(), rfqId, { etdWeek: w, spec: spec('S-125'), qty: '500', extraContainers: 1, ...why });
    if ('dryRun' in r) throw new Error('not saved');
    await decide(r.crId, (k) => (k === 'ADD_QTY' ? { decision: 'REJECT' } : { decision: 'APPROVE' }));
    expect((await getRfq(db, proc, rfqId)).lines.find((l) => l.label.includes('S-125'))!.status).toBe('CANCELLED');
    expect((await getDemand(db, sales, demandId)).weeks[0].containerCount).toBe(4);
    expect(await runInvariants()).toEqual([]);
  });
});

describe('week shift and mix change (spec 19)', () => {
  it('a shift shows the new week at once, holds the line, and on approval the quantity is approved for it; withdraw reverts', async () => {
    const [w, to] = [wk(8), wk(9)];
    const { demandId, rfqId } = await sourced(w);
    let rl = (await getRfq(db, proc, rfqId)).lines[0];
    const r = await raiseWeekShift(db, proc, cmd(), rfqId, { rfqLineId: rl.rfqLineId, toWeek: to, containers: 3, reasonCode: 'WEEK_AVAIL', comment: 'test' });
    if ('dryRun' in r) throw new Error('not saved');
    rl = (await getRfq(db, proc, rfqId)).lines[0];
    expect([rl.week, rl.pending?.fromWeek, rl.canShift]).toEqual([to, w, false]);
    const again = await raiseWeekShift(db, proc, cmd(), rfqId, { rfqLineId: rl.rfqLineId, toWeek: wk(10), containers: 3, reasonCode: 'WEEK_AVAIL', comment: 'test' }, true);
    expect('dryRun' in again && again.problems).toContainEqual(expect.stringMatching(/already waiting for Sales/));
    expect(await runInvariants()).toEqual([]);
    await withdrawCr(db, proc, cmd(), r.crId, (await getCr(db, proc, r.crId)).rowVer, 'changed our mind');
    expect((await getRfq(db, proc, rfqId)).lines[0].week).toBe(w);

    const r2 = await raiseWeekShift(db, proc, cmd(), rfqId, { rfqLineId: rl.rfqLineId, toWeek: to, containers: 3, reasonCode: 'WEEK_AVAIL', comment: 'test' });
    if ('dryRun' in r2) throw new Error('not saved');
    await decide(r2.crId, () => ({ decision: 'APPROVE' }));
    const weeks = (await sql<{ ApprovedEtdWeek: string }>`SELECT DISTINCT s.ApprovedEtdWeek FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId WHERE l.DemandId = ${demandId} AND s.ExecState = 'IN_RFQ'`.execute(db)).rows;
    expect(weeks.map((x) => x.ApprovedEtdWeek)).toEqual([to]);
    expect((await getDemand(db, sales, demandId)).weeks[0].lines[0].approvedFor).toEqual([`3,000 CT approved for ${to}`]);
    expect(await runInvariants()).toEqual([]);
  });

  it('mix change: less of one line (cancelled, origin Change), more of another (Open, origin Change)', async () => {
    const w = wk(11);
    const { demandId, rfqId } = await sourced(w);
    const rl = (await getRfq(db, proc, rfqId)).lines[0];
    const r = await raiseMixChange(db, proc, cmd(), rfqId, { reductions: [{ rfqLineId: rl.rfqLineId, qty: '1000' }], additions: [{ etdWeek: w, spec: spec('S-125'), qty: '1000' }], reasonCode: 'MIX_OFFER', comment: 'test' });
    if ('dryRun' in r) throw new Error('not saved');
    await decide(r.crId, () => ({ decision: 'APPROVE' }));
    expect(await lines(demandId)).toEqual([[w, 'S-100', '3000.000', '0.000', '2000.000', '0.000', '1000.000'], [w, 'S-125', '1000.000', '1000.000', '0.000', '0.000', '0.000']]);
    const origins = (await sql<{ Size: string; BusinessOrigin: string; CancelOrigin: string | null }>`
      SELECT l.Size, s.BusinessOrigin, s.CancelOrigin FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId
      WHERE l.DemandId = ${demandId} AND (s.ExecState = 'CANCELLED' OR l.Size = 'S-125')`.execute(db)).rows;
    expect(origins.map((o) => [o.Size, o.BusinessOrigin, o.CancelOrigin]).sort()).toEqual([['S-100', 'SALES', 'CHANGE'], ['S-125', 'CHANGE', null]]);
    expect(await runInvariants()).toEqual([]);
  });
});
