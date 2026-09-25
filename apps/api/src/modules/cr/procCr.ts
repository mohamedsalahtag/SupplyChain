/**
 * Procurement change requests raised from an RFQ and decided by Sales (spec 19,
 * plan v5 §4 rules 7–9): add quantity (+ extra containers), week shift, mix change.
 * `dryRun` returns the pre-check only (the screens' Check button).
 */
import { sql } from 'kysely';
import { incrementFor } from '../demand/content.js';
import { skuForCriteria, specExists } from '../demand/lookups.js';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { assertIsoWeek, isoWeekOf } from '../workflow/isoWeek.js';
import { formatQty, fromDb, parseQty, type Milli } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import type { Db, Tx } from '../workflow/tx.js';
import { acceptedDemand, assertReason, crNoOf, linesOf, P_CR, saveCr, type DemandRow, type LineInfo, type NewItem } from './crService.js';
import type { Spec } from './diff.js';

export type SpecInput = Spec & { unit: string };
const keyOf = (s: Spec) => [s.majorCategory, s.subMajorCategory, s.size, s.materialClass, s.originCode, s.materialCode ?? ''].join('|');
const labelOf = (s: Spec) => [s.subMajorCategory, s.size || 'any size', s.materialClass || 'any class', s.originCode, s.materialCode].filter(Boolean).join(' ');
const IN_RFQ = sql`s.ExecState IN ('IN_RFQ', 'QUOTED')`;
const AWARDED = sql`s.ExecState IN ('AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED', 'PO_CREATED')`;

type Ctx = { demand: DemandRow; rfq: { RfqId: string; RfqNo: string; ManualStatus: string }; lines: LineInfo[]; weekHolds: { EtdWeek: string; CrId: string }[]; units: Map<string, string>; increment: (u: string) => Milli };

async function context(tx: Tx, actor: Actor, rfqId: string): Promise<Ctx> {
  const rfq = await tx.selectFrom('scm.Rfq').select(['RfqId', 'RfqNo', 'DemandId', 'CompanyCode', 'ManualStatus']).where('RfqId', '=', rfqId).executeTakeFirst();
  if (!rfq || !actor.companies.has(rfq.CompanyCode)) throw new NotFoundError(`RFQ ${rfqId}`);
  assertCan(actor, P_CR.raiseProcurement, rfq.CompanyCode);
  assertCan(actor, 'rfq.manage', rfq.CompanyCode);
  if (rfq.ManualStatus === 'CANCELLED') throw new DomainError('BAD_STATE', `${rfq.RfqNo} is cancelled`, 409);
  const demand = await acceptedDemand(tx, actor, String(rfq.DemandId));
  const settings = await loadWfSettings(tx);
  return {
    demand, rfq: { RfqId: String(rfq.RfqId), RfqNo: rfq.RfqNo, ManualStatus: rfq.ManualStatus }, lines: await linesOf(tx, demand.DemandId),
    weekHolds: (await tx.selectFrom('scm.WeekHold').select(['EtdWeek', 'CrId']).where('DemandId', '=', demand.DemandId).execute()).map((h) => ({ EtdWeek: h.EtdWeek, CrId: String(h.CrId) })),
    units: new Map((await tx.selectFrom('scm.DemandKeyUom').select(['LineKey', 'Unit']).where('DemandId', '=', demand.DemandId).execute()).map((u) => [u.LineKey, u.Unit])),
    increment: (u) => incrementFor(settings, u),
  };
}

