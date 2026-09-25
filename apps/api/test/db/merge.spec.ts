/** Stage 3 (spec 17) against a real database: merge, blockers, lineage, chains, unmerge, invariants. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideCr } from '../../src/modules/cr/crApply.js';
import { getCr } from '../../src/modules/cr/crRead.js';
import { raiseContainerChange, type ProposedInput } from '../../src/modules/cr/crService.js';
import '../../src/modules/demand/access.js';
import type { DraftInput } from '../../src/modules/demand/content.js';
import { getDemand } from '../../src/modules/demand/demandRead.js';
import { acceptDemand, createDemand, submitDemand } from '../../src/modules/demand/demandService.js';
import { listMerges, mergeCandidates, mergePlanView } from '../../src/modules/merge/mergeRead.js';
import { executeMerge, unmerge } from '../../src/modules/merge/mergeService.js';
import { isoWeekMonday, isoWeekOf } from '../../src/modules/workflow/isoWeek.js';
import { refreshOrigins } from '../../src/modules/workflow/origins.js';
import { createSlice, splitSlice } from '../../src/modules/workflow/slices.js';
import { withTx } from '../../src/modules/workflow/tx.js';
import { actor, db, makeUser, runInvariants, uid } from './helpers.js';

const cmd = () => randomUUID();
const wk = (n: number) => isoWeekOf(new Date(isoWeekMonday(isoWeekOf(new Date())).getTime() + n * 7 * 86_400_000));
let sales: ReturnType<typeof actor>;
let proc: ReturnType<typeof actor>;
let wide: ReturnType<typeof actor>, wideProc: ReturnType<typeof actor>;

async function material(sub: string, size: string) {
  await db.insertInto('md.Material').values({
    MaterialCode: uid('MG'), Description: `${sub} ${size}`, MajorCategoryCode: 'AP', MajorCategory: 'Apples', SubMajorCategory: sub, MaterialGroupCode: '', MaterialGroup: '',
    MaterialType: 'ZTRD', BaseUnit: 'CT', BaseUnitName: 'Carton', Origin: 'Chile', Variety: '', Size: size, Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: 'Cat1',
    InSap: true, SapChangedAt: new Date(),
  }).execute();
}

beforeAll(async () => {
  await material('Apples Braeburn', 'S-100');
  await material('Apples Jazz', 'S-100');
  await refreshOrigins(db);
  const salesPerms = ['demands.open', 'demand.create', 'demand.submit', 'crs.open', 'cr.raise.sales', 'cr.decide.procurement'];
  const procPerms = ['demands.open', 'demand.accept', 'demand.merge', 'demand.unmerge', 'crs.open', 'cr.decide.sales'];
  sales = actor({ id: await makeUser(), permissions: new Set(salesPerms), companies: new Set(['1000']) });
  proc = actor({ id: await makeUser(), permissions: new Set(procPerms), companies: new Set(['1000']) });
  wide = actor({ id: await makeUser(), permissions: new Set([...salesPerms, ...procPerms]), companies: new Set(['1000', '2000']) });
  wideProc = actor({ id: await makeUser(), permissions: new Set(procPerms), companies: new Set(['1000', '2000']) }); // someone else accepts (separation of duties)
});
afterAll(() => db.destroy());

type Item = DraftInput['weeks'][number]['groups'][number]['items'][number];
const braeburn: Item = { majorCategory: 'Apples', subMajorCategory: 'Apples Braeburn', size: 'S-100', materialClass: 'Cat1', originCode: 'CL', share: '100' };
const jazz: Item = { ...braeburn, subMajorCategory: 'Apples Jazz' };

/** An accepted demand with one group per week: [week, containers, item]. */
async function accepted(weeks: [string, number, Item][], company = '1000', by = sales) {
  const { demandId } = await createDemand(db, by, cmd(), company);
  await submitDemand(db, by, cmd(), demandId, (await getDemand(db, by, demandId)).rowVer, {
    notes: '', weeks: weeks.map(([etdWeek, count, item]) => ({ etdWeek, groups: [{ name: item.subMajorCategory.replace('Apples ', ''), containerCount: count, capacity: '1000', unit: 'CT', items: [item] }] })),
  });
  const accepter = by === wide ? wideProc : proc;
  await acceptDemand(db, accepter, cmd(), demandId, (await getDemand(db, accepter, demandId)).rowVer);
  return demandId;
}
const merge = async (sourceId: string, targetId: string, weeks: string[] | 'ALL', a = proc) =>
  executeMerge(db, a, cmd(), { sourceDemandId: sourceId, targetDemandId: targetId, targetRowVer: (await getDemand(db, a, targetId)).rowVer, weeks, comment: 'test' });
