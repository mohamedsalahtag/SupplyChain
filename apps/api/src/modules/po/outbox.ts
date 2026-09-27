/**
 * The SAP outbox (plan v5 §7 rules 8–11): at most one SAP PO per draft, and quantity is never unlocked while the SAP
 * outcome is unknown. processSubmissions sends due submissions; reconcileUnknown asks SAP about unknown outcomes and
 * resends the SAME frozen payload with the SAME key only when SAP confirms the PO does not exist. A claim whose lease
 * expired (crashed worker) is treated as unknown — never resent blindly.
 *
 * Claims and fencing (review 2026-09-26): each worker claims ONE row at a time, under its own claim token
 * (ClaimedBy) and a lease. It sends only while the lease still covers the whole SAP call (MAX_TIMEOUT_SECONDS), and
 * records an outcome only while it still holds the claim (ClaimedBy = token AND LeaseUntil > now); a worker that lost
 * its claim changes nothing and logs it — the next claimer asks SAP. No database lock or transaction is ever held
 * across the SAP call (the ODBC pool gives no pinned session, so a session applock around a pass is not possible
 * without one); the per-row fencing is what keeps two workers from both settling a submission.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { MAX_TIMEOUT_SECONDS } from '../../settings/sapPoApi.js';
import { maintenanceRunning } from '../ops/maintenance.js';
import { openInbox } from '../workflow/inbox.js';
import { withTx, type Db, type Tx } from '../workflow/tx.js';
import { markCreated, markRejected, P_PO, sha256 } from './poService.js';
import type { SapPoAdapter } from './sapAdapter.js';

export const OUTBOX = { maxAttempts: 3, maxChecks: 5, leaseMinutes: 5, batch: 5 } as const;
/** A send starts only with this much lease left: the whole SAP call (at most MAX_TIMEOUT_SECONDS) plus the writes around it. */
const SEND_MARGIN_SECONDS = MAX_TIMEOUT_SECONDS + 60;
if (SEND_MARGIN_SECONDS >= OUTBOX.leaseMinutes * 60) throw new Error('The SAP call budget must stay well inside the outbox lease');

type Claim = { SubmissionId: string; PoDraftId: string; token: string };
type Claimed = Claim & { IdempotencyKey: string; Reference: string; PayloadJson: string; PayloadSha256: string; Attempts: number; PrevStatus: string };
type Due = Claim & { Reference: string; Attempts: number; ReconcileChecks: number };

const newToken = (workerId: string) => `${workerId}#${randomUUID().slice(0, 8)}`.slice(0, 100);
const affected = (r: { numAffectedRows?: bigint }) => Number(r.numAffectedRows ?? 0);
const lost = (c: Claim, what: string) => console.warn(`SAP outbox: claim ${c.token} on submission ${c.SubmissionId} was lost — ${what} not recorded; the next claimer asks SAP`);

async function attempt<T extends { kind: string; detail?: string; errors?: string[] }>(db: Db, submissionId: string, kind: 'CREATE' | 'LOOKUP', workerId: string, call: () => Promise<T>): Promise<T> {
  const a = await db.insertInto('scm.SapSubmissionAttempt').values({ SubmissionId: submissionId, Kind: kind, StartedAt: sql<Date>`SYSUTCDATETIME()`, FinishedAt: null, Outcome: null, Detail: null, WorkerId: workerId })
    .output('inserted.AttemptId').executeTakeFirstOrThrow();
  let r: T;
  try { r = await call(); } catch (e) { r = { kind: 'UNKNOWN', detail: e instanceof Error ? e.message : String(e) } as unknown as T; }
  await db.updateTable('scm.SapSubmissionAttempt').set({ FinishedAt: sql<Date>`SYSUTCDATETIME()`, Outcome: r.kind, Detail: (r.detail ?? r.errors?.join('; ') ?? (r as { poNumber?: string }).poNumber ?? null)?.slice(0, 2000) ?? null })
    .where('AttemptId', '=', String(a.AttemptId)).execute();
  return r;
}

/** Inside an outcome transaction: the claim is still ours (and locked until the commit), or false. */
async function holdClaim(tx: Tx, c: Claim, status: 'IN_FLIGHT' | 'UNKNOWN'): Promise<boolean> {
  const r = await sql<{ SubmissionId: string }>`SELECT SubmissionId FROM scm.SapSubmission WITH (UPDLOCK, ROWLOCK)
    WHERE SubmissionId = ${c.SubmissionId} AND Status = ${status} AND ClaimedBy = ${c.token} AND LeaseUntil > SYSUTCDATETIME()`.execute(tx);
  return r.rows.length === 1;
}

