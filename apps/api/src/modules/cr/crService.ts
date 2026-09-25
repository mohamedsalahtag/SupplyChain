/**
 * Raising and withdrawing change requests (spec 14, plan v5 Stage 2): the
 * container change is turned into items, pre-checked, held, and put on the other
 * department's My work. Deciding and applying live in crApply.ts.
 */
import { sql } from 'kysely';
import { incrementFor, normalize, type DraftInput } from '../demand/content.js';
import { assertCan, type Actor } from '../workflow/access.js';
import { assertBelongs } from '../workflow/belongs.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { recordEvent } from '../workflow/events.js';
import { closeInbox, openInbox } from '../workflow/inbox.js';
import { isoWeekOf } from '../workflow/isoWeek.js';
import { formatQty, fromDb, parseQty, type Milli } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import { addThreadEntry } from '../workflow/threads.js';
import { updateWithRowVer, type Db, type Tx } from '../workflow/tx.js';
import { crTypeOf, diffGroups, type DiffItem, type GroupState } from './diff.js';
import { undoProcRequest } from './procApply.js';

export const P_CR = {
  open: 'crs.open', raiseSales: 'cr.raise.sales', raiseProcurement: 'cr.raise.procurement',
  decideSales: 'cr.decide.sales', decideProcurement: 'cr.decide.procurement', withdraw: 'cr.withdraw',
} as const;
export const CR_TYPE_LABEL: Record<string, string> = {
  CHANGE_CONTAINERS: 'Change containers', CANCEL_WEEK: 'Cancel week', CANCEL_DEMAND: 'Cancel demand', NOT_SOURCED: 'Not sourced',
  ADD_TO_DEMAND: 'Add to demand', WEEK_SHIFT: 'Week shift', MIX_CHANGE: 'Mix change',
};
export const decidePermission = (dept: 'SALES' | 'PROCUREMENT') => (dept === 'SALES' ? P_CR.decideSales : P_CR.decideProcurement);

export type DemandRow = { DemandId: string; DemandNo: string; CompanyCode: string; WorkflowStatus: string };

export async function acceptedDemand(tx: Tx, actor: Actor, demandId: string): Promise<DemandRow> {
  const d = (await sql<DemandRow>`SELECT DemandId, DemandNo, CompanyCode, WorkflowStatus FROM scm.Demand WITH (UPDLOCK) WHERE DemandId = ${demandId}`.execute(tx)).rows[0];
  if (!d || !actor.companies.has(d.CompanyCode)) throw new NotFoundError(`Demand ${demandId}`);
  if (d.WorkflowStatus !== 'ACCEPTED') throw new DomainError('BAD_STATE', `${d.DemandNo} is not accepted yet: edit or return it instead of a change request`);
  return { ...d, DemandId: String(d.DemandId) };
}

/** Today's active container groups of the demand, in the shape the diff compares. */
export async function currentGroups(db: Db | Tx, demandId: string): Promise<GroupState[]> {
  const groups = await db.selectFrom('scm.ContainerGroup as g').innerJoin('scm.DemandWeek as w', 'w.DemandWeekId', 'g.DemandWeekId')
    .select(['g.ContainerGroupId', 'w.EtdWeek', 'g.Name', 'g.ContainerCount', 'g.CapacityQty', 'g.Unit'])
    .where('g.DemandId', '=', demandId).where('g.IsActive', '=', true).orderBy('w.EtdWeek').orderBy('g.GroupNumber').execute();
  if (!groups.length) return [];
  const items = await db.selectFrom('scm.ContainerGroupItem')
    .select(['ContainerGroupId', 'MajorCategory', 'SubMajorCategory', 'Size', 'MaterialClass', 'OriginCode', 'MaterialCode', 'ShareBp', 'LineKey'])
    .where('ContainerGroupId', 'in', groups.map((g) => String(g.ContainerGroupId))).orderBy('ContainerGroupItemId').execute();
  return groups.map((g) => ({
    groupId: String(g.ContainerGroupId), etdWeek: g.EtdWeek, name: g.Name, containerCount: Number(g.ContainerCount), capacity: fromDb(g.CapacityQty), unit: g.Unit,
    items: items.filter((i) => String(i.ContainerGroupId) === String(g.ContainerGroupId)).map((i) => ({
      majorCategory: i.MajorCategory, subMajorCategory: i.SubMajorCategory, size: i.Size, materialClass: i.MaterialClass, originCode: i.OriginCode,
      materialCode: i.MaterialCode, key: i.LineKey, shareBp: Number(i.ShareBp),
    })),
  }));
}