/** Checks one quantity to add (Add quantity or a mix addition) and returns its item. */
async function additionItem(tx: Tx, c: Ctx, kind: 'ADD_QTY' | 'MIX_ADD', etdWeek: string, spec: SpecInput, qtyText: string, problems: string[]): Promise<NewItem> {
  const week = assertIsoWeek(etdWeek);
  const what = `${week} · ${labelOf(spec)}`;
  let qty = 0;
  try { qty = parseQty(qtyText, c.increment(spec.unit)); } catch { problems.push(`${what}: the quantity must be whole ${spec.unit}`); }
  if (qty <= 0) problems.push(`${what}: add a quantity above zero`);
  if (week < isoWeekOf(new Date())) problems.push(`${what}: ${week} is in the past`);
  if (!(await specExists(tx, spec))) problems.push(`${what}: no material in SAP matches this specification in ${spec.unit}`);
  if (spec.materialCode && !(await skuForCriteria(tx, spec.materialCode, spec))) problems.push(`${what}: SKU ${spec.materialCode} does not match the specification`);
  const key = keyOf(spec);
  const unit = c.units.get(key);
  if (unit && unit !== spec.unit) problems.push(`${what}: ordered in ${unit} on this demand, not ${spec.unit}`);
  const hold = c.weekHolds.find((h) => h.EtdWeek === week);
  if (hold) problems.push(`${week} is already in ${await crNoOf(tx, hold.CrId)}`);
  const line = c.lines.find((l) => l.EtdWeek === week && l.LineKey === key);
  if (line?.ChangeHoldCrId) problems.push(`${what} is already in ${await crNoOf(tx, line.ChangeHoldCrId)}`);
  return { kind, etdWeek: week, groupId: null, lineId: line?.LineId ?? null, before: null, after: { spec, rfqLineId: null }, effect: [{ ...spec, key, delta: qty }], requestedCount: null, requestedQty: qty };
}

type Raised = { crId: string; crNo: string; status: string; problems: string[] } | { dryRun: true; problems: string[]; items: number };

export async function raiseAddQuantity(db: Db, actor: Actor, commandId: string, rfqId: string,
  input: { etdWeek: string; spec: SpecInput; qty: string; extraContainers: number; reasonCode: string; comment: string }, dryRun = false): Promise<Raised> {
  if (!input.comment.trim()) throw new DomainError('COMMENT_REQUIRED', 'A comment for Sales is required');
  return runCommand(db, actor.id, commandId, dryRun ? 'cr.check' : 'cr.raise.addToDemand', async (tx) => {
    const c = await context(tx, actor, rfqId);
    await assertReason(tx, input.reasonCode, 'CR_PROC');
    const problems: string[] = [];
    const add = await additionItem(tx, c, 'ADD_QTY', input.etdWeek, input.spec, input.qty, problems);
    const pending = await tx.selectFrom('scm.RfqLine').select('RfqLineId').where('RfqId', '=', rfqId).where('Origin', '=', 'PROCUREMENT').where('DemandLineId', 'is', null)
      .where('IsCancelled', '=', false).where('ProposedEtdWeek', '=', add.etdWeek).where('LineKey', '=', keyOf(input.spec)).executeTakeFirst();
    if (pending) problems.push(`${c.rfq.RfqNo} already proposes this material for ${add.etdWeek}`);
    const items = [add];
    if (!Number.isInteger(input.extraContainers) || input.extraContainers < 0) problems.push('Extra containers must be a whole number');
    else if (input.extraContainers > 0) {
      const w = await tx.selectFrom('scm.DemandWeek').select('ContainerCount').where('DemandId', '=', c.demand.DemandId).where('EtdWeek', '=', add.etdWeek).executeTakeFirst();
      const now = Number(w?.ContainerCount ?? 0);
      items.push({ kind: 'ADD_CONTAINERS', etdWeek: add.etdWeek, groupId: null, lineId: null, before: { containerCount: now }, after: { containerCount: now + input.extraContainers }, effect: [], requestedCount: input.extraContainers, requestedQty: null });
    }
    if (dryRun) return { dryRun: true as const, problems: [...new Set(problems)], items: items.length };
    const r = await saveCr(tx, actor, c.demand, { crType: 'ADD_TO_DEMAND', dept: 'PROCUREMENT', reasonCode: input.reasonCode, comment: input.comment, rfqId },
      items, [...new Set(problems)], add.lineId ? [add.lineId] : [], [add.etdWeek]);
    if (r.status === 'SUBMITTED') { // the proposed quantity joins the RFQ now, so suppliers can quote it (plan §4 rule 7)
      const s = input.spec;
      const rl = String((await tx.insertInto('scm.RfqLine').values({
        RfqId: rfqId, DemandLineId: null, Origin: 'PROCUREMENT', MajorCategory: s.majorCategory, SubMajorCategory: s.subMajorCategory, Size: s.size, MaterialClass: s.materialClass,
        OriginCode: s.originCode, MaterialCode: s.materialCode, Unit: s.unit, ProposedEtdWeek: add.etdWeek, AskedQty: add.requestedQty!, ProposedQty: add.requestedQty!, AddCrId: r.crId,
      }).output('inserted.RfqLineId').executeTakeFirstOrThrow()).RfqLineId);
      await sql`UPDATE scm.ChangeRequestItem SET AfterJson = ${JSON.stringify({ spec: s, rfqLineId: rl })} WHERE CrId = ${r.crId} AND ItemKind = 'ADD_QTY'`.execute(tx);
      await ensureRfqWeek(tx, rfqId, add.etdWeek, input.extraContainers);
    }
    return r;
  });
}

