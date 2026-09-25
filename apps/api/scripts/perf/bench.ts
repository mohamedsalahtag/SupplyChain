/**
 * Database review benchmark against the PERFORMANCE database (built by build.ts): times the real read functions behind
 * each screen as a one-company user, runs a small concurrency test, then lists the statements that read the most.
 *   npx tsx --env-file-if-exists=../../.env scripts/perf/bench.ts [label]
 */
import { sql } from 'kysely';
import { ALL_PERMISSION_KEYS } from '@supplychain/shared';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/db.js';
import '../../src/modules/demand/access.js';
import { getBatch, listBatches } from '../../src/modules/award/awardRead.js';
import { containerGrid } from '../../src/modules/award/containerGrid.js';
import { listCrs } from '../../src/modules/cr/crRead.js';
import { demandHistory, getDemand, listDemands } from '../../src/modules/demand/demandRead.js';
import { listVersions } from '../../src/modules/demand/versions.js';
import { getHandoff, handoffPanel, listHandoffs } from '../../src/modules/handoff/handoffRead.js';
import { opsStatus } from '../../src/modules/ops/opsStatus.js';
import { listDrafts, preparation } from '../../src/modules/po/poRead.js';
import { crRegister, demandReport, executionSummary, performance } from '../../src/modules/reports/reports.js';
import { builderData, getRfq, listRfqs, shortlistFor } from '../../src/modules/rfq/rfqRead.js';
import { listWork, workTabs } from '../../src/modules/workflow/inbox.js';
import { randomUUID } from 'node:crypto';
import { acceptDemand, createDemand, submitDemand } from '../../src/modules/demand/demandService.js';
import { createRfq } from '../../src/modules/rfq/rfqService.js';
import { isoWeekMonday, isoWeekOf } from '../../src/modules/workflow/isoWeek.js';

const label = process.argv[2] ?? 'run';
const cfg = loadConfig();
const PERF = process.env.PERF_DB_NAME || 'supplychain_perf';
if (!/_perf$/.test(PERF)) throw new Error('bench runs only against a *_perf database');
const db = createDb({ ...cfg, DB_NAME: PERF });
const started = (await sql<{ t: Date }>`SELECT SYSDATETIME() AS t`.execute(db)).rows[0].t;

const userId = Number((await sql<{ id: number }>`SELECT TOP 1 u.UserId AS id FROM app.[User] u JOIN scm.UserCompany c ON c.UserId = u.UserId WHERE c.CompanyCode = '1000' AND u.Username LIKE 'perf.%'`.execute(db)).rows[0].id);
const actor = { id: userId, isAdmin: false, permissions: new Set(ALL_PERMISSION_KEYS), companies: new Set(['1000']) };
const pick = (await sql<{ DemandId: string; RfqId: string; AwardBatchId: string; HandoffId: string; CrId: string | null }>`
  SELECT TOP 1 d.DemandId, r.RfqId, b.AwardBatchId, h.HandoffId, (SELECT TOP 1 CrId FROM scm.ChangeRequest c WHERE c.CompanyCode = '1000' ORDER BY CrId DESC) AS CrId
  FROM scm.Demand d JOIN scm.Rfq r ON r.DemandId = d.DemandId JOIN scm.AwardBatch b ON b.RfqId = r.RfqId JOIN scm.Handoff h ON h.AwardBatchId = b.AwardBatchId
  WHERE d.CompanyCode = '1000' ORDER BY d.DemandId DESC`.execute(db)).rows[0];
const ids = { demand: String(pick.DemandId), rfq: String(pick.RfqId), batch: String(pick.AwardBatchId), handoff: String(pick.HandoffId), cr: String(pick.CrId) };
const lineIds = (await db.selectFrom('scm.DemandLine').select('LineId').where('DemandId', '=', ids.demand).execute()).map((l) => String(l.LineId));

// Network baseline: one trivial round trip (everything below includes this per query).
const rt: number[] = [];
for (let i = 0; i < 10; i++) { const t = Number(process.hrtime.bigint() / 1000n) / 1000; await sql`SELECT 1`.execute(db); rt.push(Number(process.hrtime.bigint() / 1000n) / 1000 - t); }
rt.sort((a, b) => a - b);
console.log(`Round trip to SQL Server (SELECT 1): median ${rt[5].toFixed(0)} ms`);
// Every statement the app sends in this run, counted by wrapping the driver's executeQuery.
let statements = 0;
const exec = (db as unknown as { getExecutor: () => { executeQuery: (...a: unknown[]) => unknown } }).getExecutor();
const orig = exec.executeQuery.bind(exec);
exec.executeQuery = (...a: unknown[]) => { statements++; return orig(...a); };

/** Database-side totals so far for this database: elapsed ms and pages read (independent of the network). */
const serverTotals = async () => (await sql<{ ms: number; reads: number }>`
  SELECT ISNULL(SUM(qs.total_elapsed_time), 0) / 1000.0 AS ms, ISNULL(SUM(qs.total_logical_reads), 0) AS reads
  FROM sys.dm_exec_query_stats qs CROSS APPLY (SELECT CONVERT(int, value) AS dbid FROM sys.dm_exec_plan_attributes(qs.plan_handle) WHERE attribute = 'dbid') pa
  CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st WHERE pa.dbid = DB_ID() AND st.text NOT LIKE '%dm_exec_query_stats%'`.execute(db)).rows[0];