const undo = async (targetId: string, mergeNo: string, a = proc) => {
  const m = (await listMerges(db, a, targetId)).find((x) => x.mergeNo === mergeNo)!;
  return unmerge(db, a, cmd(), m.mergeId, m.rowVer, 'test');
};
const view = async (id: string) => {
  const d = await getDemand(db, proc, id);
  return d.weeks.map((w) => [w.etdWeek, w.containerCount, w.lines.map((l) => `${l.subMajorCategory.replace('Apples ', '')} ${l.ledger.requested}/${l.ledger.open}/${l.ledger.mergedOut}`).join(', ')]);
};
/** Open quantity of some demands together: merge and unmerge never change it. */
const openTotal = async (ids: string[]) => Number((await sql<{ q: string }>`
  SELECT ISNULL(SUM(s.Qty), 0) AS q FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId
  WHERE l.DemandId IN (${sql.join(ids)}) AND s.ExecState = 'OPEN'`.execute(db)).rows[0].q);
const problemsOf = (e: { details?: { problems?: string[] } }) => e.details?.problems ?? [];

describe('merge (spec 17)', () => {
  it('adds the week to the target: same key summed, groups moved, lineage kept; the source is Merged', async () => {
    const w = wk(4);
    const target = await accepted([[w, 5, braeburn]]);
    const source = await accepted([[w, 2, braeburn], [wk(5), 1, jazz]]);
    const before = await openTotal([source, target]);
    expect((await mergeCandidates(db, proc, target)).map((c) => c.demandId)).toContain(source);
    const plan = await mergePlanView(db, proc, target, source);
    expect(plan.weeks.map((x) => [x.etdWeek, x.containers, x.targetContainers, x.blockers])).toEqual([[w, 2, 5, []], [wk(5), 1, 0, []]]);
    expect(plan.weeks[0].lines).toMatchObject([{ now: '5000.000', adds: '2000.000', after: '7000.000', newLine: false }]);

    const { mergeNo } = await merge(source, target, 'ALL');
    expect(await view(target)).toEqual([[w, 7, 'Braeburn 7000.000/7000.000/0.000'], [wk(5), 1, 'Jazz 1000.000/1000.000/0.000']]);
    expect(await view(source)).toEqual([[w, 0, 'Braeburn 2000.000/0.000/2000.000'], [wk(5), 0, 'Jazz 1000.000/0.000/1000.000']]);
    const src = await getDemand(db, proc, source);
    expect(src.status).toBe('MERGED');
    expect(src.weeks[0].mergedInto).toEqual([{ mergeNo, demandNo: expect.any(String), demandId: target }]);
    const tgt = await getDemand(db, proc, target);
    expect(tgt.weeks[0].groups.map((g) => [g.name, g.containerCount, g.mergedFrom?.mergeNo ?? null])).toEqual([['Braeburn', 5, null], ['Braeburn', 2, mergeNo]]);
    expect(tgt.weeks[0].lines[0].mergedIn[0]).toMatch(new RegExp(`^2,000 CT from ${src.demandNo} via ${mergeNo} \\(origin: Sales, requested \\d{4}-\\d{2}-\\d{2}\\)$`));

    const lineage = (await sql<{ BusinessOrigin: string; OriginDemandId: string; clockSame: number }>`
      SELECT t.BusinessOrigin, t.OriginDemandId, CASE WHEN t.EffectiveSubmittedAt = s.EffectiveSubmittedAt THEN 1 ELSE 0 END AS clockSame
      FROM scm.QtySlice t JOIN scm.QtySlice s ON s.SliceId = t.MergedFromSliceId JOIN scm.DemandLine l ON l.LineId = t.LineId
      WHERE l.DemandId = ${target} AND t.ArrivedVia = 'MERGE'`.execute(db)).rows;
    expect(lineage.map((r) => [r.BusinessOrigin, String(r.OriginDemandId), r.clockSame])).toEqual([['SALES', source, 1], ['SALES', source, 1]]);
    expect((await db.selectFrom('scm.DemandVersion').select('Reason').where('DemandId', 'in', [source, target]).where('SourceRef', '=', mergeNo).execute()).map((v) => v.Reason).sort()).toEqual(['MERGE_IN', 'MERGE_OUT']);
    expect(await openTotal([source, target])).toBe(before);
    expect(await runInvariants()).toEqual([]);
  });

  it('keeps a Procurement-origin quantity Procurement after the merge (KPIs do not shift)', async () => {
    const w = wk(6);
    const target = await accepted([[w, 1, braeburn]]);
    const source = await accepted([[w, 1, braeburn]]);
    const line = (await getDemand(db, proc, source)).weeks[0].lines[0];
    await withTx(db, async (tx) => {
      await sql`UPDATE scm.DemandLine SET RequestedQty = RequestedQty + 500000 WHERE LineId = ${line.lineId}`.execute(tx);
      await createSlice(tx, { lineId: line.lineId, qty: 500000, businessOrigin: 'PROCUREMENT', originDemandId: source, originLineId: line.lineId, approvedWeek: w, clock: new Date() }, { actorUserId: proc.id });
    });
    await merge(source, target, [w]);
    const origins = (await sql<{ BusinessOrigin: string; q: string }>`
      SELECT s.BusinessOrigin, SUM(s.Qty) AS q FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId
      WHERE l.DemandId = ${target} AND s.ExecState = 'OPEN' GROUP BY s.BusinessOrigin ORDER BY s.BusinessOrigin`.execute(db)).rows;
    expect(origins.map((o) => [o.BusinessOrigin, Number(o.q)])).toEqual([['PROCUREMENT', 500000], ['SALES', 2000000]]);
    expect(await runInvariants()).toEqual([]);
  });

  it('blocks: a held target week, a unit clash, another company, Sales, a demand into itself', async () => {
    const w = wk(7);
    const target = await accepted([[w, 2, braeburn]]);
    const source = await accepted([[w, 1, braeburn]]);
    // a change request on the target week holds it
    const d = await getDemand(db, sales, target);
    const p: ProposedInput = { weeks: d.weeks.map((x) => ({ etdWeek: x.etdWeek, groups: x.groups.map((g) => ({ groupId: g.groupId, name: g.name, containerCount: 3, capacity: '1000', unit: 'CT', items: [braeburn] })) })) };
    const cr = await raiseContainerChange(db, sales, cmd(), target, { ...p, reasonCode: 'CUST_CANCEL', comment: 'test' });
    const held = await merge(source, target, [w]).catch((e) => e);
    expect([held.code, problemsOf(held)[0]]).toEqual(['NOT_MERGEABLE', `${w}: The target's ${w} is on hold in ${cr.crNo}`]);
    const c = await getCr(db, proc, cr.crId);
    await decideCr(db, proc, cmd(), cr.crId, c.rowVer, c.items.map((i) => ({ crItemId: i.crItemId, decision: 'REJECT' as const })), 'no');

    // the same key in another unit on the target (kept only for this check)
    const key = d.weeks[0].lines[0].key;
    await sql`UPDATE scm.DemandKeyUom SET Unit = 'KG' WHERE DemandId = ${target} AND LineKey = ${key}`.execute(db);
    const unit = await merge(source, target, [w]).catch((e) => e);
    await sql`UPDATE scm.DemandKeyUom SET Unit = 'CT' WHERE DemandId = ${target} AND LineKey = ${key}`.execute(db);
    expect(problemsOf(unit)[0]).toMatch(/is ordered in KG on the target, not CT/);

    const other = await accepted([[w, 1, braeburn]], '2000', wide);
    expect((await merge(other, target, [w], wide).catch((e) => e)).code).toBe('COMPANY_MISMATCH');
    expect((await merge(source, target, [w], sales).catch((e) => e)).status).toBe(403);
    expect((await merge(target, target, [w]).catch((e) => e)).code).toBe('SAME_DEMAND');
    expect(await runInvariants()).toEqual([]);
  });
});

