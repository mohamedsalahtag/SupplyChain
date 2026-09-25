/** Stage 6 (spec 22) against a real database: terms, readiness, handoff with/without Sales' acknowledgement, accept, return, resend, auto-return. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acknowledge } from '../../src/modules/award/ack.js';
import { getBatch } from '../../src/modules/award/awardRead.js';
import { updateShipment } from '../../src/modules/award/awardService.js';
import { awardContainers } from '../../src/modules/award/containerAward.js';
import { containerGrid } from '../../src/modules/award/containerGrid.js';
import { decideCr } from '../../src/modules/cr/crApply.js';
import { getCr } from '../../src/modules/cr/crRead.js';
import { raiseContainerChange } from '../../src/modules/cr/crService.js';
import '../../src/modules/demand/access.js';
import { getDemand } from '../../src/modules/demand/demandRead.js';
import { acceptDemand, createDemand, submitDemand } from '../../src/modules/demand/demandService.js';
import { getHandoff, handoffPanel } from '../../src/modules/handoff/handoffRead.js';
import { acceptHandoff, returnHandoff, saveTerms, sendHandoff } from '../../src/modules/handoff/handoffService.js';
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
let po: ReturnType<typeof actor>;
const [A, B] = [uid('HOa'), uid('HOb')];
const SUB = 'Apples Gala HO';
const port = async (name: string) => (await db.selectFrom('scm.Port').select('PortId').where('Name', '=', name).executeTakeFirstOrThrow()).PortId;
const problemsOf = (e: { details?: { problems?: string[] } }) => e.details?.problems ?? [];

beforeAll(async () => {
  await db.insertInto('md.Material').values({
    MaterialCode: uid('HO'), Description: `${SUB} S-100`, MajorCategoryCode: 'AP', MajorCategory: 'Apples', SubMajorCategory: SUB, MaterialGroupCode: '', MaterialGroup: '',
    MaterialType: 'ZTRD', BaseUnit: 'CT', BaseUnitName: 'Carton', Origin: 'Chile', Variety: '', Size: 'S-100', Weight: null, WeightUnit: '', MaterialClassCode: '', MaterialClass: 'Cat1',
    InSap: true, SapChangedAt: new Date(),
  }).execute();
  await refreshOrigins(db);
  await db.updateTable('scm.Company').set({ PurchasingOrg: '1000' }).where('CompanyCode', '=', '1000').execute();
  await sql`IF NOT EXISTS (SELECT 1 FROM scm.PaymentTerm WHERE Code = 'N030') INSERT INTO scm.PaymentTerm (Code, Description) VALUES ('N030', '30 days net')`.execute(db);
  for (const s of [A, B]) {
    await db.insertInto('md.Supplier').values({
      SupplierCode: s, Name: s, SupplierGroup: 'ZIMP', Country: 'CL', Currency: 'USD', Street: '', HouseNumber: '', City: 'Santiago', PostalCode: '', Region: '', Email: `${s}@x.cl`,
      InSap: true, SapChangedAt: new Date(), PurchasingIsBlocked: false, PostingIsBlocked: false,
    }).execute();
    await db.insertInto('md.SupplierPurchasingOrg').values({ SupplierCode: s, PurchasingOrg: '1000', IsBlocked: false, PaymentTerms: 'N030' }).execute();
    await db.insertInto('scm.SupplierOrigin').values({ SupplierCode: s, OriginCode: 'CL', Source: 'COUNTRY', AddedBy: null }).execute();
  }
  sales = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.create', 'demand.submit', 'crs.open', 'cr.raise.sales', 'awards.open', 'ack.respond']), companies: new Set(['1000']) });
  proc = actor({ id: await makeUser(), permissions: new Set(['demands.open', 'demand.accept', 'rfqs.open', 'rfq.manage', 'crs.open', 'cr.decide.sales', 'awards.open', 'award.manage', 'handoffs.open', 'handoff.send']), companies: new Set(['1000']) });
  po = actor({ id: await makeUser(), permissions: new Set(['awards.open', 'handoffs.open', 'handoff.accept', 'handoff.return']), companies: new Set(['1000']) });
});
afterAll(() => db.destroy());

/** Week w: "Gala" 3 × 1,000 CT; A wins 2 containers, B 1. */
async function awarded(w: string) {
  const { demandId } = await createDemand(db, sales, cmd(), '1000');
  const item = { majorCategory: 'Apples', subMajorCategory: SUB, size: 'S-100', materialClass: 'Cat1', originCode: 'CL', materialCode: null, share: '100' };
  await submitDemand(db, sales, cmd(), demandId, (await getDemand(db, sales, demandId)).rowVer, { notes: '', weeks: [{ etdWeek: w, groups: [{ name: 'Gala', containerCount: 3, capacity: '1000', unit: 'CT', items: [item] }] }] });
  await acceptDemand(db, proc, cmd(), demandId, (await getDemand(db, proc, demandId)).rowVer);
  const d = await getDemand(db, proc, demandId);
  const { rfqId } = await createRfq(db, proc, cmd(), { demandId, weeks: [], lines: d.weeks[0].lines.map((l) => ({ lineId: l.lineId, week: w, qty: String(Number(l.ledger.requested)) })), suppliers: [A, B] });
  await sendRfq(db, proc, cmd(), rfqId, (await getRfq(db, proc, rfqId)).rowVer);
  const key = (await getRfq(db, proc, rfqId)).supplierView[0].key;
  for (const s of [A, B]) await recordQuotes(db, proc, cmd(), rfqId, s, 'USD', [{ etdWeek: w, lineKey: key, unitPrice: '18.50', availableQty: '3000', quotedSku: null }], [{ etdWeek: w, containersOffered: 3 }]);
  const g = (await containerGrid(db, { RfqId: rfqId, DemandId: demandId })).weeks[0].groups[0];
  const r = await awardContainers(db, proc, cmd(), rfqId, (await getRfq(db, proc, rfqId)).rowVer, {
    containers: [{ groupId: g.groupId, supplierCode: A, count: 2 }, { groupId: g.groupId, supplierCode: B, count: 1 }], added: [], other: [], shipments: [], comment: '',
  });
  return { demandId, batchId: r.awardBatchId, abNo: r.abNo };
}
const state = async (handoffId: string) => (await sql<{ ExecState: string; n: string }>`SELECT ExecState, SUM(Qty) AS n FROM scm.QtySlice WHERE HandoffId = ${handoffId} GROUP BY ExecState`.execute(db)).rows.map((r) => [r.ExecState, Number(r.n)]);
const work = async (who: ReturnType<typeof actor>, tab: string, q: string) => (await listWork(db, who, { tab, q, page: 1, pageSize: 25 })).rows.length;