const cases: [string, () => Promise<unknown>][] = [
  ['My work: tab counts', () => workTabs(db, actor)],
  ['My work: first page (50)', () => listWork(db, actor, { page: 1, pageSize: 50 })],
  ['My work: search', () => listWork(db, actor, { q: 'D-0019', page: 1, pageSize: 50 })],
  ['Demands list: page 1 (50)', () => listDemands(db, actor, { mine: false, page: 1, pageSize: 50 })],
  ['Demands list: page 100', () => listDemands(db, actor, { mine: false, page: 100, pageSize: 50 })],
  ['Demands list: search', () => listDemands(db, actor, { mine: false, q: 'D-00123', page: 1, pageSize: 50 })],
  ['Demands list: status filter', () => listDemands(db, actor, { mine: false, status: ['NOT_STARTED', 'PARTIALLY_IN_EXECUTION'], page: 1, pageSize: 50 })],
  ['Demand page', () => getDemand(db, actor, ids.demand)],
  ['Demand: history tab', () => demandHistory(db, ids.demand)],
  ['Demand: versions tab', () => listVersions(db, ids.demand)],
  ['RFQ builder', () => builderData(db, actor, ids.demand)],
  ['RFQ builder: shortlist', () => shortlistFor(db, actor, ids.demand, lineIds)],
  ['RFQs list', () => listRfqs(db, actor, { page: 1, pageSize: 50 })],
  ['RFQ page', () => getRfq(db, actor, ids.rfq)],
  ['Award grid', () => containerGrid(db, { RfqId: ids.rfq, DemandId: ids.demand })],
  ['Awards list', () => listBatches(db, actor, { page: 1, pageSize: 50 })],
  ['Award page', () => getBatch(db, actor, ids.batch)],
  ['Award: handoff panel', () => handoffPanel(db, actor, ids.batch)],
  ['Handoffs list', () => listHandoffs(db, actor, { page: 1, pageSize: 50 })],
  ['Handoff page', () => getHandoff(db, actor, ids.handoff)],
  ['PO preparation', () => preparation(db, actor, ids.handoff)],
  ['PO drafts list', () => listDrafts(db, actor, { page: 1, pageSize: 50 })],
  ['Change requests list', () => listCrs(db, actor, { mine: false, page: 1, pageSize: 50 })],
  ['Report: demand execution (all)', () => executionSummary(db, actor, {})],
  ['Report: execution, one quarter', () => executionSummary(db, actor, { from: '2026-01-01', to: '2026-03-31' })],
  ['Report: one demand', () => demandReport(db, actor, ids.demand)],
  ['Report: CR register (all)', () => crRegister(db, actor, {})],
  ['Report: performance (all)', () => performance(db, actor, {})],
  ['Report: performance, one quarter', () => performance(db, actor, { from: '2026-01-01', to: '2026-03-31' })],
  ['Operations status', () => opsStatus(db, cfg, cfg.SETTINGS_ENCRYPTION_KEY)],
];

const time = async (fn: () => Promise<unknown>) => { const t = performance_now(); await fn(); return performance_now() - t; };
function performance_now() { return Number(process.hrtime.bigint() / 1000n) / 1000; }

console.log(`\n=== ${label} — ${PERF}, user of company 1000, demand ${ids.demand} ===`);
const results: { name: string; ms: number }[] = [];
for (const [name, fn] of cases) {
  try {
    await fn(); // warm-up (plans, connection)
    const before = statements;
    const s0 = await serverTotals();
    const t = [await time(fn), await time(fn), await time(fn)].sort((a, b) => a - b);
    const s1 = await serverTotals();
    const perCall = (statements - before) / 3;
    const dbMs = (Number(s1.ms) - Number(s0.ms)) / 3;
    const reads = (Number(s1.reads) - Number(s0.reads)) / 3;
    results.push({ name, ms: t[1] });
    console.log(`${name.padEnd(36)} ${t[1].toFixed(0).padStart(7)} ms  ${perCall.toFixed(0).padStart(4)} statements · database ${dbMs.toFixed(0).padStart(5)} ms, ${Math.round(reads).toLocaleString('en-GB').padStart(9)} pages`);
  } catch (e) {
    console.log(`${name.padEnd(36)}   ERROR ${(e as Error).message.slice(0, 120)}`);
  }
}

