/** Stage 4a (spec 18) against a real database: shortlist, create, send, quotes, release, cancel, unmerge, aging, invariants. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../../src/modules/demand/access.js';
import type { DraftInput } from '../../src/modules/demand/content.js';
import { getDemand } from '../../src/modules/demand/demandRead.js';
import { acceptDemand, createDemand, submitDemand } from '../../src/modules/demand/demandService.js';
import { listMerges } from '../../src/modules/merge/mergeRead.js';
import { executeMerge, unmerge } from '../../src/modules/merge/mergeService.js';
import { refreshAging } from '../../src/modules/rfq/aging.js';
import { recordQuotes } from '../../src/modules/rfq/quotes.js';
import { builderData, getRfq, listRfqs, shortlistFor } from '../../src/modules/rfq/rfqRead.js';
import { cancelRfq, createRfq, releaseQty, sendRfq } from '../../src/modules/rfq/rfqService.js';
import { listWork } from '../../src/modules/workflow/inbox.js';
import { isoWeekMonday, isoWeekOf } from '../../src/modules/workflow/isoWeek.js';
import { refreshOrigins } from '../../src/modules/workflow/origins.js';
import { actor, db, makeUser, runInvariants, uid } from './helpers.js';

const cmd = () => randomUUID();
const wk = (n: number) => isoWeekOf(new Date(isoWeekMonday(isoWeekOf(new Date())).getTime() + n * 7 * 86_400_000));
let sales: ReturnType<typeof actor>;
let proc: ReturnType<typeof actor>;
const S = { chile: uid('CLa'), chile2: uid('CLb'), trader: uid('AEt'), blocked: uid('CLx'), notExtended: uid('CLn'), cape: uid('ZAc') };

async function material(sub: string, size: string, origin: string) {
  await db.insertInto('md.Material').values({
    MaterialCode: uid('RQ'), Description: `${sub} ${size}`, MajorCategoryCode: 'AP', MajorCategory: 'Apples', SubMajorCategory: sub, MaterialGroupCode: '', MaterialGroup: '',
    MaterialType: 'ZTRD', BaseUnit: 'CT', BaseUnitName: 'Carton', Origin: origin, Variety: '', Size: size, Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: 'Cat1',
    InSap: true, SapChangedAt: new Date(),
  }).execute();
}
async function supplier(code: string, country: string, opts: { blocked?: boolean; org?: boolean; origins?: string[] } = {}) {
  await db.insertInto('md.Supplier').values({
    SupplierCode: code, Name: code, SupplierGroup: 'ZIMP', Country: country, Currency: 'USD', Street: '', HouseNumber: '', City: '', PostalCode: '', Region: '', Email: '',
    InSap: true, SapChangedAt: new Date(), PurchasingIsBlocked: !!opts.blocked, PostingIsBlocked: false,
  }).execute();
  if (opts.org !== false) await db.insertInto('md.SupplierPurchasingOrg').values({ SupplierCode: code, PurchasingOrg: '1000', IsBlocked: false }).execute();
  for (const [i, o] of [country, ...(opts.origins ?? [])].entries()) {
    await db.insertInto('scm.SupplierOrigin').values({ SupplierCode: code, OriginCode: o, Source: i === 0 ? 'COUNTRY' : 'HISTORY', AddedBy: null }).execute();
  }
}
async function history(code: string, sub: string, size: string, pos: number) {
  await db.insertInto('scm.PurchaseHistorySummary').values({
    SupplierCode: code, CompanyCode: '1000', MajorCategory: 'Apples', SubMajorCategory: sub, Size: size, OriginCode: 'CL', MaterialCode: '', Unit: 'CT',
    PoCount: pos, TotalQtyMilli: String(pos * 1_000_000), FirstPoDate: new Date('2025-01-01'), LastPoDate: new Date('2026-06-01'), LastUnitPrice: 18.62, LastCurrency: 'USD',
  }).execute();
}

beforeAll(async () => {
  await material('Apples Fuji RQ', 'S-100', 'Chile');
  await material('Pears Packham RQ', 'S-100', 'South Africa');
  await refreshOrigins(db);
  await db.updateTable('scm.Company').set({ PurchasingOrg: '1000' }).where('CompanyCode', '=', '1000').execute();
  await supplier(S.chile, 'CL');
  await supplier(S.chile2, 'CL');
  await supplier(S.trader, 'AE', { origins: ['CL'] }); // a trader: registered in AE, supplied CL to us
  await supplier(S.blocked, 'CL', { blocked: true });
  await supplier(S.notExtended, 'CL', { org: false });
  await supplier(S.cape, 'ZA');
  await history(S.chile2, 'Apples Fuji RQ', 'S-100', 12); // same material and size
  await history(S.trader, 'Apples Fuji RQ', 'S-113', 30); // same material, other size
  const salesPerms = ['demands.open', 'demand.create', 'demand.submit'];
  const procPerms = ['demands.open', 'demand.accept', 'demand.merge', 'demand.unmerge', 'rfqs.open', 'rfq.manage'];
  sales = actor({ id: await makeUser(), permissions: new Set(salesPerms), companies: new Set(['1000']) });
  proc = actor({ id: await makeUser(), permissions: new Set(procPerms), companies: new Set(['1000']) });
});
afterAll(() => db.destroy());

type Item = DraftInput['weeks'][number]['groups'][number]['items'][number];
const fuji: Item = { majorCategory: 'Apples', subMajorCategory: 'Apples Fuji RQ', size: 'S-100', materialClass: 'Cat1', originCode: 'CL', share: '100' };
const packham: Item = { ...fuji, subMajorCategory: 'Pears Packham RQ', originCode: 'ZA' };

async function accepted(weeks: [string, number, Item[]][]) {
  const { demandId } = await createDemand(db, sales, cmd(), '1000');
  await submitDemand(db, sales, cmd(), demandId, (await getDemand(db, sales, demandId)).rowVer, {
    notes: '', weeks: weeks.map(([etdWeek, count, items]) => ({
      etdWeek, groups: items.map((it) => ({ name: it.subMajorCategory, containerCount: count, capacity: '1000', unit: 'CT', items: [it] })),
    })),
  });
  await acceptDemand(db, proc, cmd(), demandId, (await getDemand(db, proc, demandId)).rowVer);
  return demandId;
}
const lineOf = async (demandId: string, sub: string) => (await getDemand(db, proc, demandId)).weeks.flatMap((w) => w.lines).find((l) => l.subMajorCategory === sub)!;
const mine = (codes: string[]) => codes.filter((c) => (Object.values(S) as string[]).includes(c));
const problemsOf = (e: { details?: { problems?: string[] } }) => e.details?.problems ?? [];

describe('shortlist (spec 18, plan §4.4)', () => {
  it('only usable suppliers able to supply the origin (country or history); ranked by our history', async () => {
    const d = await accepted([[wk(3), 5, [fuji]]]);
    const line = await lineOf(d, 'Apples Fuji RQ');
    const [cl] = await shortlistFor(db, proc, d, [line.lineId]);
    expect(cl.originCode).toBe('CL');
    const codes = mine(cl.entries.map((e) => e.supplierCode));
    expect(codes).toEqual([S.chile2, S.trader, S.chile]); // same size (12 POs) > same material (30 POs) > no history
    const trader = cl.entries.find((e) => e.supplierCode === S.trader)!;
    expect([trader.origins, trader.hint.matchLevel, trader.hint.poCount]).toEqual([['AE', 'CL'], 'SUBCATEGORY', 30]);
    expect(cl.entries.find((e) => e.supplierCode === S.chile)!.rank).toBeNull();
  });
});

describe('RFQ (spec 18)', () => {
  it('create takes part of the Open quantity per week; invite rules; send; quotes; re-quote; release; supplier view', async () => {
    const w = wk(4);
    const d = await accepted([[w, 5, [fuji, packham]]]); // 5 × 1000 CT each
    const [f, p] = [await lineOf(d, 'Apples Fuji RQ'), await lineOf(d, 'Pears Packham RQ')];
    const b = await builderData(db, proc, d);
    expect(b.rows.map((r) => [r.week, r.label.split(' ')[1], r.open])).toEqual([[w, 'Fuji', '5000.000'], [w, 'Packham', '5000.000']]);

    const base = { demandId: d, weeks: [], lines: [{ lineId: f.lineId, week: w, qty: '3000' }, { lineId: p.lineId, week: w, qty: '5000' }] };
    expect((await createRfq(db, proc, cmd(), { ...base, suppliers: [S.blocked] }).catch((e) => e)).code).toBe('VENDOR_BLOCKED');
    expect((await createRfq(db, proc, cmd(), { ...base, suppliers: [S.notExtended] }).catch((e) => e)).code).toBe('VENDOR_NOT_EXTENDED');
    expect((await createRfq(db, proc, cmd(), { ...base, lines: [{ lineId: f.lineId, week: w, qty: '6000' }], suppliers: [S.chile] }).catch((e) => e)).code).toBe('INSUFFICIENT_QTY');
    const other = await accepted([[w, 1, [fuji]]]);
    expect((await createRfq(db, proc, cmd(), { ...base, lines: [{ lineId: (await lineOf(other, 'Apples Fuji RQ')).lineId, week: w, qty: '1' }], suppliers: [S.chile] }).catch((e) => e)).status).toBe(404);

    const { rfqId, rfqNo } = await createRfq(db, proc, cmd(), { ...base, suppliers: [S.chile2, S.trader, S.cape] });
    const after = await lineOf(d, 'Apples Fuji RQ');
    expect([after.ledger.byState.IN_RFQ, after.ledger.open]).toEqual(['3000.000', '2000.000']);
    let r = await getRfq(db, proc, rfqId);
    expect([r.status, r.weeks]).toEqual(['DRAFT', [{ etdWeek: w, containerCount: 8, defaultCount: 8 }]]); // 10 × 8000/10000
    expect(r.suppliers.find((s) => s.supplierCode === S.trader)).toMatchObject({ originsAtInvite: ['AE', 'CL'], rank: expect.any(Number) });
    expect(r.supplierView.map((v) => [v.label.split(' ')[1], v.originCode, v.qty, v.weekContainers])).toEqual([['Fuji', 'CL', '3000.000', 8], ['Packham', 'ZA', '5000.000', 8]]);
    expect(JSON.stringify(r.supplierView)).not.toContain('D-'); // no demand numbers for suppliers

    expect((await recordQuotes(db, proc, cmd(), rfqId, S.chile2, 'USD', [{ etdWeek: w, lineKey: r.supplierView[0].key, unitPrice: '18.5', availableQty: '3000' }]).catch((e) => e)).code).toBe('BAD_STATE'); // not sent
    await sendRfq(db, proc, cmd(), rfqId, r.rowVer);
    expect((await listWork(db, proc, { tab: 'RFQ_TO_QUOTE', q: rfqNo, page: 1, pageSize: 25 })).rows).toHaveLength(1);

    const [fujiRow, packRow] = r.supplierView;
    const cape = await recordQuotes(db, proc, cmd(), rfqId, S.cape, 'USD', [{ etdWeek: w, lineKey: fujiRow.key, unitPrice: '17', availableQty: '3000' }], [{ etdWeek: w, containersOffered: 1 }]).catch((e) => e);
    expect(cape.code).toBe('SUPPLIER_ORIGIN_MISMATCH'); // ZA supplier cannot quote the CL row
    expect(problemsOf(await recordQuotes(db, proc, cmd(), rfqId, S.chile2, 'USD', [{ etdWeek: w, lineKey: fujiRow.key, unitPrice: '0', availableQty: '3000' }], [{ etdWeek: w, containersOffered: 1 }]).catch((e) => e))[0]).toMatch(/unit price must be above 0/);

    const noContainers = await recordQuotes(db, proc, cmd(), rfqId, S.chile2, 'USD', [{ etdWeek: w, lineKey: fujiRow.key, unitPrice: '18.5', availableQty: '2000' }]).catch((e) => e);
    expect(problemsOf(noContainers)).toEqual([`${w}: enter the containers offered for this week (at least 1) to save its quotes`]); // no quote without containers
    await recordQuotes(db, proc, cmd(), rfqId, S.chile2, 'USD', [{ etdWeek: w, lineKey: fujiRow.key, unitPrice: '18.5', availableQty: '2000' }], [{ etdWeek: w, containersOffered: 1 }]);
    expect((await lineOf(d, 'Apples Fuji RQ')).ledger.byState.QUOTED).toBe('3000.000');
    const again = await recordQuotes(db, proc, cmd(), rfqId, S.chile2, 'USD', [{ etdWeek: w, lineKey: fujiRow.key, unitPrice: '18.1234', availableQty: '3000' }], [{ etdWeek: w, containersOffered: 1 }]);
    expect(again).toEqual({ saved: 1, replaced: 1 });
    await recordQuotes(db, proc, cmd(), rfqId, S.trader, 'EUR', [{ etdWeek: w, lineKey: fujiRow.key, unitPrice: '17.9', availableQty: '1000' }], [{ etdWeek: w, containersOffered: 3 }]);
    await recordQuotes(db, proc, cmd(), rfqId, S.trader, 'EUR', [], [{ etdWeek: w, containersOffered: 4 }]); // containers per week; the latest counts
    expect((await getRfq(db, proc, rfqId)).weekOffers).toContainEqual({ supplierCode: S.trader, week: w, containers: 4 });
    expect((await recordQuotes(db, proc, cmd(), rfqId, S.trader, 'EUR', [], [{ etdWeek: wk(30), containersOffered: 1 }]).catch((e) => e)).code).toBe('BAD_QUOTE');
    r = await getRfq(db, proc, rfqId);
    expect(r.status).toBe('QUOTING');
    expect(r.quotes.map((q) => [q.supplierCode, q.unitPrice, q.currency, q.available]).sort()).toEqual([[S.chile2, '18.1234', 'USD', '3000.000'], [S.trader, '17.90', 'EUR', '1000.000']].sort());
    expect(r.replacedQuotes.map((q) => q.unitPrice)).toEqual(['18.50']);
    expect((await listWork(db, proc, { tab: 'RFQ_TO_QUOTE', q: rfqNo, page: 1, pageSize: 25 })).rows).toHaveLength(1); // Tru-Cape still to quote
    await recordQuotes(db, proc, cmd(), rfqId, S.cape, 'USD', [{ etdWeek: w, lineKey: packRow.key, unitPrice: '21.4', availableQty: '5000' }], [{ etdWeek: w, containersOffered: 1 }]);
    expect((await listWork(db, proc, { tab: 'RFQ_TO_QUOTE', q: rfqNo, page: 1, pageSize: 25 })).rows).toHaveLength(0); // everybody quoted

    const fujiLine = r.lines.find((l) => l.label.includes('Fuji'))!;
    expect((await releaseQty(db, proc, cmd(), fujiLine.rfqLineId, '1000', 'NOPE', '').catch((e) => e)).code).toBe('BAD_REASON');
    await releaseQty(db, proc, cmd(), fujiLine.rfqLineId, '1000', 'QTY_NOT_NEEDED', 'test');
    expect([(await lineOf(d, 'Apples Fuji RQ')).ledger.open, (await lineOf(d, 'Apples Fuji RQ')).ledger.byState.QUOTED]).toEqual(['3000.000', '2000.000']);
    r = await getRfq(db, proc, rfqId);
    expect(r.lines.find((l) => l.label.includes('Fuji'))).toMatchObject({ asked: '3000.000', quoted: '2000.000', released: '1000.000', status: 'QUOTED' });
    expect((await listRfqs(db, proc, { q: rfqNo, page: 1, pageSize: 25 })).rows).toMatchObject([{ rfqNo, status: 'QUOTING', suppliers: 3, quoted: 3 }]);

    await cancelRfq(db, proc, cmd(), rfqId, r.rowVer, 'NO_OFFERS', 'test');
    const fin = await lineOf(d, 'Apples Fuji RQ');
    expect([fin.ledger.open, fin.ledger.byState.IN_RFQ, fin.ledger.byState.QUOTED]).toEqual(['5000.000', '0.000', '0.000']);
    expect((await getRfq(db, proc, rfqId)).status).toBe('CANCELLED');
    expect(await runInvariants()).toEqual([]);
  });

  it('unmerge releases merged quantity that is in an RFQ first (plan §3 rule 8)', async () => {
    const w = wk(5);
    const [target, source] = [await accepted([[w, 2, [fuji]]]), await accepted([[w, 1, [fuji]]])];
    const m = await executeMerge(db, proc, cmd(), { sourceDemandId: source, targetDemandId: target, targetRowVer: (await getDemand(db, proc, target)).rowVer, weeks: 'ALL', comment: '' });
    const line = await lineOf(target, 'Apples Fuji RQ');
    await createRfq(db, proc, cmd(), { demandId: target, weeks: [], lines: [{ lineId: line.lineId, week: w, qty: '3000' }], suppliers: [S.chile] });
    const rec = (await listMerges(db, proc, target)).find((x) => x.mergeNo === m.mergeNo)!;
    expect(rec.unmerge.allowed).toBe(true);
    await unmerge(db, proc, cmd(), rec.mergeId, rec.rowVer, 'test');
    expect((await lineOf(source, 'Apples Fuji RQ')).ledger.open).toBe('1000.000');
    const t = await lineOf(target, 'Apples Fuji RQ');
    expect([t.ledger.byState.IN_RFQ, t.ledger.mergedOut]).toEqual(['2000.000', '1000.000']);
    expect(await runInvariants()).toEqual([]);
  });

  it('Open quantity near its ETD is an exception until it is in an RFQ', async () => {
    const d = await accepted([[wk(1), 1, [fuji]]]);
    const line = await lineOf(d, 'Apples Fuji RQ');
    await refreshAging(db);
    const items = async () => (await sql<{ n: number }>`SELECT COUNT(*) AS n FROM scm.InboxItem WHERE ItemType = 'OPEN_QTY_AGING' AND EntityId = ${line.lineId} AND IsOpen = 1`.execute(db)).rows[0].n;
    expect(Number(await items())).toBe(1);
    await createRfq(db, proc, cmd(), { demandId: d, weeks: [], lines: [{ lineId: line.lineId, week: wk(1), qty: '1000' }], suppliers: [S.chile] });
    expect(Number(await items())).toBe(0);
  });
});
