/** Stage 2 (spec 14) against a real database: raise, pre-check, holds, decide, apply, withdraw, invariants. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideCr, type ItemDecision } from '../../src/modules/cr/crApply.js';
import { getCr } from '../../src/modules/cr/crRead.js';
import { raiseContainerChange, raiseNotSourced, withdrawCr, type ProposedInput } from '../../src/modules/cr/crService.js';
import '../../src/modules/demand/access.js';
import type { DraftInput } from '../../src/modules/demand/content.js';
import { getDemand } from '../../src/modules/demand/demandRead.js';
import { acceptDemand, createDemand, submitDemand } from '../../src/modules/demand/demandService.js';
import { listWork } from '../../src/modules/workflow/inbox.js';
import { isoWeekMonday, isoWeekOf } from '../../src/modules/workflow/isoWeek.js';
import { refreshOrigins } from '../../src/modules/workflow/origins.js';
import { takeQty, transitionSlice } from '../../src/modules/workflow/slices.js';
import { withTx } from '../../src/modules/workflow/tx.js';
import { actor, db, makeUser, runInvariants, uid, onRfq, onAward } from './helpers.js';

const cmd = () => randomUUID();
const wk = (n: number) => isoWeekOf(new Date(isoWeekMonday(isoWeekOf(new Date())).getTime() + n * 7 * 86_400_000));
let sales: ReturnType<typeof actor>;
let proc: ReturnType<typeof actor>;
let both: ReturnType<typeof actor>;

async function material(sub: string, size: string, cls: string) {
  await db.insertInto('md.Material').values({
    MaterialCode: uid('CR'), Description: `${sub} ${size}`, MajorCategoryCode: 'AP', MajorCategory: 'Apples', SubMajorCategory: sub, MaterialGroupCode: '', MaterialGroup: '',
    MaterialType: 'ZTRD', BaseUnit: 'CT', BaseUnitName: 'Carton', Origin: 'Chile', Variety: '', Size: size, Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: cls,
    InSap: true, SapChangedAt: new Date(),
  }).execute();
}

beforeAll(async () => {
  await material('Apples Pink Lady', 'S-100', 'Cat1');
  await material('Apples Pink Lady', 'S-113', 'Cat1');
  await material('Apples Fuji', 'S-100', 'Cat1');
  await refreshOrigins(db);
  const salesPerms = ['demands.open', 'demand.create', 'demand.submit', 'crs.open', 'cr.raise.sales', 'cr.decide.procurement', 'cr.withdraw'];
  const procPerms = ['demands.open', 'demand.accept', 'crs.open', 'cr.raise.procurement', 'cr.decide.sales', 'cr.withdraw'];
  sales = actor({ id: await makeUser(), permissions: new Set(salesPerms), companies: new Set(['1000']) });
  proc = actor({ id: await makeUser(), permissions: new Set(procPerms), companies: new Set(['1000']) });
  both = actor({ id: await makeUser(), permissions: new Set([...salesPerms, ...procPerms]), companies: new Set(['1000']) });
});
afterAll(() => db.destroy());

type Item = DraftInput['weeks'][number]['groups'][number]['items'][number];
const pink = (size: string, share: string): Item => ({ majorCategory: 'Apples', subMajorCategory: 'Apples Pink Lady', size, materialClass: 'Cat1', originCode: 'CL', share });
const fuji = (share: string): Item => ({ majorCategory: 'Apples', subMajorCategory: 'Apples Fuji', size: 'S-100', materialClass: 'Cat1', originCode: 'CL', share });

/** An accepted demand: one week, one group of `count` × 1000 CT at 40 / 60 (S-100 / S-113). */
async function acceptedDemand(count = 3, week = wk(3), raiser = sales) {
  const { demandId } = await createDemand(db, raiser, cmd(), '1000');
  await submitDemand(db, raiser, cmd(), demandId, (await getDemand(db, raiser, demandId)).rowVer,
    { notes: '', weeks: [{ etdWeek: week, groups: [{ name: 'Pink', containerCount: count, capacity: '1000', unit: 'CT', items: [pink('S-100', '40'), pink('S-113', '60')] }] }] });
  await acceptDemand(db, proc.id === raiser.id ? sales : proc, cmd(), demandId, (await getDemand(db, proc, demandId)).rowVer);
  return demandId;
}

