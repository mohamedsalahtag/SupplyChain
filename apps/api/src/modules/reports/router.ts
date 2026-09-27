/** Reports (spec 24), the Dashboard tab (spec 26) and the arrivals / supplier / trend tabs (spec 28): company-scoped reads only. */
import { P } from '@supplychain/shared';
import { z } from 'zod';
import { procedure, router } from '../../trpc/trpc.js';
import { loadActor } from '../workflow/access.js';
import { atRisk, changeRequests, flow, pipeline, queues, rfqsWaiting, stability, suppliers, weeks } from './dashboard.js';
import { arrivals, supplierDetail, suppliers as scorecard, trend } from './insights.js';
import { reportCounts } from './counts.js';
import { isCalendarDate } from './pure.js';
import { crRegister, demandReport, executionSummary, performance } from './reports.js';

const open = procedure.meta({ permission: P.reportsOpen });
/** A real calendar date (2026-02-30 is refused with a 400, not a SQL error). */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate, 'Not a calendar date');
const base = z.object({ company: z.array(z.string().max(10)).max(20).optional(), q: z.string().trim().max(40).optional(), from: day.optional(), to: day.optional() });
const fromNotAfterTo = <T extends { from?: string; to?: string }>(f: T) => !f.from || !f.to || f.from <= f.to;
const period = { message: 'From must not be after To', path: ['to'] };
const filter = base.refine(fromNotAfterTo, period);

export const reportsRouter = router({
  // The tab-title counts (COUNT queries only; each tab loads its data when opened).
  counts: open.input(filter).query(async ({ ctx, input }) => reportCounts(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  execution: open.input(filter).query(async ({ ctx, input }) => executionSummary(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  demand: open.input(z.object({ demandId: z.string().regex(/^\d+$/) })).query(async ({ ctx, input }) => demandReport(ctx.db, await loadActor(ctx.db, ctx.user), input.demandId)),
  changeRequests: open.input(filter).query(async ({ ctx, input }) => crRegister(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  performance: open.input(filter).query(async ({ ctx, input }) => performance(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  // Spec 28: what is coming (Sales), the supplier scorecard (Procurement) and the monthly trend (management).
  arrivals: open.input(filter).query(async ({ ctx, input }) => arrivals(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  suppliers: open.input(filter).query(async ({ ctx, input }) => scorecard(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  supplierDetail: open.input(base.extend({ supplierCode: z.string().min(1).max(20) }).refine(fromNotAfterTo, period)).query(async ({ ctx, input }) => supplierDetail(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  trend: open.input(filter).query(async ({ ctx, input }) => trend(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  // The Dashboard tab (spec 26). "Now" cards ignore the dates; "period" cards use them (the UI sends the last 12 weeks when empty).
  dashboard: router({
    pipeline: open.input(filter).query(async ({ ctx, input }) => pipeline(ctx.db, await loadActor(ctx.db, ctx.user), input)),
    queues: open.input(filter).query(async ({ ctx, input }) => queues(ctx.db, await loadActor(ctx.db, ctx.user), input)),
    weeks: open.input(filter).query(async ({ ctx, input }) => weeks(ctx.db, await loadActor(ctx.db, ctx.user), input)),
    atRisk: open.input(filter).query(async ({ ctx, input }) => atRisk(ctx.db, await loadActor(ctx.db, ctx.user), input)),
    rfqsWaiting: open.input(filter).query(async ({ ctx, input }) => rfqsWaiting(ctx.db, await loadActor(ctx.db, ctx.user), input)),
    flow: open.input(filter).query(async ({ ctx, input }) => flow(ctx.db, await loadActor(ctx.db, ctx.user), input)),
    changeRequests: open.input(filter).query(async ({ ctx, input }) => changeRequests(ctx.db, await loadActor(ctx.db, ctx.user), input)),
    stability: open.input(filter).query(async ({ ctx, input }) => stability(ctx.db, await loadActor(ctx.db, ctx.user), input)),
    suppliers: open.input(filter).query(async ({ ctx, input }) => suppliers(ctx.db, await loadActor(ctx.db, ctx.user), input)),
  }),
});
