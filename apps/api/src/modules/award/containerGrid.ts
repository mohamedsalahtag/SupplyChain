/**
 * The award grid (spec 20 revision 1): per RFQ week, the demand's container groups with their mix, how many
 * containers are still open, and each supplier's quoted price per unit for every material of the mix; plus the
 * quoted quantity that is in no container group ("other quantity", awarded by quantity).
 */
import { sql } from 'kysely';
import { formatQty, fromDb, type Milli } from '../workflow/qty.js';
import type { Db, Tx } from '../workflow/tx.js';
import { currentQuotes, lineBlocker, lineLabel, rfqLines } from './awardCheck.js';

type Line = Awaited<ReturnType<typeof rfqLines>>[number];

export type GridGroup = {
  groupId: string; week: string; name: string; capacity: Milli; unit: string; containerCount: number; awarded: number; available: number; blocker: string | null;
  items: { itemId: string; key: string; label: string; originCode: string; perContainer: Milli; line: Line | null }[];
};

export async function loadGrid(db: Db | Tx, rfq: { RfqId: string; DemandId: string }) {
  const allLines = await rfqLines(db, rfq.RfqId);
  const lines = allLines.filter((l) => !l.IsCancelled);
  const lineOf = new Map(lines.filter((l) => l.DemandLineId).map((l) => [`${l.ProposedEtdWeek}|${l.LineKey}`, l]));
  const weeks = (await db.selectFrom('scm.RfqWeek').select(['EtdWeek', 'ContainerCount']).where('RfqId', '=', rfq.RfqId).orderBy('EtdWeek').execute());

  const groupRows = (await sql<{ ContainerGroupId: string; Name: string; ContainerCount: number; CapacityQty: string; Unit: string; EtdWeek: string }>`
    SELECT g.ContainerGroupId, g.Name, g.ContainerCount, g.CapacityQty, g.Unit, w.EtdWeek
    FROM scm.ContainerGroup g JOIN scm.DemandWeek w ON w.DemandWeekId = g.DemandWeekId
    WHERE g.DemandId = ${rfq.DemandId} AND g.IsActive = 1 AND g.MergedOutBy IS NULL
      AND w.EtdWeek IN (SELECT EtdWeek FROM scm.RfqWeek WHERE RfqId = ${rfq.RfqId})
    ORDER BY w.EtdWeek, g.GroupNumber`.execute(db)).rows.map((g) => ({ ...g, ContainerGroupId: String(g.ContainerGroupId) }));
  const ids = groupRows.map((g) => g.ContainerGroupId);
  const itemRows = ids.length ? await db.selectFrom('scm.ContainerGroupItem')
    .select(['ContainerGroupItemId', 'ContainerGroupId', 'LineKey', 'SubMajorCategory', 'Size', 'MaterialClass', 'MaterialCode', 'OriginCode', 'ComputedQty'])
    .where('ContainerGroupId', 'in', ids).orderBy('ContainerGroupItemId').execute() : [];
  const awardedRows = ids.length ? await db.selectFrom('scm.AwardContainer').select(['ContainerGroupId', (eb) => eb.fn.sum<string>('Containers').as('n')])
    .where('ContainerGroupId', 'in', ids).where('IsActive', '=', true).groupBy('ContainerGroupId').execute() : [];
  const awarded = new Map(awardedRows.map((a) => [String(a.ContainerGroupId), Number(a.n)]));

  const groups: GridGroup[] = groupRows.map((g) => {
    const items = itemRows.filter((i) => String(i.ContainerGroupId) === g.ContainerGroupId).map((i) => ({
      itemId: String(i.ContainerGroupItemId), key: i.LineKey, label: lineLabel(i), originCode: i.OriginCode,
      perContainer: fromDb(i.ComputedQty) / g.ContainerCount, // a group's containers are identical (composeGroup), so this is exact
      line: lineOf.get(`${g.EtdWeek}|${i.LineKey}`) ?? null,
    }));
    const done = awarded.get(g.ContainerGroupId) ?? 0;
    const missing = items.find((i) => !i.line);
    const blocked = items.map((i) => (i.line ? lineBlocker(i.line) : null)).find(Boolean) ?? null;
    const byQuoted = items.map((i) => (i.line && i.perContainer > 0 ? Math.floor(fromDb(i.line.Quoted) / i.perContainer) : 0));
    return {
      groupId: g.ContainerGroupId, week: g.EtdWeek, name: g.Name, capacity: fromDb(g.CapacityQty), unit: g.Unit, containerCount: g.ContainerCount, awarded: done,
      available: missing || blocked ? 0 : Math.max(0, Math.min(g.ContainerCount - done, ...byQuoted)),
      blocker: missing ? `${missing.label} is not on this RFQ` : blocked, items,
    };
  });
  const inGroups = new Set(groups.flatMap((g) => g.items.map((i) => `${g.week}|${i.key}`)));
  const other = lines.filter((l) => fromDb(l.Quoted) > 0 && !inGroups.has(`${l.ProposedEtdWeek}|${l.LineKey}`));
  // Containers already awarded per supplier × week (this RFQ, every batch) and the containers each supplier offered.
  const prior = (await sql<{ SupplierCode: string; EtdWeek: string; n: number }>`
    SELECT c.SupplierCode, c.EtdWeek, SUM(c.Containers) AS n FROM scm.AwardContainer c JOIN scm.AwardBatch b ON b.AwardBatchId = c.AwardBatchId
    WHERE b.RfqId = ${rfq.RfqId} AND c.IsActive = 1 GROUP BY c.SupplierCode, c.EtdWeek`.execute(db)).rows;
  const offered = await db.selectFrom('scm.SupplierQuoteWeek').select(['SupplierCode', 'EtdWeek', 'ContainersOffered']).where('RfqId', '=', rfq.RfqId).execute();
  return {
    allLines, lines, weeks, groups, other,
    prior: (s: string, w: string) => Number(prior.find((p) => p.SupplierCode === s && p.EtdWeek === w)?.n ?? 0),
    offered: (s: string, w: string) => offered.find((o) => o.SupplierCode === s && o.EtdWeek === w)?.ContainersOffered ?? 0,
  };
}

