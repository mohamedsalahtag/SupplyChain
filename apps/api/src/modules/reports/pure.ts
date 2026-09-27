/**
 * The pure parts of the reports (spec 24 / 28), kept apart from the SQL so they are unit-tested (`pure.spec.ts`):
 * exact per-unit sums in milli-units, quantity-weighted stage times, and the trend's month buckets.
 */
import { DomainError } from '../workflow/errors.js';
import { assertMilli, formatQty, fromDb, sumQty, type Milli } from '../workflow/qty.js';

export type ReportFilter = { company?: string[]; q?: string; from?: string; to?: string };

/** A raw BIGINT milli value from the database → the API's decimal string ("2000.000"). */
export const q3 = (m: string | number | null | undefined) => formatQty(fromDb(m ?? 0));
/** Percent with 1 decimal; null (N/A) when there is nothing to divide by. */
export const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/**
 * An API decimal quantity ("1000.125", "0.000", "-3.5") → exact milli-units. The inverse of `formatQty`; unlike `parseQty`
 * (user input) it accepts zero and a sign, because report sums can be zero. Never goes through floating point.
 */
export function milliOf(s: string): Milli {
  const m = /^(-?)(\d{1,15})(?:\.(\d{1,3}))?$/.exec(String(s).trim());
  if (!m) throw new DomainError('BAD_QTY', `Not a decimal quantity: "${s}"`);
  const v = Number(m[2]) * 1000 + Number((m[3] ?? '').padEnd(3, '0'));
  return assertMilli(m[1] ? -v : v);
}

/* ---------------------------------------------------------------- Headline per unit ---------------------------------------------------------------- */
export type Milestone = {
  DemandId: string; Unit: string; Qty: string; ClockStart: Date; AcceptedAt: Date | null; InRfq: Date | null; Quoted: Date | null; Awarded: Date | null;
  HandedOff: Date | null; HandoffAccepted: Date | null; PoCreated: Date | null; ConfirmedEtd: Date | null;
};
/** The fields of an execution row the headline reads (decimal strings, as `executionSummary` returns them). */
export type ExecLike = { demandId: string; unit: string; committed: string; executed: string; notSourced: string; outstanding: string; procApproved: string; procOrdered: string };

const hours = (a: Date | null, b: Date | null) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 36e5 : null);
const later = (a: Date | null, b: Date | null) => (a && b ? (new Date(a) > new Date(b) ? a : b) : a ?? b);
export const STAGES: [string, (m: Milestone) => number | null][] = [
  ['Accept → RFQ', (m) => hours(later(m.AcceptedAt, m.ClockStart), m.InRfq)], ['RFQ → quote', (m) => hours(m.InRfq, m.Quoted)], ['Quote → award', (m) => hours(m.Quoted, m.Awarded)],
  ['Award → handoff', (m) => hours(m.Awarded, m.HandedOff)], ['Handoff → PO created', (m) => hours(m.HandoffAccepted, m.PoCreated)], ['End to end', (m) => hours(m.ClockStart, m.PoCreated)],
];
const SUMS = ['committed', 'executed', 'notSourced', 'outstanding', 'procApproved', 'procOrdered'] as const;
type Sums = Record<(typeof SUMS)[number], Milli[]>;

/**
 * The headline per unit from execution rows and milestones (pure: the trend runs it once per month on one fetch).
 * Quantities are summed exactly in milli-units and formatted once. Each rate carries its sample size `n` (the number of
 * demands it measures) so the UI can show "92% (n=12)".
 */
