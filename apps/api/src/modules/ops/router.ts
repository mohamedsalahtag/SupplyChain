/** Operations status (spec 25): administrators, read-only; and Configuration → Start over (purge all workflow data). */
import { P } from '@supplychain/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { audit } from '../../auth/audit.js';
import { procedure, router } from '../../trpc/trpc.js';
import { DomainError } from '../workflow/errors.js';
import { opsStatus } from './opsStatus.js';
import { purgeAll, purgePreview } from './purge.js';

const purge = procedure.meta({ permission: P.configPurge });

/** The first line of a database error, short: enough for an administrator to see what blocked the purge. */
const shortReason = (err: unknown) => String(err instanceof Error ? err.message : err).split(/\r?\n/)[0].replace(/^\[[^\]]*\]\s*/g, '').slice(0, 300);

export const opsRouter = router({
  status: procedure.meta({ permission: P.operationsOpen }).query(({ ctx }) => opsStatus(ctx.db, ctx.cfg, ctx.encKey)),
  purgePreview: purge.query(({ ctx }) => purgePreview(ctx.db, ctx.cfg.ALLOW_PURGE)),
  /** The word PURGE must be typed: a second, deliberate step, never a double click. */
  purge: purge.input(z.object({ confirm: z.literal('PURGE') })).mutation(async ({ ctx }) => {
    let r;
    try {
      r = await purgeAll(ctx.db, ctx.cfg.ATTACHMENTS_DIR, ctx.cfg.ALLOW_PURGE);
    } catch (err) {
      if (err instanceof DomainError) throw err; // already a sentence for the user (refused, SAP in progress, sync running)
      // One transaction: a failure deletes nothing. Say so, with the database's reason (e.g. a table missing from TABLES).
      ctx.log.error({ err, user: ctx.user.username }, 'Purge failed');
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `The purge failed and nothing was deleted. Reason: ${shortReason(err)}` });
    }
    await audit(ctx.db, { userId: ctx.user.id, action: 'data.purge', details: { deleted: r.deleted, filesRemoved: r.filesRemoved } }, ctx.log);
    ctx.log.warn({ user: ctx.user.username, deleted: r.deleted }, 'All workflow data purged');
    return r;
  }),
});
