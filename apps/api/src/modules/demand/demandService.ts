/**
 * Demand commands (spec 12, plan v5 Stage 1): create, save draft, submit,
 * accept, return, comment. The one place that changes a demand's workflow
 * status (hard rule 2). Every command runs through runCommand (duplicate-safe,
 * one transaction) and checks the demand's RowVer.
 */
import { sql } from 'kysely';
import type { DemandWorkflowStatus } from '../../db/schema.js';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { recordEvent } from '../workflow/events.js';
import { closeInbox, openInbox } from '../workflow/inbox.js';
import { fromDb } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import { createSlice } from '../workflow/slices.js';
import { addThreadEntry } from '../workflow/threads.js';
import { rowVerHex, updateWithRowVer, type Db, type Tx } from '../workflow/tx.js';
import { assertNoProblems, normalize, type DraftInput, type NormalWeek } from './content.js';
import { snapshotVersion } from './versions.js';

export const P_DEMAND = {
  open: 'demands.open', create: 'demand.create', submit: 'demand.submit', accept: 'demand.accept', return: 'demand.return',
  comment: 'demand.comment', attach: 'demand.attach',
} as const;

type DemandRow = { DemandId: string; DemandNo: string; CompanyCode: string; WorkflowStatus: DemandWorkflowStatus; SubmittedAt: Date | null; CreatedBy: number; RowVer: string };

/** Loads and locks the demand; 404 unless the actor may see it (demands.open + company). */
export async function lockDemand(tx: Tx, actor: Actor, demandId: string): Promise<DemandRow> {
  const d = (await sql<DemandRow>`
    SELECT DemandId, DemandNo, CompanyCode, WorkflowStatus, SubmittedAt, CreatedBy, ${rowVerHex()} AS RowVer
    FROM scm.Demand WITH (UPDLOCK, ROWLOCK) WHERE DemandId = ${demandId}`.execute(tx)).rows[0];
  if (!d || !actor.companies.has(d.CompanyCode) || !(actor.isAdmin || actor.permissions.has(P_DEMAND.open))) throw new NotFoundError(`Demand ${demandId}`);
  return { ...d, DemandId: String(d.DemandId) };
}

const assertStatus = (d: DemandRow, allowed: DemandWorkflowStatus[], what: string) => {
  if (!allowed.includes(d.WorkflowStatus)) throw new DomainError('BAD_STATE', `${d.DemandNo} is ${d.WorkflowStatus.toLowerCase()}; it cannot be ${what}.`, 409);
};

const link = (demandId: string) => `/demands/${demandId}`;

export async function createDemand(db: Db, actor: Actor, commandId: string, companyCode: string): Promise<{ demandId: string; demandNo: string }> {
  assertCan(actor, P_DEMAND.create, companyCode);
  return runCommand(db, actor.id, commandId, 'demand.create', async (tx) => {
    const seq = (await sql<{ n: string }>`SELECT NEXT VALUE FOR scm.DemandNoSeq AS n`.execute(tx)).rows[0].n;
    const demandNo = `D-${String(seq).padStart(6, '0')}`;
    const row = await tx.insertInto('scm.Demand').values({ DemandNo: demandNo, CompanyCode: companyCode, CreatedBy: actor.id, BaselineVersion: null, SubmittedAt: null, AcceptedAt: null, AcceptedBy: null })
      .output('inserted.DemandId').executeTakeFirstOrThrow();
    const demandId = String(row.DemandId);
    await recordEvent(tx, { type: 'DEMAND_CREATED', entityType: 'DEMAND', entityId: demandId, demandId, actorUserId: actor.id });
    return { demandId, demandNo };
  });
}

/**
 * Replaces the content of a draft/returned demand: weeks, container groups with
 * their composition, and the week x material lines worked out from them. Safe:
 * no slices exist before acceptance, and submitted content lives on in versions.
 */
