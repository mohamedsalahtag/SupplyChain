/** Stage 7 (spec 23) against a real database: SKU selection, one PO per handoff, validation, SAP outbox fault injection, manual resolution. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBatch } from '../../src/modules/award/awardRead.js';
import { updateShipment } from '../../src/modules/award/awardService.js';
import { awardContainers } from '../../src/modules/award/containerAward.js';
import { containerGrid } from '../../src/modules/award/containerGrid.js';
import '../../src/modules/demand/access.js';
import { getDemand } from '../../src/modules/demand/demandRead.js';
import { acceptDemand, createDemand, submitDemand } from '../../src/modules/demand/demandService.js';
import { getHandoff } from '../../src/modules/handoff/handoffRead.js';
import { acceptHandoff, returnHandoff, saveTerms, sendHandoff } from '../../src/modules/handoff/handoffService.js';
import { runOutbox } from '../../src/modules/po/outbox.js';
import { getDraft, preparation, skuCandidates } from '../../src/modules/po/poRead.js';
import { buildDraft, resolveUnknown, selectSkus, submitDraft, validateDraft } from '../../src/modules/po/poService.js';
import { stubSapAdapter } from '../../src/modules/po/sapAdapter.js';
import { crRegister, demandReport, executionSummary, performance } from '../../src/modules/reports/reports.js';
import { recordQuotes } from '../../src/modules/rfq/quotes.js';
import { getRfq } from '../../src/modules/rfq/rfqRead.js';
import { createRfq, sendRfq } from '../../src/modules/rfq/rfqService.js';
import { listWork } from '../../src/modules/workflow/inbox.js';
import { isoWeekMonday, isoWeekOf } from '../../src/modules/workflow/isoWeek.js';
import { refreshOrigins } from '../../src/modules/workflow/origins.js';
import { ALL_PERMISSION_KEYS } from '@supplychain/shared';
import { loadConfig } from '../../src/config.js';
import { appRouter } from '../../src/trpc/router.js';
import { createCallerFactory, type Context } from '../../src/trpc/trpc.js';
import { actor, db, makeUser, runInvariants, uid } from './helpers.js';

const cmd = () => randomUUID();
const wk = (n: number) => isoWeekOf(new Date(isoWeekMonday(isoWeekOf(new Date())).getTime() + n * 7 * 86_400_000));
let sales: ReturnType<typeof actor>;
let proc: ReturnType<typeof actor>;
let po: ReturnType<typeof actor>;
const [A, B] = [uid('POa'), uid('POb')];
const SUB = 'Apples Gala PO';
const [M1, M2] = [uid('PM'), uid('PM')];
const adapter = stubSapAdapter(db);
const problemsOf = (e: { details?: { problems?: string[] } }) => e.details?.problems ?? [];
const sliceStates = async (handoffId: string) => (await sql<{ ExecState: string; n: string }>`SELECT ExecState, SUM(Qty) AS n FROM scm.QtySlice WHERE HandoffId = ${handoffId} GROUP BY ExecState`.execute(db)).rows.map((r) => [r.ExecState, Number(r.n)]);
const due = () => sql`UPDATE scm.SapSubmission SET NextActionAt = DATEADD(minute, -1, SYSUTCDATETIME()) WHERE Status IN ('UNKNOWN', 'PENDING')`.execute(db);
const run = () => runOutbox(db, adapter, 'test-worker');
const draft = (id: string) => getDraft(db, po, id);
const stubPos = async (ref: string) => Number((await sql<{ n: number }>`SELECT COUNT(*) AS n FROM scm.StubSapPo WHERE Reference = ${ref}`.execute(db)).rows[0].n);

beforeAll(async () => {
  for (const code of [M1, M2]) {
    await db.insertInto('md.Material').values({
      MaterialCode: code, Description: `${SUB} S-100 ${code}`, MajorCategoryCode: 'AP', MajorCategory: 'Apples', SubMajorCategory: SUB, MaterialGroupCode: '', MaterialGroup: '',
      MaterialType: 'ZTRD', BaseUnit: 'CT', BaseUnitName: 'Carton', Origin: 'Chile', Variety: '', Size: 'S-100', Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: 'Cat1',
      InSap: true, SapChangedAt: new Date(),
    }).execute();
  }
  await refreshOrigins(db);
  await db.updateTable('scm.Company').set({ PurchasingOrg: '1000', PurchasingGroup: '100' }).where('CompanyCode', '=', '1000').execute(); // the seeded plant HO01 stays (foundation.spec checks it)
  await sql`IF NOT EXISTS (SELECT 1 FROM scm.PaymentTerm WHERE Code = 'N030') INSERT INTO scm.PaymentTerm (Code, Description) VALUES ('N030', '30 days net')`.execute(db);
  for (const src of ['sap.materials', 'sap.suppliers', 'sap.purchaseOrders']) { // master data is fresh
    await sql`INSERT INTO integ.SyncRun (Source, Status, StartedBy, FinishedAt) VALUES (${src}, 'Succeeded', 'test', SYSUTCDATETIME())`.execute(db);
  }
  for (const s of [A, B]) {
    await db.insertInto('md.Supplier').values({
      SupplierCode: s, Name: s, SupplierGroup: 'ZIMP', Country: 'CL', Currency: 'USD', Street: '', HouseNumber: '', City: '', PostalCode: '', Region: '', Email: '',
      InSap: true, SapChangedAt: new Date(), PurchasingIsBlocked: false, PostingIsBlocked: false,
    }).execute();
    await db.insertInto('md.SupplierPurchasingOrg').values({ SupplierCode: s, PurchasingOrg: '1000', IsBlocked: false, PaymentTerms: 'N030' }).execute();
    await db.insertInto('scm.SupplierOrigin').values({ SupplierCode: s, OriginCode: 'CL', Source: 'COUNTRY', AddedBy: null }).execute();
  }
  sales = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.create', 'demand.submit', 'awards.open']), companies: new Set(['1000']) });
  proc = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.accept', 'rfqs.open', 'rfq.manage', 'awards.open', 'award.manage', 'handoffs.open', 'handoff.send']), companies: new Set(['1000']) });
  po = actor({ id: await makeUser(), permissions: new Set(['awards.open', 'handoffs.open', 'handoff.accept', 'handoff.return', 'po.open', 'po.manage']), companies: new Set(['1000']) });
});
afterAll(() => db.destroy());

/** Week w: "Gala" `boxes` × 1,000 CT awarded to the given suppliers, handed off (without the acknowledgement) and accepted. */
async function accepted(w: string, split: [string, number][]) {
  const boxes = split.reduce((a, [, n]) => a + n, 0);
  const { demandId } = await createDemand(db, sales, cmd(), '1000');
  const item = { majorCategory: 'Apples', subMajorCategory: SUB, size: 'S-100', materialClass: 'Cat1', originCode: 'CL', materialCode: null, share: '100' };
  await submitDemand(db, sales, cmd(), demandId, (await getDemand(db, sales, demandId)).rowVer, { notes: '', weeks: [{ etdWeek: w, groups: [{ name: 'Gala', containerCount: boxes, capacity: '1000', unit: 'CT', items: [item] }] }] });
  await acceptDemand(db, proc, cmd(), demandId, (await getDemand(db, proc, demandId)).rowVer);
  const d = await getDemand(db, proc, demandId);
  const sup = split.map(([s]) => s);
  const { rfqId } = await createRfq(db, proc, cmd(), { demandId, weeks: [], lines: d.weeks[0].lines.map((l) => ({ lineId: l.lineId, week: w, qty: String(Number(l.ledger.requested)) })), suppliers: sup });
  await sendRfq(db, proc, cmd(), rfqId, (await getRfq(db, proc, rfqId)).rowVer);
  const key = (await getRfq(db, proc, rfqId)).supplierView[0].key;
  for (const s of sup) await recordQuotes(db, proc, cmd(), rfqId, s, 'USD', [{ etdWeek: w, lineKey: key, unitPrice: '18.50', availableQty: '9000', quotedSku: null }], [{ etdWeek: w, containersOffered: boxes }]);
  const g = (await containerGrid(db, { RfqId: rfqId, DemandId: demandId })).weeks[0].groups[0];
  const r = await awardContainers(db, proc, cmd(), rfqId, (await getRfq(db, proc, rfqId)).rowVer, { containers: split.map(([s, n]) => ({ groupId: g.groupId, supplierCode: s, count: n })), added: [], other: [], shipments: [], comment: '' });
  const port = async (name: string) => (await db.selectFrom('scm.Port').select('PortId').where('Name', '=', name).executeTakeFirstOrThrow()).PortId;
  const out: Record<string, string> = {};
  for (const s of sup) {
    await saveTerms(db, proc, cmd(), r.awardBatchId, s, { incoterm: 'FOB', portOfLoadingId: Number(await port('Valparaíso')), portOfDischargeId: Number(await port('Jeddah')), paymentTerms: 'N030' });
    const sh = (await getBatch(db, proc, r.awardBatchId)).shipments.find((x) => x.supplierCode === s)!;
    await updateShipment(db, proc, cmd(), sh.shipmentId, sh.rowVer, sh.containers, '2027-02-01');
    const h = await sendHandoff(db, proc, cmd(), r.awardBatchId, s, { confirmWithoutAck: true, reasonCode: 'URGENT' });
    await acceptHandoff(db, po, cmd(), h.handoffId, (await getHandoff(db, po, h.handoffId)).rowVer);
    out[s] = h.handoffId;
  }
  return out;
}
async function submitted(handoffId: string, skus: [string, string][]) {
  const prep = await preparation(db, po, handoffId);
  for (const it of prep.items) await selectSkus(db, po, cmd(), it.awardItemId, skus.map(([materialCode, qty]) => ({ materialCode, qty })));
  const b = await buildDraft(db, po, cmd(), handoffId);
  expect((await validateDraft(db, po, cmd(), b.poDraftId, (await draft(b.poDraftId)).rowVer)).problems).toEqual([]);
  await submitDraft(db, po, cmd(), b.poDraftId, (await draft(b.poDraftId)).rowVer);
  return b;
}