async function ensureRfqWeek(tx: Tx, rfqId: string, week: string, containers: number) {
  const w = await tx.selectFrom('scm.RfqWeek').select('EtdWeek').where('RfqId', '=', rfqId).where('EtdWeek', '=', week).executeTakeFirst();
  if (!w) await tx.insertInto('scm.RfqWeek').values({ RfqId: rfqId, EtdWeek: week, ContainerCount: containers, DefaultCount: containers }).execute();
}

type RfqLineQty = { RfqLineId: string; DemandLineId: string | null; Origin: string; ProposedEtdWeek: string; IsCancelled: boolean; ShiftStatus: string | null; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string; MaterialCode: string | null; MajorCategory: string; Unit: string; LineKey: string; Live: string; Awarded: string };

async function rfqLine(tx: Tx, rfqId: string, rfqLineId: string): Promise<RfqLineQty> {
  const l = (await sql<RfqLineQty>`
    SELECT l.RfqLineId, l.DemandLineId, l.Origin, l.ProposedEtdWeek, l.IsCancelled, c.Status AS ShiftStatus, l.MajorCategory, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, l.Unit, l.LineKey,
      ISNULL(SUM(CASE WHEN ${IN_RFQ} THEN s.Qty END), 0) AS Live, ISNULL(SUM(CASE WHEN ${AWARDED} THEN s.Qty END), 0) AS Awarded
    FROM scm.RfqLine l WITH (UPDLOCK) LEFT JOIN scm.QtySlice s ON s.RfqLineId = l.RfqLineId LEFT JOIN scm.ChangeRequest c ON c.CrId = l.WeekShiftCrId
    WHERE l.RfqLineId = ${rfqLineId} AND l.RfqId = ${rfqId}
    GROUP BY l.RfqLineId, l.DemandLineId, l.Origin, l.ProposedEtdWeek, l.IsCancelled, c.Status, l.MajorCategory, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, l.Unit, l.LineKey`.execute(tx)).rows[0];
  if (!l) throw new NotFoundError(`RFQ line ${rfqLineId}`);
  return { ...l, RfqLineId: String(l.RfqLineId), DemandLineId: l.DemandLineId ? String(l.DemandLineId) : null };
}

