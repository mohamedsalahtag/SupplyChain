import { SIGNED_IN } from '@supplychain/shared';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { SYNC_SOURCES, syncStatus } from './syncRun.js';

export const syncRouter = router({
  /** The running sync (if any) and the last finished one for a source. */
  status: procedure
    .meta({ permission: SIGNED_IN })
    .input(z.object({ source: z.enum(SYNC_SOURCES) }))
    .query(({ ctx, input }) => syncStatus(ctx.db, input.source)),
});