/** The grid for the award screen (serialisable). */
export async function containerGrid(db: Db, rfq: { RfqId: string; DemandId: string }) {
  const { weeks, groups, other, prior, offered } = await loadGrid(db, rfq);
  const quotes = await currentQuotes(db, rfq.RfqId);
  const invited = await db.selectFrom('scm.RfqSupplier as r').innerJoin('md.Supplier as s', 's.SupplierCode', 'r.SupplierCode')
    .select(['r.SupplierCode', 's.Name']).where('r.RfqId', '=', rfq.RfqId).orderBy('s.Name').execute();
  const quoted = invited.filter((s) => quotes.some((q) => q.SupplierCode === s.SupplierCode));
  const price = (supplier: string, week: string, key: string) => {
    const q = quotes.find((x) => x.SupplierCode === supplier && x.EtdWeek === week && x.LineKey === key);
    return q ? { UnitPrice: Number(q.UnitPrice).toFixed(2) } : undefined; // as quoted: price per unit, 2 decimals
  };

  return {
    suppliers: quoted.map((s) => ({ code: s.SupplierCode, name: s.Name, currency: quotes.find((q) => q.SupplierCode === s.SupplierCode)?.Currency ?? '' })),
    weeks: weeks.map((w) => ({
      week: w.EtdWeek,
      offered: Object.fromEntries(quoted.map((s) => [s.SupplierCode, offered(s.SupplierCode, w.EtdWeek)])),
      awardedBefore: Object.fromEntries(quoted.map((s) => [s.SupplierCode, prior(s.SupplierCode, w.EtdWeek)])),
      groups: groups.filter((g) => g.week === w.EtdWeek).map((g) => ({
        groupId: g.groupId, name: g.name || 'Container group', capacity: formatQty(g.capacity), unit: g.unit,
        containerCount: g.containerCount, awarded: g.awarded, available: g.available, blocker: g.blocker,
        items: g.items.map((i) => ({ label: i.label, originCode: i.originCode, perContainer: formatQty(i.perContainer) })),
        prices: Object.fromEntries(quoted.map((s) => [s.SupplierCode, g.items.map((i) => price(s.SupplierCode, g.week, i.key)?.UnitPrice ?? null)])),
      })),
    })),
    other: other.map((l) => ({
      rfqLineId: l.RfqLineId, week: l.ProposedEtdWeek, label: lineLabel(l), originCode: l.OriginCode, unit: l.Unit, quoted: formatQty(fromDb(l.Quoted)), blocker: lineBlocker(l),
      prices: Object.fromEntries(quoted.map((s) => [s.SupplierCode, price(s.SupplierCode, l.ProposedEtdWeek, l.LineKey)?.UnitPrice ?? null])),
    })),
  };
}
