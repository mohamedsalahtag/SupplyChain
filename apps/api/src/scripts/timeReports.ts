/**
 * Times the report queries against the configured database as an administrator (read-only), and checks that the one-pass
 * trend equals the Performance tab run month by month. `npx tsx --env-file=../../.env src/scripts/timeReports.ts`
 */
import { loadConfig } from '../config.js';
import { createDb } from '../db/db.js';
import { allCompanies } from '../modules/workflow/access.js';
import { arrivals, suppliers, trend, trendMonths } from '../modules/reports/insights.js';
import { performance } from '../modules/reports/reports.js';

const db = createDb(loadConfig());
const actor = { id: 1, isAdmin: true, permissions: new Set<string>(), companies: await allCompanies(db) };
const time = async <T>(name: string, fn: () => Promise<T>) => { const t = Date.now(); const r = await fn(); console.log(`${name}: ${Date.now() - t} ms`); return r; };
await time('performance 12 weeks', () => performance(db, actor, { from: new Date(Date.now() - 84 * 864e5).toISOString().slice(0, 10) }));
await time('arrivals', () => arrivals(db, actor, {}));
await time('suppliers', () => suppliers(db, actor, {}));
const tr = await time('trend', () => trend(db, actor, {}));

let diffs = 0;
for (const m of trendMonths({}).months) {
  const p = await performance(db, actor, { from: m.from, to: m.to });
  const want = JSON.stringify(p.headline.map((u) => ({ unit: u.unit, committed: u.committed, executed: u.executed, outstanding: u.outstanding, executionRate: u.executionRate, executionN: u.executionN, notSourcedRate: u.notSourcedRate, onTimeRate: u.onTimeRate, onTimeN: u.onTimeN, endToEndHours: u.endToEndHours, endToEndN: u.endToEndN, stages: u.stages })));
  const t = tr.months.find((x) => x.month === m.month)!;
  const got = JSON.stringify(t.units);
  const side = [t.handoffs.handoffs === p.handoffs.handoffs, t.handoffs.returnRate === p.handoffs.returnRate, t.sap.submitted === p.sap.submitted, t.sap.firstReplyRate === p.sap.firstReplyRate];
  if (want !== got || side.includes(false)) { diffs++; console.log(`DIFF ${m.month}\n  perf:  ${want}\n  trend: ${got}\n  side: ${side}`); }
}
console.log(diffs ? `${diffs} month(s) differ` : 'trend = performance for every month');
await db.destroy();
