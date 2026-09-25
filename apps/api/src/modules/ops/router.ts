/** Operations status (spec 25): administrators, read-only. */
import { P } from '@supplychain/shared';
import { procedure, router } from '../../trpc/trpc.js';
import { opsStatus } from './opsStatus.js';

export const opsRouter = router({
  status: procedure.meta({ permission: P.operationsOpen }).query(({ ctx }) => opsStatus(ctx.db, ctx.cfg)),
});