export type ProposedInput = { weeks: (DraftInput['weeks'][number] & { groups: (DraftInput['weeks'][number]['groups'][number] & { groupId?: string | null })[] })[] };

export type LineInfo = { LineId: string; EtdWeek: string; LineKey: string; Unit: string; ChangeHoldCrId: string | null; cancellable: Milli; awardedOrLater: Milli; open: Milli };

export async function linesOf(db: Db | Tx, demandId: string): Promise<LineInfo[]> {
  const rows = await db.selectFrom('scm.vLineLedger as g').innerJoin('scm.DemandLine as l', 'l.LineId', 'g.LineId')
    .select(['g.LineId', 'g.EtdWeek', 'g.LineKey', 'g.Unit', 'l.ChangeHoldCrId', 'g.OpenQty', 'g.InRfqQty', 'g.QuotedQty', 'g.AwardedQty', 'g.HandedOffQty', 'g.PoPrepQty', 'g.PoSubmittedQty', 'g.PoCreatedQty'])
    .where('g.DemandId', '=', demandId).where('g.IsActive', '=', true).execute();
  return rows.map((r) => ({
    LineId: String(r.LineId), EtdWeek: r.EtdWeek, LineKey: r.LineKey, Unit: r.Unit, ChangeHoldCrId: r.ChangeHoldCrId ? String(r.ChangeHoldCrId) : null,
    open: fromDb(r.OpenQty),
    cancellable: [r.OpenQty, r.InRfqQty, r.QuotedQty, r.AwardedQty, r.HandedOffQty, r.PoPrepQty].reduce((s, x) => s + fromDb(x), 0),
    awardedOrLater: [r.AwardedQty, r.HandedOffQty, r.PoPrepQty, r.PoSubmittedQty, r.PoCreatedQty].reduce((s, x) => s + fromDb(x), 0),
  }));
}

export const crNoOf = async (db: Db | Tx, crId: string | null) =>
  crId ? ((await db.selectFrom('scm.ChangeRequest').select('CrNo').where('CrId', '=', crId).executeTakeFirst())?.CrNo ?? `CR ${crId}`) : '';

/** Turns the editor's proposal into items and checks them (no writes). */
export async function planContainerChange(tx: Tx, demand: DemandRow, input: ProposedInput) {
  const settings = await loadWfSettings(tx);
  const current = await currentGroups(tx, demand.DemandId);
  const existingWeeks = new Set((await tx.selectFrom('scm.DemandWeek').select('EtdWeek').where('DemandId', '=', demand.DemandId).execute()).map((w) => w.EtdWeek));
  const { weeks, problems } = await normalize(tx, { notes: '', weeks: input.weeks }, settings, { strict: false, mergeTwins: false, allowPastWeeks: existingWeeks });

  // Pair each normalized group with the id the editor sent (same order).
  const proposed: GroupState[] = [];
  for (const w of weeks) {
    const sent = input.weeks.find((x) => x.etdWeek === w.etdWeek)!;
    w.groups.forEach((g, i) => {
      const where = `${w.etdWeek} group ${i + 1}`;
      if (!g.complete) problems.push(`${where}: shares must total 100% and every material must be valid.`);
      proposed.push({
        groupId: sent.groups[i]?.groupId ?? null, etdWeek: w.etdWeek, name: g.name, containerCount: g.containerCount, capacity: g.capacity, unit: g.unit,
        items: g.items.map((it) => ({
          majorCategory: it.majorCategory, subMajorCategory: it.subMajorCategory, size: it.size, materialClass: it.materialClass, originCode: it.originCode,
          materialCode: it.materialCode, key: it.key, shareBp: it.shareBp,
        })),
      });
    });
  }
  const items = diffGroups(current, proposed, (unit) => incrementFor(settings, unit));
  if (items.length === 0) problems.push('Nothing has changed.');
  problems.push(...(await precheck(tx, demand, items)));
  return { items, problems, crType: crTypeOf(items, current.length) };
}

