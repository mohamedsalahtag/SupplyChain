/**
 * Delete a draft demand that was never accepted (2026-09-29, backlog 12). Only a demand nothing else points at can go:
 * draft or returned, never accepted, no quantity ledger, RFQ, award, change request or merge. It is marked deleted
 * (migration 0035) rather than removed — its versions and comments are immutable history — and is hidden everywhere
 * from then on: lists, filters, the page, its comments and attachments; its open My work items close.
 */
import { sql } from 'kysely';
import { assertCan, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError } from '../workflow/errors.js';
import { recordEvent } from '../workflow/events.js';
import { addThreadEntry } from '../workflow/threads.js';
import type { Db, Tx } from '../workflow/tx.js';
import { lockDemand } from './demandService.js';

export const P_DEMAND_DELETE = 'demand.delete';

/** Why a demand cannot be deleted (null = it can). Also used for the Delete button. */
export async function deleteBlockedReason(tx: Tx | Db, demandId: string): Promise<string | null> {
  const r = (await sql<{ WorkflowStatus: string; AcceptedAt: Date | null; Slices: number; Rfqs: number; Awards: number; Crs: number; Merges: number }>`
    SELECT d.WorkflowStatus, d.AcceptedAt,
      (SELECT COUNT(*) FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId WHERE l.DemandId = d.DemandId)
        + (SELECT COUNT(*) FROM scm.QtySlice s WHERE s.OriginDemandId = d.DemandId) AS Slices,
      (SELECT COUNT(*) FROM scm.Rfq WHERE DemandId = d.DemandId) AS Rfqs,
      (SELECT COUNT(*) FROM scm.AwardBatch WHERE DemandId = d.DemandId) AS Awards,
      (SELECT COUNT(*) FROM scm.ChangeRequest WHERE DemandId = d.DemandId) AS Crs,
      (SELECT COUNT(*) FROM scm.MergeRecord WHERE SourceDemandId = d.DemandId OR TargetDemandId = d.DemandId) AS Merges
    FROM scm.Demand d WHERE d.DemandId = ${demandId}`.execute(tx)).rows[0];
  if (!r) return 'not found';
  if (!['DRAFT', 'RETURNED'].includes(r.WorkflowStatus)) return 'only a draft or returned demand can be deleted';
  if (r.AcceptedAt) return 'it was accepted once';
  if (Number(r.Slices) || Number(r.Rfqs) || Number(r.Awards) || Number(r.Crs) || Number(r.Merges)) return 'other records point at it';
  return null;
}

export async function deleteDemand(db: Db, actor: Actor, commandId: string, demandId: string, rowVer: string): Promise<{ deleted: true; demandNo: string }> {
  return runCommand(db, actor.id, commandId, 'demand.delete', async (tx) => {
    const d = await lockDemand(tx, actor, demandId);
    assertCan(actor, P_DEMAND_DELETE, d.CompanyCode);
    if (!actor.isAdmin && Number(d.CreatedBy) !== actor.id) throw new DomainError('NOT_YOURS', `${d.DemandNo} was created by someone else — only its creator or an administrator can delete it`, 403);
    if (d.RowVer !== rowVer) throw new DomainError('STALE_WRITE', 'Someone changed this demand since you opened it. Reload the page first.', 409);
    const blocked = await deleteBlockedReason(tx, demandId);
    if (blocked) throw new DomainError('CANNOT_DELETE', `${d.DemandNo} cannot be deleted: ${blocked}`, 409);

    await sql`UPDATE scm.Demand SET DeletedAt = SYSUTCDATETIME(), DeletedBy = ${actor.id} WHERE DemandId = ${demandId}`.execute(tx);
    await sql`UPDATE scm.InboxItem SET IsOpen = 0, ClosedAt = SYSUTCDATETIME(), ClosedBy = ${actor.id} WHERE EntityType = 'DEMAND' AND EntityId = ${demandId} AND IsOpen = 1`.execute(tx);
    const eventId = await recordEvent(tx, { type: 'DEMAND_DELETED', entityType: 'DEMAND', entityId: demandId, demandId, payload: { demandNo: d.DemandNo, status: d.WorkflowStatus }, actorUserId: actor.id });
    await addThreadEntry(tx, { entityType: 'DEMAND', entityId: demandId, kind: 'SYSTEM', body: `${d.DemandNo} deleted (draft, never accepted)`, authorUserId: actor.id, eventId });
    return { deleted: true as const, demandNo: d.DemandNo };
  }, { demandId, rowVer });
}
