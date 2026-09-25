/**
 * Award by containers (spec 20 revision 1). Procurement picks, per container group, how many containers each
 * supplier ships; the award items (per RFQ line × supplier) are worked out as containers × the group's quantity per
 * container. Above a supplier's offered containers is allowed and logged. Containers added here grow the demand as
 * Procurement-added quantity. Un-award works by containers too.
 */
import { sql, type RawBuilder } from 'kysely';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { eventSql } from '../workflow/events.js';
import { formatQty, fromDb, type Milli } from '../workflow/qty.js';
import { runSliceBatch } from '../workflow/sliceBatch.js';
import { addThreadEntry, threadEntrySql } from '../workflow/threads.js';
import { rowVerHex, updateWithRowVer, type Db, type Tx } from '../workflow/tx.js';
import { refreshHandoffTasks } from '../handoff/handoffService.js';
import { resetAck } from './ack.js';
import { checkAward, currentQuotes, type AwardInput } from './awardCheck.js';
import { lockItem, P_AWARD, unawardQty, writeAward } from './awardService.js';
import { loadGrid, type GridGroup } from './containerGrid.js';

export type ContainerAwardInput = {
  containers: { groupId: string; supplierCode: string; count: number }[];
  added: { groupId: string; count: number }[];
  other: { rfqLineId: string; supplierCode: string; qty: string }[];
  shipments: { supplierCode: string; etdWeek: string; confirmedEtd?: string | null; note?: string }[];
  comment: string;
};

const qtyText = (m: Milli) => formatQty(m);

async function lockRfq(tx: Tx, actor: Actor, rfqId: string) {
  const rfq = (await sql<{ RfqId: string; RfqNo: string; DemandId: string; CompanyCode: string; ManualStatus: string }>`
    SELECT RfqId, RfqNo, DemandId, CompanyCode, ManualStatus FROM scm.Rfq WITH (UPDLOCK) WHERE RfqId = ${rfqId}`.execute(tx)).rows[0];
  if (!rfq || !actor.companies.has(rfq.CompanyCode)) throw new NotFoundError(`RFQ ${rfqId}`);
  assertCan(actor, P_AWARD.manage, rfq.CompanyCode);
  return { ...rfq, RfqId: String(rfq.RfqId), DemandId: String(rfq.DemandId) };
}

/**
 * + Add container, all groups in one batch: each group, its demand week, its lines (new Procurement-origin quantity,
 * already Quoted on the RFQ line) and the RFQ week grow. The grid is updated in memory to match.
 */
async function growGroups(tx: Tx, actor: Actor, r: { RfqId: string; RfqNo: string; DemandId: string }, adds: { g: GridGroup; count: number }[]) {
  const parts: RawBuilder<unknown>[] = [];
  let n = 0;
  for (const { g, count } of adds) {
    const name = g.name || 'a container group';
    for (const i of g.items) {
      const l = i.line!;
      const delta = i.perContainer * count;
      const slice = sql.raw(`@slice${n}`);
      parts.push(sql`UPDATE scm.ContainerGroupItem SET ComputedQty = ComputedQty + ${delta} WHERE ContainerGroupItemId = ${i.itemId};
UPDATE scm.DemandLine SET RequestedQty = RequestedQty + ${delta} WHERE LineId = ${l.DemandLineId};
UPDATE scm.RfqLine SET AskedQty = AskedQty + ${delta} WHERE RfqLineId = ${l.RfqLineId};
INSERT INTO scm.QtySlice (LineId, Qty, ExecState, BusinessOrigin, ArrivedVia, OriginDemandId, OriginLineId, ApprovedEtdWeek, EffectiveSubmittedAt, RfqLineId)
  VALUES (${l.DemandLineId}, ${delta}, 'QUOTED', 'PROCUREMENT', 'DIRECT', ${r.DemandId}, ${l.DemandLineId}, ${g.week}, SYSUTCDATETIME(), ${l.RfqLineId});
DECLARE ${slice} bigint = SCOPE_IDENTITY();
INSERT INTO scm.SliceHistory (SliceId, Action, TriggerName, FromState, ToState, Qty, RelatedSliceId, ReasonCode, DocType, DocId, Comment, ActorUserId)
  VALUES (${slice}, 'CREATE', NULL, NULL, 'QUOTED', ${delta}, NULL, NULL, 'RFQ', ${r.RfqId}, ${`Added at award: ${count} container(s) of ${name}`}, ${actor.id});`);
      l.Quoted = String(fromDb(l.Quoted) + delta); // the grid in memory follows
      n++;
    }
    parts.push(sql`UPDATE scm.ContainerGroup SET ContainerCount = ContainerCount + ${count} WHERE ContainerGroupId = ${g.groupId};
UPDATE scm.DemandWeek SET ContainerCount = ContainerCount + ${count} WHERE DemandId = ${r.DemandId} AND EtdWeek = ${g.week};
UPDATE scm.RfqWeek SET ContainerCount = ContainerCount + ${count} WHERE RfqId = ${r.RfqId} AND EtdWeek = ${g.week};
${eventSql(`ev${n}`, { type: 'AWARD_CONTAINERS_ADDED', entityType: 'RFQ', entityId: r.RfqId, demandId: r.DemandId, payload: { groupId: g.groupId, week: g.week, count }, actorUserId: actor.id })}
${threadEntrySql(n, { entityType: 'DEMAND', entityId: r.DemandId, kind: 'SYSTEM', body: `Procurement added ${count} container(s) of ${name} in ${g.week} at award (${r.RfqNo})`, authorUserId: actor.id }, `ev${n}`)}`);
    n++;
    g.containerCount += count;
    g.available += count;
  }
  for (let i = 0; i < parts.length; i += 20) await runSliceBatch(tx, parts.slice(i, i + 20));
}