/** Plan v5 §2 rule 3: cancellable quantity, holds, awarded quantity on composition changes, units, past weeks. */
async function precheck(tx: Tx, demand: DemandRow, items: DiffItem[]): Promise<string[]> {
  const problems: string[] = [];
  const lines = await linesOf(tx, demand.DemandId);
  const lineOf = (week: string, key: string) => lines.find((l) => l.EtdWeek === week && l.LineKey === key);
  const weekHolds = await tx.selectFrom('scm.WeekHold').select(['EtdWeek', 'CrId']).where('DemandId', '=', demand.DemandId).execute();
  const units = new Map((await tx.selectFrom('scm.DemandKeyUom').select(['LineKey', 'Unit']).where('DemandId', '=', demand.DemandId).execute()).map((u) => [u.LineKey, u.Unit]));
  const thisWeek = isoWeekOf(new Date());
  const label = (e: { subMajorCategory: string; size: string; materialClass: string; originCode: string; materialCode: string | null }) =>
    `${e.subMajorCategory} ${e.size || 'any size'} ${e.materialClass || 'any class'} ${e.originCode}${e.materialCode ? ` ${e.materialCode}` : ''}`;

  for (const w of new Set(items.map((i) => i.etdWeek))) {
    const h = weekHolds.find((x) => x.EtdWeek === w);
    if (h) problems.push(`${w} is already in ${await crNoOf(tx, String(h.CrId))}.`);
  }
  const reductions = new Map<string, number>();
  for (const it of items) {
    const adds = it.effect.some((e) => e.delta > 0);
    if (adds && it.etdWeek < thisWeek) problems.push(`${it.etdWeek} is in the past: containers can no longer be added there.`);
    for (const e of it.effect) {
      const line = lineOf(it.etdWeek, e.key);
      if (line?.ChangeHoldCrId) problems.push(`${it.etdWeek} · ${label(e)} is already in ${await crNoOf(tx, line.ChangeHoldCrId)}.`);
      if (e.delta < 0) reductions.set(`${it.etdWeek}|${e.key}`, (reductions.get(`${it.etdWeek}|${e.key}`) ?? 0) - e.delta);
      const unit = units.get(e.key);
      if (e.delta > 0 && unit && unit !== e.unit) problems.push(`${label(e)} is ordered in ${unit} on this demand, not ${e.unit}.`);
    }
    if (it.kind === 'GROUP_COMPOSITION') {
      for (const key of new Set([...(it.before?.items ?? []), ...(it.after?.items ?? [])].map((i) => i.key))) {
        const line = lineOf(it.etdWeek, key);
        if (line && line.awardedOrLater > 0) problems.push(`${it.etdWeek}: part of ${key.split('|').slice(1, 5).join(' ')} is already awarded — un-award it before changing the composition.`);
      }
    }
  }
  for (const [wk, qty] of reductions) {
    const [week, key] = [wk.slice(0, 8), wk.slice(9)];
    const line = lineOf(week, key);
    const can = line?.cancellable ?? 0;
    if (qty > can) problems.push(`${week} · ${key.split('|').slice(1, 5).join(' ')}: ${formatQty(qty)} to cancel, but only ${formatQty(can)} is still cancellable (the rest is sent to SAP).`);
  }
  return [...new Set(problems)];
}

