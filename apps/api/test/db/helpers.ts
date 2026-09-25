/** Shared helpers for database tests. Each test uses fresh random ids, so tests never clash. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/db.js';
import type { Actor } from '../../src/modules/workflow/access.js';

export const db = createDb(loadConfig());

export const uid = (prefix = '') => `${prefix}${randomUUID().slice(0, 8)}`;

/** A registered user; returns its id. */
export async function makeUser(name = uid('u')): Promise<number> {
  const row = await db
    .insertInto('app.User')
    .values({ Username: name, Upn: '', DisplayName: name, Email: '', Department: '', Title: '', IsActive: true, CreatedBy: 'test', LastLoginAt: null })
    .output('inserted.UserId')
    .executeTakeFirstOrThrow();
  return Number(row.UserId);
}

export const actor = (over: Partial<Actor> = {}): Actor => ({ id: 1, isAdmin: false, permissions: new Set(), companies: new Set(), ...over });

export const count = async (table: string, where: ReturnType<typeof sql>) =>
  Number((await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.table(table)} WHERE ${where}`.execute(db)).rows[0].n);

/** Runs every tests/invariants/*.sql; returns the files that found violating rows (plan v5 §6). */
export async function runInvariants(): Promise<{ file: string; rows: unknown[] }[]> {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const dir = resolve(import.meta.dirname, '../../../../tests/invariants');
  const out: { file: string; rows: unknown[] }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const rows = (await sql.raw(readFileSync(join(dir, file), 'utf8')).execute(db)).rows;
    if (rows.length) out.push({ file, rows });
  }
  return out;
}

/**
 * For tests that move quantity to In RFQ by hand: a minimal RFQ line for the
 * slice's line and week, so invariant 4 holds. Pass the result to transitionSlice.
 */
export async function onRfq(sliceId: string) {
  const s = await db.selectFrom('scm.QtySlice as s').innerJoin('scm.DemandLine as l', 'l.LineId', 's.LineId').innerJoin('scm.Demand as d', 'd.DemandId', 'l.DemandId')
    .select(['s.LineId', 's.Qty', 's.ApprovedEtdWeek', 'l.DemandId', 'd.CompanyCode', 'd.CreatedBy', 'l.MajorCategory', 'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.OriginCode', 'l.MaterialCode', 'l.Unit'])
    .where('s.SliceId', '=', sliceId).executeTakeFirstOrThrow();
  const rfq = await db.insertInto('scm.Rfq').values({
    RfqNo: uid('RFQT'), DemandId: String(s.DemandId), CompanyCode: s.CompanyCode, CreatedBy: Number(s.CreatedBy), SentBy: null, SentAt: null,
    CancelledBy: null, CancelledAt: null, CancelReason: null, CancelComment: null,
  }).output('inserted.RfqId').executeTakeFirstOrThrow();
  const line = await db.insertInto('scm.RfqLine').values({
    RfqId: String(rfq.RfqId), DemandLineId: String(s.LineId), MajorCategory: s.MajorCategory, SubMajorCategory: s.SubMajorCategory, Size: s.Size, MaterialClass: s.MaterialClass,
    OriginCode: s.OriginCode, MaterialCode: s.MaterialCode, Unit: s.Unit, ProposedEtdWeek: s.ApprovedEtdWeek, AskedQty: s.Qty,
  }).output('inserted.RfqLineId').executeTakeFirstOrThrow();
  return sql`RfqLineId = ${String(line.RfqLineId)}`;
}

/** Gives a slice already on an RFQ line an award item (quote, batch, item, shipment) — for tests that move a slice past Awarded by hand. */
export async function onAward(sliceId: string) {
  const r = await sql<{ AwardItemId: string }>`
    DECLARE @rfqLine bigint, @rfq bigint, @demand bigint, @company nvarchar(10), @by int, @week char(8), @key nvarchar(400), @origin nvarchar(10), @unit nvarchar(10), @qty bigint;
    SELECT @rfqLine = l.RfqLineId, @rfq = l.RfqId, @demand = q.DemandId, @company = q.CompanyCode, @by = q.CreatedBy, @week = l.ProposedEtdWeek,
           @key = l.LineKey, @origin = l.OriginCode, @unit = l.Unit, @qty = s.Qty
    FROM scm.QtySlice s JOIN scm.RfqLine l ON l.RfqLineId = s.RfqLineId JOIN scm.Rfq q ON q.RfqId = l.RfqId WHERE s.SliceId = ${sliceId};
    SET XACT_ABORT ON; BEGIN TRAN;
    IF NOT EXISTS (SELECT 1 FROM scm.RfqSupplier WHERE RfqId = @rfq AND SupplierCode = 'TEST')
      INSERT INTO scm.RfqSupplier (RfqId, SupplierCode, OriginsAtInvite, InvitedBy) VALUES (@rfq, 'TEST', @origin, @by);
    INSERT INTO scm.SupplierQuote (RfqId, SupplierCode, EtdWeek, LineKey, OriginCode, Unit, UnitPrice, Currency, AvailableQty, OriginsAtQuote, RecordedBy)
    VALUES (@rfq, 'TEST', @week, @key, @origin, @unit, 1, 'USD', @qty, @origin, @by);
    DECLARE @quote bigint = SCOPE_IDENTITY();
    INSERT INTO scm.AwardBatch (AbNo, RfqId, DemandId, CompanyCode, CreatedBy) VALUES (${uid('ABT')}, @rfq, @demand, @company, @by);
    DECLARE @batch bigint = SCOPE_IDENTITY();
    INSERT INTO scm.AwardItem (AwardBatchId, RfqLineId, SupplierCode, EtdWeek, LineKey, Qty, Unit, QuoteId, UnitPrice, Currency)
    VALUES (@batch, @rfqLine, 'TEST', @week, @key, @qty, @unit, @quote, 1, 'USD');
    DECLARE @item bigint = SCOPE_IDENTITY();
    INSERT INTO scm.AwardShipment (AwardBatchId, SupplierCode, EtdWeek, ContainerCount, UpdatedBy) VALUES (@batch, 'TEST', @week, 1, @by);
    UPDATE scm.QtySlice SET AwardItemId = @item WHERE SliceId = ${sliceId};
    COMMIT;
    SELECT CAST(@item AS nvarchar(20)) AS AwardItemId;`.execute(db);
  return r.rows[0].AwardItemId;
}