/** Before a send: the claim is ours and its lease still covers the whole SAP call. */
async function maySend(db: Db, c: Claim): Promise<boolean> {
  const r = await sql<{ SubmissionId: string }>`SELECT SubmissionId FROM scm.SapSubmission WHERE SubmissionId = ${c.SubmissionId} AND Status = 'IN_FLIGHT'
    AND ClaimedBy = ${c.token} AND LeaseUntil > DATEADD(second, ${SEND_MARGIN_SECONDS}, SYSUTCDATETIME())`.execute(db);
  return r.rows.length === 1;
}

/** Marks a submission unknown: the draft shows UNKNOWN, its quantity stays PO submitted, a lookup is due. Only by the claim holder. */
const toUnknown = (db: Db, c: Claim, detail: string, delayMinutes: number) => withTx(db, async (tx) => {
  const r = await sql`UPDATE scm.SapSubmission SET Status = 'UNKNOWN', ClaimedBy = NULL, LeaseUntil = NULL, NextActionAt = DATEADD(minute, ${delayMinutes}, SYSUTCDATETIME())
    WHERE SubmissionId = ${c.SubmissionId} AND Status = 'IN_FLIGHT' AND ClaimedBy = ${c.token} AND LeaseUntil > SYSUTCDATETIME()`.execute(tx);
  if (!affected(r)) { lost(c, 'the unknown outcome'); return false; }
  await sql`UPDATE scm.PoDraft SET Status = 'UNKNOWN', LastError = ${detail} WHERE PoDraftId = ${c.PoDraftId} AND Status IN ('SUBMITTED', 'UNKNOWN')`.execute(tx);
  return true;
});

/**
 * Nobody can settle it automatically any more: an exception for the PO team (resolve with evidence). Only by the claim
 * holder, only for an open submission of an open draft; the work item opens only when something changed.
 */
const toManual = (db: Db, c: Claim, detail: string, opts: { bumpChecks?: boolean } = {}) => withTx(db, async (tx) => {
  const r = await sql`UPDATE scm.SapSubmission SET Status = 'MANUAL', ClaimedBy = NULL, LeaseUntil = NULL, ReconcileChecks = ReconcileChecks + ${opts.bumpChecks ? 1 : 0}
    WHERE SubmissionId = ${c.SubmissionId} AND Status IN ('IN_FLIGHT', 'UNKNOWN') AND ClaimedBy = ${c.token} AND LeaseUntil > SYSUTCDATETIME()`.execute(tx);
  if (!affected(r)) { lost(c, 'the manual exception'); return false; }
  const d = await sql`UPDATE scm.PoDraft SET Status = 'UNKNOWN', LastError = ${detail} WHERE PoDraftId = ${c.PoDraftId} AND Status IN ('SUBMITTED', 'UNKNOWN')`.execute(tx);
  if (!affected(d)) { console.warn(`SAP outbox: draft ${c.PoDraftId} is already settled — no manual exception opened`); return false; }
  const draft = await tx.selectFrom('scm.PoDraft').select(['PoDraftNo', 'CompanyCode']).where('PoDraftId', '=', c.PoDraftId).executeTakeFirstOrThrow();
  await openInbox(tx, {
    itemType: 'SAP_UNKNOWN', permission: P_PO.manage, companyCode: draft.CompanyCode, entityType: 'PO_DRAFT', entityId: c.PoDraftId, number: draft.PoDraftNo,
    title: `${draft.PoDraftNo}: SAP outcome unknown`, note: `${detail} — check SAP, attach the evidence, then resolve`, link: `/po-drafts/${c.PoDraftId}`, raisedBy: null,
  });
  return true;
});

/** The claim holder closes a submission whose draft was already settled (so it is not claimed and asked again and again). */
const park = (tx: Tx, c: Claim, status: 'CREATED' | 'MANUAL') =>
  sql`UPDATE scm.SapSubmission SET Status = ${status}, ClaimedBy = NULL, LeaseUntil = NULL WHERE SubmissionId = ${c.SubmissionId} AND ClaimedBy = ${c.token}`.execute(tx);

/** SAP answered for a draft that was already settled (e.g. a reply after the lease expired): nothing changes; a person must look. */
const lateReply = (db: Db, draftId: string, what: string) => withTx(db, async (tx) => {
  const d = await tx.selectFrom('scm.PoDraft').select(['PoDraftNo', 'CompanyCode', 'Status']).where('PoDraftId', '=', draftId).executeTakeFirstOrThrow();
  await openInbox(tx, {
    itemType: 'SAP_UNKNOWN', permission: P_PO.manage, companyCode: d.CompanyCode, entityType: 'PO_DRAFT', entityId: draftId, number: d.PoDraftNo,
    title: `${d.PoDraftNo}: late SAP reply`, note: `SAP answered "${what}" after the draft was settled as ${d.Status.toLowerCase()} — check SAP and cancel any duplicate PO`,
    link: `/po-drafts/${draftId}`, raisedBy: null,
  });
});

