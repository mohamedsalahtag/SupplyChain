/**
 * Container change → change request items (spec 14). Compares today's container
 * groups with the ones Sales asks for: one item per changed group, each with its
 * quantity effect per material (whole units, the same split as the demand).
 */
import { composeGroup } from '../demand/compose.js';
import type { Milli } from '../workflow/qty.js';

export type Spec = { majorCategory: string; subMajorCategory: string; size: string; materialClass: string; originCode: string; materialCode: string | null };
export type GroupItem = Spec & { key: string; shareBp: number };
export type GroupState = { groupId: string | null; etdWeek: string; name: string; containerCount: number; capacity: Milli; unit: string; items: GroupItem[] };
export type Effect = Spec & { key: string; unit: string; delta: Milli };
export type ItemKind = 'GROUP_COUNT' | 'GROUP_ADD' | 'GROUP_REMOVE' | 'GROUP_COMPOSITION';
export type DiffItem = { kind: ItemKind; etdWeek: string; groupId: string | null; before: GroupState | null; after: GroupState | null; effect: Effect[] };

/** Quantity of each material key a group holds (whole-unit split per container × containers). */
export function contribution(g: GroupState | null, increment: (unit: string) => Milli): Map<string, { spec: Spec; qty: Milli; unit: string }> {
  const out = new Map<string, { spec: Spec; qty: Milli; unit: string }>();
  if (!g || g.containerCount <= 0 || g.items.length === 0) return out;
  const qty = composeGroup({ containerCount: g.containerCount, capacity: g.capacity, increment: increment(g.unit), sharesBp: g.items.map((i) => i.shareBp) });
  g.items.forEach((i, n) => {
    const { key, shareBp: _s, ...spec } = i;
    out.set(key, { spec, qty: qty[n], unit: g.unit });
  });
  return out;
}

/** after − before, per material key; keys with no change are left out. */
export function effectOf(before: GroupState | null, after: GroupState | null, increment: (unit: string) => Milli): Effect[] {
  const b = contribution(before, increment);
  const a = contribution(after, increment);
  const keys = [...new Set([...b.keys(), ...a.keys()])];
  return keys
    .map((key) => {
      const x = a.get(key) ?? b.get(key)!;
      return { ...x.spec, key, unit: x.unit, delta: (a.get(key)?.qty ?? 0) - (b.get(key)?.qty ?? 0) };
    })
    .filter((e) => e.delta !== 0);
}

const makeUp = (g: GroupState) => `${g.capacity}|${g.unit}|${g.items.map((i) => `${i.key}=${i.shareBp}`).sort().join(';')}`;

/**
 * Today's groups vs the requested ones. A group keeps its id when edited; a
 * group moved to another week counts as removed there and added here. Name
 * changes alone are not a change request.
 */
export function diffGroups(current: GroupState[], proposed: GroupState[], increment: (unit: string) => Milli): DiffItem[] {
  const items: DiffItem[] = [];
  const byId = new Map(current.filter((g) => g.groupId).map((g) => [g.groupId!, g]));
  const kept = new Set<string>();

  for (const p of proposed) {
    const c = p.groupId ? byId.get(p.groupId) : undefined;
    if (!c || c.etdWeek !== p.etdWeek) {
      items.push({ kind: 'GROUP_ADD', etdWeek: p.etdWeek, groupId: null, before: null, after: { ...p, groupId: null }, effect: effectOf(null, p, increment) });
      continue;
    }
    kept.add(c.groupId!);
    if (makeUp(c) !== makeUp(p)) {
      items.push({ kind: 'GROUP_COMPOSITION', etdWeek: c.etdWeek, groupId: c.groupId, before: c, after: p, effect: effectOf(c, p, increment) });
    } else if (c.containerCount !== p.containerCount) {
      items.push({ kind: 'GROUP_COUNT', etdWeek: c.etdWeek, groupId: c.groupId, before: c, after: p, effect: effectOf(c, p, increment) });
    }
  }
  for (const c of current) {
    if (!kept.has(c.groupId!)) items.push({ kind: 'GROUP_REMOVE', etdWeek: c.etdWeek, groupId: c.groupId, before: c, after: null, effect: effectOf(c, null, increment) });
  }
  // Reductions first, then compositions, then additions; by week.
  const order: Record<ItemKind, number> = { GROUP_REMOVE: 0, GROUP_COUNT: 1, GROUP_COMPOSITION: 2, GROUP_ADD: 3 };
  return items.sort((a, b) => a.etdWeek.localeCompare(b.etdWeek) || order[a.kind] - order[b.kind]);
}

/** The group as it ends up after a decision: the approved number of containers (0 = none). */
export function finalAfter(item: DiffItem, approvedCount: number | null): GroupState | null {
  if (!item.after) return null;
  return approvedCount == null ? item.after : { ...item.after, containerCount: approvedCount };
}

/** Change requests are named after what they do. */
export function crTypeOf(items: DiffItem[], currentGroups: number): 'CHANGE_CONTAINERS' | 'CANCEL_WEEK' | 'CANCEL_DEMAND' {
  const onlyRemovals = items.length > 0 && items.every((i) => i.kind === 'GROUP_REMOVE');
  if (onlyRemovals && items.length === currentGroups) return 'CANCEL_DEMAND';
  if (onlyRemovals && new Set(items.map((i) => i.etdWeek)).size === 1) return 'CANCEL_WEEK';
  return 'CHANGE_CONTAINERS';
}