describe('unmerge (spec 17)', () => {
  it('chains undo in reverse order, split descendants included; totals never change', async () => {
    const w = wk(8);
    const [a, b, c] = [await accepted([[w, 1, braeburn]]), await accepted([[w, 2, braeburn]]), await accepted([[w, 3, braeburn]])];
    const before = await openTotal([a, b, c]);
    const ab = await merge(a, b, [w]);
    const bc = await merge(b, c, [w]);
    expect(await view(c)).toEqual([[w, 6, 'Braeburn 6000.000/6000.000/0.000']]);
    // split quantity that came from B (and A) inside C, as an RFQ would
    const merged = await db.selectFrom('scm.QtySlice').select('SliceId').where('MergedInBy', '=', bc.mergeId).orderBy('SliceId').executeTakeFirstOrThrow();
    await withTx(db, (tx) => splitSlice(tx, String(merged.SliceId), 400000, { actorUserId: proc.id }));

    const blocked = await undo(b, ab.mergeNo).catch((e) => e);
    expect([blocked.code, problemsOf(blocked)]).toEqual(['UNMERGE_BLOCKED', [`Part of it was merged onward in ${bc.mergeNo}: undo ${bc.mergeNo} first`]]);
    expect((await listMerges(db, proc, b)).find((m) => m.mergeNo === ab.mergeNo)!.unmerge.allowed).toBe(false);

    await undo(c, bc.mergeNo);
    expect(await view(c)).toEqual([[w, 3, 'Braeburn 6000.000/3000.000/3000.000']]);
    expect(await view(b)).toEqual([[w, 3, 'Braeburn 3000.000/3000.000/0.000']]);
    await undo(b, ab.mergeNo);
    expect(await view(a)).toEqual([[w, 1, 'Braeburn 1000.000/1000.000/0.000']]);
    expect(await view(b)).toEqual([[w, 2, 'Braeburn 3000.000/2000.000/1000.000']]);
    expect((await getDemand(db, proc, b)).weeks[0].groups.map((g) => [g.name, g.containerCount, g.mergedFrom])).toEqual([['Braeburn', 2, null]]);
    expect(await openTotal([a, b, c])).toBe(before);
    expect((await undo(b, ab.mergeNo).catch((e) => e)).code).toBe('BAD_STATE');
    expect(await runInvariants()).toEqual([]);
  });

  it('is blocked once a change request changed the merged-in group', async () => {
    const w = wk(9);
    const target = await accepted([[w, 2, braeburn]]);
    const source = await accepted([[w, 2, jazz]]);
    const m = await merge(source, target, [w]);
    const d = await getDemand(db, sales, target);
    const p: ProposedInput = {
      weeks: d.weeks.map((x) => ({ etdWeek: x.etdWeek, groups: x.groups.map((g) => ({
        groupId: g.groupId, name: g.name, containerCount: g.mergedFrom ? 1 : g.containerCount, capacity: '1000', unit: 'CT',
        items: g.items.map((i) => ({ majorCategory: i.majorCategory, subMajorCategory: i.subMajorCategory, size: i.size, materialClass: i.materialClass, originCode: i.originCode, materialCode: i.materialCode, share: i.share })),
      })) })),
    };
    const cr = await raiseContainerChange(db, sales, cmd(), target, { ...p, reasonCode: 'CUST_CANCEL', comment: 'one Jazz less' });
    const pending = await undo(target, m.mergeNo).catch((e) => e);
    expect(problemsOf(pending)).toContain(`${w} is on hold in ${cr.crNo}`);
    const c = await getCr(db, proc, cr.crId);
    await decideCr(db, proc, cmd(), cr.crId, c.rowVer, c.items.map((i) => ({ crItemId: i.crItemId, decision: 'APPROVE' as const })), 'ok');
    const blocked = await undo(target, m.mergeNo).catch((e) => e);
    expect(problemsOf(blocked)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Apples Jazz S-100 Cat1 CL: 1,000 CT is cancelled; only Open quantity or quantity still in an RFQ can be moved back$/),
      `Group Jazz in ${w} was changed by a change request since the merge`,
    ]));
    expect(await runInvariants()).toEqual([]);
  });
});
