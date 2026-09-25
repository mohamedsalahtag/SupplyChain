/**
 * "Last step" and "History" (spec 21): the domain events of a demand or an RFQ as plain sentences —
 * what happened, who did it (with the role that step belongs to), when, and the reason or comment.
 */
import { sql } from 'kysely';
import type { Db } from './tx.js';

type EventRow = {
  K: string; EventType: string; PayloadJson: string | null; OccurredAt: Date; DisplayName: string | null;
  RfqNo: string | null; AbNo: string | null; CrNo: string | null; SupplierName: string | null;
};
export type Step = { type: string; text: string; note: string | null; at: string };

/** Noise that is not a business step. */
const SKIP = ['ATTACHMENT_DOWNLOADED', 'WORK_ITEM_ESCALATED', 'AWARD_ACK_REQUESTED'];

const ROLE: Record<string, string> = {
  DEMAND_CREATED: 'Sales', DEMAND_SUBMITTED: 'Sales', DEMAND_RESUBMITTED: 'Sales', DEMAND_RECALLED: 'Sales',
  DEMAND_ACCEPTED: 'Procurement', DEMAND_RETURNED: 'Procurement',
  RFQ_CREATED: 'Procurement', RFQ_SENT: 'Procurement', QUOTES_RECORDED: 'Procurement', RFQ_RELEASED: 'Procurement', RFQ_CANCELLED: 'Procurement',
  AWARD_BATCH_CREATED: 'Procurement', AWARD_UNAWARDED: 'Procurement', AWARD_SKU_CORRECTED: 'Procurement', AWARD_SHIPMENT_CHANGED: 'Procurement',
  AWARD_CONTAINERS_ADDED: 'Procurement', AWARD_QUERY_ANSWERED: 'Procurement', AWARD_ACKNOWLEDGED: 'Sales', AWARD_QUERY: 'Sales',
  MERGE_EXECUTED: 'Procurement', MERGE_UNDONE: 'Procurement',
};

function describe(e: EventRow): Step {
  const p = (e.PayloadJson ? JSON.parse(e.PayloadJson) : {}) as Record<string, unknown>;
  const role = ROLE[e.EventType];
  const by = e.DisplayName ? ` by ${e.DisplayName}${role ? ` (${role})` : ''}` : '';
  const rfq = e.RfqNo ?? 'RFQ'; const ab = e.AbNo ?? 'the award'; const cr = e.CrNo ?? (p.crNo as string | undefined) ?? 'a change request';
  const text: Record<string, string> = {
    DEMAND_CREATED: `Created${by}`,
    DEMAND_SUBMITTED: `Submitted to Procurement${by}`,
    DEMAND_RESUBMITTED: `Submitted again to Procurement (version ${p.version ?? '?'})${by}`,
    DEMAND_RECALLED: `Taken back to change${by}`,
    DEMAND_ACCEPTED: `Accepted${by}`,
    DEMAND_RETURNED: `Returned to Sales${by}`,
    RFQ_CREATED: `${p.rfqNo ?? rfq} created${by}`,
    RFQ_SENT: `${rfq} sent to suppliers${by}`,
    QUOTES_RECORDED: `${rfq}: quote from ${e.SupplierName ?? p.supplierCode ?? 'a supplier'} recorded${by}`,
    RFQ_RELEASED: `${rfq}: quantity released back to the demand${by}`,
    RFQ_CANCELLED: `${rfq} cancelled${by}`,
    AWARD_BATCH_CREATED: `${ab} awarded${by}`,
    AWARD_ACKNOWLEDGED: `${ab} acknowledged${by}`,
    AWARD_QUERY: `${ab}: question${by}`,
    AWARD_QUERY_ANSWERED: `${ab}: question answered${by}`,
    AWARD_UNAWARDED: `${ab}: un-awarded${by}`,
    AWARD_SKU_CORRECTED: `${ab}: SKU corrected${by}`,
    AWARD_SHIPMENT_CHANGED: `${ab}: shipment changed${by}`,
    AWARD_CONTAINERS_ADDED: `${rfq}: containers added at award${by}`,
    CR_SUBMITTED: `${cr} raised${by}`, CR_BLOCKED: `${cr} raised (blocked)${by}`, CR_DECIDED: `${cr} decided${by}`, CR_WITHDRAWN: `${cr} withdrawn${by}`,
    MERGE_EXECUTED: `Merged (${p.source ?? '?'} into ${p.target ?? '?'})${by}`,
    MERGE_UNDONE: `Merge undone${by}`,
  };
  const note = (p.comment as string | undefined) || (p.reasonCode as string | undefined) || (p.reason as string | undefined) || null;
  const fallback = e.EventType.toLowerCase().replace(/_/g, ' ');
  return { type: e.EventType, text: text[e.EventType] ?? `${fallback[0].toUpperCase()}${fallback.slice(1)}${by}`, note, at: e.OccurredAt.toISOString() };
}

