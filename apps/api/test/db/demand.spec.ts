/** Stage 1 (specs 12, 13) against a real database: containers and composition, demand flow, rules, access, ledger, invariants. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DraftInput } from '../../src/modules/demand/content.js';
import { demandHistory, getDemand, listDemands } from '../../src/modules/demand/demandRead.js';
import { acceptDemand, addComment, createDemand, recallDemand, returnDemand, saveDraft, submitDemand } from '../../src/modules/demand/demandService.js';
import '../../src/modules/demand/access.js';
import { composeOptions } from '../../src/modules/demand/lookups.js';
import { diffSnapshots, listVersions } from '../../src/modules/demand/versions.js';
import { assertEntityAccess } from '../../src/modules/workflow/entityAccess.js';
import { listWork } from '../../src/modules/workflow/inbox.js';
import { isoWeekMonday, isoWeekOf } from '../../src/modules/workflow/isoWeek.js';
import { parseQty } from '../../src/modules/workflow/qty.js';
import { refreshOrigins } from '../../src/modules/workflow/origins.js';
import { splitSlice, takeQty, transitionSlice } from '../../src/modules/workflow/slices.js';
import { withTx } from '../../src/modules/workflow/tx.js';
import { runSliceBatch, takeTransitionSql } from '../../src/modules/workflow/sliceBatch.js';
import { actor, count, db, makeUser, runInvariants, uid, onRfq, onAward } from './helpers.js';

const cmd = () => randomUUID();
let sales: ReturnType<typeof actor>;
let proc: ReturnType<typeof actor>;
let uae: ReturnType<typeof actor>;
const SKU = uid('MSKU');

/** The ISO week `n` weeks from now (0 = this week). */
const wk = (n: number) => isoWeekOf(new Date(isoWeekMonday(isoWeekOf(new Date())).getTime() + n * 7 * 86_400_000));

async function material(code: string, sub: string, size: string, cls: string, origin: string, unit = 'CT') {
  await db.insertInto('md.Material').values({
    MaterialCode: code, Description: `${sub} ${size} ${cls} ${origin}`, MajorCategoryCode: 'AP', MajorCategory: 'Apples', SubMajorCategory: sub,
    MaterialGroupCode: '', MaterialGroup: '', MaterialType: 'ZTRD', BaseUnit: unit, BaseUnitName: unit, Origin: origin, Variety: '', Size: size,
    Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: cls, InSap: true, SapChangedAt: new Date(),
  }).execute();
}

beforeAll(async () => {
  for (const size of ['S-100', 'S-113']) for (const cls of ['Cat1', 'Extra Fancy']) await material(uid('M'), 'Apples Royal Gala', size, cls, 'Chile');
  await material(uid('M'), 'Apples Royal Gala', 'S-100', 'Cat1', 'Chile', 'KGM');
  await material(uid('M'), 'Apples Granny Smith', 'S-113', 'Cat1', 'Chile');
  await material(SKU, 'Apples Granny Smith', 'S-113', 'Cat1', 'France');
  await refreshOrigins(db);
  const s = await makeUser();
  const p = await makeUser();
  sales = actor({ id: s, permissions: new Set(['demands.open', 'demand.create', 'demand.submit', 'demand.comment', 'demand.attach']), companies: new Set(['1000']) });
  proc = actor({ id: p, permissions: new Set(['demands.open', 'demand.accept', 'demand.return', 'demand.comment']), companies: new Set(['1000']) });
  uae = actor({ id: p, permissions: new Set(['demands.open', 'demand.create', 'demand.accept']), companies: new Set(['2000']) });
});
afterAll(() => db.destroy());