export async function raiseWeekShift(db: Db, actor: Actor, commandId: string, rfqId: string,
  input: { rfqLineId: string; toWeek: string; containers: number; reasonCode: string; comment: string }, dryRun = false): Promise<Raised> {
  if (!input.comment.trim()) throw new DomainError('COMMENT_REQUIRED', 'A comment for Sales is required');
  return runCommand(db, actor.id, commandId, dryRun ? 'cr.check' : 'cr.raise.weekShift', async (tx) => {
    const c = await context(tx, actor, rfqId);
    await assertReason(tx, input.reasonCode, 'CR_PROC');
    const l = await rfqLine(tx, rfqId, input.rfqLineId);
    const to = assertIsoWeek(input.toWeek);
    const problems: string[] = [];
    const what = `${l.ProposedEtdWeek} · ${labelOf(l as unknown as Spec)}`;
    if (l.Origin !== 'DEMAND' || !l.DemandLineId || l.IsCancelled) problems.push(`${what}: only a demand line in this RFQ can be shifted`);
    if (l.ShiftStatus === 'SUBMITTED') problems.push(`${what}: a week shift is already waiting for Sales`);
    const qty = fromDb(l.Live);
    if (qty === 0) problems.push(`${what}: nothing left in this RFQ to shift`);
    if (to === l.ProposedEtdWeek) problems.push('Choose another week');
    if (to < isoWeekOf(new Date())) problems.push(`${to} is in the past`);
    if (!Number.isInteger(input.containers) || input.containers < 0) problems.push('Containers must be a whole number');
    const clash = await tx.selectFrom('scm.RfqLine').select('RfqLineId').where('RfqId', '=', rfqId).where('DemandLineId', '=', l.DemandLineId ?? '0')
      .where('ProposedEtdWeek', '=', to).where('Origin', '=', 'DEMAND').where('IsCancelled', '=', false).executeTakeFirst();
    if (clash) problems.push(`${c.rfq.RfqNo} already asks for this line in ${to}`);
    const dl = c.lines.find((x) => x.LineId === l.DemandLineId);
    if (dl?.ChangeHoldCrId) problems.push(`${what} is already in ${await crNoOf(tx, dl.ChangeHoldCrId)}`);
    const item: NewItem = { kind: 'WEEK_SHIFT', etdWeek: l.ProposedEtdWeek, groupId: null, lineId: l.DemandLineId, before: { week: l.ProposedEtdWeek },
      after: { rfqLineId: l.RfqLineId, fromWeek: l.ProposedEtdWeek, toWeek: to, containers: input.containers }, effect: [], requestedCount: null, requestedQty: qty };
    if (dryRun) return { dryRun: true as const, problems, items: 1 };
    const r = await saveCr(tx, actor, c.demand, { crType: 'WEEK_SHIFT', dept: 'PROCUREMENT', reasonCode: input.reasonCode, comment: input.comment, rfqId },
      [item], problems, l.DemandLineId ? [l.DemandLineId] : [], []);
    if (r.status === 'SUBMITTED') { // the RFQ shows the proposed week until Sales decides; rejected → back
      if (fromDb(l.Awarded) > 0) { // spec 20: the awarded part keeps its week; the rest moves to a new RFQ line for the proposed week
        const split = String((await sql<{ RfqLineId: string }>`
          INSERT INTO scm.RfqLine (RfqId, DemandLineId, Origin, MajorCategory, SubMajorCategory, Size, MaterialClass, OriginCode, MaterialCode, Unit, ProposedEtdWeek, AskedQty, PreviousEtdWeek, WeekShiftCrId)
          OUTPUT inserted.RfqLineId
          SELECT RfqId, DemandLineId, Origin, MajorCategory, SubMajorCategory, Size, MaterialClass, OriginCode, MaterialCode, Unit, ${to}, ${qty}, ProposedEtdWeek, ${r.crId}
          FROM scm.RfqLine WHERE RfqLineId = ${l.RfqLineId}`.execute(tx)).rows[0].RfqLineId);
        await sql`UPDATE scm.QtySlice SET RfqLineId = ${split} WHERE RfqLineId = ${l.RfqLineId} AND ExecState IN ('IN_RFQ', 'QUOTED')`.execute(tx);
        await sql`UPDATE scm.ChangeRequestItem SET AfterJson = ${JSON.stringify({ rfqLineId: split, splitFrom: l.RfqLineId, fromWeek: l.ProposedEtdWeek, toWeek: to, containers: input.containers })}
          WHERE CrId = ${r.crId} AND ItemKind = 'WEEK_SHIFT'`.execute(tx);
      } else {
        await tx.updateTable('scm.RfqLine').set({ PreviousEtdWeek: l.ProposedEtdWeek, ProposedEtdWeek: to, WeekShiftCrId: r.crId }).where('RfqLineId', '=', l.RfqLineId).execute();
      }
      await ensureRfqWeek(tx, rfqId, to, input.containers);
    }
    return r;
  });
}