async function writeContent(tx: Tx, demandId: string, weeks: NormalWeek[]): Promise<void> {
  await sql`DELETE i FROM scm.ContainerGroupItem i JOIN scm.ContainerGroup g ON g.ContainerGroupId = i.ContainerGroupId WHERE g.DemandId = ${demandId}`.execute(tx);
  await tx.deleteFrom('scm.ContainerGroup').where('DemandId', '=', demandId).execute();
  await tx.deleteFrom('scm.DemandKeyUom').where('DemandId', '=', demandId).execute();
  await tx.deleteFrom('scm.DemandLine').where('DemandId', '=', demandId).execute();
  await tx.deleteFrom('scm.DemandWeek').where('DemandId', '=', demandId).execute();
  let lineNumber = 0;
  const units = new Map<string, string>();
  for (const w of weeks) {
    const wk = await tx.insertInto('scm.DemandWeek').values({ DemandId: demandId, EtdWeek: w.etdWeek, ContainerCount: w.containerCount }).output('inserted.DemandWeekId').executeTakeFirstOrThrow();
    const weekId = String(wk.DemandWeekId);
    for (const [gi, g] of w.groups.entries()) {
      const grp = await tx.insertInto('scm.ContainerGroup')
        .values({ DemandId: demandId, DemandWeekId: weekId, GroupNumber: gi + 1, Name: g.name, ContainerCount: g.containerCount, CapacityQty: g.capacity || 1, Unit: g.unit })
        .output('inserted.ContainerGroupId').executeTakeFirstOrThrow();
      for (const it of g.items) {
        await tx.insertInto('scm.ContainerGroupItem').values({
          ContainerGroupId: String(grp.ContainerGroupId), SpecMode: it.specMode, MajorCategory: it.majorCategory, SubMajorCategory: it.subMajorCategory,
          Size: it.size, MaterialClass: it.materialClass, OriginCode: it.originCode, MaterialCode: it.materialCode, Unit: it.unit, ShareBp: it.shareBp, ComputedQty: it.qty,
        }).execute();
      }
    }
    for (const l of w.lines) {
      await tx.insertInto('scm.DemandLine').values({
        DemandId: demandId, DemandWeekId: weekId, LineNumber: ++lineNumber, SpecMode: l.specMode, MajorCategory: l.majorCategory,
        SubMajorCategory: l.subMajorCategory, Size: l.size, MaterialClass: l.materialClass, OriginCode: l.originCode, MaterialCode: l.materialCode,
        Unit: l.unit, RequestedQty: l.qty, ChangeHoldCrId: null,
      }).execute();
      units.set(l.key, l.unit);
    }
  }
  for (const [key, unit] of units) await tx.insertInto('scm.DemandKeyUom').values({ DemandId: demandId, LineKey: key, Unit: unit }).execute();
}

export async function saveDraft(db: Db, actor: Actor, commandId: string, demandId: string, rowVer: string, input: DraftInput): Promise<{ rowVer: string }> {
  return runCommand(db, actor.id, commandId, 'demand.save', async (tx) => {
    const d = await lockDemand(tx, actor, demandId);
    assertCan(actor, P_DEMAND.create, d.CompanyCode);
    assertStatus(d, ['DRAFT', 'RETURNED'], 'edited');
    const { weeks, problems } = await normalize(tx, input, await loadWfSettings(tx), false);
    assertNoProblems(problems, 'INVALID_DRAFT');
    await updateWithRowVer(tx, 'scm.Demand', 'DemandId', demandId, rowVer, sql`Notes = ${input.notes}`);
    await writeContent(tx, demandId, weeks);
    return { rowVer: await currentRowVer(tx, demandId) };
  });
}

const currentRowVer = async (tx: Tx, demandId: string) =>
  (await sql<{ v: string }>`SELECT ${rowVerHex()} AS v FROM scm.Demand WHERE DemandId = ${demandId}`.execute(tx)).rows[0].v;

/** "W14, W16 · 3 containers · 2 lines" for My work. */
async function summary(tx: Tx, demandId: string): Promise<string> {
  const weeks = await tx.selectFrom('scm.DemandWeek').select(['EtdWeek', 'ContainerCount']).where('DemandId', '=', demandId).orderBy('EtdWeek').execute();
  const lines = await tx.selectFrom('scm.DemandLine').select((eb) => eb.fn.countAll<number>().as('n')).where('DemandId', '=', demandId).where('IsActive', '=', true).executeTakeFirstOrThrow();
  const containers = weeks.reduce((s, w) => s + Number(w.ContainerCount), 0);
  return `${weeks.map((w) => w.EtdWeek.slice(5)).join(', ')} · ${containers} container(s) · ${Number(lines.n)} line(s)`;
}

