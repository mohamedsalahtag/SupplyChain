/**
 * The SAP outbox (plan v5 §7 rules 8–11): at most one SAP PO per draft, and quantity is never unlocked while the SAP
 * outcome is unknown. processSubmissions sends due submissions; reconcileUnknown asks SAP about unknown outcomes and
 * resends the SAME frozen payload with the SAME key only when SAP confirms the PO does not exist. A claim whose lease
 * expired (crashed worker) is treated as unknown — never resent blindly.
 */
import { sql } from 'kysely';
import { openInbox } from '../workflow/inbox.js';
import { withTx, type Db } from '../workflow/tx.js';
import { markCreated, markRejected, P_PO, sha256 } from './poService.js';
import type { SapPoAdapter } from './sapAdapter.js';

export const OUTBOX = { maxAttempts: 3, maxChecks: 5, leaseMinutes: 5, batch: 5 } as const;

type Claimed = { SubmissionId: string; PoDraftId: string; IdempotencyKey: string; Reference: string; PayloadJson: string; PayloadSha256: string; Attempts: number; PrevStatus: string };

async function attempt<T extends { kind: string; detail?: string; errors?: string[] }>(db: Db, submissionId: string, kind: 'CREATE' | 'LOOKUP', workerId: string, call: () => Promise<T>): Promise<T> {
  const a = await db.insertInto('scm.SapSubmissionAttempt').values({ SubmissionId: submissionId, Kind: kind, StartedAt: sql<Date>`SYSUTCDATETIME()`, FinishedAt: null, Outcome: null, Detail: null, WorkerId: workerId })
    .output('inserted.AttemptId').executeTakeFirstOrThrow();
  let r: T;
  try { r = await call(); } catch (e) { r = { kind: 'UNKNOWN', detail: e instanceof Error ? e.message : String(e) } as unknown as T; }
  await db.updateTable('scm.SapSubmissionAttempt').set({ FinishedAt: sql<Date>`SYSUTCDATETIME()`, Outcome: r.kind, Detail: (r.detail ?? r.errors?.join('; ') ?? (r as { poNumber?: string }).poNumber ?? null)?.slice(0, 2000) ?? null })
    .where('AttemptId', '=', String(a.AttemptId)).execute();
  return r;
}

/** Marks a submission unknown: the draft shows UNKNOWN, its quantity stays PO submitted, a lookup is due. */
const toUnknown = (db: Db, s: { SubmissionId: string; PoDraftId: string }, detail: string, delayMinutes: number) => withTx(db, async (tx) => {
  await sql`UPDATE scm.SapSubmission SET Status = 'UNKNOWN', ClaimedBy = NULL, LeaseUntil = NULL, NextActionAt = DATEADD(minute, ${delayMinutes}, SYSUTCDATETIME())
    WHERE SubmissionId = ${s.SubmissionId} AND Status IN ('IN_FLIGHT', 'PENDING', 'UNKNOWN')`.execute(tx);
  await sql`UPDATE scm.PoDraft SET Status = 'UNKNOWN', LastError = ${detail} WHERE PoDraftId = ${s.PoDraftId} AND Status IN ('SUBMITTED', 'UNKNOWN')`.execute(tx);
});

/** Nobody can settle it automatically any more: an exception for the PO team (resolve with evidence). */
const toManual = (db: Db, s: { SubmissionId: string; PoDraftId: string }, detail: string) => withTx(db, async (tx) => {
  await sql`UPDATE scm.SapSubmission SET Status = 'MANUAL', ClaimedBy = NULL, LeaseUntil = NULL WHERE SubmissionId = ${s.SubmissionId}`.execute(tx);
  await sql`UPDATE scm.PoDraft SET Status = 'UNKNOWN', LastError = ${detail} WHERE PoDraftId = ${s.PoDraftId}`.execute(tx);
  const d = await tx.selectFrom('scm.PoDraft').select(['PoDraftNo', 'CompanyCode']).where('PoDraftId', '=', s.PoDraftId).executeTakeFirstOrThrow();
  await openInbox(tx, {
    itemType: 'SAP_UNKNOWN', permission: P_PO.manage, companyCode: d.CompanyCode, entityType: 'PO_DRAFT', entityId: s.PoDraftId, number: d.PoDraftNo,
    title: `${d.PoDraftNo}: SAP outcome unknown`, note: `${detail} — check SAP, attach the evidence, then resolve`, link: `/po-drafts/${s.PoDraftId}`, raisedBy: null,
  });
});

/** SAP answered for a draft that was already settled (e.g. a reply after the lease expired): nothing changes; a person must look. */
const lateReply = (db: Db, draftId: string, what: string) => withTx(db, async (tx) => {
  const d = await tx.selectFrom('scm.PoDraft').select(['PoDraftNo', 'CompanyCode', 'Status']).where('PoDraftId', '=', draftId).executeTakeFirstOrThrow();
  await openInbox(tx, {
    itemType: 'SAP_UNKNOWN', permission: P_PO.manage, companyCode: d.CompanyCode, entityType: 'PO_DRAFT', entityId: draftId, number: d.PoDraftNo,
    title: `${d.PoDraftNo}: late SAP reply`, note: `SAP answered "${what}" after the draft was settled as ${d.Status.toLowerCase()} — check SAP and cancel any duplicate PO`,
    link: `/po-drafts/${draftId}`, raisedBy: null,
  });
});

/** One item failing must not strand the others: the next run picks it up again. */
async function each<T>(items: T[], fn: (x: T) => Promise<unknown>) {
  for (const x of items) {
    try { await fn(x); } catch (e) { console.error('SAP outbox item failed', e); }
  }
}

