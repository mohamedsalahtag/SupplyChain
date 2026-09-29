/**
 * Container capacity matching (spec 32), pure so it is unit-tested without a database.
 * Per product the most specific active row wins: major + sub-major + size > major + sub-major > major.
 * A mixed container is limited by its most restrictive product, so a group takes the SMALLEST matched capacity.
 */
export type CapacityRow = {
  capacityId: number;
  majorCategory: string;
  subMajorCategory: string | null;
  size: string | null;
  unit: string;
  capacity: number;
  isActive: boolean;
};

/** One product of a container group, as the demand holds it ('' size = any size). */
export type CapacityItem = { majorCategory: string; subMajorCategory: string; size: string };

export type CapacityResult = {
  /** null = no active row matches any of the products. */
  capacity: number | null;
  unit: string | null;
  /** The row that set the capacity, and a short name for it ("Apples Royal Gala 100"). */
  source: { capacityId: number; majorCategory: string; subMajorCategory: string | null; size: string | null; label: string } | null;
  /** Products with no capacity defined (they did not limit the result). */
  unmatched: CapacityItem[];
  note: string | null;
};

// SQL Server compares these case- and trailing-space-insensitively; do the same here.
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** "Apples (all)", "Apples Royal Gala S-100"; SAP sub-majors usually repeat the major ("Apples Royal Gala"), so it is not doubled. */
export function capacityLabel(r: { majorCategory: string; subMajorCategory: string | null; size: string | null }): string {
  if (r.subMajorCategory === null) return `${r.majorCategory} (all)`;
  const sub = norm(r.subMajorCategory).startsWith(norm(r.majorCategory)) ? r.subMajorCategory : `${r.majorCategory} ${r.subMajorCategory}`;
  return r.size ? `${sub} ${r.size}` : sub;
}

/** The most specific active row for one product, or null. */
export function matchOne(rows: CapacityRow[], item: CapacityItem): CapacityRow | null {
  let best: CapacityRow | null = null;
  let bestScore = -1;
  for (const r of rows) {
    if (!r.isActive || norm(r.majorCategory) !== norm(item.majorCategory)) continue;
    if (r.subMajorCategory !== null && norm(r.subMajorCategory) !== norm(item.subMajorCategory)) continue;
    // A row for one size applies only to a product of that size; "any size" on the demand matches only rows for any size.
    if (r.size !== null && (norm(item.size) === '' || norm(r.size) !== norm(item.size))) continue;
    const score = (r.subMajorCategory !== null ? 1 : 0) + (r.size !== null ? 1 : 0);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

/** Capacity for a container group: the smallest of its products' capacities. */
export function capacityForGroup(rows: CapacityRow[], items: CapacityItem[]): CapacityResult {
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    const k = `${norm(i.majorCategory)}|${norm(i.subMajorCategory)}|${norm(i.size)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const matched: CapacityRow[] = [];
  const unmatched: CapacityItem[] = [];
  for (const i of unique) {
    const m = matchOne(rows, i);
    if (m) matched.push(m);
    else unmatched.push(i);
  }
  if (!matched.length) return { capacity: null, unit: null, source: null, unmatched, note: null };
  const smallest = matched.reduce((a, b) => (b.capacity < a.capacity ? b : a));
  const units = [...new Set(matched.map((m) => m.unit))];
  const notes: string[] = [];
  if (units.length > 1) notes.push(`The products are defined in different units (${units.join(', ')}); this is the smallest number, in ${smallest.unit}.`);
  if (unmatched.length) notes.push(`No capacity is defined for ${unmatched.map((u) => [u.subMajorCategory, u.size].filter(Boolean).join(' ')).join(', ')}.`);
  return {
    capacity: smallest.capacity,
    unit: smallest.unit,
    source: { capacityId: smallest.capacityId, majorCategory: smallest.majorCategory, subMajorCategory: smallest.subMajorCategory, size: smallest.size, label: capacityLabel(smallest) },
    unmatched,
    note: notes.length ? notes.join(' ') : null,
  };
}