/** Saves the editor's content, checks everything, and submits (first time: version 1 = baseline). */
export async function submitDemand(db: Db, actor: Actor, commandId: string, demandId: string, rowVer: string, input: DraftInput): Promise<{ version: number }> {
  return runCommand(db, actor.id, commandId, 'demand.submit', async (tx) => {
    const d = await lockDemand(tx, actor, demandId);
    assertCan(actor, P_DEMAND.submit, d.CompanyCode);
    assertStatus(d, ['DRAFT', 'RETURNED'], 'submitted');
    const { weeks, problems } = await normalize(tx, input, await loadWfSettings(tx), true);
    assertNoProblems(problems, 'NOT_SUBMITTABLE');
    const first = d.SubmittedAt == null;
    await updateWithRowVer(tx, 'scm.Demand', 'DemandId', demandId, rowVer,
      sql`Notes = ${input.notes}, WorkflowStatus = 'SUBMITTED'${first ? sql`, SubmittedAt = SYSUTCDATETIME()` : sql``}`);
    await writeContent(tx, demandId, weeks);
    const version = await snapshotVersion(tx, demandId, first ? 'SUBMIT' : 'RESUBMIT', null, actor.id);
    if (first) await tx.updateTable('scm.Demand').set({ BaselineVersion: version }).where('DemandId', '=', demandId).execute();

    const eventId = await recordEvent(tx, { type: first ? 'DEMAND_SUBMITTED' : 'DEMAND_RESUBMITTED', entityType: 'DEMAND', entityId: demandId, demandId, payload: { version }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'DEMAND', entityId: demandId, kind: 'SYSTEM', body: `${first ? 'Submitted' : 'Resubmitted'} to Procurement (version ${version})`, authorUserId: actor.id, eventId });
    await closeInbox(tx, 'DEMAND_RETURNED', 'DEMAND', demandId, actor.id);
    await openInbox(tx, {
      itemType: 'DEMAND_TO_ACCEPT', permission: P_DEMAND.accept, companyCode: d.CompanyCode, entityType: 'DEMAND', entityId: demandId,
      number: d.DemandNo, title: await summary(tx, demandId), note: first ? null : `Resubmitted (version ${version})`, link: link(demandId), raisedBy: actor.id,
    });
    return { version };
  });
}

/** Accept: one Open slice per active line, holding its full quantity; the clock is the first submission. */
export async function acceptDemand(db: Db, actor: Actor, commandId: string, demandId: string, rowVer: string): Promise<{ slices: number }> {
  return runCommand(db, actor.id, commandId, 'demand.accept', async (tx) => {
    const d = await lockDemand(tx, actor, demandId);
    assertCan(actor, P_DEMAND.accept, d.CompanyCode);
    assertStatus(d, ['SUBMITTED'], 'accepted');
    // Separation of duties (plan v5 §0.4): the person who raised the demand does not accept it (administrators excepted).
    if (!actor.isAdmin && Number(d.CreatedBy) === actor.id) throw new DomainError('OWN_DEMAND', 'You created this demand, so someone else in Procurement must accept it', 403);
    await updateWithRowVer(tx, 'scm.Demand', 'DemandId', demandId, rowVer, sql`WorkflowStatus = 'ACCEPTED', AcceptedAt = SYSUTCDATETIME(), AcceptedBy = ${actor.id}`);
    const lines = await tx
      .selectFrom('scm.DemandLine as l').innerJoin('scm.DemandWeek as w', 'w.DemandWeekId', 'l.DemandWeekId')
      .select(['l.LineId', 'l.RequestedQty', 'w.EtdWeek']).where('l.DemandId', '=', demandId).where('l.IsActive', '=', true).orderBy('l.LineId').execute();
    for (const l of lines) {
      await createSlice(tx, {
        lineId: String(l.LineId), qty: fromDb(l.RequestedQty), businessOrigin: 'SALES', originDemandId: demandId, originLineId: String(l.LineId),
        approvedWeek: l.EtdWeek, clock: d.SubmittedAt!,
      }, { actorUserId: actor.id, docType: 'DEMAND', docId: demandId, comment: 'Accepted' });
    }
    const eventId = await recordEvent(tx, { type: 'DEMAND_ACCEPTED', entityType: 'DEMAND', entityId: demandId, demandId, payload: { lines: lines.length }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'DEMAND', entityId: demandId, kind: 'SYSTEM', body: 'Accepted by Procurement', authorUserId: actor.id, eventId });
    await closeInbox(tx, 'DEMAND_TO_ACCEPT', 'DEMAND', demandId, actor.id);
    return { slices: lines.length };
  });
}