describe('PO drafts and the SAP outbox (spec 23)', () => {
  it('SKU selection, one PO per handoff, rejected then rebuilt, reply lost then reconciled — never two POs', async () => {
    const h = await accepted(wk(22), [[A, 2], [B, 1]]);
    expect(await listWork(db, po, { tab: 'PO_TO_PREPARE', page: 1, pageSize: 50 }).then((r) => r.rows.filter((x) => [`/handoffs/${h[A]}`, `/handoffs/${h[B]}`].includes(x.action.link)).length)).toBe(2);

    // A: no SKU was provided → the PO team picks, quantities must add up exactly
    const prep = await preparation(db, po, h[A]);
    const itemA = prep.items[0];
    expect([itemA.skuStatus, itemA.qty, prep.canBuild]).toEqual(['PENDING', '2000.000', true]);
    await expect(buildDraft(db, po, cmd(), h[A])).rejects.toMatchObject({ code: 'SKU_PENDING' });
    expect((await skuCandidates(db, po, itemA.awardItemId)).map((c) => c.code).sort()).toEqual([M1, M2].sort());
    await expect(selectSkus(db, po, cmd(), itemA.awardItemId, [{ materialCode: M1, qty: '1999' }])).rejects.toMatchObject({ code: 'QTY_MISMATCH' });
    await expect(selectSkus(db, po, cmd(), itemA.awardItemId, [{ materialCode: 'NOPE', qty: '2000' }])).rejects.toMatchObject({ code: 'INVALID_SKU' });
    await selectSkus(db, po, cmd(), itemA.awardItemId, [{ materialCode: M1, qty: '1200' }, { materialCode: M2, qty: '800' }]);

    // Build → one draft (containers 2, two items), a second live draft is refused; validate; submit
    const d1 = await buildDraft(db, po, cmd(), h[A]);
    await expect(buildDraft(db, po, cmd(), h[A])).rejects.toMatchObject({ code: 'DRAFT_EXISTS' });
    const v1 = await draft(d1.poDraftId);
    expect([v1.containers, v1.items.map((i) => [i.material, i.qty]), v1.plant, v1.incoterm, v1.portOfDischarge]).toEqual([2, [[M1, '1200.000'], [M2, '800.000']], 'HO01', 'FOB', 'Jeddah (SA)']);
    await expect(submitDraft(db, po, cmd(), d1.poDraftId, v1.rowVer)).rejects.toMatchObject({ code: 'BAD_STATE' }); // validate first
    expect((await validateDraft(db, po, cmd(), d1.poDraftId, v1.rowVer)).problems).toEqual([]);
    await submitDraft(db, po, cmd(), d1.poDraftId, (await draft(d1.poDraftId)).rowVer);
    expect(await sliceStates(h[A])).toEqual([['PO_SUBMITTED', 2_000_000]]);
    await expect(returnHandoff(db, po, cmd(), h[A], (await getHandoff(db, po, h[A])).rowVer, 'DATA', 'x')).rejects.toMatchObject({ code: 'PO_SUBMITTED' });

    // SAP rejects → quantity back to PO preparation; rebuild → a new draft number and a new key
    await db.insertInto('scm.StubSapFault').values({ Reference: d1.poDraftNo, Mode: 'reject', CreatedBy: null }).execute();
    await run();
    expect([(await draft(d1.poDraftId)).status, await sliceStates(h[A]), await stubPos(d1.poDraftNo)]).toEqual(['REJECTED', [['PO_PREPARATION', 2_000_000]], 0]);
    expect(await listWork(db, po, { tab: 'EXCEPTIONS', q: d1.poDraftNo, page: 1, pageSize: 25 }).then((r) => r.rows.map((x) => x.itemType))).toContain('SAP_REJECTED');
    const d2 = await buildDraft(db, po, cmd(), h[A]);
    expect(d2.poDraftNo).not.toBe(d1.poDraftNo);
    expect((await validateDraft(db, po, cmd(), d2.poDraftId, (await draft(d2.poDraftId)).rowVer)).problems).toEqual([]);
    await submitDraft(db, po, cmd(), d2.poDraftId, (await draft(d2.poDraftId)).rowVer);
    await run();
    const c2 = await draft(d2.poDraftId);
    expect([c2.status, c2.resolution, c2.sapPoNumber, await sliceStates(h[A])]).toEqual(['CREATED', 'SAP_REPLY', expect.stringMatching(/^45\d{8}$/), [['PO_CREATED', 2_000_000]]]);

    // B: SAP created the PO but the reply was lost → UNKNOWN, quantity stays PO submitted; the lookup finds it → CREATED, one PO
    const dB = await submitted(h[B], [[M1, '1000']]);
    await db.insertInto('scm.StubSapFault').values({ Reference: dB.poDraftNo, Mode: 'timeout-after-create', CreatedBy: null }).execute();
    await run();
    expect([(await draft(dB.poDraftId)).status, await sliceStates(h[B])]).toEqual(['UNKNOWN', [['PO_SUBMITTED', 1_000_000]]]);
    expect(await runInvariants()).toEqual([]);
    await due(); await run();
    const cB = await draft(dB.poDraftId);
    expect([cB.status, cB.resolution, await stubPos(dB.poDraftNo), await sliceStates(h[B])]).toEqual(['CREATED', 'RECONCILED', 1, [['PO_CREATED', 1_000_000]]]);
    expect(await runInvariants()).toEqual([]);
  });

  it('a crashed worker is not resent blindly; an unreachable SAP ends in manual resolution with evidence; a lost request is resent with the same key once', async () => {
    const h = await accepted(wk(23), [[A, 1]]);
    const d = await submitted(h[A], [[M2, '1000']]);
    // the worker claimed it and died: the lease expires → UNKNOWN, not resent
    await sql`UPDATE scm.SapSubmission SET Status = 'IN_FLIGHT', ClaimedBy = 'dead', LeaseUntil = DATEADD(minute, -1, SYSUTCDATETIME()), Attempts = 1 WHERE PoDraftId = ${d.poDraftId}`.execute(db);
    await db.insertInto('scm.StubSapFault').values({ Reference: d.poDraftNo, Mode: 'lookup-unknown', Remaining: 5, CreatedBy: null }).execute();
    await run();
    expect([(await draft(d.poDraftId)).status, await stubPos(d.poDraftNo)]).toEqual(['UNKNOWN', 0]);
    for (let i = 0; i < 5; i++) { await due(); await run(); } // SAP cannot be asked → manual
    const u = await draft(d.poDraftId);
    expect([u.status, u.submission?.status, await sliceStates(h[A])]).toEqual(['UNKNOWN', 'MANUAL', [['PO_SUBMITTED', 1_000_000]]]);
    expect(await listWork(db, po, { tab: 'EXCEPTIONS', q: d.poDraftNo, page: 1, pageSize: 25 }).then((r) => r.rows.map((x) => x.itemType))).toContain('SAP_UNKNOWN');

    // resolve: evidence first; then "not created" (SAP confirms it has none) → REJECTED, quantity unlocked
    await expect(resolveUnknown(db, po, adapter, cmd(), d.poDraftId, u.rowVer, { outcome: 'NOT_CREATED' }, 'checked ME23N')).rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' });
    await db.insertInto('scm.Attachment').values({ EntityType: 'PO_DRAFT', EntityId: d.poDraftId, CompanyCode: '1000', FileName: 'sap.png', ContentType: 'image/png', SizeBytes: 1, Sha256: 'x'.repeat(64), StorageKey: 'test', SupersedesId: null, UploadedBy: po.id }).execute();
    await expect(resolveUnknown(db, po, adapter, cmd(), d.poDraftId, u.rowVer, { outcome: 'CREATED', sapPoNumber: '4599999999' }, 'x')).rejects.toMatchObject({ code: 'PO_NOT_FOUND' });
    await resolveUnknown(db, po, adapter, cmd(), d.poDraftId, (await draft(d.poDraftId)).rowVer, { outcome: 'NOT_CREATED' }, 'Checked ME23N: no PO with this reference');
    expect([(await draft(d.poDraftId)).status, (await draft(d.poDraftId)).resolution, await sliceStates(h[A])]).toEqual(['REJECTED', 'MANUAL_NOT_CREATED', [['PO_PREPARATION', 1_000_000]]]);

    // rebuild; the request is lost before SAP created it → lookup: not found → resent with the same key → created once
    const d2 = await buildDraft(db, po, cmd(), h[A]);
    await validateDraft(db, po, cmd(), d2.poDraftId, (await draft(d2.poDraftId)).rowVer);
    await submitDraft(db, po, cmd(), d2.poDraftId, (await draft(d2.poDraftId)).rowVer);
    const key = (await draft(d2.poDraftId)).submission!.key;
    await db.insertInto('scm.StubSapFault').values({ Reference: d2.poDraftNo, Mode: 'timeout-before-create', CreatedBy: null }).execute();
    await run();
    expect([(await draft(d2.poDraftId)).status, await stubPos(d2.poDraftNo)]).toEqual(['UNKNOWN', 0]);
    await due(); await run(); // lookup → not found → PENDING
    await due(); await run(); // resend
    const c = await draft(d2.poDraftId);
    expect([c.status, c.submission?.key, c.submission?.attempts, await stubPos(d2.poDraftNo), await sliceStates(h[A])]).toEqual(['CREATED', key, 2, 1, [['PO_CREATED', 1_000_000]]]);
    expect(await runInvariants()).toEqual([]);
  });

  it('reports (spec 24): per demand, per week, execution by origin, performance; company scope and permission enforced', async () => {
    const h = await accepted(wk(24), [[A, 2]]);
    const dA = await submitted(h[A], [[M1, '2000']]);
    await run();
    expect((await draft(dA.poDraftId)).status).toBe('CREATED');
    const demandId = (await getHandoff(db, po, h[A])).demandId;
    const rep = actor({ id: await makeUser(), permissions: new Set(['reports.open']), companies: new Set(['1000']) });

    const d = await demandReport(db, rep, demandId);
    expect(d.lines.map((l) => [Number(l.baseline), Number(l.requested), Number(l.poCreated), Number(l.open), l.sapPos.length])).toEqual([[2000, 2000, 2000, 0, 1]]);
    expect(d.weeks.map((w) => [w.week, w.baseline, w.current, w.awarded, w.ordered])).toEqual([[wk(24), 2, 2, 2, 2]]);

    const ex = (await executionSummary(db, rep, { q: d.demandNo })).find((r) => r.demandId === demandId)!;
    expect([Number(ex.committed), Number(ex.executed), ex.executionRate, ex.notSourcedRate, Number(ex.outstanding)]).toEqual([2000, 2000, 100, 0, 0]);
    const perf = await performance(db, rep, {});
    const ct = perf.headline.find((x) => x.unit === 'CT')!;
    expect(ct.executionRate).not.toBeNull();
    expect(ct.stages.find((x) => x.label === 'End to end')!.hours).not.toBeNull();
    expect(perf.sap.submitted).toBeGreaterThan(0);
    expect(Array.isArray(await crRegister(db, rep, {}))).toBe(true);

    // another company's demand is not found; without reports.open nothing is readable
    await expect(demandReport(db, actor({ id: rep.id, permissions: new Set(['reports.open']), companies: new Set(['9999']) }), demandId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await executionSummary(db, actor({ id: rep.id, permissions: new Set(['reports.open']), companies: new Set(['9999']) }), {})).length).toBe(0);
    await expect(executionSummary(db, actor({ id: rep.id, companies: new Set(['1000']) }), {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('negative authorization (plan §10): every permission but another company → not found on reads, writes, threads and files; lists leave it out', async () => {
    const h = await accepted(wk(25), [[A, 1]]);
    const d = await submitted(h[A], [[M1, '1000']]);
    const ho = await getHandoff(db, po, h[A]);
    const { AwardBatchId: awardBatchId, RfqId: rfqId } = await db.selectFrom('scm.AwardBatch').select(['AwardBatchId', 'RfqId']).where('AwardBatchId', '=', ho.awardBatchId).executeTakeFirstOrThrow();
    const demandId = ho.demandId;
    const awardItemId = (await preparation(db, po, h[A])).items[0].awardItemId;
    const dr = await draft(d.poDraftId);

    const outsiderId = await makeUser();
    await db.insertInto('scm.UserCompany').values({ UserId: outsiderId, CompanyCode: '2000' }).execute();
    const user = { id: outsiderId, username: 'outsider', displayName: 'Outsider', isAdmin: false, isDemo: false, viewAs: null, permissions: new Set(ALL_PERMISSION_KEYS) };
    const caller = createCallerFactory(appRouter)({ db, cfg: loadConfig(), user, encKey: '', log: console, req: {}, res: {} } as unknown as Context);
    const c = () => randomUUID();
    const rv = '00000000000007D1';
    const calls: [string, () => Promise<unknown>][] = [
      ['demand.get', () => caller.demand.get({ demandId })], ['demand.versions', () => caller.demand.versions({ demandId })], ['demand.history', () => caller.demand.history({ demandId })],
      ['demand.thread', () => caller.demand.thread({ demandId })], ['demand.attachments', () => caller.demand.attachments({ demandId })],
      ['demand.accept', () => caller.demand.accept({ demandId, commandId: c(), rowVer: rv })], ['demand.return', () => caller.demand.return({ demandId, commandId: c(), rowVer: rv, comment: 'x' })],
      ['demand.comment', () => caller.demand.comment({ demandId, commandId: c(), body: 'x' })],
      ['rfq.get', () => caller.rfq.get({ rfqId })], ['rfq.history', () => caller.rfq.history({ rfqId })], ['rfq.thread', () => caller.rfq.thread({ rfqId })],
      ['rfq.builder', () => caller.rfq.builder({ demandId })], ['rfq.send', () => caller.rfq.send({ rfqId, commandId: c(), rowVer: rv })],
      ['rfq.cancel', () => caller.rfq.cancel({ rfqId, commandId: c(), rowVer: rv, reasonCode: 'OTHER', comment: 'x' })],
      ['award.get', () => caller.award.get({ awardBatchId })], ['award.thread', () => caller.award.thread({ awardBatchId })], ['award.grid', () => caller.award.grid({ rfqId })],
      ['award.comment', () => caller.award.comment({ awardBatchId, commandId: c(), body: 'x' })],
      ['handoff.panel', () => caller.handoff.panel({ awardBatchId })], ['handoff.get', () => caller.handoff.get({ handoffId: h[A] })], ['handoff.thread', () => caller.handoff.thread({ handoffId: h[A] })],
      ['handoff.accept', () => caller.handoff.accept({ handoffId: h[A], commandId: c(), rowVer: rv })],
      ['handoff.return', () => caller.handoff.return({ handoffId: h[A], commandId: c(), rowVer: rv, reasonCode: 'DATA', comment: 'x' })],
      ['po.preparation', () => caller.po.preparation({ handoffId: h[A] })], ['po.candidates', () => caller.po.candidates({ awardItemId })],
      ['po.selectSkus', () => caller.po.selectSkus({ commandId: c(), awardItemId, allocations: [{ materialCode: M1, qty: '1000' }] })],
      ['po.markMissing', () => caller.po.markMissing({ commandId: c(), awardItemId, note: 'x' })], ['po.build', () => caller.po.build({ commandId: c(), handoffId: h[A] })],
      ['po.get', () => caller.po.get({ poDraftId: d.poDraftId })], ['po.thread', () => caller.po.thread({ poDraftId: d.poDraftId })], ['po.attachments', () => caller.po.attachments({ poDraftId: d.poDraftId })],
      ['po.validate', () => caller.po.validate({ commandId: c(), poDraftId: d.poDraftId, rowVer: dr.rowVer })], ['po.submit', () => caller.po.submit({ commandId: c(), poDraftId: d.poDraftId, rowVer: dr.rowVer })],
      ['reports.demand', () => caller.reports.demand({ demandId })],
    ];
    const leaks: string[] = [];
    for (const [name, fn] of calls) {
      const code = await fn().then(() => 'OK', (e: { code?: string }) => e.code ?? 'ERR');
      if (code !== 'NOT_FOUND') leaks.push(`${name}: ${code}`);
    }
    expect(leaks).toEqual([]);
    // lists: nothing of company 1000
    const lists = await Promise.all([
      caller.demand.list({ q: ho.snapshot.award.demandNo, page: 1, pageSize: 25 }).then((r) => r.rows.length),
      caller.handoff.list({ q: ho.hoNo, page: 1, pageSize: 25 }).then((r) => r.rows.length),
      caller.po.list({ q: d.poDraftNo, page: 1, pageSize: 25 }).then((r) => r.rows.length),
      caller.reports.execution({ q: ho.snapshot.award.demandNo }).then((r) => r.length),
    ]);
    expect(lists).toEqual([0, 0, 0, 0]);
    expect((await draft(d.poDraftId)).status).toBe('SUBMITTED'); // nothing changed
  });
});
