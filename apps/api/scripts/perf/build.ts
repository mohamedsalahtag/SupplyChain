/**
 * Builds the PERFORMANCE database (supplychain_perf) for the database review: every migration, the SAP master data
 * copied from the dev database, then years of synthetic workflow data generated set-based on the server.
 * Refuses any database name that does not end in "_perf". Never touches the dev or live data (read-only copy).
 *
 *   npx tsx --env-file-if-exists=../../.env scripts/perf/build.ts [demands=10000]
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/db.js';
import type { Database } from '../../src/db/schema.js';

const N = Number(process.argv[2] ?? 10_000);
const cfg = loadConfig();
const SRC = cfg.DB_NAME;
const PERF = process.env.PERF_DB_NAME || 'supplychain_perf';
if (!/_perf$/.test(PERF)) throw new Error(`Refusing "${PERF}": the performance database name must end in _perf`);
if (PERF === SRC) throw new Error('The performance database cannot be the source database');

const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(5)} s  ${m}`);

// 1. Fresh database + migrations
const master = createDb({ ...cfg, DB_NAME: 'master' });
await sql.raw(`IF DB_ID('${PERF}') IS NOT NULL BEGIN ALTER DATABASE [${PERF}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${PERF}]; END;
  CREATE DATABASE [${PERF}]; ALTER DATABASE [${PERF}] SET RECOVERY SIMPLE;`).execute(master);
await master.destroy();
log(`created ${PERF}`);
const mig = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/migrate.ts'], { cwd: resolve(import.meta.dirname, '../..'), env: { ...process.env, DB_NAME: PERF }, encoding: 'utf8' });
if (mig.status !== 0) throw new Error(`Migrations failed:\n${mig.stdout}\n${mig.stderr}`);
log('migrated');

const db: Kysely<Database> = createDb({ ...cfg, DB_NAME: PERF, DB_POOL_MAX: 2 });
const run = async (label: string, text: string) => {
  const t = Date.now();
  await sql.raw(`SET NOCOUNT ON; ${text}`).execute(db);
  log(`${label} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
};

// 2. Master data copied from the dev database (read-only on the source)
async function copy(table: string) {
  const cols = (await sql<{ c: string; ident: number }>`
    SELECT c.name AS c, c.is_identity AS ident FROM sys.columns c WHERE c.object_id = OBJECT_ID(${table}) AND c.is_computed = 0 AND TYPE_NAME(c.user_type_id) <> 'timestamp' ORDER BY c.column_id`.execute(db)).rows;
  const list = cols.map((c) => `[${c.c}]`).join(',');
  const ident = cols.some((c) => c.ident);
  await run(`copied ${table}`, `${ident ? `SET IDENTITY_INSERT ${table} ON;` : ''} DELETE FROM ${table}; INSERT INTO ${table} (${list}) SELECT ${list} FROM [${SRC}].${table}; ${ident ? `SET IDENTITY_INSERT ${table} OFF;` : ''}`);
}
for (const t of ['md.Material', 'md.Supplier', 'md.SupplierPurchasingOrg', 'md.PurchaseOrder', 'md.PurchaseOrderLine', 'scm.PurchaseHistorySummary']) await copy(t);
await run('reference data', `
  DELETE FROM scm.SupplierOrigin; INSERT INTO scm.SupplierOrigin (SupplierCode, OriginCode, Source, AddedBy, AddedAt) SELECT SupplierCode, OriginCode, Source, NULL, AddedAt FROM [${SRC}].scm.SupplierOrigin WHERE Source IN ('COUNTRY','HISTORY','MANUAL');
  MERGE scm.RefOrigin t USING (SELECT OriginName, CountryCode, Source, MaterialCount FROM [${SRC}].scm.RefOrigin) s ON t.OriginName = s.OriginName
    WHEN MATCHED THEN UPDATE SET CountryCode = s.CountryCode, Source = s.Source, MaterialCount = s.MaterialCount
    WHEN NOT MATCHED THEN INSERT (OriginName, CountryCode, Source, MaterialCount) VALUES (s.OriginName, s.CountryCode, s.Source, s.MaterialCount);
  UPDATE scm.Company SET PurchasingOrg = CompanyCode, PurchasingGroup = '100';`);

// 3. Users: 30 people, 10 per company
await run('users', `
  INSERT INTO app.[User] (Username, DisplayName, CreatedBy) SELECT 'perf.user' + RIGHT('0' + CAST(n AS varchar), 2), 'Perf User ' + CAST(n AS varchar), 'perf'
  FROM (SELECT TOP 30 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x;
  INSERT INTO scm.UserCompany (UserId, CompanyCode) SELECT UserId, CHOOSE(UserId % 3 + 1, '1000', '2000', '3000') FROM app.[User] WHERE Username LIKE 'perf.%';`);

// Helpers created once: a numbers table, the ISO week of a date, material specs and suppliers to draw from.
await run('helpers', `
  CREATE TABLE #n (i int PRIMARY KEY);
  INSERT INTO #n SELECT TOP (${N * 40}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c;
  SELECT * INTO perf_n FROM #n; ALTER TABLE perf_n ADD CONSTRAINT PK_perf_n PRIMARY KEY (i);`);
await run('specs and suppliers', `
  SELECT ROW_NUMBER() OVER (ORDER BY x.SubMajorCategory, x.Size, x.MaterialClass) - 1 AS rn, x.* INTO perf_spec FROM (
    SELECT TOP 400 m.MajorCategory, m.SubMajorCategory, m.Size, m.MaterialClass, r.CountryCode AS OriginCode, MIN(m.BaseUnit) AS Unit
    FROM md.Material m JOIN scm.RefOrigin r ON r.OriginName = m.Origin AND r.CountryCode IS NOT NULL
    WHERE m.InSap = 1 AND m.MajorCategory <> '' AND m.SubMajorCategory <> '' AND m.BaseUnit <> ''
    GROUP BY m.MajorCategory, m.SubMajorCategory, m.Size, m.MaterialClass, r.CountryCode) x;
  SELECT ROW_NUMBER() OVER (ORDER BY SupplierCode) - 1 AS rn, SupplierCode INTO perf_sup FROM (SELECT TOP 60 SupplierCode FROM md.Supplier WHERE InSap = 1 ORDER BY SupplierCode) s;`);
const specs = Number((await sql<{ n: number }>`SELECT COUNT(*) AS n FROM perf_spec`.execute(db)).rows[0].n);
const sups = Number((await sql<{ n: number }>`SELECT COUNT(*) AS n FROM perf_sup`.execute(db)).rows[0].n);
log(`${specs} material specs, ${sups} suppliers to draw from`);
const U = `(SELECT MIN(UserId) FROM app.[User] WHERE Username LIKE 'perf.%')`;
const iso = (d: string) => `CAST(YEAR(DATEADD(day, 26 - DATEPART(ISO_WEEK, ${d}), ${d})) AS char(4)) + '-W' + RIGHT('0' + CAST(DATEPART(ISO_WEEK, ${d}) AS varchar), 2)`;

// 4. Demands: ~3 years, 5 % draft, 5 % submitted, 90 % accepted
await run(`${N} demands`, `
  INSERT INTO scm.Demand (DemandNo, CompanyCode, WorkflowStatus, CurrentVersion, BaselineVersion, Notes, CreatedBy, CreatedAt, SubmittedAt, AcceptedAt, AcceptedBy)
  SELECT 'D-' + RIGHT('0000000' + CAST(i AS varchar), 7), CHOOSE(i % 3 + 1, '1000', '2000', '3000'),
    CASE i % 20 WHEN 0 THEN 'DRAFT' WHEN 1 THEN 'SUBMITTED' ELSE 'ACCEPTED' END,
    CASE i % 20 WHEN 0 THEN 0 ELSE 1 END, CASE i % 20 WHEN 0 THEN NULL ELSE 1 END, 'Performance data', ${U} + i % 30,
    DATEADD(minute, i * ${Math.floor((3 * 365 * 24 * 60) / N)}, '2023-10-01'),
    CASE WHEN i % 20 = 0 THEN NULL ELSE DATEADD(minute, i * ${Math.floor((3 * 365 * 24 * 60) / N)} + 60, '2023-10-01') END,
    CASE WHEN i % 20 IN (0, 1) THEN NULL ELSE DATEADD(minute, i * ${Math.floor((3 * 365 * 24 * 60) / N)} + 600, '2023-10-01') END,
    CASE WHEN i % 20 IN (0, 1) THEN NULL ELSE ${U} + (i + 7) % 30 END
  FROM perf_n WHERE i <= ${N};`);
await run('weeks (3 per demand)', `
  INSERT INTO scm.DemandWeek (DemandId, EtdWeek, ContainerCount)
  SELECT d.DemandId, ${iso('DATEADD(week, k.k + 3, d.CreatedAt)')}, 2 + (d.DemandId + k.k) % 3
  FROM scm.Demand d CROSS JOIN (VALUES (0), (1), (2)) k(k);`);
await run('container groups', `
  INSERT INTO scm.ContainerGroup (DemandId, DemandWeekId, GroupNumber, ContainerCount, CapacityQty, Unit, Name)
  SELECT w.DemandId, w.DemandWeekId, 1, w.ContainerCount, 1540000, s.Unit, 'Group' FROM scm.DemandWeek w JOIN perf_spec s ON s.rn = (w.DemandWeekId * 2) % ${specs};`);
await run('container group items (2 per group)', `
  INSERT INTO scm.ContainerGroupItem (ContainerGroupId, SpecMode, MajorCategory, SubMajorCategory, Size, MaterialClass, OriginCode, MaterialCode, Unit, ShareBp, ComputedQty)
  SELECT g.ContainerGroupId, 'SPEC', s.MajorCategory, s.SubMajorCategory, s.Size, s.MaterialClass, s.OriginCode, NULL, g.Unit, 5000, g.ContainerCount * g.CapacityQty / 2
  FROM scm.ContainerGroup g CROSS JOIN (VALUES (0), (1)) k(k) JOIN perf_spec s ON s.rn = (g.DemandWeekId * 2 + k.k) % ${specs};`);
await run('demand lines', `
  INSERT INTO scm.DemandLine (DemandId, DemandWeekId, LineNumber, SpecMode, MajorCategory, SubMajorCategory, Size, MaterialClass, OriginCode, MaterialCode, Unit, RequestedQty)
  SELECT g.DemandId, g.DemandWeekId, ROW_NUMBER() OVER (PARTITION BY g.DemandId ORDER BY g.DemandWeekId, i.ContainerGroupItemId), 'SPEC',
    i.MajorCategory, i.SubMajorCategory, i.Size, i.MaterialClass, i.OriginCode, NULL, i.Unit, i.ComputedQty
  FROM scm.ContainerGroupItem i JOIN scm.ContainerGroup g ON g.ContainerGroupId = i.ContainerGroupId;
  INSERT INTO scm.DemandKeyUom (DemandId, LineKey, Unit) SELECT DemandId, LineKey, MIN(Unit) FROM scm.DemandLine GROUP BY DemandId, LineKey;`);
await run('versions (baseline snapshot per submitted demand)', `
  DECLARE @snap nvarchar(max) = ISNULL((SELECT TOP 1 SnapshotJson FROM [${SRC}].scm.DemandVersion ORDER BY LEN(SnapshotJson) DESC), REPLICATE(N'x', 3000));
  INSERT INTO scm.DemandVersion (DemandId, VersionNo, Reason, SnapshotJson, CreatedBy, CreatedAt)
  SELECT DemandId, 1, 'SUBMITTED', @snap, CreatedBy, SubmittedAt FROM scm.Demand WHERE SubmittedAt IS NOT NULL;`);

// 5. Slices: 2 per line of accepted demands, spread over every state
await run('slices', `
  INSERT INTO scm.QtySlice (LineId, Qty, ExecState, BusinessOrigin, OriginDemandId, OriginLineId, ApprovedEtdWeek, EffectiveSubmittedAt, CancelOrigin)
  SELECT l.LineId, CASE k.k WHEN 0 THEN l.RequestedQty / 2 ELSE l.RequestedQty - l.RequestedQty / 2 END,
    CASE (l.LineId * 2 + k.k) % 20 WHEN 0 THEN 'OPEN' WHEN 1 THEN 'OPEN' WHEN 2 THEN 'IN_RFQ' WHEN 3 THEN 'IN_RFQ' WHEN 4 THEN 'QUOTED' WHEN 5 THEN 'AWARDED' WHEN 6 THEN 'AWARDED'
      WHEN 7 THEN 'HANDED_OFF' WHEN 8 THEN 'PO_PREPARATION' WHEN 9 THEN 'PO_SUBMITTED' WHEN 19 THEN 'CANCELLED' ELSE 'PO_CREATED' END,
    'SALES', l.DemandId, l.LineId, w.EtdWeek, d.SubmittedAt, CASE WHEN (l.LineId * 2 + k.k) % 20 = 19 THEN 'SALES' END
  FROM scm.DemandLine l JOIN scm.DemandWeek w ON w.DemandWeekId = l.DemandWeekId JOIN scm.Demand d ON d.DemandId = l.DemandId
  CROSS JOIN (VALUES (0), (1)) k(k) WHERE d.WorkflowStatus = 'ACCEPTED';
  UPDATE s2 SET SplitFromSliceId = s1.SliceId FROM scm.QtySlice s2 JOIN scm.QtySlice s1 ON s1.LineId = s2.LineId AND s1.SliceId < s2.SliceId;`);

// 6. RFQs, quotes, awards, handoffs for accepted demands
await run('RFQs, lines, invited suppliers', `
  INSERT INTO scm.Rfq (RfqNo, DemandId, CompanyCode, ManualStatus, CreatedBy, CreatedAt, SentBy, SentAt)
  SELECT 'RFQ-' + RIGHT('0000000' + CAST(ROW_NUMBER() OVER (ORDER BY DemandId) AS varchar), 7), DemandId, CompanyCode, 'SENT', AcceptedBy, DATEADD(day, 1, AcceptedAt), AcceptedBy, DATEADD(day, 1, AcceptedAt)
  FROM scm.Demand WHERE WorkflowStatus = 'ACCEPTED';
  INSERT INTO scm.RfqLine (RfqId, DemandLineId, MajorCategory, SubMajorCategory, Size, MaterialClass, OriginCode, MaterialCode, Unit, ProposedEtdWeek, AskedQty)
  SELECT r.RfqId, l.LineId, l.MajorCategory, l.SubMajorCategory, LEFT(l.Size, 40), l.MaterialClass, l.OriginCode, NULL, l.Unit, w.EtdWeek, l.RequestedQty
  FROM scm.Rfq r JOIN scm.DemandLine l ON l.DemandId = r.DemandId JOIN scm.DemandWeek w ON w.DemandWeekId = l.DemandWeekId;
  INSERT INTO scm.RfqSupplier (RfqId, SupplierCode, OriginsAtInvite, ShortlistRank, InvitedBy)
  SELECT r.RfqId, s.SupplierCode, 'CL', k.k + 1, r.CreatedBy FROM scm.Rfq r CROSS JOIN (VALUES (0), (1), (2)) k(k) JOIN perf_sup s ON s.rn = (r.RfqId + k.k * 7) % ${sups};`);
await run('quotes (3 suppliers per line)', `
  INSERT INTO scm.SupplierQuote (RfqId, SupplierCode, EtdWeek, LineKey, OriginCode, Unit, UnitPrice, Currency, AvailableQty, ContainersOffered, OriginsAtQuote, RecordedBy, RecordedAt)
  SELECT l.RfqId, rs.SupplierCode, l.ProposedEtdWeek, l.LineKey, l.OriginCode, l.Unit, 15 + (l.RfqLineId % 700) / 100.0, 'USD', l.AskedQty, 3, l.OriginCode, rs.InvitedBy, DATEADD(day, 3, rs.InvitedAt)
  FROM scm.RfqLine l JOIN scm.RfqSupplier rs ON rs.RfqId = l.RfqId;`);
await run('award batches, items, shipments, acknowledgements', `
  INSERT INTO scm.AwardBatch (AbNo, RfqId, DemandId, CompanyCode, CreatedBy, CreatedAt)
  SELECT 'AB-' + RIGHT('0000000' + CAST(ROW_NUMBER() OVER (ORDER BY RfqId) AS varchar), 7), RfqId, DemandId, CompanyCode, CreatedBy, DATEADD(day, 5, CreatedAt) FROM scm.Rfq;
  INSERT INTO scm.AwardItem (AwardBatchId, RfqLineId, SupplierCode, EtdWeek, LineKey, Qty, Unit, QuoteId, UnitPrice, Currency, SkuStatus, ByContainers)
  SELECT b.AwardBatchId, l.RfqLineId, q.SupplierCode, l.ProposedEtdWeek, l.LineKey, l.AskedQty, l.Unit, q.QuoteId, q.UnitPrice, 'USD', 'RESOLVED_AT_PO', 1
  FROM scm.AwardBatch b JOIN scm.RfqLine l ON l.RfqId = b.RfqId
  JOIN scm.SupplierQuote q ON q.RfqId = l.RfqId AND q.EtdWeek = l.ProposedEtdWeek AND q.LineKey = l.LineKey
  JOIN scm.RfqSupplier rs ON rs.RfqId = q.RfqId AND rs.SupplierCode = q.SupplierCode AND rs.ShortlistRank = 1;
  INSERT INTO scm.AwardShipment (AwardBatchId, SupplierCode, EtdWeek, ContainerCount, ConfirmedEtd, UpdatedBy)
  SELECT i.AwardBatchId, i.SupplierCode, i.EtdWeek, 2, DATEADD(day, 40, MIN(b.CreatedAt)), MIN(b.CreatedBy)
  FROM scm.AwardItem i JOIN scm.AwardBatch b ON b.AwardBatchId = i.AwardBatchId GROUP BY i.AwardBatchId, i.SupplierCode, i.EtdWeek;
  INSERT INTO scm.SalesAck (AwardBatchId, DemandId, Status, RespondedBy, RespondedAt)
  SELECT AwardBatchId, DemandId, 'ACKNOWLEDGED', CreatedBy, DATEADD(hour, 20, CreatedAt) FROM scm.AwardBatch;`);
await run('handoffs', `
  DECLARE @snap nvarchar(max) = ISNULL((SELECT TOP 1 SnapshotJson FROM [${SRC}].scm.Handoff ORDER BY LEN(SnapshotJson) DESC), REPLICATE(N'y', 4000));
  INSERT INTO scm.Handoff (HoNo, AwardBatchId, SupplierCode, CompanyCode, Status, HandedOffQty, SnapshotJson, SentBy, SentAt, AckRevision, AcceptedBy, AcceptedAt)
  SELECT 'HO-' + RIGHT('0000000' + CAST(ROW_NUMBER() OVER (ORDER BY b.AwardBatchId) AS varchar), 7), b.AwardBatchId, x.SupplierCode, b.CompanyCode, 'ACCEPTED', x.Q, @snap,
    b.CreatedBy, DATEADD(day, 2, b.CreatedAt), 1, ${U} + (b.CreatedBy - ${U} + 1) % 30, DATEADD(day, 3, b.CreatedAt)
  FROM scm.AwardBatch b JOIN (SELECT AwardBatchId, MIN(SupplierCode) AS SupplierCode, SUM(Qty) AS Q FROM scm.AwardItem GROUP BY AwardBatchId) x ON x.AwardBatchId = b.AwardBatchId;`);
await run('slices linked to RFQ lines, award items, handoffs', `
  UPDATE s SET RfqLineId = l.RfqLineId FROM scm.QtySlice s JOIN scm.RfqLine l ON l.DemandLineId = s.LineId WHERE s.ExecState NOT IN ('OPEN', 'CANCELLED');
  UPDATE s SET AwardItemId = i.AwardItemId FROM scm.QtySlice s JOIN scm.AwardItem i ON i.RfqLineId = s.RfqLineId WHERE s.ExecState NOT IN ('OPEN', 'CANCELLED', 'IN_RFQ', 'QUOTED');
  UPDATE s SET HandoffId = h.HandoffId FROM scm.QtySlice s JOIN scm.AwardItem i ON i.AwardItemId = s.AwardItemId JOIN scm.Handoff h ON h.AwardBatchId = i.AwardBatchId AND h.SupplierCode = i.SupplierCode
  WHERE s.ExecState IN ('HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED', 'PO_CREATED');`);

// 7. Ledger history: every step a slice went through, with the triggers the reports read
await run('slice history (every step up to the current state)', `
  CREATE TABLE #ladder (ord int, st nvarchar(20), trig nvarchar(30));
  INSERT INTO #ladder VALUES (1,'OPEN',NULL),(2,'IN_RFQ','ADD_TO_RFQ'),(3,'QUOTED','QUOTE_RECORDED'),(4,'AWARDED','AWARD'),(5,'HANDED_OFF','HANDOFF_SEND'),
    (6,'PO_PREPARATION','HANDOFF_ACCEPT'),(7,'PO_SUBMITTED','PO_SUBMIT'),(8,'PO_CREATED','SAP_CONFIRMED');
  INSERT INTO scm.SliceHistory (SliceId, Action, TriggerName, FromState, ToState, Qty, DocType, ActorUserId, ChangedAt)
  SELECT s.SliceId, CASE WHEN l.ord = 1 THEN 'CREATE' ELSE 'TRANSITION' END, l.trig, p.st, l.st, s.Qty, 'DEMAND', ${U} + s.SliceId % 30, DATEADD(day, l.ord * 2, s.EffectiveSubmittedAt)
  FROM scm.QtySlice s JOIN #ladder cur ON cur.st = CASE s.ExecState WHEN 'CANCELLED' THEN 'OPEN' ELSE s.ExecState END
  JOIN #ladder l ON l.ord <= cur.ord LEFT JOIN #ladder p ON p.ord = l.ord - 1;
  INSERT INTO scm.SliceHistory (SliceId, Action, TriggerName, FromState, ToState, Qty, ActorUserId, ChangedAt)
  SELECT SliceId, 'TRANSITION', 'CR_CANCEL', 'OPEN', 'CANCELLED', Qty, ${U}, DATEADD(day, 3, EffectiveSubmittedAt) FROM scm.QtySlice WHERE ExecState = 'CANCELLED';`);

// 8. Change requests (one for every second accepted demand)
await run('change requests', `
  INSERT INTO scm.ChangeRequest (CrNo, DemandId, CompanyCode, CrType, RaisedByDept, Status, ApplyStatus, ReasonCode, Comment, RaisedBy, SubmittedAt, DecidedBy, DecidedAt, AppliedAt)
  SELECT 'CR-' + RIGHT('0000000' + CAST(ROW_NUMBER() OVER (ORDER BY DemandId) AS varchar), 7), DemandId, CompanyCode, 'CHANGE_CONTAINERS', 'SALES', 'APPROVED', 'APPLIED',
    (SELECT TOP 1 ReasonCode FROM scm.ReasonCode), 'Performance data', CreatedBy, DATEADD(day, 10, AcceptedAt), AcceptedBy, DATEADD(day, 11, AcceptedAt), DATEADD(day, 11, AcceptedAt)
  FROM scm.Demand WHERE WorkflowStatus = 'ACCEPTED' AND DemandId % 2 = 0 AND CreatedBy <> AcceptedBy;
  INSERT INTO scm.ChangeRequestItem (CrId, ItemNo, ItemKind, EtdWeek, ContainerGroupId, EffectJson, RequestedCount, Decision, ApprovedCount)
  SELECT c.CrId, 1, 'GROUP_COUNT', w.EtdWeek, g.ContainerGroupId, '{}', 1, 'APPROVE', 1
  FROM scm.ChangeRequest c CROSS APPLY (SELECT TOP 1 * FROM scm.DemandWeek w WHERE w.DemandId = c.DemandId ORDER BY EtdWeek) w
  JOIN scm.ContainerGroup g ON g.DemandWeekId = w.DemandWeekId;`);

// 9. Events, threads, comments, My work items, command log — the tables that grow fastest
await run('domain events (20 per demand)', `
  INSERT INTO scm.DomainEvent (EventType, EntityType, EntityId, DemandId, PayloadJson, ActorUserId, OccurredAt)
  SELECT CHOOSE(k.i % 10 + 1, 'DEMAND_CREATED', 'DEMAND_SUBMITTED', 'DEMAND_ACCEPTED', 'RFQ_CREATED', 'RFQ_SENT', 'QUOTE_RECORDED', 'AWARD_CREATED', 'HANDOFF_SENT', 'PO_SUBMITTED', 'PO_CREATED'),
    CASE WHEN k.i % 10 < 3 THEN 'DEMAND' ELSE 'RFQ' END, CAST(d.DemandId AS nvarchar(40)), d.DemandId, N'{"n":' + CAST(k.i AS nvarchar) + N'}', d.CreatedBy, DATEADD(hour, k.i * 7, d.CreatedAt)
  FROM scm.Demand d CROSS JOIN (SELECT i FROM perf_n WHERE i <= 20) k;`);
await run('threads and entries (15 per demand)', `
  INSERT INTO scm.Thread (EntityType, EntityId) SELECT 'DEMAND', CAST(DemandId AS nvarchar(40)) FROM scm.Demand;
  INSERT INTO scm.ThreadEntry (ThreadId, EntryKind, Body, AuthorUserId, CreatedAt)
  SELECT t.ThreadId, CASE WHEN k.i % 3 = 0 THEN 'COMMENT' ELSE 'SYSTEM' END, N'Performance comment number ' + CAST(k.i AS nvarchar) + N' with some text to make it realistic in size.', ${U} + k.i % 30,
    DATEADD(hour, k.i * 5, d.CreatedAt)
  FROM scm.Thread t JOIN scm.Demand d ON CAST(d.DemandId AS nvarchar(40)) = t.EntityId CROSS JOIN (SELECT i FROM perf_n WHERE i <= 15) k;`);
await run('My work items (10 per demand, 3 % open)', `
  INSERT INTO scm.InboxItem (ItemType, Category, Permission, CompanyCode, EntityType, EntityId, Number, Title, Link, RaisedBy, CreatedAt, DueAt, IsOpen, ClosedAt, ClosedBy)
  SELECT CHOOSE(k.i, 'DEMAND_TO_ACCEPT', 'RFQ_TO_QUOTE', 'OPEN_QTY_AGING', 'ACK_PENDING', 'HANDOFF_READY', 'HANDOFF_TO_ACCEPT', 'PO_TO_PREPARE', 'CR_TO_DECIDE', 'SAP_UNKNOWN', 'DEMAND_RETURNED'),
    CASE WHEN k.i IN (3, 9) THEN 'EXCEPTION' ELSE 'TASK' END,
    CHOOSE(k.i, 'demand.accept', 'rfq.manage', 'rfq.manage', 'ack.respond', 'handoff.send', 'handoff.accept', 'po.manage', 'cr.decide.sales', 'po.manage', 'demand.submit'),
    d.CompanyCode, 'DEMAND', CAST(d.DemandId AS nvarchar(40)), d.DemandNo, d.DemandNo + N' · performance item', '/demands/' + CAST(d.DemandId AS varchar), d.CreatedBy,
    DATEADD(hour, k.i * 9, d.CreatedAt), DATEADD(day, 2, DATEADD(hour, k.i * 9, d.CreatedAt)),
    CASE WHEN d.DemandId % 33 = 0 THEN 1 ELSE 0 END, CASE WHEN d.DemandId % 33 = 0 THEN NULL ELSE DATEADD(day, 1, DATEADD(hour, k.i * 9, d.CreatedAt)) END,
    CASE WHEN d.DemandId % 33 = 0 THEN NULL ELSE d.CreatedBy END
  FROM scm.Demand d CROSS JOIN (SELECT i FROM perf_n WHERE i <= 10) k;`);
await run('command log (30 per demand)', `
  INSERT INTO scm.CommandLog (CommandId, UserId, CommandName, ResultJson, CreatedAt)
  SELECT NEWID(), d.CreatedBy, 'demand.save', N'{"ok":true}', DATEADD(minute, k.i * 13, d.CreatedAt) FROM scm.Demand d CROSS JOIN (SELECT i FROM perf_n WHERE i <= 30) k;`);

await run('statistics', `EXEC sp_updatestats; DROP TABLE perf_n; DROP TABLE perf_spec; DROP TABLE perf_sup;`);
const counts = (await sql<{ t: string; n: number }>`
  SELECT s.name + '.' + t.name AS t, SUM(p.rows) AS n FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
  WHERE s.name = 'scm' GROUP BY s.name, t.name HAVING SUM(p.rows) > 1000 ORDER BY 2 DESC`.execute(db)).rows;
for (const c of counts) console.log(`   ${c.t.padEnd(32)} ${Number(c.n).toLocaleString('en-GB')}`);
await db.destroy();
log('done');