export function headlineOf(summary: ExecLike[], milestones: Milestone[], onTimeDays: number) {
  const perUnit = new Map<string, { sums: Sums; demands: Set<string> }>();
  for (const r of summary) {
    const u = perUnit.get(r.unit) ?? { sums: Object.fromEntries(SUMS.map((k) => [k, []])) as unknown as Sums, demands: new Set<string>() };
    for (const k of SUMS) u.sums[k].push(milliOf(r[k]));
    if (milliOf(r.committed) > 0) u.demands.add(r.demandId);
    perUnit.set(r.unit, u);
  }
  const units = [...new Set([...perUnit.keys(), ...milestones.map((m) => m.Unit)])].sort();
  const weighted = (unit: string, fn: (m: Milestone) => number | null) => {
    let q = 0; let t = 0; const ds = new Set<string>();
    for (const m of milestones.filter((x) => x.Unit === unit)) { const h = fn(m); if (h === null) continue; q += Number(m.Qty); t += Number(m.Qty) * h; ds.add(String(m.DemandId)); }
    return { hours: q ? Math.round((t / q) * 10) / 10 : null, n: ds.size };
  };
  const onTime = (unit: string) => {
    let q = 0; let ok = 0; const ds = new Set<string>();
    for (const m of milestones.filter((x) => x.Unit === unit && x.PoCreated && x.ConfirmedEtd)) {
      q += Number(m.Qty); ds.add(String(m.DemandId));
      if ((new Date(m.ConfirmedEtd!).getTime() - new Date(m.PoCreated!).getTime()) / 864e5 >= onTimeDays) ok += Number(m.Qty);
    }
    return { rate: ratio(ok, q), n: ds.size };
  };
  return units.map((unit) => {
    const u = perUnit.get(unit);
    const total = (k: (typeof SUMS)[number]) => sumQty(u?.sums[k] ?? []);
    const committed = total('committed'), executed = total('executed'), notSourced = total('notSourced');
    const e2e = weighted(unit, STAGES[5][1]), ot = onTime(unit);
    return {
      unit, committed: formatQty(committed), executed: formatQty(executed), outstanding: formatQty(total('outstanding')), procApproved: formatQty(total('procApproved')), procOrdered: formatQty(total('procOrdered')),
      executionRate: ratio(executed, committed), notSourcedRate: ratio(notSourced, committed), executionN: u?.demands.size ?? 0,
      endToEndHours: e2e.hours, endToEndN: e2e.n, onTimeRate: ot.rate, onTimeN: ot.n,
      stages: STAGES.map(([label, fn]) => ({ label, ...weighted(unit, fn) })),
    };
  });
}

/* ---------------------------------------------------------------- Dates and the trend's months ---------------------------------------------------------------- */
/** A real calendar date "YYYY-MM-DD" (rejects 2026-02-30, 2026-13-01). */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
/** From/To are valid dates and From is not after To. Throws a 422 otherwise (the router rejects it earlier with a 400). */
export function assertPeriod(f: ReportFilter) {
  for (const [k, v] of [['From', f.from], ['To', f.to]] as const) if (v !== undefined && !isCalendarDate(v)) throw new DomainError('BAD_DATE', `${k} is not a date: "${v}"`);
  if (f.from && f.to && f.from > f.to) throw new DomainError('BAD_PERIOD', `From (${f.from}) is after To (${f.to})`);
}

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
export const TREND_MAX_MONTHS = 24;

/**
 * The months of the trend, each as [label, first day, last day]. The last 12 months when no dates are picked; otherwise the
 * months From–To, with the first and last month clamped to the exact dates (partial months). Over 24 months only the latest
 * 24 (ending at To) are kept and `truncated` says so.
 */
export function trendMonths(f: ReportFilter, today = new Date()): { months: { month: string; from: string; to: string }[]; truncated: boolean } {
  assertPeriod(f);
  const end = f.to ? new Date(`${f.to}T00:00:00Z`) : today;
  const start = f.from ? new Date(`${f.from}T00:00:00Z`) : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
  const all: { month: string; from: string; to: string }[] = [];
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; m++) {
    if (m > 11) { m = 0; y++; }
    const first = new Date(Date.UTC(y, m, 1));
    if (first > end) break;
    const last = new Date(Date.UTC(y, m + 1, 0));
    all.push({ month: `${y}-${String(m + 1).padStart(2, '0')}`, from: dateOnly(first < start ? start : first), to: dateOnly(f.to && last > end ? end : last) });
  }
  const truncated = all.length > TREND_MAX_MONTHS;
  return { months: truncated ? all.slice(-TREND_MAX_MONTHS) : all, truncated };
}