export async function returnDemand(db: Db, actor: Actor, commandId: string, demandId: string, rowVer: string, comment: string): Promise<{ returned: true }> {
  if (!comment.trim()) throw new DomainError('COMMENT_REQUIRED', 'A comment is required to return a demand');
  return runCommand(db, actor.id, commandId, 'demand.return', async (tx) => {
    const d = await lockDemand(tx, actor, demandId);
    assertCan(actor, P_DEMAND.return, d.CompanyCode);
    assertStatus(d, ['SUBMITTED'], 'returned');
    await updateWithRowVer(tx, 'scm.Demand', 'DemandId', demandId, rowVer, sql`WorkflowStatus = 'RETURNED'`);
    const eventId = await recordEvent(tx, { type: 'DEMAND_RETURNED', entityType: 'DEMAND', entityId: demandId, demandId, payload: { comment }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'DEMAND', entityId: demandId, kind: 'CLARIFICATION', body: `Returned: ${comment.trim()}`, authorUserId: actor.id, eventId });
    await closeInbox(tx, 'DEMAND_TO_ACCEPT', 'DEMAND', demandId, actor.id);
    await openInbox(tx, {
      itemType: 'DEMAND_RETURNED', permission: P_DEMAND.submit, companyCode: d.CompanyCode, entityType: 'DEMAND', entityId: demandId,
      number: d.DemandNo, title: await summary(tx, demandId), note: comment.trim().slice(0, 1000), link: link(demandId), raisedBy: actor.id,
    });
    return { returned: true };
  });
}

/**
 * Take back (Sales, spec 12): a submitted demand not yet accepted goes back to Draft so Sales
 * can change it and submit again (next version). It leaves Procurement's My work.
 */
export async function recallDemand(db: Db, actor: Actor, commandId: string, demandId: string, rowVer: string, comment: string): Promise<{ recalled: true }> {
  return runCommand(db, actor.id, commandId, 'demand.recall', async (tx) => {
    const d = await lockDemand(tx, actor, demandId);
    assertCan(actor, P_DEMAND.submit, d.CompanyCode);
    assertStatus(d, ['SUBMITTED'], 'taken back (only a demand Procurement has not accepted yet can be)');
    await updateWithRowVer(tx, 'scm.Demand', 'DemandId', demandId, rowVer, sql`WorkflowStatus = 'DRAFT'`);
    const text = comment.trim();
    const eventId = await recordEvent(tx, { type: 'DEMAND_RECALLED', entityType: 'DEMAND', entityId: demandId, demandId, payload: { comment: text }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'DEMAND', entityId: demandId, kind: 'SYSTEM', body: `Taken back by Sales to change it${text ? `: ${text}` : ''}`, authorUserId: actor.id, eventId });
    await closeInbox(tx, 'DEMAND_TO_ACCEPT', 'DEMAND', demandId, actor.id);
    return { recalled: true };
  });
}

export async function addComment(db: Db, actor: Actor, commandId: string, demandId: string, body: string): Promise<{ entryId: string }> {
  if (!body.trim()) throw new DomainError('COMMENT_REQUIRED', 'Write a comment first');
  return runCommand(db, actor.id, commandId, 'demand.comment', async (tx) => {
    const d = await lockDemand(tx, actor, demandId);
    assertCan(actor, P_DEMAND.comment, d.CompanyCode);
    return { entryId: await addThreadEntry(tx, { entityType: 'DEMAND', entityId: demandId, kind: 'COMMENT', body: body.trim(), authorUserId: actor.id }) };
  });
}