/** Sends due submissions (and turns expired claims into unknown outcomes). Returns how many were handled. */
export async function processSubmissions(db: Db, adapter: SapPoAdapter, workerId: string): Promise<number> {
  const claimed = (await sql<Claimed>`
    UPDATE TOP (${OUTBOX.batch}) scm.SapSubmission
      SET Status = 'IN_FLIGHT', ClaimedBy = ${workerId}, LeaseUntil = DATEADD(minute, ${OUTBOX.leaseMinutes}, SYSUTCDATETIME()),
          Attempts = Attempts + CASE WHEN Status = 'PENDING' THEN 1 ELSE 0 END
    OUTPUT inserted.SubmissionId, inserted.PoDraftId, inserted.IdempotencyKey, inserted.Reference, inserted.PayloadJson, inserted.PayloadSha256, inserted.Attempts, deleted.Status AS PrevStatus
    WHERE (Status = 'PENDING' AND NextActionAt <= SYSUTCDATETIME()) OR (Status = 'IN_FLIGHT' AND LeaseUntil < SYSUTCDATETIME())`.execute(db)).rows
    .map((c) => ({ ...c, SubmissionId: String(c.SubmissionId), PoDraftId: String(c.PoDraftId), IdempotencyKey: String(c.IdempotencyKey) }));
  await each(claimed, async (c) => {
    if (c.PrevStatus === 'IN_FLIGHT') return toUnknown(db, c, 'The worker stopped while sending (lease expired) — asking SAP before any resend', 0);
    if (sha256(c.PayloadJson) !== c.PayloadSha256) return toManual(db, c, 'The frozen payload changed since submit — not sent');
    const r = await attempt(db, c.SubmissionId, 'CREATE', workerId, () => adapter.createPo(c.IdempotencyKey, c.Reference, c.PayloadSha256, JSON.parse(c.PayloadJson)));
    if (r.kind === 'CREATED') {
      if (!(await withTx(db, (tx) => markCreated(tx, c.PoDraftId, r.poNumber, 'SAP_REPLY', null)))) await lateReply(db, c.PoDraftId, `created ${r.poNumber}`);
    } else if (r.kind === 'REJECTED') {
      if (!(await withTx(db, (tx) => markRejected(tx, c.PoDraftId, r.errors, null, null)))) await lateReply(db, c.PoDraftId, 'rejected');
    } else await toUnknown(db, c, r.detail, Math.min(60, c.Attempts));
  });
  return claimed.length;
}

/** Asks SAP about unknown outcomes: found → created; confirmed absent → resend the same payload; else back off, then manual. */
export async function reconcileUnknown(db: Db, adapter: SapPoAdapter, workerId: string): Promise<number> {
  // Claim by pushing the next check out by a lease: a second runner (another process, "Process now") skips these rows.
  const due = (await sql<{ SubmissionId: string; PoDraftId: string; Reference: string; Attempts: number; ReconcileChecks: number }>`
    UPDATE TOP (${OUTBOX.batch}) scm.SapSubmission SET NextActionAt = DATEADD(minute, ${OUTBOX.leaseMinutes}, SYSUTCDATETIME())
    OUTPUT inserted.SubmissionId, inserted.PoDraftId, inserted.Reference, inserted.Attempts, inserted.ReconcileChecks
    WHERE Status = 'UNKNOWN' AND NextActionAt <= SYSUTCDATETIME()`.execute(db)).rows
    .map((s) => ({ ...s, SubmissionId: String(s.SubmissionId), PoDraftId: String(s.PoDraftId) }));
  await each(due, async (s) => {
    const r = await attempt(db, s.SubmissionId, 'LOOKUP', workerId, () => adapter.findPoByReference(s.Reference));
    if (r.kind === 'FOUND') await withTx(db, (tx) => markCreated(tx, s.PoDraftId, r.poNumber, 'RECONCILED', null));
    else if (r.kind === 'NOT_FOUND') {
      if (s.Attempts < OUTBOX.maxAttempts) {
        await withTx(db, async (tx) => { // same key, same payload
          await sql`UPDATE scm.SapSubmission SET Status = 'PENDING', NextActionAt = SYSUTCDATETIME() WHERE SubmissionId = ${s.SubmissionId} AND Status = 'UNKNOWN'`.execute(tx);
          await sql`UPDATE scm.PoDraft SET Status = 'SUBMITTED' WHERE PoDraftId = ${s.PoDraftId} AND Status = 'UNKNOWN'`.execute(tx);
        });
      } else await toManual(db, s, `Not in SAP after ${s.Attempts} attempts`);
    } else if (s.ReconcileChecks + 1 >= OUTBOX.maxChecks) {
      await sql`UPDATE scm.SapSubmission SET ReconcileChecks = ReconcileChecks + 1 WHERE SubmissionId = ${s.SubmissionId}`.execute(db);
      await toManual(db, s, `SAP could not be asked (${r.detail})`);
    } else {
      await sql`UPDATE scm.SapSubmission SET ReconcileChecks = ReconcileChecks + 1, NextActionAt = DATEADD(minute, ${s.ReconcileChecks + 1}, SYSUTCDATETIME()) WHERE SubmissionId = ${s.SubmissionId}`.execute(db);
    }
  });
  return due.length;
}

let running: Promise<{ sent: number; checked: number }> | null = null;

/** One run of both workers (the timer in server.ts, and "Process now"); a call during a run joins that run. */
export function runOutbox(db: Db, adapter: SapPoAdapter, workerId: string) {
  running ??= (async () => {
    try {
      const sent = await processSubmissions(db, adapter, workerId);
      const checked = await reconcileUnknown(db, adapter, workerId);
      return { sent, checked };
    } finally { running = null; }
  })();
  return running;
}