// Writes on the big database: a whole demand from creation to its RFQ (two people: separation of duties).
const other = { ...actor, id: userId + 3 };
await sql`IF NOT EXISTS (SELECT 1 FROM scm.UserCompany WHERE UserId = ${other.id} AND CompanyCode = '1000') INSERT INTO scm.UserCompany (UserId, CompanyCode) VALUES (${other.id}, '1000')`.execute(db);
const spec = (await sql<{ MajorCategory: string; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string; Unit: string }>`
  SELECT TOP 1 m.MajorCategory, m.SubMajorCategory, m.Size, m.MaterialClass, r.CountryCode AS OriginCode, m.BaseUnit AS Unit FROM md.Material m
  JOIN scm.RefOrigin r ON r.OriginName = m.Origin AND r.CountryCode IS NOT NULL WHERE m.InSap = 1 AND m.BaseUnit = 'CT' AND m.MajorCategory <> '' ORDER BY m.MaterialCode`.execute(db)).rows[0];
const week = isoWeekOf(new Date(isoWeekMonday(isoWeekOf(new Date())).getTime() + 5 * 7 * 86_400_000));
const w = async (name: string, fn: () => Promise<unknown>) => { const before = statements; const ms = await time(fn); console.log(`${name.padEnd(36)} ${ms.toFixed(0).padStart(7)} ms  ${String(statements - before).padStart(4)} statements`); };
let newDemand = '';
await w('Write: create demand', async () => { newDemand = (await createDemand(db, actor, randomUUID(), '1000')).demandId; });
await w('Write: submit demand (1 group)', async () => submitDemand(db, actor, randomUUID(), newDemand, (await getDemand(db, actor, newDemand)).rowVer, {
  notes: '', weeks: [{ etdWeek: week, groups: [{ name: 'Perf', containerCount: 2, capacity: '1000', unit: spec.Unit, items: [{ majorCategory: spec.MajorCategory, subMajorCategory: spec.SubMajorCategory, size: spec.Size, materialClass: spec.MaterialClass, originCode: spec.OriginCode, share: '100' }] }] }] }));
await w('Write: accept demand', async () => acceptDemand(db, other, randomUUID(), newDemand, (await getDemand(db, other, newDemand)).rowVer));
const newLines = (await getDemand(db, other, newDemand)).weeks.flatMap((x) => x.lines);
const sl = await shortlistFor(db, other, newDemand, newLines.map((l) => l.lineId));
await w('Write: create RFQ', async () => createRfq(db, other, randomUUID(), { demandId: newDemand, weeks: [], lines: newLines.map((l) => ({ lineId: l.lineId, week, qty: String(Number(l.ledger.requested)) })),
  suppliers: sl.flatMap((g) => g.entries.slice(0, 2).map((e) => e.supplierCode)).slice(0, 2) }).catch((e) => console.log('   (RFQ not created:', (e as Error).message.slice(0, 80), ')')));

// Concurrency: 20 users at once, each opening My work, the demands list and a demand, 3 times.
const demandIds = (await sql<{ id: string }>`SELECT TOP 200 DemandId AS id FROM scm.Demand WHERE CompanyCode = '1000' ORDER BY NEWID()`.execute(db)).rows.map((r) => String(r.id));
const lat: number[] = [];
const t0 = performance_now();
await Promise.all(Array.from({ length: 20 }, async (_, u) => {
  for (let k = 0; k < 3; k++) {
    lat.push(await time(() => listWork(db, actor, { page: 1, pageSize: 50 })));
    lat.push(await time(() => listDemands(db, actor, { mine: false, page: 1 + ((u + k) % 5), pageSize: 50 })));
    lat.push(await time(() => getDemand(db, actor, demandIds[(u * 3 + k) % demandIds.length])));
  }
}));
lat.sort((a, b) => a - b);
console.log(`\nConcurrency: 20 users × 3 × (My work + list + demand) = ${lat.length} calls in ${((performance_now() - t0) / 1000).toFixed(1)} s · median ${lat[Math.floor(lat.length / 2)].toFixed(0)} ms · p95 ${lat[Math.floor(lat.length * 0.95)].toFixed(0)} ms · max ${lat[lat.length - 1].toFixed(0)} ms`);

// The statements that read the most during this run (this database only).
const top = (await sql<{ reads: number; execs: number; ms: number; txt: string }>`
  SELECT TOP 15 qs.total_logical_reads / qs.execution_count AS reads, qs.execution_count AS execs, qs.total_elapsed_time / qs.execution_count / 1000 AS ms,
    REPLACE(REPLACE(SUBSTRING(st.text, (qs.statement_start_offset / 2) + 1, 220), CHAR(10), ' '), CHAR(13), ' ') AS txt
  FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
  CROSS APPLY (SELECT CONVERT(int, value) AS dbid FROM sys.dm_exec_plan_attributes(qs.plan_handle) WHERE attribute = 'dbid') pa
  WHERE pa.dbid = DB_ID() AND qs.last_execution_time >= ${started} AND st.text NOT LIKE '%dm_exec_query_stats%'
  ORDER BY qs.total_logical_reads / qs.execution_count DESC`.execute(db)).rows;
console.log('\nTop statements by logical reads per execution (8 KB pages):');
for (const r of top) console.log(`${String(r.reads).padStart(9)} reads ${String(r.ms).padStart(6)} ms ×${r.execs}  ${r.txt.replace(/\s+/g, ' ').slice(0, 170)}`);
await db.destroy();