type Item = DraftInput['weeks'][number]['groups'][number]['items'][number];
const gala = (size: string, cls: string, share: string): Item => ({ majorCategory: 'Apples', subMajorCategory: 'Apples Royal Gala', size, materialClass: cls, originCode: 'CL', share });
const granny = (share: string): Item => ({ majorCategory: 'Apples', subMajorCategory: 'Apples Granny Smith', size: 'S-113', materialClass: 'Cat1', originCode: 'CL', share });
const group = (containerCount: number, capacity: string, items: Item[], unit = 'CT', name = '') => ({ name, containerCount, capacity, unit, items });
const content = (weeks: DraftInput['weeks'], notes = ''): DraftInput => ({ notes, weeks });
const rowVer = async (id: string, a = sales) => (await getDemand(db, a, id)).rowVer;
const newDemand = async () => (await createDemand(db, sales, cmd(), '1000')).demandId;
const lines = async (id: string) =>
  (await getDemand(db, sales, id)).weeks.map((w) => [w.etdWeek, w.containerCount, w.lines.map((l) => [l.sizeLabel, l.classLabel, l.ledger.requested])]);

describe('containers and composition (spec 12)', () => {
  it('3 sizes x classes compose; each group gives containers x capacity; the same key in two groups is one line', async () => {
    const id = await newDemand();
    const w = wk(2);
    await saveDraft(db, sales, cmd(), id, await rowVer(id), content([{
      etdWeek: w,
      groups: [
        group(2, '1540', [gala('S-100', 'Cat1', '40'), gala('S-100', 'Extra Fancy', '30'), gala('S-113', 'Cat1', '20'), gala('S-113', 'Extra Fancy', '10')]),
        group(1, '1540', [gala('S-100', 'Cat1', '50'), granny('50')]),
      ],
    }]));
    // Group 1: 3,080 CT → 1,232 / 924 / 616 / 308. Group 2: 1,540 → 770 / 770. S-100 Cat1 appears in both: 1,232 + 770 = 2,002.
    expect(await lines(id)).toEqual([[w, 3, [
      ['S-100', 'Cat1', '2002.000'], ['S-100', 'Extra Fancy', '924.000'], ['S-113', 'Cat1', '616.000'], ['S-113', 'Extra Fancy', '308.000'], ['S-113', 'Cat1', '770.000'],
    ]]]);
    const g = (await getDemand(db, sales, id)).weeks[0].groups;
    expect(g.map((x) => [x.containerCount, x.capacity, x.unit, x.totalShare, x.items.map((i) => [i.share, i.groupQty])])).toEqual([
      [2, '1540.000', 'CT', '100', [['40', '1232.000'], ['30', '924.000'], ['20', '616.000'], ['10', '308.000']]],
      [1, '1540.000', 'CT', '100', [['50', '770.000'], ['50', '770.000']]],
    ]);
    expect(await runInvariants()).toEqual([]);
  });

  it('offers every size x class combination with its SKUs, marking missing ones', async () => {
    const combos = await composeOptions(db, { majorCategory: 'Apples', subMajorCategory: 'Apples Royal Gala', sizes: ['S-100', 'S-113', 'S-125'], classes: ['Cat1', 'Extra Fancy'], originCode: 'CL', unit: 'CT' });
    expect(combos).toHaveLength(6);
    expect(combos.filter((c) => c.available).map((c) => `${c.size}/${c.materialClass}`)).toEqual(['S-100/Cat1', 'S-100/Extra Fancy', 'S-113/Cat1', 'S-113/Extra Fancy']);
    expect(combos.every((c) => c.available === c.skus.length > 0)).toBe(true);
  });

  it('an incomplete group can be saved but not submitted; shares must total 100%', async () => {
    const id = await newDemand();
    const half = content([{ etdWeek: wk(3), groups: [group(1, '1540', [gala('S-100', 'Cat1', '60')])] }]);
    await saveDraft(db, sales, cmd(), id, await rowVer(id), half);
    expect((await getDemand(db, sales, id)).weeks[0].lines).toEqual([]); // nothing until the group is complete
    const err = await submitDemand(db, sales, cmd(), id, await rowVer(id), half).catch((e) => e);
    expect(err.details.problems).toEqual([`${wk(3)} group 1: shares total 60%, they must total 100%.`]);
    expect(await runInvariants()).toEqual([]);
  });

  it('shares can never exceed 100%, not even in a draft', async () => {
    const id = await newDemand();
    const err = await saveDraft(db, sales, cmd(), id, await rowVer(id), content([{ etdWeek: wk(3), groups: [group(1, '1540', [gala('S-100', 'Cat1', '70'), gala('S-100', 'Extra Fancy', '40')])] }])).catch((e) => e);
    expect(err.details.problems).toEqual([`${wk(3)} group 1: shares total 110%, more than 100%.`]);
  });

  it('identical containers are one group: the counts are added, never repeated sections', async () => {
    const id = await newDemand();
    const make = () => [gala('S-100', 'Cat1', '40'), gala('S-100', 'Extra Fancy', '60')];
    await saveDraft(db, sales, cmd(), id, await rowVer(id), content([{ etdWeek: wk(4), groups: [group(1, '1540', make(), 'CT', 'Mixed Gala'), group(2, '1540', make()), group(1, '1500', make())] }]));
    const w = (await getDemand(db, sales, id)).weeks[0];
    expect(w.groups.map((g) => [g.name, g.containerCount, g.capacity])).toEqual([['Mixed Gala', 3, '1540.000'], ['', 1, '1500.000']]);
    expect(w.containerCount).toBe(4);
    expect(w.lines.map((l) => l.ledger.requested)).toEqual(['2448.000', '3672.000']); // (3×1540 + 1500) × 40% / 60%
    expect(await runInvariants()).toEqual([]);
  });

  it('refuses past weeks, a unit mix for one key, an SKU that does not match, a capacity off the increment', async () => {
    const id = await newDemand();
    const err = await saveDraft(db, sales, cmd(), id, await rowVer(id), content([
      { etdWeek: wk(-1), groups: [] },
      { etdWeek: wk(4), groups: [group(1, '100', [gala('S-100', 'Cat1', '100')], 'KGM'), group(1, '1540', [gala('S-100', 'Cat1', '100')])] },
      { etdWeek: wk(5), groups: [group(1, '1540', [{ ...granny('100'), materialCode: SKU }])] },
      { etdWeek: wk(6), groups: [group(1, '1540.5', [granny('100')])] },
    ])).catch((e) => e);
    expect(err.code).toBe('INVALID_DRAFT');
    const p: string[] = err.details.problems;
    expect(p.some((x) => /is in the past/.test(x))).toBe(true);
    expect(p.some((x) => /one unit per material per demand/.test(x))).toBe(true);
    expect(p.some((x) => new RegExp(`material ${SKU} does not match`).test(x))).toBe(true); // FR material on a CL line
    expect(p.some((x) => /capacity must be a whole number of CT/.test(x))).toBe(true);
  });

  it('an SKU that matches its combination is kept; the same spec with an SKU is its own line', async () => {
    const id = await newDemand();
    const fr = { majorCategory: 'Apples', subMajorCategory: 'Apples Granny Smith', size: 'S-113', materialClass: 'Cat1', originCode: 'FR', share: '50', materialCode: SKU };
    await saveDraft(db, sales, cmd(), id, await rowVer(id), content([{ etdWeek: wk(2), groups: [group(1, '1000', [granny('50'), fr])] }]));
    const ls = (await getDemand(db, sales, id)).weeks[0].lines;
    expect(ls.map((l) => [l.specMode, l.originCode, l.materialCode, l.ledger.requested])).toEqual([['SPEC', 'CL', null, '500.000'], ['SKU', 'FR', SKU, '500.000']]);
  });
});