describe('handoff (spec 22)', () => {
  it('checks readiness, hands off without the acknowledgement only with a reason, accepts, returns, resends; one open handoff per supplier', async () => {
    const w = wk(20);
    const a = await awarded(w);
    expect([await work(proc, 'HANDOFF_READY', a.abNo)]).toEqual([2]); // one per supplier

    // Not ready: no ports, no confirmed ETD
    const p0 = await handoffPanel(db, proc, a.batchId);
    const cardA = p0.cards.find((c) => c.supplierCode === A)!;
    expect([cardA.terms.paymentTerms, cardA.termsSource, cardA.terms.currency]).toEqual(['N030', 'SAP', 'USD']);
    await expect(sendHandoff(db, proc, cmd(), a.batchId, A)).rejects.toSatisfy((e: { details?: { problems?: string[] } }) =>
      problemsOf(e).some((p) => /Shipping terms complete — missing: Incoterm, port of loading, port of discharge/.test(p)) && problemsOf(e).some((p) => /Confirmed ETD .* missing for/.test(p)));

    await saveTerms(db, proc, cmd(), a.batchId, A, { incoterm: 'FOB', portOfLoadingId: await port('Valparaíso'), portOfDischargeId: await port('Jeddah'), paymentTerms: 'N030' });
    const shipA = (await getBatch(db, proc, a.batchId)).shipments.find((s) => s.supplierCode === A)!;
    await updateShipment(db, proc, cmd(), shipA.shipmentId, shipA.rowVer, shipA.containers, '2027-01-05');
    expect((await getBatch(db, proc, a.batchId)).ack!.revision).toBe(1); // the first confirmed ETD does not ask Sales again

    // Sales has not acknowledged: refused, then sent with a reason
    await expect(sendHandoff(db, proc, cmd(), a.batchId, A)).rejects.toMatchObject({ code: 'ACK_MISSING' });
    const h1 = await sendHandoff(db, proc, cmd(), a.batchId, A, { confirmWithoutAck: true, reasonCode: 'URGENT' });
    expect([h1.hoNo, h1.sentWithoutAck, await state(h1.handoffId)]).toEqual([expect.stringMatching(/^HO-\d{6}$/), true, [['HANDED_OFF', 2_000_000]]]);
    expect([await work(proc, 'HANDOFF_READY', a.abNo), await work(po, 'HANDOFF_TO_ACCEPT', h1.hoNo)]).toEqual([1, 1]); // B still to hand off
    await expect(sendHandoff(db, proc, cmd(), a.batchId, A)).rejects.toMatchObject({ code: 'BAD_STATE' }); // one open handoff per supplier
    const b1 = await getBatch(db, sales, a.batchId);
    await acknowledge(db, sales, cmd(), b1.ack!.ackId, b1.ack!.rowVer, '');
    expect((await getBatch(db, sales, a.batchId)).ack!.status).toBe('ACKNOWLEDGED_LATE');

    // The snapshot has the supplier, the terms and the shipments as sent
    const s1 = await getHandoff(db, po, h1.handoffId);
    expect([s1.snapshot.supplier.code, s1.snapshot.supplier.email, s1.snapshot.terms.portOfDischarge, s1.snapshot.terms.paymentTermsText, s1.snapshot.shipments[0].confirmedEtd])
      .toEqual([A, `${A}@x.cl`, 'Jeddah (SA)', 'N030 · 30 days net', '2027-01-05']);

    // Procurement cannot accept; the PO team accepts, then returns it (SKU)
    await expect(acceptHandoff(db, proc, cmd(), h1.handoffId, s1.rowVer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await acceptHandoff(db, po, cmd(), h1.handoffId, s1.rowVer);
    expect(await state(h1.handoffId)).toEqual([['PO_PREPARATION', 2_000_000]]);
    await returnHandoff(db, po, cmd(), h1.handoffId, (await getHandoff(db, po, h1.handoffId)).rowVer, 'SKU_ISSUE', 'Use the 18 kg carton');
    expect([await state(h1.handoffId), (await getHandoff(db, po, h1.handoffId)).returned?.from, await work(proc, 'HANDOFF_RETURNED', h1.hoNo)]).toEqual([[], 'ACCEPTED', 1]);

    // Fix (discharge in Dammam) and resend: a new handoff; the first one still shows what it sent
    await saveTerms(db, proc, cmd(), a.batchId, A, { incoterm: 'FOB', portOfLoadingId: await port('Valparaíso'), portOfDischargeId: await port('Dammam'), paymentTerms: 'N030' });
    const h2 = await sendHandoff(db, proc, cmd(), a.batchId, A);
    expect([h2.hoNo !== h1.hoNo, h2.sentWithoutAck, (await getHandoff(db, po, h2.handoffId)).snapshot.terms.portOfDischarge, (await getHandoff(db, po, h1.handoffId)).snapshot.terms.portOfDischarge])
      .toEqual([true, false, 'Dammam (SA)', 'Jeddah (SA)']);
    expect(await work(proc, 'HANDOFF_RETURNED', h1.hoNo)).toBe(0);
    expect(await runInvariants()).toEqual([]);

    // A change request cancelling 2 of the 3 containers reaches the handed-off quantity: that handoff comes back automatically
    const d = await getDemand(db, sales, a.demandId);
    const g = d.weeks[0].groups[0];
    const item = { majorCategory: 'Apples', subMajorCategory: SUB, size: 'S-100', materialClass: 'Cat1', originCode: 'CL', materialCode: null, share: '100' };
    const cr = await raiseContainerChange(db, sales, cmd(), a.demandId, { weeks: [{ etdWeek: w, groups: [{ groupId: g.groupId, name: g.name, containerCount: 1, capacity: '1000', unit: 'CT', items: [item] }] }], reasonCode: 'CUST_CANCEL', comment: 'test' });
    const c = await getCr(db, proc, cr.crId);
    await decideCr(db, proc, cmd(), cr.crId, c.rowVer, c.items.map((i) => ({ crItemId: i.crItemId, decision: 'APPROVE' as const })), 'ok');
    const h2now = await getHandoff(db, po, h2.handoffId);
    expect([h2now.status, h2now.returned?.reason, h2now.returned?.by, await work(proc, 'HANDOFF_AUTO_RETURNED', h2.hoNo), await work(po, 'HANDOFF_TO_ACCEPT', h2.hoNo)])
      .toEqual(['RETURNED', 'CR_CHANGE', null, 1, 0]);
    expect(await runInvariants()).toEqual([]);
  });
});