/**
 * Records "SAP has / created PO n" for a claim. Settled by us → done. The draft already settled some other way
 * (anything but this very PO) → the late-reply exception. Still open but claimed by another worker → logged only.
 */
async function recordCreated(db: Db, c: Claim, status: 'IN_FLIGHT' | 'UNKNOWN', poNumber: string, resolution: 'SAP_REPLY' | 'RECONCILED') {
  const r = await withTx(db, async (tx) => {
    const mine = await holdClaim(tx, c, status);
    if (mine && await markCreated(tx, c.PoDraftId, poNumber, resolution, null)) return 'done' as const;
    const d = await tx.selectFrom('scm.PoDraft').select(['Status', 'SapPoNumber']).where('PoDraftId', '=', c.PoDraftId).executeTakeFirst();
    if (!d || ['SUBMITTED', 'UNKNOWN'].includes(d.Status)) return 'lost' as const;
    const same = d.Status === 'CREATED' && d.SapPoNumber === poNumber;
    if (mine) await park(tx, c, same ? 'CREATED' : 'MANUAL');
    return same ? 'done' as const : 'late' as const;
  });
  if (r === 'late') await lateReply(db, c.PoDraftId, `created ${poNumber}`);
  if (r === 'lost') lost(c, `"created ${poNumber}"`);
}

/** Claims one due submission (or an expired claim) under a fresh token; null when none is due. */
async function claimSubmission(db: Db, workerId: string): Promise<Claimed | null> {
  const token = newToken(workerId);
  const c = (await sql<Omit<Claimed, 'token'>>`
    UPDATE TOP (1) scm.SapSubmission WITH (ROWLOCK, READPAST)
      SET Status = 'IN_FLIGHT', ClaimedBy = ${token}, LeaseUntil = DATEADD(minute, ${OUTBOX.leaseMinutes}, SYSUTCDATETIME()),
          Attempts = Attempts + CASE WHEN Status = 'PENDING' THEN 1 ELSE 0 END
    OUTPUT inserted.SubmissionId, inserted.PoDraftId, inserted.IdempotencyKey, inserted.Reference, inserted.PayloadJson, inserted.PayloadSha256, inserted.Attempts, deleted.Status AS PrevStatus
    WHERE (Status = 'PENDING' AND NextActionAt <= SYSUTCDATETIME()) OR (Status = 'IN_FLIGHT' AND LeaseUntil < SYSUTCDATETIME())`.execute(db)).rows[0];
  return c ? { ...c, SubmissionId: String(c.SubmissionId), PoDraftId: String(c.PoDraftId), IdempotencyKey: String(c.IdempotencyKey), token } : null;
}

async function sendOne(db: Db, adapter: SapPoAdapter, c: Claimed) {
  if (c.PrevStatus === 'IN_FLIGHT') return toUnknown(db, c, 'The worker stopped while sending (lease expired) — asking SAP before any resend', 0);
  if (sha256(c.PayloadJson) !== c.PayloadSha256) return toManual(db, c, 'The frozen payload changed since submit — not sent');
  if (!(await maySend(db, c))) { console.warn(`SAP outbox: claim ${c.token} on submission ${c.SubmissionId} no longer covers a SAP call — not sent`); return; }
  const r = await attempt(db, c.SubmissionId, 'CREATE', c.token, () => adapter.createPo(c.IdempotencyKey, c.Reference, c.PayloadSha256, JSON.parse(c.PayloadJson)));
  if (r.kind === 'CREATED') return recordCreated(db, c, 'IN_FLIGHT', r.poNumber, 'SAP_REPLY');
  if (r.kind === 'REJECTED') {
    const done = await withTx(db, async (tx) => {
      if (!(await holdClaim(tx, c, 'IN_FLIGHT'))) return 'lost';
      if (await markRejected(tx, c.PoDraftId, r.errors, null, null)) return 'done';
      await park(tx, c, 'MANUAL');
      return 'late';
    });
    if (done === 'late') await lateReply(db, c.PoDraftId, 'rejected');
    if (done === 'lost') lost(c, '"rejected"');
    return;
  }
  return toUnknown(db, c, r.detail, Math.min(60, c.Attempts));
}

