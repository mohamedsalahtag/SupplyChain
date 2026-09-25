/**
 * Demand content (spec 12): what the editor sends — weeks, container groups and
 * their composition — and how the week × material lines are worked out from it.
 * Every problem is collected; `strict` (submit) adds the completeness checks.
 */
import { z } from 'zod';
import { DomainError } from '../workflow/errors.js';
import { assertIsoWeek, isoWeekOf } from '../workflow/isoWeek.js';
import { parseQty, type Milli } from '../workflow/qty.js';
import type { WfSettings } from '../workflow/settings.js';
import type { Tx } from '../workflow/tx.js';
import { composeGroup, formatShare, FULL_BP, parseShare } from './compose.js';
import { skuForCriteria, specExists, specLabel } from './lookups.js';

const WEEK = z.string().regex(/^\d{4}-W\d{2}$/, 'Week must be YYYY-Www');

const itemInput = z.object({
  majorCategory: z.string().trim().min(1).max(80),
  subMajorCategory: z.string().trim().min(1).max(80),
  size: z.string().trim().max(80), // '' = any size
  materialClass: z.string().trim().max(80), // '' = any class
  originCode: z.string().regex(/^[A-Z]{2}$/),
  materialCode: z.string().trim().max(40).nullable().optional(), // an SKU chosen for this combination
  share: z.string().trim().max(10),
});
const groupInput = z.object({
  name: z.string().trim().max(60).default(''),
  containerCount: z.number().int().min(1).max(999),
  capacity: z.string().trim().max(20),
  unit: z.string().trim().min(1).max(10),
  items: z.array(itemInput).max(60),
});
export const draftInput = z.object({
  notes: z.string().max(2000),
  weeks: z.array(z.object({ etdWeek: WEEK, groups: z.array(groupInput).max(50) })).max(60),
});
export type DraftInput = z.infer<typeof draftInput>;

type Spec = { majorCategory: string; subMajorCategory: string; size: string; materialClass: string; originCode: string; materialCode: string | null };
export type NormalItem = Spec & { specMode: 'SPEC' | 'SKU'; unit: string; shareBp: number; qty: Milli; key: string; label: string };
export type NormalGroup = { name: string; containerCount: number; capacity: Milli; unit: string; complete: boolean; items: NormalItem[] };
export type NormalLine = Spec & { specMode: 'SPEC' | 'SKU'; unit: string; qty: Milli; key: string; label: string };
export type NormalWeek = { etdWeek: string; containerCount: number; groups: NormalGroup[]; lines: NormalLine[] };

export const lineKey = (l: Spec) => [l.majorCategory, l.subMajorCategory, l.size, l.materialClass, l.originCode, l.materialCode ?? ''].join('|');

/**
 * The step for demand quantities: whole units at least (cartons cannot be split),
 * or a larger step set in Configuration → Workflow (e.g. 5 = multiples of 5).
 */
export function incrementFor(settings: WfSettings, unit: string): Milli {
  const v = settings.minIncrement[unit];
  return Math.max(v ? parseQty(v) : 1, 1000);
}

export type NormalizeOptions = {
  /** Submit: completeness checks. */
  strict: boolean;
  /** Identical groups of a week become one (drafts). Change requests keep each group to compare it with today's. */
  mergeTwins?: boolean;
  /** Weeks already on an accepted demand may lie in the past; only new weeks must be current or later. */
  allowPastWeeks?: ReadonlySet<string>;
};

