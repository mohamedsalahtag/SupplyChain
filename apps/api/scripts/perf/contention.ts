/** Submits N demands at once (perf database) while sampling what SQL Server's requests wait on: finds lock contention on write paths. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { ALL_PERMISSION_KEYS } from '@supplychain/shared';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/db.js';
import '../../src/modules/demand/access.js';
import { getDemand } from '../../src/modules/demand/demandRead.js';
import { createDemand, submitDemand } from '../../src/modules/demand/demandService.js';
import { isoWeekMonday, isoWeekOf } from '../../src/modules/workflow/isoWeek.js';

const N = Number(process.argv[2] ?? 4);
const cfg = loadConfig();
const db = createDb({ ...cfg, DB_NAME: 'supplychain_perf', DB_POOL_MAX: 20 });
const mon = createDb({ ...cfg, DB_NAME: 'supplychain_perf', DB_POOL_MAX: 1 });
const uid = Number((await sql<{ id: number }>`SELECT TOP 1 u.UserId AS id FROM app.[User] u JOIN scm.UserCompany c ON c.UserId = u.UserId WHERE c.CompanyCode = '1000' AND u.Username LIKE 'perf.%'`.execute(db)).rows[0].id);
const actor = { id: uid, isAdmin: false, permissions: new Set(ALL_PERMISSION_KEYS), companies: new Set(['1000']) };
const specs = (await sql<{ MajorCategory: string; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string; Unit: string }>`
  SELECT TOP (${N}) m.MajorCategory, m.SubMajorCategory, m.Size, m.MaterialClass, r.CountryCode AS OriginCode, m.BaseUnit AS Unit FROM md.Material m
  JOIN scm.RefOrigin r ON r.OriginName = m.Origin AND r.CountryCode IS NOT NULL WHERE m.InSap = 1 AND m.BaseUnit = 'CT' AND m.MajorCategory <> '' ORDER BY m.MaterialCode`.execute(db)).rows;
const week = isoWeekOf(new Date(isoWeekMonday(isoWeekOf(new Date())).getTime() + 6 * 7 * 86_400_000));
const ids = await Promise.all(Array.from({ length: N }, async () => (await createDemand(db, actor, randomUUID(), '1000')).demandId));

let sampling = true;
const waits = new Map<string, number>();
const sampler = (async () => {
  while (sampling) {
    const rows = (await sql<{ wait: string | null; res: string | null; blk: number; cmd: string; txt: string }>`
      SELECT r.wait_type AS wait, r.wait_resource AS res, r.blocking_session_id AS blk, r.command AS cmd, SUBSTRING(t.text, r.statement_start_offset / 2 + 1, 200) AS txt
      FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE r.database_id = DB_ID() AND r.session_id <> @@SPID`.execute(mon)).rows;
    for (const r of rows) { const k = `${r.wait ?? 'RUNNING'} | blocked by ${r.blk || '-'} | ${r.txt.replace(/\s+/g, ' ').slice(0, 100)}`; waits.set(k, (waits.get(k) ?? 0) + 1); }
    await new Promise((ok) => setTimeout(ok, 50));
  }
})();
const t0 = Date.now();
const times = await Promise.all(ids.map(async (id, i) => {
  const t = Date.now(); const s = specs[i % specs.length];
  await submitDemand(db, actor, randomUUID(), id, (await getDemand(db, actor, id)).rowVer, { notes: '', weeks: [{ etdWeek: week, groups: [{ name: 'P', containerCount: 2, capacity: '1000', unit: s.Unit,
    items: [{ majorCategory: s.MajorCategory, subMajorCategory: s.SubMajorCategory, size: s.Size, materialClass: s.MaterialClass, originCode: s.OriginCode, share: '100' }] }] }] });
  return Date.now() - t;
}));
sampling = false; await sampler;
console.log(`SUBMITS ${N} in parallel: ${times.join(', ')} ms (total ${Date.now() - t0} ms)`);
for (const [k, n] of [...waits].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${String(n).padStart(4)} samples  ${k}`);
await db.destroy(); await mon.destroy();