export async function awardContainers(db: Db, actor: Actor, commandId: string, rfqId: string, rfqRowVer: string, input: ContainerAwardInput) {
  return runCommand(db, actor.id, commandId, 'award.containers', async (tx) => {
    const r = await lockRfq(tx, actor, rfqId);
    await updateWithRowVer(tx, 'scm.Rfq', 'RfqId', r.RfqId, rfqRowVer, sql`ManualStatus = ManualStatus`); // the grid is what the buyer saw
    const problems: string[] = [];
    const picks = input.containers.filter((c) => c.count > 0);
    if (!picks.length && !input.other.some((o) => Number(o.qty) > 0)) problems.push('Give at least one container to a supplier');

    // + Add container first, so the added containers can be awarded in the same step.
    const grid = await loadGrid(tx, r);
    const addedBy = new Map<string, number>();
    for (const a of input.added.filter((x) => x.count > 0)) {
      const g = grid.groups.find((x) => x.groupId === a.groupId);
      if (!g) { problems.push(`Container group ${a.groupId} is not on this RFQ`); continue; }
      if (g.blocker) { problems.push(`${g.week} · ${g.name}: ${g.blocker}`); continue; }
      if (!Number.isInteger(a.count) || a.count > 50) { problems.push(`${g.week} · ${g.name}: add 1 to 50 containers`); continue; }
      addedBy.set(g.groupId, a.count);
    }
    if (problems.length) throw new DomainError('NOT_AWARDABLE', 'The award cannot be made', 422, { problems });
    if (addedBy.size) await growGroups(tx, actor, r, [...addedBy].map(([groupId, count]) => ({ g: grid.groups.find((x) => x.groupId === groupId)!, count })));

    // Containers → quantities per RFQ line × supplier.
    const quotes = await currentQuotes(tx, r.RfqId);
    const hasQuote = (s: string, w: string, k: string) => quotes.some((q) => q.SupplierCode === s && q.EtdWeek === w && q.LineKey === k);
    const qty = new Map<string, Milli>(); // rfqLineId|supplier
    const perWeek = new Map<string, number>(); // supplier|week → containers in this batch
    for (const g of grid.groups) {
      const mine = picks.filter((p) => p.groupId === g.groupId);
      const total = mine.reduce((s, p) => s + p.count, 0);
      if (!total) continue;
      const what = `${g.week} · ${g.name || 'Container group'}`;
      if (g.blocker) { problems.push(`${what}: ${g.blocker}`); continue; }
      if (total > g.available) { problems.push(`${what}: ${total} container(s) picked, but only ${g.available} are open`); continue; }
      for (const p of mine) {
        if (!Number.isInteger(p.count) || p.count < 0) { problems.push(`${what}: a whole number of containers`); continue; }
        const missing = g.items.filter((i) => !hasQuote(p.supplierCode, g.week, i.key));
        if (missing.length) { problems.push(`${what} · ${p.supplierCode}: not priced — ${missing.map((i) => i.label).join(', ')}`); continue; }
        for (const i of g.items) {
          const k = `${i.line!.RfqLineId}|${p.supplierCode}`;
          qty.set(k, (qty.get(k) ?? 0) + i.perContainer * p.count);
        }
        perWeek.set(`${p.supplierCode}|${g.week}`, (perWeek.get(`${p.supplierCode}|${g.week}`) ?? 0) + p.count);
      }
    }
    for (const g of input.containers) if (!grid.groups.some((x) => x.groupId === g.groupId)) problems.push(`Container group ${g.groupId} is not on this RFQ`);
    const byContainerKeys = new Set(qty.keys());
    const other = input.other.filter((o) => Number(o.qty) > 0);
    for (const o of other) if (!grid.other.some((l) => l.RfqLineId === o.rfqLineId)) problems.push(`RFQ line ${o.rfqLineId} is not awarded by quantity`);

    const weeksOf = new Map<string, Set<string>>();
    for (const k of perWeek.keys()) { const [s, w] = k.split('|'); weeksOf.set(s, (weeksOf.get(s) ?? new Set()).add(w)); }
    for (const o of other) { const l = grid.lines.find((x) => x.RfqLineId === o.rfqLineId); if (l) weeksOf.set(o.supplierCode, (weeksOf.get(o.supplierCode) ?? new Set()).add(l.ProposedEtdWeek)); }
    const shipments = [...weeksOf].flatMap(([s, ws]) => [...ws].map((w) => {
      const given = input.shipments.find((x) => x.supplierCode === s && x.etdWeek === w);
      return { supplierCode: s, etdWeek: w, containerCount: Math.max(1, perWeek.get(`${s}|${w}`) ?? 0), confirmedEtd: given?.confirmedEtd ?? null };
    }));
    const awardInput: AwardInput = {
      awards: [...[...qty].map(([k, m]) => { const [rfqLineId, supplierCode] = k.split('|'); return { rfqLineId, supplierCode, qty: qtyText(m) }; }), ...other],
      shipments, releases: [], comment: input.comment,
    };
    const byContainers = (lineId: string, supplier: string) => byContainerKeys.has(`${lineId}|${supplier}`);
    const c = await checkAward(tx, r, awardInput, { byContainers, lines: grid.allLines, quotes });
    const all = [...new Set([...problems, ...c.problems])];
    if (all.length) throw new DomainError('NOT_AWARDABLE', 'The award cannot be made', 422, { problems: all });

    const { awardBatchId, abNo } = await writeAward(tx, actor, r, c, awardInput, byContainers);
    const rows: RawBuilder<unknown>[] = [];
    for (const g of grid.groups) {
      for (const p of picks.filter((x) => x.groupId === g.groupId && x.count > 0)) rows.push(sql`INSERT INTO scm.AwardContainer (AwardBatchId, ContainerGroupId, SupplierCode, EtdWeek, Containers) VALUES (${awardBatchId}, ${g.groupId}, ${p.supplierCode}, ${g.week}, ${p.count});`);
      const added = addedBy.get(g.groupId);
      if (added) rows.push(sql`INSERT INTO scm.AwardContainerChange (AwardBatchId, ContainerGroupId, ChangeType, EtdWeek, Containers, ActorUserId) VALUES (${awardBatchId}, ${g.groupId}, 'CONTAINERS_ADDED', ${g.week}, ${added}, ${actor.id});`);
    }
    // Above the offer: the supplier's active containers in the week (every batch of this RFQ) vs what it offered — allowed, logged.
    let t = 0;
    for (const [k, n] of perWeek) {
      const [supplier, week] = k.split('|');
      const total = grid.prior(supplier, week) + n;
      const offered = grid.offered(supplier, week);
      if (total <= offered) continue;
      const note = (input.shipments.find((x) => x.supplierCode === supplier && x.etdWeek === week)?.note?.trim() ?? '').slice(0, 500);
      rows.push(sql`INSERT INTO scm.AwardContainerChange (AwardBatchId, ChangeType, SupplierCode, EtdWeek, Containers, Offered, Note, ActorUserId) VALUES (${awardBatchId}, 'ABOVE_OFFER', ${supplier}, ${week}, ${total}, ${offered}, ${note}, ${actor.id});
${threadEntrySql(t++, { entityType: 'AWARD_BATCH', entityId: awardBatchId, kind: 'SYSTEM', body: `Above the offer: ${supplier}, ${week}, ${total} containers (offered ${offered})${note ? ` — ${note}` : ''}`, authorUserId: actor.id })}`);
    }
    for (let i = 0; i < rows.length; i += 40) await runSliceBatch(tx, rows.slice(i, i + 40));
    return { awardBatchId, abNo, warnings: c.warnings };
  });
}