const detail = sql`
  JOIN scm.DomainEvent e ON e.EventId = x.EventId
  LEFT JOIN app.[User] u ON u.UserId = e.ActorUserId
  LEFT JOIN scm.Rfq r ON e.EntityType = 'RFQ' AND e.EntityId = CAST(r.RfqId AS nvarchar(40))
  LEFT JOIN scm.AwardBatch b ON e.EntityType = 'AWARD_BATCH' AND e.EntityId = CAST(b.AwardBatchId AS nvarchar(40))
  LEFT JOIN scm.Rfq rb ON rb.RfqId = b.RfqId
  LEFT JOIN scm.ChangeRequest c ON e.EntityType = 'CR' AND e.EntityId = CAST(c.CrId AS nvarchar(40))
  LEFT JOIN md.Supplier sp ON e.EventType = 'QUOTES_RECORDED' AND sp.SupplierCode = JSON_VALUE(e.PayloadJson, '$.supplierCode')
  WHERE e.EventType NOT IN (${sql.join(SKIP)})`;
const cols = sql`CAST(x.K AS nvarchar(20)) AS K, e.EventType, e.PayloadJson, e.OccurredAt, u.DisplayName, ISNULL(r.RfqNo, rb.RfqNo) AS RfqNo, b.AbNo, c.CrNo, sp.Name AS SupplierName`;

/** Every business step per demand (its own events + its award batches' events), oldest first. */
export async function demandSteps(db: Db, demandIds: string[]): Promise<Map<string, Step[]>> {
  if (!demandIds.length) return new Map();
  const rows = (await sql<EventRow>`
    SELECT ${cols} FROM (
      SELECT e.DemandId AS K, e.EventId FROM scm.DomainEvent e WHERE e.DemandId IN (${sql.join(demandIds)})
      UNION
      SELECT b.DemandId, e.EventId FROM scm.DomainEvent e JOIN scm.AwardBatch b ON e.EntityType = 'AWARD_BATCH' AND e.EntityId = CAST(b.AwardBatchId AS nvarchar(40))
      WHERE b.DemandId IN (${sql.join(demandIds)}) AND e.DemandId IS NULL
    ) x ${detail}
    ORDER BY e.OccurredAt, e.EventId`.execute(db)).rows;
  return group(rows);
}

/** Every business step per RFQ (its own events + its award batches' events), oldest first. */
export async function rfqSteps(db: Db, rfqIds: string[]): Promise<Map<string, Step[]>> {
  if (!rfqIds.length) return new Map();
  const rows = (await sql<EventRow>`
    SELECT ${cols} FROM (
      SELECT CAST(e.EntityId AS bigint) AS K, e.EventId FROM scm.DomainEvent e WHERE e.EntityType = 'RFQ' AND e.EntityId IN (${sql.join(rfqIds)})
      UNION
      SELECT b.RfqId, e.EventId FROM scm.DomainEvent e JOIN scm.AwardBatch b ON e.EntityType = 'AWARD_BATCH' AND e.EntityId = CAST(b.AwardBatchId AS nvarchar(40))
      WHERE b.RfqId IN (${sql.join(rfqIds)})
    ) x ${detail}
    ORDER BY e.OccurredAt, e.EventId`.execute(db)).rows;
  return group(rows);
}

function group(rows: EventRow[]): Map<string, Step[]> {
  const out = new Map<string, Step[]>();
  for (const r of rows) out.set(String(r.K), [...(out.get(String(r.K)) ?? []), describe(r)]);
  return out;
}
