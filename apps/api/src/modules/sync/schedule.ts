/**
 * Sync schedule (Configuration → SAP → Sync schedule): each SAP source can run by itself on chosen days and hours,
 * in Saudi time. A timer in the API checks once a minute; a scheduled run is an ordinary run in the sync history,
 * started by "Scheduler" (hard rule 4: no hidden automatic actions).
 */
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/schema.js';
import { readSetting, writeSetting } from '../../settings/store.js';
import { SYNC_JOBS } from './jobs.js';
import { startSync, type SyncHost } from './launch.js';
import { SYNC_SOURCES, type SyncSource } from './syncRun.js';

const KEY = 'sync.schedule';
/** Saudi Arabia: UTC+3 all year (no daylight saving). */
export const SCHEDULE_UTC_OFFSET_HOURS = 3;
export const SCHEDULER_NAME = 'Scheduler';

const entrySchema = z.object({
  enabled: z.boolean(),
  /** 0 = Sunday … 6 = Saturday. */
  days: z.array(z.number().int().min(0).max(6)).max(7).transform((a) => [...new Set(a)].sort((x, y) => x - y)),
  /** 0 … 23, Saudi time; the run starts at the top of each chosen hour. */
  hours: z.array(z.number().int().min(0).max(23)).max(24).transform((a) => [...new Set(a)].sort((x, y) => x - y)),
}).refine((e) => !e.enabled || (e.days.length > 0 && e.hours.length > 0), { message: 'Choose at least one day and one hour, or turn the schedule off' });
export type ScheduleEntry = z.infer<typeof entrySchema>;

export const scheduleSchema = z.object(Object.fromEntries(SYNC_SOURCES.map((s) => [s, entrySchema])) as Record<SyncSource, typeof entrySchema>);
export type SyncSchedule = z.infer<typeof scheduleSchema>;

const OFF: ScheduleEntry = { enabled: false, days: [0, 1, 2, 3, 4], hours: [5] }; // suggested when turned on: Sun–Thu at 05:00
export const DEFAULT_SCHEDULE = Object.fromEntries(SYNC_SOURCES.map((s) => [s, OFF])) as SyncSchedule;

export async function loadSchedule(db: Kysely<Database>): Promise<SyncSchedule> {
  const stored = (await readSetting(db, KEY)) as Partial<Record<SyncSource, unknown>> | null;
  const out = { ...DEFAULT_SCHEDULE };
  for (const s of SYNC_SOURCES) {
    const p = entrySchema.safeParse(stored?.[s]);
    if (p.success) out[s] = p.data;
  }
  return out;
}

export async function saveSchedule(db: Kysely<Database>, s: SyncSchedule): Promise<void> {
  await writeSetting(db, KEY, s);
}

const HOUR = 3_600_000;
const local = (t: number) => new Date(t + SCHEDULE_UTC_OFFSET_HOURS * HOUR); // read with getUTC* = Saudi wall clock

/** The start (UTC) of the scheduled hour `now` falls in, or null when the entry is off or this hour is not chosen. */
export function dueSlot(e: ScheduleEntry, now: Date): Date | null {
  if (!e.enabled) return null;
  const l = local(now.getTime());
  if (!e.days.includes(l.getUTCDay()) || !e.hours.includes(l.getUTCHours())) return null;
  return new Date(Math.floor(now.getTime() / HOUR) * HOUR); // the offset is whole hours, so UTC and Saudi hours start together
}

/** The next scheduled start after `now` (UTC), within a week; null when off. */
export function nextRun(e: ScheduleEntry, now: Date): Date | null {
  if (!e.enabled) return null;
  const first = Math.floor(now.getTime() / HOUR) * HOUR + HOUR;
  for (let t = first; t < first + 8 * 24 * HOUR; t += HOUR) {
    const l = local(t);
    if (e.days.includes(l.getUTCDay()) && e.hours.includes(l.getUTCHours())) return new Date(t);
  }
  return null;
}

/** Slots this process already tried (a refused start — e.g. a missing setting — is not retried every minute). */
const tried = new Map<SyncSource, number>();

/**
 * Called once a minute: starts every source whose scheduled hour has come and that has not run since that hour
 * began (by the schedule or by hand — then the data is fresh anyway). A run already going is left alone.
 */
export async function runScheduledSyncs(host: SyncHost, now = new Date()): Promise<void> {
  const schedule = await loadSchedule(host.db);
  for (const source of SYNC_SOURCES) {
    const slot = dueSlot(schedule[source], now);
    if (!slot || tried.get(source) === slot.getTime()) continue;
    tried.set(source, slot.getTime());
    const minutesIn = Math.floor((now.getTime() - slot.getTime()) / 60_000) + 1;
    const ran = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM integ.SyncRun WHERE Source = ${source} AND StartedAt >= DATEADD(minute, ${-minutesIn}, SYSUTCDATETIME())`.execute(host.db);
    if (Number(ran.rows[0].n) > 0) continue;
    try {
      const r = await startSync(host, source, SCHEDULER_NAME, SYNC_JOBS[source](host.db));
      if (!r.started) host.log.warn({ source, reason: r.reason }, 'Scheduled sync not started');
    } catch (err: unknown) {
      host.log.error({ err, source }, 'Scheduled sync failed to start');
    }
  }
}
