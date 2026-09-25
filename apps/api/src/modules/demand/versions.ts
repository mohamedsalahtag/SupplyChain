/**
 * Demand versions (plan v5 §1.1): a frozen snapshot per submit / resubmit /
 * change. Version 1 is the KPI baseline and never changes (DB trigger).
 */
import { sql } from 'kysely';
import { formatQty, fromDb } from '../workflow/qty.js';
import type { Db, Tx } from '../workflow/tx.js';
import { formatShare } from './compose.js';
import { lineKey } from './content.js';

export type SnapshotLine = {
  lineId: string; etdWeek: string; specMode: 'SPEC' | 'SKU'; majorCategory: string; subMajorCategory: string; size: string; materialClass?: string;
  originCode: string; materialCode: string | null; unit: string; requestedQty: string; key: string;
};
export type SnapshotGroup = { etdWeek: string; groupNumber: number; containerCount: number; capacity: string; unit: string; items: { key: string; share: string; qty: string }[] };
export type Snapshot = { notes: string; weeks: { etdWeek: string; containerCount: number }[]; lines: SnapshotLine[]; groups?: SnapshotGroup[] };

export async function takeSnapshot(db: Db | Tx, demandId: string): Promise<Snapshot> {
  const d = await db.selectFrom('scm.Demand').select('Notes').where('DemandId', '=', demandId).executeTakeFirstOrThrow();
  const weeks = await db.selectFrom('scm.DemandWeek').select(['EtdWeek', 'ContainerCount']).where('DemandId', '=', demandId).orderBy('EtdWeek').execute();
  const lines = await db
    .selectFrom('scm.DemandLine as l').innerJoin('scm.DemandWeek as w', 'w.DemandWeekId', 'l.DemandWeekId')
    .select(['l.LineId', 'w.EtdWeek', 'l.SpecMode', 'l.MajorCategory', 'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.OriginCode', 'l.MaterialCode', 'l.Unit', 'l.RequestedQty'])
    .where('l.DemandId', '=', demandId).where('l.IsActive', '=', true).orderBy('w.EtdWeek').orderBy('l.LineNumber').execute();
  return {
    notes: d.Notes,
    weeks: weeks.map((w) => ({ etdWeek: w.EtdWeek, containerCount: Number(w.ContainerCount) })),
    lines: lines.map((l) => {
      const line = { majorCategory: l.MajorCategory, subMajorCategory: l.SubMajorCategory, size: l.Size, materialClass: l.MaterialClass, originCode: l.OriginCode, materialCode: l.MaterialCode };
      return { lineId: String(l.LineId), etdWeek: l.EtdWeek, specMode: l.SpecMode, ...line, unit: l.Unit, requestedQty: formatQty(fromDb(l.RequestedQty)), key: lineKey(line) };
    }),
    groups: await snapshotGroups(db, demandId),
  };
}

async function snapshotGroups(db: Db | Tx, demandId: string): Promise<SnapshotGroup[]> {
  const groups = await db.selectFrom('scm.ContainerGroup as g').innerJoin('scm.DemandWeek as w', 'w.DemandWeekId', 'g.DemandWeekId')
    .select(['g.ContainerGroupId', 'w.EtdWeek', 'g.GroupNumber', 'g.ContainerCount', 'g.CapacityQty', 'g.Unit'])
    .where('g.DemandId', '=', demandId).where('g.IsActive', '=', true).orderBy('w.EtdWeek').orderBy('g.GroupNumber').execute();
  if (!groups.length) return [];
  const items = await db.selectFrom('scm.ContainerGroupItem').select(['ContainerGroupId', 'LineKey', 'ShareBp', 'ComputedQty'])
    .where('ContainerGroupId', 'in', groups.map((g) => String(g.ContainerGroupId))).orderBy('ContainerGroupItemId').execute();
  return groups.map((g) => ({
    etdWeek: g.EtdWeek, groupNumber: Number(g.GroupNumber), containerCount: Number(g.ContainerCount), capacity: formatQty(fromDb(g.CapacityQty)), unit: g.Unit,
    items: items.filter((i) => String(i.ContainerGroupId) === String(g.ContainerGroupId))
      .map((i) => ({ key: i.LineKey, share: formatShare(Number(i.ShareBp)), qty: formatQty(fromDb(i.ComputedQty)) })),
  }));
}

/** Writes the next version and returns its number. */
export async function snapshotVersion(tx: Tx, demandId: string, reason: string, sourceRef: string | null, actorUserId: number): Promise<number> {
  const snap = await takeSnapshot(tx, demandId);
  const v = (await sql<{ v: number }>`
    UPDATE scm.Demand SET CurrentVersion = CurrentVersion + 1 OUTPUT inserted.CurrentVersion AS v WHERE DemandId = ${demandId}`.execute(tx)).rows[0].v;
  await tx.insertInto('scm.DemandVersion').values({ DemandId: demandId, VersionNo: v, Reason: reason, SourceRef: sourceRef, SnapshotJson: JSON.stringify(snap), CreatedBy: actorUserId }).execute();
  return Number(v);
}

export async function listVersions(db: Db, demandId: string) {
  const rows = await db
    .selectFrom('scm.DemandVersion as v').leftJoin('app.User as u', 'u.UserId', 'v.CreatedBy')
    .select(['v.VersionNo', 'v.Reason', 'v.SourceRef', 'v.CreatedAt', 'v.SnapshotJson', 'u.DisplayName'])
    .where('v.DemandId', '=', demandId).orderBy('v.VersionNo').execute();
  return rows.map((r) => ({
    versionNo: Number(r.VersionNo), reason: r.Reason, sourceRef: r.SourceRef, createdAt: r.CreatedAt.toISOString(), createdBy: r.DisplayName ?? '',
    snapshot: JSON.parse(r.SnapshotJson) as Snapshot,
  }));
}

export type DiffRow = { what: string; before: string | null; after: string | null };

/** What changed from `a` (e.g. the baseline) to `b`: container counts per week and quantities per week × line key. */
export function diffSnapshots(a: Snapshot, b: Snapshot): DiffRow[] {
  const rows: DiffRow[] = [];
  const weeks = [...new Set([...a.weeks, ...b.weeks].map((w) => w.etdWeek))].sort();
  for (const wk of weeks) {
    const ca = a.weeks.find((w) => w.etdWeek === wk)?.containerCount ?? null;
    const cb = b.weeks.find((w) => w.etdWeek === wk)?.containerCount ?? null;
    if (ca !== cb) rows.push({ what: `${wk} containers`, before: ca == null ? null : String(ca), after: cb == null ? null : String(cb) });
    const keys = [...new Set([...a.lines, ...b.lines].filter((l) => l.etdWeek === wk).map((l) => l.key))];
    for (const k of keys) {
      const la = a.lines.find((l) => l.etdWeek === wk && l.key === k);
      const lb = b.lines.find((l) => l.etdWeek === wk && l.key === k);
      const qa = la ? `${la.requestedQty} ${la.unit}` : null;
      const qb = lb ? `${lb.requestedQty} ${lb.unit}` : null;
      if (qa !== qb) {
        const l = (lb ?? la)!;
        const label = l.materialCode ?? `${l.subMajorCategory} · ${l.size || 'any size'} · ${l.materialClass || 'any class'}`;
        rows.push({ what: `${wk} · ${label} · ${l.originCode}`, before: qa, after: qb });
      }
    }
  }
  return rows;
}