/** Today's containers as the editor sends them (each group with its id). */
async function proposal(demandId: string): Promise<ProposedInput> {
  const d = await getDemand(db, sales, demandId);
  return {
    weeks: d.weeks.map((w) => ({
      etdWeek: w.etdWeek,
      groups: w.groups.map((g) => ({
        groupId: g.groupId, name: g.name, containerCount: g.containerCount, capacity: g.capacity.replace(/\.000$/, ''), unit: g.unit,
        items: g.items.map((i) => ({ majorCategory: i.majorCategory, subMajorCategory: i.subMajorCategory, size: i.size, materialClass: i.materialClass, originCode: i.originCode, materialCode: i.materialCode, share: i.share })),
      })),
    })),
  };
}

const raise = (a: typeof sales, demandId: string, p: ProposedInput) => raiseContainerChange(db, a, cmd(), demandId, { ...p, reasonCode: 'CUST_CANCEL', comment: 'test' });
const decideAll = async (a: typeof sales, crId: string, decision: ItemDecision['decision'] = 'APPROVE', extra: Partial<ItemDecision> = {}) => {
  const cr = await getCr(db, a, crId);
  return decideCr(db, a, cmd(), crId, cr.rowVer, cr.items.map((i) => ({ crItemId: i.crItemId, decision, ...extra })), 'ok');
};
const ledger = async (demandId: string) =>
  (await getDemand(db, sales, demandId)).weeks.flatMap((w) => w.lines.map((l) => [w.etdWeek, l.sizeLabel, l.subMajorCategory.replace('Apples ', ''), l.ledger.requested, l.ledger.open, l.ledger.cancelled]));

