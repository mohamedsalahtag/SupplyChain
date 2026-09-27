import { P, SIGNED_IN } from '@supplychain/shared';
import { z } from 'zod';
import { audit } from '../../auth/audit.js';
import { procedure, router } from '../../trpc/trpc.js';
import { loadSchedule, nextRun, saveSchedule, SCHEDULE_UTC_OFFSET_HOURS, scheduleSchema } from './schedule.js';
import { SYNC_SOURCES, syncStatus } from './syncRun.js';

const withNext = (s: Awaited<ReturnType<typeof loadSchedule>>) => ({
  schedule: s,
  next: Object.fromEntries(SYNC_SOURCES.map((k) => [k, nextRun(s[k], new Date())?.toISOString() ?? null])) as Record<(typeof SYNC_SOURCES)[number], string | null>,
  utcOffsetHours: SCHEDULE_UTC_OFFSET_HOURS,
});

export const syncRouter = router({
  /** The running sync (if any) and the last finished one for a source. */
  status: procedure
    .meta({ permission: SIGNED_IN })
    .input(z.object({ source: z.enum(SYNC_SOURCES) }))
    .query(({ ctx, input }) => syncStatus(ctx.db, input.source)),

  /** Configuration → SAP → Sync schedule: days and hours (Saudi time) per source, and each source's next run. */
  schedule: procedure.meta({ permission: P.configOpen }).query(async ({ ctx }) => withNext(await loadSchedule(ctx.db))),
  saveSchedule: procedure.meta({ permission: P.configSyncScheduleEdit }).input(scheduleSchema).mutation(async ({ ctx, input }) => {
    await saveSchedule(ctx.db, input);
    await audit(ctx.db, { userId: ctx.user!.id, action: 'config.sync.schedule', details: input }, ctx.log);
    return withNext(input);
  }),
});
