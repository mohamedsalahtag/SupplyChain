/** My work (spec 10): the signed-in user's open work items and exceptions. */
import { DEFAULT_TABLE_PAGE_SIZE, P, TABLE_PAGE_SIZES } from '@supplychain/shared';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { loadActor } from '../workflow/access.js';
import { listWork, workTabs } from '../workflow/inbox.js';

const open = procedure.meta({ permission: P.workOpen });

const listInput = z.object({
  tab: z.string().max(60).optional(),
  q: z.string().trim().max(100).optional(),
  company: z.array(z.string().max(10)).max(20).optional(),
  due: z.enum(['overdue', 'today', 'later', 'none']).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().refine((n) => (TABLE_PAGE_SIZES as readonly number[]).includes(n)).default(DEFAULT_TABLE_PAGE_SIZE),
});

export const workRouter = router({
  /** Tabs with counts, the total for the menu badge, and whether the user has a company. */
  tabs: open.query(async ({ ctx }) => {
    const actor = await loadActor(ctx.db, ctx.user);
    return { ...(await workTabs(ctx.db, actor)), hasCompany: actor.companies.size > 0 };
  }),

  list: open.input(listInput).query(async ({ ctx, input }) => listWork(ctx.db, await loadActor(ctx.db, ctx.user), input)),
});