export async function assertReason(tx: Tx, reasonCode: string, context: 'CR_SALES' | 'CR_PROC') {
  const r = await tx.selectFrom('scm.ReasonCode').select(['Context', 'IsActive']).where('ReasonCode', '=', reasonCode).executeTakeFirst();
  if (!r || !r.IsActive || r.Context !== context) throw new DomainError('BAD_REASON', `Choose an active ${context === 'CR_SALES' ? 'Sales' : 'Procurement'} change-request reason`);
}

export type NewItem = { kind: string; etdWeek: string; groupId: string | null; lineId: string | null; before: unknown; after: unknown; effect: unknown; requestedCount: number | null; requestedQty: Milli | null };

/** Saves the CR as Submitted (holds + My work) or Blocked (reasons, nothing held). */
export async function saveCr(tx: Tx, actor: Actor, demand: DemandRow, head: { crType: string; dept: 'SALES' | 'PROCUREMENT'; reasonCode: string; comment: string; rfqId?: string | null },
  items: NewItem[], problems: string[], holdLines: string[], holdWeeks: string[]) {
  const seq = (await sql<{ n: string }>`SELECT NEXT VALUE FOR scm.CrNoSeq AS n`.execute(tx)).rows[0].n;
  const crNo = `CR-${String(seq).padStart(6, '0')}`;
  const status = problems.length ? 'BLOCKED' : 'SUBMITTED';
  const cr = await tx.insertInto('scm.ChangeRequest').values({
    CrNo: crNo, DemandId: demand.DemandId, CompanyCode: demand.CompanyCode, CrType: head.crType as never, RaisedByDept: head.dept, Status: status,
    ReasonCode: head.reasonCode, Comment: head.comment.trim(), BlockedReason: problems.length ? JSON.stringify(problems) : null, RaisedBy: actor.id,
    DecidedBy: null, DecidedAt: null, DecisionComment: null, AppliedAt: null, RfqId: head.rfqId ?? null,
  }).output('inserted.CrId').executeTakeFirstOrThrow();
  const crId = String(cr.CrId);
  let n = 0;
  for (const it of items) {
    await tx.insertInto('scm.ChangeRequestItem').values({
      CrId: crId, ItemNo: ++n, ItemKind: it.kind as never, EtdWeek: it.etdWeek, ContainerGroupId: it.groupId, LineId: it.lineId,
      BeforeJson: it.before == null ? null : JSON.stringify(it.before), AfterJson: it.after == null ? null : JSON.stringify(it.after), EffectJson: JSON.stringify(it.effect),
      RequestedCount: it.requestedCount, RequestedQty: it.requestedQty, LedgerAtSubmit: null, Decision: null, ApprovedCount: null, ApprovedQty: null, AppliedQty: null, ApplyMessage: null,
    }).execute();
  }
  const eventId = await recordEvent(tx, { type: status === 'BLOCKED' ? 'CR_BLOCKED' : 'CR_SUBMITTED', entityType: 'CR', entityId: crId, demandId: demand.DemandId, payload: { crNo, problems }, actorUserId: actor.id });
  await addThreadEntry(tx, { entityType: 'CR', entityId: crId, kind: 'COMMENT', body: head.comment.trim(), authorUserId: actor.id, eventId });
  if (status === 'SUBMITTED') {
    for (const lineId of new Set(holdLines)) {
      await tx.insertInto('scm.LineHold').values({ LineId: lineId, CrId: crId }).execute();
      await tx.updateTable('scm.DemandLine').set({ ChangeHoldCrId: crId }).where('LineId', '=', lineId).execute();
    }
    for (const w of new Set(holdWeeks)) await tx.insertInto('scm.WeekHold').values({ DemandId: demand.DemandId, EtdWeek: w, CrId: crId }).execute();
    await addThreadEntry(tx, { entityType: 'DEMAND', entityId: demand.DemandId, kind: 'SYSTEM', body: `${crNo} submitted (${head.crType.replace(/_/g, ' ').toLowerCase()})`, authorUserId: actor.id, eventId });
    await openInbox(tx, {
      itemType: 'CR_TO_DECIDE', permission: decidePermission(head.dept), companyCode: demand.CompanyCode, entityType: 'CR', entityId: crId, number: crNo,
      title: `${CR_TYPE_LABEL[head.crType] ?? head.crType} · ${demand.DemandNo} · ${items.length} item(s)`,
      note: head.comment.trim().slice(0, 1000), link: `/change-requests/${crId}`, raisedBy: actor.id, excludeUserId: actor.id,
    });
  }
  return { crId, crNo, status, problems };
}