/** Un-award n containers of an award container: their quantity goes back (quotes kept → Quoted, or released → Open). */
export async function unawardContainers(db: Db, actor: Actor, commandId: string, awardContainerId: string, rowVer: string, count: number, mode: 'KEEP_QUOTES' | 'RELEASE', reasonCode: string, comment: string) {
  return runCommand(db, actor.id, commandId, 'award.unawardContainers', async (tx) => {
    const c = (await sql<{ AwardContainerId: string; AwardBatchId: string; ContainerGroupId: string; SupplierCode: string; EtdWeek: string; Containers: number; CompanyCode: string; RfqId: string; DemandId: string; RowVer: string }>`
      SELECT c.AwardContainerId, c.AwardBatchId, c.ContainerGroupId, c.SupplierCode, c.EtdWeek, c.Containers, b.CompanyCode, b.RfqId, b.DemandId, ${rowVerHex('c.RowVer')} AS RowVer
      FROM scm.AwardContainer c WITH (UPDLOCK) JOIN scm.AwardBatch b ON b.AwardBatchId = c.AwardBatchId WHERE c.AwardContainerId = ${awardContainerId}`.execute(tx)).rows[0];
    if (!c || !actor.companies.has(c.CompanyCode)) throw new NotFoundError(`Award container ${awardContainerId}`);
    assertCan(actor, P_AWARD.manage, c.CompanyCode);
    await updateWithRowVer(tx, 'scm.AwardContainer', 'AwardContainerId', awardContainerId, rowVer, sql`Containers = Containers`);
    if (!Number.isInteger(count) || count < 1 || count > c.Containers) throw new DomainError('BAD_COUNT', `Un-award 1 to ${c.Containers} container(s)`);
    const reason = await tx.selectFrom('scm.ReasonCode').select('ReasonCode').where('ReasonCode', '=', reasonCode).where('Context', '=', 'UNAWARD').where('IsActive', '=', true).executeTakeFirst();
    if (!reason) throw new DomainError('BAD_REASON', 'Choose an un-award reason');
    const batchId = String(c.AwardBatchId);

    const g = await tx.selectFrom('scm.ContainerGroup').select(['ContainerCount', 'Name']).where('ContainerGroupId', '=', String(c.ContainerGroupId)).executeTakeFirstOrThrow();
    const items = await tx.selectFrom('scm.ContainerGroupItem').select(['LineKey', 'ComputedQty']).where('ContainerGroupId', '=', String(c.ContainerGroupId)).execute();
    for (const it of items) {
      const take = (Number(it.ComputedQty) / g.ContainerCount) * count;
      const ai = await tx.selectFrom('scm.AwardItem').select('AwardItemId').where('AwardBatchId', '=', batchId).where('SupplierCode', '=', c.SupplierCode)
        .where('EtdWeek', '=', c.EtdWeek).where('LineKey', '=', it.LineKey).where('ByContainers', '=', true).where('IsActive', '=', true).executeTakeFirst();
      if (!ai) throw new DomainError('BAD_STATE', 'This award has nothing left of that material to un-award', 409);
      await unawardQty(tx, actor, await lockItem(tx, actor, String(ai.AwardItemId)), take, mode, reasonCode, comment);
    }
    const left = c.Containers - count;
    await tx.updateTable('scm.AwardContainer').set({ Containers: left, IsActive: left > 0 }).where('AwardContainerId', '=', awardContainerId).execute();
    await sql`UPDATE scm.AwardShipment SET ContainerCount = CASE WHEN ContainerCount - ${count} < 1 THEN 1 ELSE ContainerCount - ${count} END, UpdatedBy = ${actor.id}, UpdatedAt = SYSUTCDATETIME()
      WHERE AwardBatchId = ${batchId} AND SupplierCode = ${c.SupplierCode} AND EtdWeek = ${c.EtdWeek} AND IsActive = 1`.execute(tx);
    await tx.insertInto('scm.AwardContainerChange').values({
      AwardBatchId: batchId, AwardContainerId: awardContainerId, ContainerGroupId: String(c.ContainerGroupId), ChangeType: mode === 'KEEP_QUOTES' ? 'UNAWARD_KEEP_QUOTES' : 'UNAWARD_RELEASE',
      SupplierCode: c.SupplierCode, EtdWeek: c.EtdWeek, Containers: count, Offered: null, Note: comment.slice(0, 500), ReasonCode: reasonCode, ActorUserId: actor.id,
    }).execute();
    await addThreadEntry(tx, { entityType: 'AWARD_BATCH', entityId: batchId, kind: 'SYSTEM', body: `Un-awarded ${count} container(s) of ${g.Name || 'a container group'} from ${c.SupplierCode}, ${c.EtdWeek}`, authorUserId: actor.id });
    await resetAck(tx, batchId, 'RESET_UNAWARD', actor.id);
    await refreshHandoffTasks(tx, batchId);
    return { unawarded: count };
  });
}