describe('Sales: change containers', () => {
  it('3 → 2 containers: submitted with holds, decided by Procurement, applied, holds released', async () => {
    const id = await acceptedDemand(3);
    const p = await proposal(id);
    p.weeks[0].groups[0].containerCount = 2;
    const r = await raise(sales, id, p);
    expect([r.status, r.problems]).toEqual(['SUBMITTED', []]);
    let d = await getDemand(db, sales, id);
    expect([d.weeks[0].hold?.crNo, d.weeks[0].lines.every((l) => l.onHold)]).toEqual([r.crNo, true]);
    expect((await listWork(db, proc, { tab: 'CR_TO_DECIDE', q: r.crNo, page: 1, pageSize: 25 })).rows).toHaveLength(1);
    expect((await listWork(db, sales, { tab: 'CR_TO_DECIDE', q: r.crNo, page: 1, pageSize: 25 })).rows).toHaveLength(0);

    expect(await decideAll(proc, r.crId)).toEqual({ status: 'APPROVED', applyStatus: 'APPLIED' });
    d = await getDemand(db, sales, id);
    expect([d.weeks[0].containerCount, d.weeks[0].groups.map((g) => g.containerCount), d.weeks[0].hold, d.weeks[0].lines.some((l) => l.onHold)]).toEqual([2, [2], null, false]);
    // 3 × 1000 at 40/60 → 2 × 1000: S-100 1200 → 800 (400 cancelled), S-113 1800 → 1200 (600 cancelled)
    expect(await ledger(id)).toEqual([[wk(3), 'S-100', 'Pink Lady', '1200.000', '800.000', '400.000'], [wk(3), 'S-113', 'Pink Lady', '1800.000', '1200.000', '600.000']]);
    expect(d.currentVersion).toBe(2);
    expect((await listWork(db, proc, { tab: 'CR_TO_DECIDE', q: r.crNo, page: 1, pageSize: 25 })).rows).toHaveLength(0);
    expect(await runInvariants()).toEqual([]);
  });

  it('a new group of 3 containers, approved as 1: new material line with Open quantity', async () => {
    const id = await acceptedDemand(1);
    const p = await proposal(id);
    p.weeks[0].groups.push({ groupId: null, name: 'Fuji', containerCount: 3, capacity: '1000', unit: 'CT', items: [fuji('100')] });
    const r = await raise(sales, id, p);
    const cr = await getCr(db, proc, r.crId);
    expect(cr.items.map((i) => [i.kind, i.partial])).toEqual([['GROUP_ADD', { type: 'count', min: 1, max: 2 }]]);
    await expect(decideCr(db, proc, cmd(), r.crId, cr.rowVer, [{ crItemId: cr.items[0].crItemId, decision: 'PARTIAL', approvedCount: 3 }], 'x')).rejects.toMatchObject({ code: 'BAD_DECISION' });
    expect(await decideCr(db, proc, cmd(), r.crId, cr.rowVer, [{ crItemId: cr.items[0].crItemId, decision: 'PARTIAL', approvedCount: 1 }], 'one only'))
      .toEqual({ status: 'PARTIALLY_APPROVED', applyStatus: 'APPLIED' });
    const d = await getDemand(db, sales, id);
    expect(d.weeks[0].containerCount).toBe(2);
    expect(d.weeks[0].lines.find((l) => l.subMajorCategory === 'Apples Fuji')?.ledger).toMatchObject({ requested: '1000.000', open: '1000.000' });
    expect(await runInvariants()).toEqual([]);
  });

  it('cancel the whole demand: every group removed, all quantity cancelled, status Cancelled', async () => {
    const id = await acceptedDemand(2);
    const r = await raise(sales, id, { weeks: [{ etdWeek: wk(3), groups: [] }] });
    expect((await getCr(db, sales, r.crId)).crType).toBe('CANCEL_DEMAND');
    await decideAll(proc, r.crId);
    const d = await getDemand(db, sales, id);
    expect([d.status, d.weeks[0].containerCount, d.weeks[0].groups]).toEqual(['CANCELLED', 0, []]);
    expect(await runInvariants()).toEqual([]);
  });
});

describe('pre-check (spec 14 step 4)', () => {
  it('a second request on the same week is Blocked, and nothing is held for it', async () => {
    const id = await acceptedDemand(3);
    const p = await proposal(id);
    p.weeks[0].groups[0].containerCount = 2;
    const first = await raise(sales, id, p);
    const second = await raise(sales, id, p);
    expect(second.status).toBe('BLOCKED');
    expect(second.problems.some((x) => x.includes(`already in ${first.crNo}`))).toBe(true);
    expect(await runInvariants()).toEqual([]);
  });

  it('a composition change is refused while the material is awarded; a reduction beyond cancellable is refused', async () => {
    const id = await acceptedDemand(1);
    const line = (await getDemand(db, sales, id)).weeks[0].lines[0];
    const ctx = { actorUserId: proc.id };
    const [s] = await withTx(db, (tx) => takeQty(tx, { lineId: line.lineId, qty: 100_000, states: ['OPEN'], ctx }));
    for (const t of ['ADD_TO_RFQ', 'QUOTE_RECORDED', 'AWARD'] as const) { const rfq = t === 'ADD_TO_RFQ' ? await onRfq(s) : undefined; await withTx(db, (tx) => transitionSlice(tx, s, t, ctx, rfq)); }
    await onAward(s);

    const p = await proposal(id);
    p.weeks[0].groups[0].items[0].share = '50';
    p.weeks[0].groups[0].items[1].share = '50';
    const comp = await raise(sales, id, p);
    expect([comp.status, comp.problems.some((x) => /un-award it before/.test(x))]).toEqual(['BLOCKED', true]);

    // Everything of S-100 sent to SAP: it can no longer be cancelled.
    const all = await withTx(db, (tx) => takeQty(tx, { lineId: line.lineId, qty: 300_000, states: ['OPEN'], ctx }));
    for (const x of all) for (const t of ['ADD_TO_RFQ', 'QUOTE_RECORDED', 'AWARD'] as const) { const rfq = t === 'ADD_TO_RFQ' ? await onRfq(x) : undefined; await withTx(db, (tx) => transitionSlice(tx, x, t, ctx, rfq)); }
    for (const x of all) await onAward(x);
    for (const x of [s, ...all]) for (const t of ['HANDOFF_SEND', 'HANDOFF_ACCEPT', 'PO_SUBMIT'] as const) await withTx(db, (tx) => transitionSlice(tx, x, t, ctx));
    const cancel = await raise(sales, id, { weeks: [{ etdWeek: wk(3), groups: [] }] });
    expect([cancel.status, cancel.problems.some((x) => /only 0.000 is still cancellable/.test(x))]).toEqual(['BLOCKED', true]);
  });
});