export async function normalize(tx: Tx, input: DraftInput, settings: WfSettings, opts: NormalizeOptions | boolean, now = new Date()): Promise<{ weeks: NormalWeek[]; problems: string[] }> {
  const { strict, mergeTwins = true, allowPastWeeks } = typeof opts === 'boolean' ? { strict: opts } : opts;
  const problems: string[] = [];
  const weeks: NormalWeek[] = [];
  const seenWeeks = new Set<string>();
  const unitByKey = new Map<string, { unit: string; week: string }>();
  const thisWeek = isoWeekOf(now);

  if (strict && input.weeks.length === 0) problems.push('Add at least one ETD week.');

  for (const w of input.weeks) {
    try {
      assertIsoWeek(w.etdWeek);
    } catch (e) {
      problems.push((e as Error).message);
      continue;
    }
    if (w.etdWeek < thisWeek && !allowPastWeeks?.has(w.etdWeek)) problems.push(`${w.etdWeek} is in the past; choose ${thisWeek} or later.`);
    if (seenWeeks.has(w.etdWeek)) {
      problems.push(`${w.etdWeek} appears twice.`);
      continue;
    }
    seenWeeks.add(w.etdWeek);
    if (strict && w.groups.length === 0) problems.push(`${w.etdWeek}: add at least one container group.`);

    const groups: NormalGroup[] = [];
    for (const [gi, g] of w.groups.entries()) {
      const where = `${w.etdWeek} group ${gi + 1}`;
      const increment = incrementFor(settings, g.unit);
      let capacity = 0;
      try {
        capacity = parseQty(g.capacity, increment);
      } catch (e) {
        problems.push(`${where}: capacity must be a whole number of ${g.unit}${increment > 1000 ? ` in steps of ${increment / 1000}` : ''} (got "${g.capacity}").`);
      }
      const items: NormalItem[] = [];
      const keys = new Set<string>();
      for (const it of g.items) {
        const spec: Spec = {
          majorCategory: it.majorCategory, subMajorCategory: it.subMajorCategory, size: it.size, materialClass: it.materialClass,
          originCode: it.originCode, materialCode: it.materialCode || null,
        };
        const label = `${specLabel({ MajorCategory: spec.majorCategory, SubMajorCategory: spec.subMajorCategory, Size: spec.size, MaterialClass: spec.materialClass })} · ${spec.originCode}${spec.materialCode ? ` · ${spec.materialCode}` : ''}`;
        let shareBp = 0;
        try {
          shareBp = parseShare(it.share);
        } catch (e) {
          problems.push(`${where} · ${label}: ${(e as Error).message}.`);
          continue;
        }
        const criteria = { ...spec, unit: g.unit };
        if (spec.materialCode) {
          if (!(await skuForCriteria(tx, spec.materialCode, criteria))) {
            problems.push(`${where}: material ${spec.materialCode} does not match ${label} in ${g.unit} (or is no longer in SAP).`);
            continue;
          }
        } else if (!(await specExists(tx, criteria))) {
          problems.push(`${where}: no material in SAP matches ${label} in ${g.unit}.`);
          continue;
        }
        const key = lineKey(spec);
        if (keys.has(key)) {
          problems.push(`${where}: ${label} appears twice in the group.`);
          continue;
        }
        keys.add(key);
        const other = unitByKey.get(key);
        if (other && other.unit !== g.unit) {
          problems.push(`${label} is ordered in ${other.unit} in ${other.week} but in ${g.unit} in ${w.etdWeek}: one unit per material per demand.`);
          continue;
        }
        unitByKey.set(key, { unit: g.unit, week: w.etdWeek });
        items.push({ ...spec, specMode: spec.materialCode ? 'SKU' : 'SPEC', unit: g.unit, shareBp, qty: 0, key, label });
      }

      const totalBp = items.reduce((s, i) => s + i.shareBp, 0);
      // Shares can never exceed 100%, not even in a draft.
      if (totalBp > FULL_BP) problems.push(`${where}: shares total ${formatShare(totalBp)}%, more than 100%.`);
      const complete = capacity > 0 && items.length > 0 && totalBp === FULL_BP && items.length === g.items.length;
      if (complete) {
        composeGroup({ containerCount: g.containerCount, capacity, increment, sharesBp: items.map((i) => i.shareBp) }).forEach((q, i) => (items[i].qty = q));
      } else if (strict) {
        if (g.items.length === 0) problems.push(`${where}: add at least one material.`);
        else if (totalBp !== FULL_BP) problems.push(`${where}: shares total ${formatShare(totalBp)}%, they must total 100%.`);
      }
      // Identical containers are one group: same capacity, unit and composition → add the containers to the existing group.
      const twin = mergeTwins ? groups.find((x) => sameMakeUp(x, { capacity, unit: g.unit, items })) : undefined;
      if (twin) {
        twin.containerCount += g.containerCount;
        if (twin.complete) recompose(twin, increment);
      } else {
        groups.push({ name: g.name, containerCount: g.containerCount, capacity, unit: g.unit, complete, items });
      }
    }

    // The week's lines: the same key in several groups is one line with the quantities added.
    const byKey = new Map<string, NormalLine>();
    for (const it of groups.flatMap((g) => g.items)) {
      if (it.qty <= 0) continue;
      const line = byKey.get(it.key);
      if (line) line.qty += it.qty;
      else {
        const { shareBp: _s, ...rest } = it;
        byKey.set(it.key, { ...rest });
      }
    }
    weeks.push({ etdWeek: w.etdWeek, containerCount: groups.reduce((s, g) => s + g.containerCount, 0), groups, lines: [...byKey.values()] });
  }
  weeks.sort((a, b) => a.etdWeek.localeCompare(b.etdWeek));
  return { weeks, problems };
}

/** Same capacity, unit and composition (materials, SKUs and shares): the containers are identical. */
export function sameMakeUp(a: Pick<NormalGroup, 'capacity' | 'unit' | 'items'>, b: Pick<NormalGroup, 'capacity' | 'unit' | 'items'>): boolean {
  if (a.capacity !== b.capacity || a.unit !== b.unit || a.items.length !== b.items.length) return false;
  const sig = (g: Pick<NormalGroup, 'items'>) => g.items.map((i) => `${i.key}=${i.shareBp}`).sort().join(';');
  return sig(a) === sig(b);
}

function recompose(g: NormalGroup, increment: Milli): void {
  composeGroup({ containerCount: g.containerCount, capacity: g.capacity, increment, sharesBp: g.items.map((i) => i.shareBp) }).forEach((q, i) => (g.items[i].qty = q));
}

export function assertNoProblems(problems: string[], code: 'INVALID_DRAFT' | 'NOT_SUBMITTABLE'): void {
  if (problems.length) {
    const what = code === 'NOT_SUBMITTABLE' ? 'The demand cannot be submitted yet' : 'The demand cannot be saved';
    throw new DomainError(code, `${what}: ${problems.length} problem(s).`, 422, { problems });
  }
}