export async function raiseMixChange(db: Db, actor: Actor, commandId: string, rfqId: string,
  input: { reductions: { rfqLineId: string; qty: string }[]; additions: { etdWeek: string; spec: SpecInput; qty: string }[]; reasonCode: string; comment: string }, dryRun = false): Promise<Raised> {
  if (!input.comment.trim()) throw new DomainError('COMMENT_REQUIRED', 'A comment for Sales is required');
  return runCommand(db, actor.id, commandId, dryRun ? 'cr.check' : 'cr.raise.mixChange', async (tx) => {
    const c = await context(tx, actor, rfqId);
    await assertReason(tx, input.reasonCode, 'CR_PROC');
    const problems: string[] = [];
    const items: NewItem[] = [];
    const rfqWeeks = new Set((await tx.selectFrom('scm.RfqWeek').select('EtdWeek').where('RfqId', '=', rfqId).execute()).map((w) => w.EtdWeek));
    for (const red of input.reductions) {
      const l = await rfqLine(tx, rfqId, red.rfqLineId);
      const what = `${l.ProposedEtdWeek} · ${labelOf(l as unknown as Spec)}`;
      let qty = 0;
      try { qty = parseQty(red.qty, c.increment(l.Unit)); } catch { problems.push(`${what}: the quantity must be whole ${l.Unit}`); }
      if (qty <= 0) continue;
      if (l.Origin !== 'DEMAND' || !l.DemandLineId || l.IsCancelled) { problems.push(`${what}: only demand lines can be reduced`); continue; }
      if (fromDb(l.Awarded) > 0) problems.push(`${what}: part is awarded — not offered for a mix change`);
      if (qty > fromDb(l.Live)) problems.push(`${what}: ${formatQty(qty)} less, but only ${formatQty(fromDb(l.Live))} is in this RFQ`);
      const dl = c.lines.find((x) => x.LineId === l.DemandLineId);
      if (dl?.ChangeHoldCrId) problems.push(`${what} is already in ${await crNoOf(tx, dl.ChangeHoldCrId)}`);
      const spec: SpecInput = { majorCategory: l.MajorCategory, subMajorCategory: l.SubMajorCategory, size: l.Size, materialClass: l.MaterialClass, originCode: l.OriginCode, materialCode: l.MaterialCode, unit: l.Unit };
      items.push({ kind: 'MIX_REDUCE', etdWeek: l.ProposedEtdWeek, groupId: null, lineId: l.DemandLineId, before: null, after: { rfqLineId: l.RfqLineId, spec },
        effect: [{ ...spec, key: l.LineKey, delta: -qty }], requestedCount: null, requestedQty: qty });
    }
    for (const a of input.additions) {
      const it = await additionItem(tx, c, 'MIX_ADD', a.etdWeek, a.spec, a.qty, problems);
      if (!rfqWeeks.has(it.etdWeek)) problems.push(`${it.etdWeek}: a mix change adds only in the weeks of ${c.rfq.RfqNo}`);
      items.push(it);
    }
    if (!items.length) problems.push('Reduce a line or add a material');
    if (dryRun) return { dryRun: true as const, problems: [...new Set(problems)], items: items.length };
    const holdLines = items.map((i) => i.lineId).filter((x): x is string => !!x);
    return saveCr(tx, actor, c.demand, { crType: 'MIX_CHANGE', dept: 'PROCUREMENT', reasonCode: input.reasonCode, comment: input.comment, rfqId },
      items, [...new Set(problems)], holdLines, items.filter((i) => i.kind === 'MIX_ADD').map((i) => i.etdWeek));
  });
}