describe('deciding (spec 14 step 7)', () => {
  it('nobody decides their own request, even with both roles; the database refuses it too', async () => {
    const id = await acceptedDemand(2, wk(4), both);
    const p = await proposal(id);
    p.weeks[0].groups[0].containerCount = 1;
    const r = await raise(both, id, p);
    expect((await getCr(db, both, r.crId)).actions).toEqual({ decide: false, withdraw: true });
    expect((await listWork(db, both, { tab: 'CR_TO_DECIDE', q: r.crNo, page: 1, pageSize: 25 })).rows).toHaveLength(0);
    await expect(decideAll(both, r.crId)).rejects.toMatchObject({ code: 'SELF_DECISION' });
    await expect(sql`UPDATE scm.ChangeRequest SET DecidedBy = RaisedBy WHERE CrId = ${r.crId}`.execute(db)).rejects.toThrow(/CK_ChangeRequest_NoSelfDecision/);
  });

  it('every item exactly once; a stale version is refused; withdraw releases the holds', async () => {
    const id = await acceptedDemand(3);
    const p = await proposal(id);
    p.weeks[0].groups[0].containerCount = 2;
    const r = await raise(sales, id, p);
    const cr = await getCr(db, proc, r.crId);
    await expect(decideCr(db, proc, cmd(), r.crId, cr.rowVer, [], 'x')).rejects.toMatchObject({ code: 'BAD_DECISION' });
    await expect(decideCr(db, proc, cmd(), r.crId, '0000000000000000', cr.items.map((i) => ({ crItemId: i.crItemId, decision: 'REJECT' as const })), 'x')).rejects.toMatchObject({ code: 'STALE_WRITE' });
    await expect(withdrawCr(db, proc, cmd(), r.crId, cr.rowVer, 'no')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await withdrawCr(db, sales, cmd(), r.crId, cr.rowVer, 'changed my mind');
    const d = await getDemand(db, sales, id);
    expect([d.weeks[0].hold, d.weeks[0].containerCount]).toEqual([null, 3]);
    expect(await runInvariants()).toEqual([]);
  });

  it('a rejection changes nothing', async () => {
    const id = await acceptedDemand(2);
    const p = await proposal(id);
    p.weeks[0].groups[0].containerCount = 1;
    const r = await raise(sales, id, p);
    expect(await decideAll(proc, r.crId, 'REJECT')).toEqual({ status: 'REJECTED', applyStatus: 'NOT_REQUIRED' });
    expect((await getDemand(db, sales, id)).weeks[0].containerCount).toBe(2);
    expect(await runInvariants()).toEqual([]);
  });

  it('quantity that moved to PO submitted while waiting: applied as far as possible, Partially applied', async () => {
    const id = await acceptedDemand(1);
    const r = await raise(sales, id, { weeks: [{ etdWeek: wk(3), groups: [] }] });
    const line = (await getDemand(db, sales, id)).weeks[0].lines[0]; // S-100: 400 CT
    const ctx = { actorUserId: proc.id };
    const [s] = await withTx(db, (tx) => takeQty(tx, { lineId: line.lineId, qty: 100_000, states: ['OPEN'], ctx }));
    for (const t of ['ADD_TO_RFQ', 'QUOTE_RECORDED'] as const) { const rfq = t === 'ADD_TO_RFQ' ? await onRfq(s) : undefined; await withTx(db, (tx) => transitionSlice(tx, s, t, ctx, rfq)); }
    // (award / PO steps are blocked by the hold; move the slice straight to PO submitted as a later stage would have before the hold)
    await onAward(s);
    await sql`UPDATE scm.QtySlice SET ExecState = 'PO_SUBMITTED' WHERE SliceId = ${s}`.execute(db);
    await sql`INSERT INTO scm.SliceHistory (SliceId, Action, FromState, ToState, Qty) VALUES (${s}, 'TRANSITION', 'QUOTED', 'PO_SUBMITTED', 100000)`.execute(db);
    expect(await decideAll(proc, r.crId)).toEqual({ status: 'APPROVED', applyStatus: 'PARTIALLY_APPLIED' });
    const cr = await getCr(db, sales, r.crId);
    expect(cr.items[0].applyMessage).toMatch(/only 300.000 of 400.000 was still cancellable/);
    expect(await runInvariants()).toEqual([]);
  });
});

describe('Procurement: not sourced', () => {
  it('Open quantity only; Sales approves less; cancelled as not sourced; week count lowered', async () => {
    const id = await acceptedDemand(3);
    const d = await getDemand(db, proc, id);
    const s113 = d.weeks[0].lines.find((l) => l.sizeLabel === 'S-113')!;
    const tooMuch = await raiseNotSourced(db, proc, cmd(), id, { lines: [{ lineId: s113.lineId, qty: '9999' }], weeks: [], reasonCode: 'NO_SUPPLY', comment: 'x' });
    expect(tooMuch.status).toBe('BLOCKED');
    await expect(raiseNotSourced(db, proc, cmd(), id, { lines: [{ lineId: s113.lineId, qty: '1' }], weeks: [], reasonCode: 'CUST_CANCEL', comment: 'x' })).rejects.toMatchObject({ code: 'BAD_REASON' });

    const r = await raiseNotSourced(db, proc, cmd(), id, { lines: [{ lineId: s113.lineId, qty: '600' }], weeks: [{ etdWeek: wk(3), containerCount: 2 }], reasonCode: 'NO_SUPPLY', comment: 'no S-113' });
    expect(r.status).toBe('SUBMITTED');
    expect((await listWork(db, sales, { tab: 'CR_TO_DECIDE', q: r.crNo, page: 1, pageSize: 25 })).rows).toHaveLength(1);
    const cr = await getCr(db, sales, r.crId);
    expect(await decideCr(db, sales, cmd(), r.crId, cr.rowVer, [
      { crItemId: cr.items[0].crItemId, decision: 'PARTIAL', approvedQty: '400' },
      { crItemId: cr.items[1].crItemId, decision: 'APPROVE' },
    ], 'only 400')).toEqual({ status: 'PARTIALLY_APPROVED', applyStatus: 'APPLIED' });
    const after = await getDemand(db, sales, id);
    expect(after.weeks[0].containerCount).toBe(2);
    expect(after.weeks[0].lines.find((l) => l.sizeLabel === 'S-113')?.ledger).toMatchObject({ requested: '1800.000', open: '1400.000', cancelled: '400.000' });
    const origin = await db.selectFrom('scm.QtySlice').select('CancelOrigin').where('LineId', '=', s113.lineId).where('ExecState', '=', 'CANCELLED').executeTakeFirstOrThrow();
    expect(origin.CancelOrigin).toBe('PROCUREMENT');
    expect(await runInvariants()).toEqual([]);
  });
});
