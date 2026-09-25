/**
 * Operations status (spec 25, plan v5 Stage 10): what an administrator checks every morning — the SAP outbox, master-data
 * freshness, overdue work, users whose roles break separation of duties, attachment storage and the switches that must be
 * off on the live server. Read-only; company scope does not apply (administrators only).
 */
import { sql } from 'kysely';
import type { Config } from '../../config.js';
import { lastSuccessfulSyncs, MASTER_DATA_SOURCES, staleSources } from '../workflow/masterData.js';
import { loadWfSettings } from '../workflow/settings.js';
import { loadSapPoApi, sapPoApiProblems } from '../../settings/sapPoApi.js';
import type { Db } from '../workflow/tx.js';

/** Pairs one person should not hold together (plan v5 §0.4 separation of duties). */
export const SOD_PAIRS: [string, string, string][] = [
  ['demand.submit', 'demand.accept', 'raises and accepts the same demand'],
  ['award.manage', 'handoff.accept', 'awards and accepts the handoff of the award'],
  ['handoff.send', 'po.manage', 'hands off and builds the PO'],
  ['cr.raise.sales', 'cr.decide.sales', 'raises and decides Sales change requests'],
  ['cr.raise.procurement', 'cr.decide.procurement', 'raises and decides Procurement change requests'],
];

const SOD_KEYS = [...new Set(SOD_PAIRS.flatMap(([a, b]) => [a, b]))];

/** Users (not administrators) holding both keys of a pair, with what that lets them do alone. */
export function sodConflicts(rows: { UserId: number | string; DisplayName: string; PermissionKey: string }[]) {
  const users = new Map<number, { name: string; keys: Set<string> }>();
  for (const r of rows) {
    const u = users.get(Number(r.UserId)) ?? { name: r.DisplayName, keys: new Set<string>() };
    u.keys.add(r.PermissionKey);
    users.set(Number(r.UserId), u);
  }
  return [...users].flatMap(([userId, u]) => {
    const conflicts = SOD_PAIRS.filter(([a, b]) => u.keys.has(a) && u.keys.has(b)).map(([, , why]) => why);
    return conflicts.length ? [{ userId, name: u.name, conflicts }] : [];
  });
}

export async function opsStatus(db: Db, config: Config, encKey: string) {
  const settings = await loadWfSettings(db);
  const poApi = await loadSapPoApi(db, encKey);
  const now = new Date();
  const [outbox, lastRun, syncs, overdue, sod, noCompany, files] = await Promise.all([
    sql<{ Status: string; N: number; Oldest: Date | null }>`SELECT Status, COUNT(*) AS N, MIN(CreatedAt) AS Oldest FROM scm.SapSubmission
      WHERE Status IN ('PENDING', 'IN_FLIGHT', 'UNKNOWN', 'MANUAL') GROUP BY Status`.execute(db),
    sql<{ At: Date | null }>`SELECT MAX(StartedAt) AS At FROM scm.SapSubmissionAttempt`.execute(db),
    lastSuccessfulSyncs(db),
    sql<{ ItemType: string; Category: string; N: number; Oldest: Date | null }>`SELECT ItemType, Category, COUNT(*) AS N, MIN(DueAt) AS Oldest FROM scm.InboxItem
      WHERE IsOpen = 1 AND DueAt < SYSUTCDATETIME() GROUP BY ItemType, Category ORDER BY COUNT(*) DESC`.execute(db),
    // SQL Server 2016: no STRING_AGG — one row per user × key, grouped below.
    sql<{ UserId: number; DisplayName: string; PermissionKey: string }>`SELECT DISTINCT u.UserId, u.DisplayName, rp.PermissionKey
      FROM app.[User] u JOIN app.UserRole ur ON ur.UserId = u.UserId JOIN app.RolePermission rp ON rp.RoleId = ur.RoleId
      WHERE u.IsActive = 1 AND NOT EXISTS (SELECT 1 FROM app.UserRole ar JOIN app.Role r ON r.RoleId = ar.RoleId WHERE ar.UserId = u.UserId AND r.IsAdmin = 1) AND rp.PermissionKey IN (${sql.join(SOD_KEYS)})`.execute(db),
    sql<{ UserId: number; DisplayName: string }>`SELECT u.UserId, u.DisplayName FROM app.[User] u
      WHERE u.IsActive = 1 AND NOT EXISTS (SELECT 1 FROM app.UserRole ar JOIN app.Role r ON r.RoleId = ar.RoleId WHERE ar.UserId = u.UserId AND r.IsAdmin = 1) AND EXISTS (SELECT 1 FROM app.UserRole ur WHERE ur.UserId = u.UserId)
        AND NOT EXISTS (SELECT 1 FROM scm.UserCompany c WHERE c.UserId = u.UserId) ORDER BY u.DisplayName`.execute(db),
    sql<{ N: number; Bytes: number | null }>`SELECT COUNT(*) AS N, SUM(CAST(SizeBytes AS bigint)) AS Bytes FROM scm.Attachment`.execute(db),
  ]);
  const stale = staleSources(syncs, settings.masterDataMaxAgeHours, now);
  const by = (s: string) => outbox.rows.find((r) => r.Status === s);
  const ageMin = (d: Date | null | undefined) => (d ? Math.round((now.getTime() - new Date(d).getTime()) / 60_000) : null);
  return {
    checkedAt: now.toISOString(),
    sap: {
      pending: Number(by('PENDING')?.N ?? 0), oldestPendingMinutes: ageMin(by('PENDING')?.Oldest), inFlight: Number(by('IN_FLIGHT')?.N ?? 0),
      unknown: Number(by('UNKNOWN')?.N ?? 0), manual: Number(by('MANUAL')?.N ?? 0), lastAttemptMinutes: ageMin(lastRun.rows[0]?.At), adapter: poApi.mode, apiProblems: sapPoApiProblems(poApi),
    },
    masterData: {
      maxAgeHours: settings.masterDataMaxAgeHours,
      sources: MASTER_DATA_SOURCES.map((s) => ({ source: s, lastSuccess: syncs[s]?.toISOString() ?? null, stale: stale.includes(s) })),
    },
    overdue: overdue.rows.map((r) => ({ itemType: r.ItemType, category: r.Category, count: Number(r.N), oldestDueAt: r.Oldest ? new Date(r.Oldest).toISOString() : null })),
    separationOfDuties: sodConflicts(sod.rows),
    usersWithoutCompany: noCompany.rows.map((u) => ({ userId: Number(u.UserId), name: u.DisplayName })),
    attachments: { files: Number(files.rows[0]?.N ?? 0), megabytes: Math.round(Number(files.rows[0]?.Bytes ?? 0) / 1_048_576 * 10) / 10 },
    switches: { viewAs: config.ALLOW_VIEW_AS, testLogin: config.ALLOW_TEST_LOGIN, production: process.env.NODE_ENV === 'production' },
  };
}
