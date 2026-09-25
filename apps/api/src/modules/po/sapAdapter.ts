/**
 * The SAP purchase-order adapter (plan v5 §7.4). The real ZCON adapter is Stage 9; until then a durable stub
 * (tables scm.StubSapPo / scm.StubSapFault) behaves like SAP would: idempotent per key, the portal reference stored
 * on the PO and searchable, and faults can be injected (reject, timeout before/after create, lookup unknown).
 */
import { sql } from 'kysely';
import { loadSapPoApi, sapPoApiProblems } from '../../settings/sapPoApi.js';
import { DomainError } from '../workflow/errors.js';
import type { Db } from '../workflow/tx.js';
import { httpSapAdapter } from './sapHttpAdapter.js';

export type CreateResult =
  | { kind: 'CREATED'; poNumber: string }
  | { kind: 'REJECTED'; errors: string[] }   // SAP answered with a business / validation error
  | { kind: 'UNKNOWN'; detail: string };     // timeout, connection loss, 5xx, malformed reply
export type LookupResult = { kind: 'FOUND'; poNumber: string } | { kind: 'NOT_FOUND' } | { kind: 'UNKNOWN'; detail: string };

export interface SapPoAdapter {
  createPo(idempotencyKey: string, reference: string, payloadSha256: string, payload: unknown): Promise<CreateResult>;
  /** Requires the portal reference (POD-…) to be stored on the SAP PO — mandatory before production. */
  findPoByReference(reference: string): Promise<LookupResult>;
}

/** Takes one injected fault for this reference (or the '*' wildcard), if any. */
async function takeFault(db: Db, reference: string, modes: string[]): Promise<string | null> {
  const r = (await sql<{ Mode: string }>`
    UPDATE TOP (1) scm.StubSapFault SET Remaining = Remaining - 1
    OUTPUT inserted.Mode
    WHERE Remaining > 0 AND Reference IN (${reference}, '*') AND Mode IN (${sql.join(modes)})`.execute(db)).rows[0];
  if (r) await sql`DELETE FROM scm.StubSapFault WHERE Remaining <= 0`.execute(db);
  return r?.Mode ?? null;
}

export function stubSapAdapter(db: Db): SapPoAdapter {
  const store = async (key: string, reference: string, hash: string) => {
    const existing = await db.selectFrom('scm.StubSapPo').select(['PoNumber', 'Reference']).where('IdempotencyKey', '=', key).executeTakeFirst();
    if (existing) return existing.PoNumber; // same key → the same PO, never a second one
    const n = (await sql<{ n: string }>`SELECT COUNT(*) + 1 AS n FROM scm.StubSapPo`.execute(db)).rows[0].n;
    const poNumber = `45${String(Number(n) + 10_000_000).slice(-8)}`;
    await db.insertInto('scm.StubSapPo').values({ PoNumber: poNumber, IdempotencyKey: key, Reference: reference, PayloadSha256: hash }).execute();
    return poNumber;
  };
  return {
    async createPo(key, reference, hash) {
      const fault = await takeFault(db, reference, ['reject', 'timeout-before-create', 'timeout-after-create']);
      if (fault === 'reject') return { kind: 'REJECTED', errors: ['SAP (stub): the purchase order was rejected — fault injection'] };
      if (fault === 'timeout-before-create') return { kind: 'UNKNOWN', detail: 'SAP (stub): timeout before the PO was created' };
      const poNumber = await store(key, reference, hash);
      if (fault === 'timeout-after-create') return { kind: 'UNKNOWN', detail: 'SAP (stub): timeout — the PO was created but the reply was lost' };
      return { kind: 'CREATED', poNumber };
    },
    async findPoByReference(reference) {
      if (await takeFault(db, reference, ['lookup-unknown'])) return { kind: 'UNKNOWN', detail: 'SAP (stub): lookup timed out' };
      const r = await db.selectFrom('scm.StubSapPo').select('PoNumber').where('Reference', '=', reference).executeTakeFirst();
      return r ? { kind: 'FOUND', poNumber: r.PoNumber } : { kind: 'NOT_FOUND' };
    },
  };
}

/**
 * The adapter in use, chosen in Configuration → SAP purchase orders on every call (a change applies at once):
 * the stub, or the company's PO API through the HTTP adapter. An incomplete API setting never sends anything.
 */
export function poAdapter(db: Db, encKey: string): SapPoAdapter {
  const current = async (): Promise<SapPoAdapter | string> => {
    const c = await loadSapPoApi(db, encKey);
    if (c.mode === 'stub') return stubSapAdapter(db);
    const missing = sapPoApiProblems(c);
    return missing.length ? `SAP PO API not configured: ${missing.join(', ')}` : httpSapAdapter(c);
  };
  return {
    async createPo(...args) { const a = await current(); return typeof a === 'string' ? { kind: 'REJECTED', errors: [a] } : a.createPo(...args); },
    async findPoByReference(ref) { const a = await current(); return typeof a === 'string' ? { kind: 'UNKNOWN', detail: a } : a.findPoByReference(ref); },
  };
}

/** A production server does not send purchase orders to the simulator unless ALLOW_SAP_STUB=true (a test server). */
export async function assertSapTargetAllowed(db: Db, encKey: string): Promise<void> {
  const c = await loadSapPoApi(db, encKey);
  if (c.mode === 'stub' && process.env.NODE_ENV === 'production' && process.env.ALLOW_SAP_STUB !== 'true') {
    throw new DomainError('SAP_NOT_CONFIGURED', 'Purchase orders cannot be sent: SAP is still the simulator. An administrator sets up Configuration → SAP purchase orders.', 422);
  }
  const missing = sapPoApiProblems(c);
  if (missing.length) throw new DomainError('SAP_NOT_CONFIGURED', `The SAP PO API is not fully configured: ${missing.join(', ')}`, 422);
}