describe('the demand flow (spec 12)', () => {
  it('draft → submit (v1 baseline) → return → resubmit (v2) → accept (one Open slice per line)', async () => {
    const id = await newDemand();
    const w = wk(2);
    const v1 = content([{ etdWeek: w, groups: [group(2, '1500', [gala('S-100', 'Cat1', '100')])] }]);
    expect(await submitDemand(db, sales, cmd(), id, await rowVer(id), v1)).toEqual({ version: 1 });
    let d = await getDemand(db, proc, id);
    expect([d.workflowStatus, d.baselineVersion, d.actions.accept, d.actions.return, d.actions.edit]).toEqual(['SUBMITTED', 1, true, true, false]);
    expect((await listWork(db, proc, { tab: 'DEMAND_TO_ACCEPT', q: d.demandNo, page: 1, pageSize: 25 })).rows.map((r) => r.action.link)).toEqual([`/demands/${id}`]);

    await returnDemand(db, proc, cmd(), id, d.rowVer, 'Need 3 containers');
    expect((await listWork(db, sales, { tab: 'DEMAND_RETURNED', q: d.demandNo, page: 1, pageSize: 25 })).rows[0].note).toBe('Need 3 containers');

    const v2 = content([{ etdWeek: w, groups: [group(3, '1500', [gala('S-100', 'Cat1', '100')])] }]);
    expect(await submitDemand(db, sales, cmd(), id, await rowVer(id), v2)).toEqual({ version: 2 });
    const versions = await listVersions(db, id);
    expect(diffSnapshots(versions[0].snapshot, versions[1].snapshot)).toEqual([
      { what: `${w} containers`, before: '2', after: '3' },
      { what: `${w} · Apples Royal Gala · S-100 · Cat1 · CL`, before: '3000.000 CT', after: '4500.000 CT' },
    ]);
    expect(versions[1].snapshot.groups?.[0]).toMatchObject({ containerCount: 3, capacity: '1500.000', unit: 'CT', items: [{ share: '100', qty: '4500.000' }] });
    await expect(sql`UPDATE scm.DemandVersion SET Reason = 'x' WHERE DemandId = ${id}`.execute(db)).rejects.toThrow(/cannot be changed/);

    d = await getDemand(db, proc, id);
    await acceptDemand(db, proc, cmd(), id, d.rowVer);
    d = await getDemand(db, sales, id);
    expect([d.workflowStatus, d.status]).toEqual(['ACCEPTED', 'NOT_STARTED']);
    expect(d.weeks[0].lines.map((l) => [l.ledger.requested, l.ledger.open])).toEqual([['4500.000', '4500.000']]);
    expect(d.weeks[0].groups).toHaveLength(1); // the composition stays visible after acceptance
    expect((await demandHistory(db, id)).some((h) => h.kind === 'quantity' && /4500.000 CT created OPEN/.test(h.text))).toBe(true);
    expect(await runInvariants()).toEqual([]);
  });

  it('Sales takes a submitted demand back, changes it and submits it again (v2); not after acceptance', async () => {
    const id = await newDemand();
    const w = wk(3);
    await submitDemand(db, sales, cmd(), id, await rowVer(id), content([{ etdWeek: w, groups: [group(2, '1500', [gala('S-100', 'Cat1', '100')])] }]));
    let d = await getDemand(db, sales, id);
    expect([d.actions.recall, d.actions.edit]).toEqual([true, false]);
    expect((await getDemand(db, proc, id)).actions.recall).toBe(false); // Procurement returns instead

    await recallDemand(db, sales, cmd(), id, d.rowVer, 'Customer wants 3');
    d = await getDemand(db, sales, id);
    expect([d.workflowStatus, d.actions.edit, d.actions.recall]).toEqual(['DRAFT', true, false]);
    expect((await listWork(db, proc, { tab: 'DEMAND_TO_ACCEPT', q: d.demandNo, page: 1, pageSize: 25 })).rows).toHaveLength(0);
    expect((await demandHistory(db, id)).some((h) => h.kind === 'event' && h.text === 'DEMAND_RECALLED')).toBe(true);

    expect(await submitDemand(db, sales, cmd(), id, await rowVer(id), content([{ etdWeek: w, groups: [group(3, '1500', [gala('S-100', 'Cat1', '100')])] }]))).toEqual({ version: 2 });
    expect((await listWork(db, proc, { tab: 'DEMAND_TO_ACCEPT', q: d.demandNo, page: 1, pageSize: 25 })).rows[0].note).toBe('Resubmitted (version 2)');

    await acceptDemand(db, proc, cmd(), id, await rowVer(id, proc));
    const err = await recallDemand(db, sales, cmd(), id, await rowVer(id), '').catch((e) => e);
    expect(err.code).toBe('BAD_STATE');
    expect(await runInvariants()).toEqual([]);
  });
});