/** Sends due submissions (and turns expired claims into unknown outcomes), one claim at a time. Returns how many were handled. */
export async function processSubmissions(db: Db, adapter: SapPoAdapter, workerId: string): Promise<number> {
  let n = 0;
  for (; n < OUTBOX.batch; n++) {
    const c = await claimSubmission(db, workerId);
    if (!c) break;
    // One item failing must not strand the others: its claim expires and the next run picks it up as unknown.
    try { await sendOne(db, adapter, c); } catch (e) { console.error('SAP outbox item failed', e); }
  }
  return n;
}

/** Claims one unknown outcome whose check is due: the next check moves out by a lease, so another runner skips it. */
async function claimUnknown(db: Db, workerId: string): Promise<Due | null> {
  const token = newToken(workerId);
  const s = (await sql<Omit<Due, 'token'>>`
    UPDATE TOP (1) scm.SapSubmission WITH (ROWLOCK, READPAST)
      SET ClaimedBy = ${token}, LeaseUntil = DATEADD(minute, ${OUTBOX.leaseMinutes}, SYSUTCDATETIME()), NextActionAt = DATEADD(minute, ${OUTBOX.leaseMinutes}, SYSUTCDATETIME())
    OUTPUT inserted.SubmissionId, inserted.PoDraftId, inserted.Reference, inserted.Attempts, inserted.ReconcileChecks
    WHERE Status = 'UNKNOWN' AND NextActionAt <= SYSUTCDATETIME()`.execute(db)).rows[0];
  return s ? { ...s, SubmissionId: String(s.SubmissionId), PoDraftId: String(s.PoDraftId), token } : null;
}

async function checkOne(db: Db, adapter: SapPoAdapter, s: Due) {
  const r = await attempt(db, s.SubmissionId, 'LOOKUP', s.token, () => adapter.findPoByReference(s.Reference));
  if (r.kind === 'FOUND') return recordCreated(db, s, 'UNKNOWN', r.poNumber, 'RECONCILED');
  if (r.kind === 'NOT_FOUND') {
    if (s.Attempts >= OUTBOX.maxAttempts) return toManual(db, s, `Not in SAP after ${s.Attempts} attempts`);
    return withTx(db, async (tx) => { // same key, same payload
      const u = await sql`UPDATE scm.SapSubmission SET Status = 'PENDING', NextActionAt = SYSUTCDATETIME(), ClaimedBy = NULL, LeaseUntil = NULL
        WHERE SubmissionId = ${s.SubmissionId} AND Status = 'UNKNOWN' AND ClaimedBy = ${s.token} AND LeaseUntil > SYSUTCDATETIME()`.execute(tx);
      if (!affected(u)) return lost(s, '"not found"');
      await sql`UPDATE scm.PoDraft SET Status = 'SUBMITTED' WHERE PoDraftId = ${s.PoDraftId} AND Status = 'UNKNOWN'`.execute(tx);
    });
  }
  if (s.ReconcileChecks + 1 >= OUTBOX.maxChecks) return toManual(db, s, `SAP could not be asked (${r.detail})`, { bumpChecks: true });
  const u = await sql`UPDATE scm.SapSubmission SET ReconcileChecks = ReconcileChecks + 1, NextActionAt = DATEADD(minute, ${s.ReconcileChecks + 1}, SYSUTCDATETIME()), ClaimedBy = NULL, LeaseUntil = NULL
    WHERE SubmissionId = ${s.SubmissionId} AND Status = 'UNKNOWN' AND ClaimedBy = ${s.token} AND LeaseUntil > SYSUTCDATETIME()`.execute(db);
  if (!affected(u)) lost(s, 'the failed check');
}

/** Asks SAP about unknown outcomes: found → created; confirmed absent → resend the same payload; else back off, then manual. */
export async function reconcileUnknown(db: Db, adapter: SapPoAdapter, workerId: string): Promise<number> {
  let n = 0;
  for (; n < OUTBOX.batch; n++) {
    const s = await claimUnknown(db, workerId);
    if (!s) break;
    try { await checkOne(db, adapter, s); } catch (e) { console.error('SAP outbox item failed', e); }
  }
  return n;
}

let running: Promise<{ sent: number; checked: number }> | null = null;

/**
 * One run of both workers (the timer in server.ts, and "Process now"); a call during a run joins that run.
 * Nothing runs while Configuration → Start over holds the maintenance lock.
 */
export function runOutbox(db: Db, adapter: SapPoAdapter, workerId: string) {
  running ??= (async () => {
    try {
      if (await maintenanceRunning(db)) return { sent: 0, checked: 0 };
      const sent = await processSubmissions(db, adapter, workerId);
      const checked = await reconcileUnknown(db, adapter, workerId);
      return { sent, checked };
    } finally { running = null; }
  })();
  return running;
}