/** Sales: the container change as requested in the editor (spec 14). */
export async function raiseContainerChange(db: Db, actor: Actor, commandId: string, demandId: string, input: ProposedInput & { reasonCode: string; comment: string }) {
  if (!input.comment.trim()) throw new DomainError('COMMENT_REQUIRED', 'A comment is required');
  return runCommand(db, actor.id, commandId, 'cr.raise.sales', async (tx) => {
    const demand = await acceptedDemand(tx, actor, demandId);
    assertCan(actor, P_CR.raiseSales, demand.CompanyCode);
    await assertReason(tx, input.reasonCode, 'CR_SALES');
    const plan = await planContainerChange(tx, demand, input);
    const lines = await linesOf(tx, demand.DemandId);
    const holdLines = plan.items.flatMap((i) => i.effect.map((e) => lines.find((l) => l.EtdWeek === i.etdWeek && l.LineKey === e.key)?.LineId)).filter((x): x is string => !!x);
    return saveCr(tx, actor, demand, { crType: plan.crType, dept: 'SALES', reasonCode: input.reasonCode, comment: input.comment },
      plan.items.map((i) => ({ kind: i.kind, etdWeek: i.etdWeek, groupId: i.groupId, lineId: null, before: i.before, after: i.after, effect: i.effect, requestedCount: i.after?.containerCount ?? 0, requestedQty: null })),
      plan.problems, holdLines, plan.items.map((i) => i.etdWeek));
  });
}

/** Procurement: quantity that cannot be sourced (Open only), and optionally a lower container count per week. */
export async function raiseNotSourced(
  db: Db, actor: Actor, commandId: string, demandId: string,
  input: { lines: { lineId: string; qty: string }[]; weeks: { etdWeek: string; containerCount: number }[]; reasonCode: string; comment: string },
) {
  if (!input.comment.trim()) throw new DomainError('COMMENT_REQUIRED', 'A comment is required');
  return runCommand(db, actor.id, commandId, 'cr.raise.procurement', async (tx) => {
    const demand = await acceptedDemand(tx, actor, demandId);
    assertCan(actor, P_CR.raiseProcurement, demand.CompanyCode);
    await assertReason(tx, input.reasonCode, 'CR_PROC');
    await assertBelongs(tx, 'LINE', input.lines.map((l) => l.lineId), demand.DemandId);
    const lines = await linesOf(tx, demand.DemandId);
    const dbWeeks = await tx.selectFrom('scm.DemandWeek').select(['EtdWeek', 'ContainerCount']).where('DemandId', '=', demand.DemandId).execute();
    const holds = await tx.selectFrom('scm.WeekHold').select('EtdWeek').where('DemandId', '=', demand.DemandId).execute();
    const problems: string[] = [];
    const items: NewItem[] = [];
    for (const l of input.lines) {
      const line = lines.find((x) => x.LineId === l.lineId)!;
      let qty = 0;
      try {
        qty = parseQty(l.qty, 1000);
      } catch (e) {
        problems.push(`${line.EtdWeek}: ${(e as Error).message} (whole units only)`);
        continue;
      }
      if (qty > line.open) problems.push(`${line.EtdWeek} · ${line.LineKey.split('|').slice(1, 5).join(' ')}: ${formatQty(qty)} not sourced, but only ${formatQty(line.open)} is Open.`);
      if (line.ChangeHoldCrId) problems.push(`${line.EtdWeek}: the line is already in ${await crNoOf(tx, line.ChangeHoldCrId)}.`);
      items.push({ kind: 'QTY_NOT_SOURCED', etdWeek: line.EtdWeek, groupId: null, lineId: line.LineId, before: { open: formatQty(line.open) }, after: null,
        effect: [{ key: line.LineKey, unit: line.Unit, delta: -qty }], requestedCount: null, requestedQty: qty });
    }
    for (const w of input.weeks) {
      const cur = dbWeeks.find((x) => x.EtdWeek === w.etdWeek);
      if (!cur) throw new NotFoundError(`Week ${w.etdWeek}`);
      if (w.containerCount >= Number(cur.ContainerCount)) problems.push(`${w.etdWeek}: the container count can only be lowered here (now ${cur.ContainerCount}).`);
      if (holds.some((h) => h.EtdWeek === w.etdWeek)) problems.push(`${w.etdWeek} is already in another change request.`);
      items.push({ kind: 'WEEK_CONTAINERS', etdWeek: w.etdWeek, groupId: null, lineId: null, before: { containerCount: Number(cur.ContainerCount) }, after: { containerCount: w.containerCount },
        effect: [], requestedCount: w.containerCount, requestedQty: null });
    }
    if (items.length === 0) problems.push('Choose at least one line or week.');
    return saveCr(tx, actor, demand, { crType: 'NOT_SOURCED', dept: 'PROCUREMENT', reasonCode: input.reasonCode, comment: input.comment },
      items, problems, items.filter((i) => i.lineId).map((i) => i.lineId!), input.weeks.map((w) => w.etdWeek));
  });
}