describe('access and concurrency', () => {
  it('other companies see nothing; permissions per action; stale versions and repeated commands are safe', async () => {
    const id = await newDemand();
    await expect(getDemand(db, uae, id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(saveDraft(db, proc, cmd(), id, await rowVer(id), content([]))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createDemand(db, sales, cmd(), '2000')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const v = await rowVer(id);
    await saveDraft(db, sales, cmd(), id, v, content([], 'first'));
    await expect(saveDraft(db, sales, cmd(), id, v, content([], 'second'))).rejects.toMatchObject({ code: 'STALE_WRITE', status: 409 });

    const good = content([{ etdWeek: wk(8), groups: [group(1, '100', [granny('100')])] }]);
    const commandId = cmd();
    const again = await rowVer(id);
    const [a, b] = [await submitDemand(db, sales, commandId, id, again, good), await submitDemand(db, sales, commandId, id, again, good)];
    expect(a).toEqual(b);
    expect(await count('scm.DemandVersion', sql`DemandId = ${id}`)).toBe(1);

    const mine = await listDemands(db, sales, { mine: true, q: (await getDemand(db, sales, id)).demandNo, page: 1, pageSize: 25 });
    expect(mine.rows.map((r) => [r.status, r.containers, r.lines, r.requested])).toEqual([['SUBMITTED', 1, 1, '100 CT']]);

    await addComment(db, proc, cmd(), id, 'Looks fine');
    await expect(assertEntityAccess(db, sales, 'DEMAND', id, true)).resolves.toEqual({ companyCode: '1000' });
    await expect(assertEntityAccess(db, proc, 'DEMAND', id, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

async function acceptedLine(capacity: string) {
  const id = await newDemand();
  await submitDemand(db, sales, cmd(), id, await rowVer(id), content([{ etdWeek: wk(10), groups: [group(1, capacity, [gala('S-113', 'Cat1', '100')])] }]));
  await acceptDemand(db, proc, cmd(), id, await rowVer(id, proc));
  const line = await db.selectFrom('scm.DemandLine').select('LineId').where('DemandId', '=', id).executeTakeFirstOrThrow();
  return { demandId: id, lineId: String(line.LineId) };
}

describe('slices keep the ledger exact (plan v5 §1.7)', () => {
  it('take: exact fit, split, insufficient; 300 random splits keep the total', async () => {
    const { lineId } = await acceptedLine('5000');
    const ctx = { actorUserId: proc.id };
    const [a] = await withTx(db, (tx) => takeQty(tx, { lineId, qty: parseQty('3000'), states: ['OPEN'], ctx }));
    { const rfq = await onRfq(a); await withTx(db, (tx) => transitionSlice(tx, a, 'ADD_TO_RFQ', ctx, rfq)); }
    await expect(withTx(db, (tx) => takeQty(tx, { lineId, qty: parseQty('2000.001'), states: ['OPEN'], ctx }))).rejects.toMatchObject({ code: 'INSUFFICIENT_QTY' });
    let seed = 7;
    const rnd = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
    await withTx(db, async (tx) => {
      for (let i = 0; i < 300; i++) {
        const slices = await tx.selectFrom('scm.QtySlice').select(['SliceId', 'Qty']).where('LineId', '=', lineId).execute();
        const s = slices[Math.floor(rnd() * slices.length)];
        const q = Number(s.Qty);
        if (q > 1) await splitSlice(tx, String(s.SliceId), 1 + Math.floor(rnd() * (q - 1)), { actorUserId: null });
      }
    });
    const total = await db.selectFrom('scm.QtySlice').select((eb) => eb.fn.sum<string>('Qty').as('t')).where('LineId', '=', lineId).executeTakeFirstOrThrow();
    expect(Number(total.t)).toBe(5_000_000);
    expect(await runInvariants()).toEqual([]);
  });
});

describe('set-based slice moves (sliceBatch) keep the same rules as takeQty + transitionSlice', () => {
  it('splits, moves several in one batch, fits exactly, refuses a shortfall; history and invariants hold', async () => {
    const { lineId } = await acceptedLine('5000');
    const ctx = { actorUserId: proc.id };
    const [first] = (await db.selectFrom('scm.QtySlice').select('SliceId').where('LineId', '=', lineId).execute()).map((x) => String(x.SliceId));
    const rfq = await onRfq(first);
    // two moves in ONE round trip: 1,200 then 800 of the 5,000 Open go to the RFQ (each splits the Open slice)
    await withTx(db, (tx) => runSliceBatch(tx, [
      takeTransitionSql(0, { lineId, qty: parseQty('1200'), states: ['OPEN'], trigger: 'ADD_TO_RFQ', ctx, extraSet: rfq }),
      takeTransitionSql(1, { lineId, qty: parseQty('800'), states: ['OPEN'], trigger: 'ADD_TO_RFQ', ctx, extraSet: rfq }),
    ]));
    const state = async () => (await db.selectFrom('scm.QtySlice').select(['ExecState', 'Qty']).where('LineId', '=', lineId).orderBy('SliceId').execute()).map((x) => [x.ExecState, Number(x.Qty)]);
    expect(await state()).toEqual([['OPEN', 3_000_000], ['IN_RFQ', 1_200_000], ['IN_RFQ', 800_000]]);
    // exact fit: both In-RFQ slices, no split
    await withTx(db, (tx) => runSliceBatch(tx, [takeTransitionSql(0, { lineId, qty: parseQty('2000'), states: ['IN_RFQ'], trigger: 'QUOTE_RECORDED', ctx })]));
    expect(await state()).toEqual([['OPEN', 3_000_000], ['QUOTED', 1_200_000], ['QUOTED', 800_000]]);
    // shortfall: the usual error, nothing changed
    await expect(withTx(db, (tx) => runSliceBatch(tx, [takeTransitionSql(0, { lineId, qty: parseQty('3000.001'), states: ['OPEN'], trigger: 'ADD_TO_RFQ', ctx, extraSet: rfq })])))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_QTY', details: { available: '3000.000' } });
    expect(() => takeTransitionSql(0, { lineId, qty: 1000, states: ['OPEN'], trigger: 'AWARD', ctx })).toThrow(/Cannot AWARD from OPEN/);
    const hist = await db.selectFrom('scm.SliceHistory as h').innerJoin('scm.QtySlice as s', 's.SliceId', 'h.SliceId').select(['h.Action', 'h.TriggerName'])
      .where('s.LineId', '=', lineId).where('h.Action', '!=', 'CREATE').execute();
    expect(hist.map((h) => `${h.Action}:${h.TriggerName ?? ''}`).sort()).toEqual(['SPLIT:', 'SPLIT:', 'SPLIT:', 'SPLIT:', 'TRANSITION:ADD_TO_RFQ', 'TRANSITION:ADD_TO_RFQ', 'TRANSITION:QUOTE_RECORDED', 'TRANSITION:QUOTE_RECORDED']);
    expect(await runInvariants()).toEqual([]);
  });
});

describe('status: the SQL view agrees with deriveStatus', () => {
  it('at every step from Not started to Closed partially executed', async () => {
    const { demandId, lineId } = await acceptedLine('10');
    const ctx = { actorUserId: proc.id };
    const check = async (expected: string) => {
      const view = await db.selectFrom('scm.vDemandStatus').select('Status').where('DemandId', '=', demandId).executeTakeFirstOrThrow();
      expect([(await getDemand(db, sales, demandId)).status, view.Status]).toEqual([expected, expected]);
    };
    await check('NOT_STARTED');
    const [four] = await withTx(db, (tx) => takeQty(tx, { lineId, qty: 4000, states: ['OPEN'], ctx }));
    { const rfq = await onRfq(four); await withTx(db, (tx) => transitionSlice(tx, four, 'ADD_TO_RFQ', ctx, rfq)); }
    await check('PARTIALLY_IN_EXECUTION');
    const [six] = await withTx(db, (tx) => takeQty(tx, { lineId, qty: 6000, states: ['OPEN'], ctx }));
    await withTx(db, (tx) => transitionSlice(tx, six, 'CR_CANCEL', ctx));
    await check('FULLY_IN_EXECUTION');
    await onAward(four);
    for (const t of ['QUOTE_RECORDED', 'AWARD', 'HANDOFF_SEND', 'HANDOFF_ACCEPT', 'PO_SUBMIT', 'SAP_CONFIRMED'] as const) await withTx(db, (tx) => transitionSlice(tx, four, t, ctx));
    await check('CLOSED_PARTIALLY_EXECUTED');
    expect(await runInvariants()).toEqual([]);
  });
});