/** Releases every hold of a change request (operational lock rows only). */
export async function releaseHolds(tx: Tx, crId: string): Promise<void> {
  await tx.updateTable('scm.DemandLine').set({ ChangeHoldCrId: null }).where('ChangeHoldCrId', '=', crId).execute();
  await tx.deleteFrom('scm.LineHold').where('CrId', '=', crId).execute();
  await tx.deleteFrom('scm.WeekHold').where('CrId', '=', crId).execute();
}

/** The raiser takes a Submitted request back: holds released, nothing changes. */
export async function withdrawCr(db: Db, actor: Actor, commandId: string, crId: string, rowVer: string, comment: string) {
  if (!comment.trim()) throw new DomainError('COMMENT_REQUIRED', 'Say why you withdraw it');
  return runCommand(db, actor.id, commandId, 'cr.withdraw', async (tx) => {
    const cr = await tx.selectFrom('scm.ChangeRequest').select(['CrId', 'CrNo', 'DemandId', 'CompanyCode', 'Status', 'RaisedBy']).where('CrId', '=', crId).executeTakeFirst();
    if (!cr || !actor.companies.has(cr.CompanyCode)) throw new NotFoundError(`Change request ${crId}`);
    assertCan(actor, P_CR.withdraw, cr.CompanyCode);
    if (Number(cr.RaisedBy) !== actor.id) throw new DomainError('FORBIDDEN', 'Only the person who raised it can withdraw it', 403);
    if (cr.Status !== 'SUBMITTED') throw new DomainError('BAD_STATE', `${cr.CrNo} is ${cr.Status.toLowerCase()}; it can no longer be withdrawn`, 409);
    await updateWithRowVer(tx, 'scm.ChangeRequest', 'CrId', crId, rowVer, sql`Status = 'WITHDRAWN'`);
    await undoProcRequest(tx, crId); // a proposed RFQ line is cancelled, a proposed week reverts (spec 19)
    await releaseHolds(tx, crId);
    await closeInbox(tx, 'CR_TO_DECIDE', 'CR', crId, actor.id);
    const eventId = await recordEvent(tx, { type: 'CR_WITHDRAWN', entityType: 'CR', entityId: crId, demandId: String(cr.DemandId), payload: { comment }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'CR', entityId: crId, kind: 'COMMENT', body: `Withdrawn: ${comment.trim()}`, authorUserId: actor.id, eventId });
    return { withdrawn: true };
  });
}
