/**
 * Reports → Dashboard (spec 26): the first tab of Reports, the ten cards the user chose from the candidate mockup.
 * Every card is company-scoped under reports.open. "Now" cards read the live state and ignore the dates; "period"
 * cards follow From/To (the UI sends the last 12 weeks when the dates are empty). Spec 24 rules hold: quantities are
 * never added across units, and a ratio with nothing to divide by is null (N/A). Containers are the one measure that
 * can be added across units.
 */
import { sql } from 'kysely';
import type { Actor } from '../workflow/access.js';
import { ITEM_TYPES } from '../workflow/inbox.js';
import { isoWeekMonday, isoWeekOf } from '../workflow/isoWeek.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { loadWfSettings } from '../workflow/settings.js';
import type { Db } from '../workflow/tx.js';
import { between, q3, ratio, scope, type ReportFilter } from './reports.js';

const IN_PROGRESS = sql`('OPEN', 'IN_RFQ', 'QUOTED', 'AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED')`;
const DAY = 86_400_000;
const addWeeks = (w: string, n: number) => isoWeekOf(new Date(isoWeekMonday(w).getTime() + n * 7 * DAY));
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: unknown) => Number(v ?? 0);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

/** D1 · Where the quantity is: per unit, the quantity of demands still in progress by class (the Demands list's five classes). */
export async function pipeline(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const rows = (await sql<{ Unit: string; OpenQ: string; RfqQ: string; AwardedQ: string; PoQ: string; CancelledQ: string; Demands: number }>`
    WITH inprog AS (
      SELECT DISTINCT l.DemandId FROM scm.DemandLine l JOIN scm.QtySlice s ON s.LineId = l.LineId
      WHERE l.IsActive = 1 AND s.ExecState IN ${IN_PROGRESS})
    SELECT l.Unit,
      SUM(CASE WHEN s.ExecState = 'OPEN' THEN s.Qty ELSE 0 END) AS OpenQ,
      SUM(CASE WHEN s.ExecState IN ('IN_RFQ', 'QUOTED') THEN s.Qty ELSE 0 END) AS RfqQ,
      SUM(CASE WHEN s.ExecState IN ('AWARDED', 'HANDED_OFF', 'PO_PREPARATION') THEN s.Qty ELSE 0 END) AS AwardedQ,
      SUM(CASE WHEN s.ExecState IN ('PO_SUBMITTED', 'PO_CREATED') THEN s.Qty ELSE 0 END) AS PoQ,
      SUM(CASE WHEN s.ExecState = 'CANCELLED' THEN s.Qty ELSE 0 END) AS CancelledQ,
      COUNT(DISTINCT d.DemandId) AS Demands
    FROM scm.Demand d JOIN inprog i ON i.DemandId = d.DemandId
      JOIN scm.DemandLine l ON l.DemandId = d.DemandId AND l.IsActive = 1
      JOIN scm.QtySlice s ON s.LineId = l.LineId AND s.ExecState <> 'MERGED_OUT'
    WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${sql.join(companies)})
    GROUP BY l.Unit ORDER BY l.Unit`.execute(db)).rows;
  const demands = (await sql<{ N: number }>`
    SELECT COUNT(*) AS N FROM scm.Demand d WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${sql.join(companies)})
      AND EXISTS (SELECT 1 FROM scm.DemandLine l JOIN scm.QtySlice s ON s.LineId = l.LineId WHERE l.DemandId = d.DemandId AND l.IsActive = 1 AND s.ExecState IN ${IN_PROGRESS})`.execute(db)).rows[0];
  return {
    demands: num(demands?.N),
    units: rows.map((r) => ({
      unit: r.Unit, open: q3(r.OpenQ), inRfq: q3(r.RfqQ), awarded: q3(r.AwardedQ), onPo: q3(r.PoQ), cancelled: q3(r.CancelledQ),
      total: formatQty(fromDb(r.OpenQ) + fromDb(r.RfqQ) + fromDb(r.AwardedQ) + fromDb(r.PoQ) + fromDb(r.CancelledQ)), demands: num(r.Demands),
    })),
  };
}

/** D2 · Who has the ball: open work items of the companies by step, with who may act (the roles holding the permission), overdue and oldest. */
export async function queues(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const rows = (await sql<{ ItemType: string; Permission: string; N: number; Overdue: number; OldestDue: Date | null; OldestCreated: Date }>`
    SELECT i.ItemType, i.Permission, COUNT(*) AS N, SUM(CASE WHEN i.DueAt < SYSUTCDATETIME() THEN 1 ELSE 0 END) AS Overdue, MIN(i.DueAt) AS OldestDue, MIN(i.CreatedAt) AS OldestCreated
    FROM scm.InboxItem i
    WHERE i.IsOpen = 1 AND (i.CompanyCode IS NULL OR i.CompanyCode IN (${sql.join(companies)}))
    GROUP BY i.ItemType, i.Permission`.execute(db)).rows;
  const perms = [...new Set(rows.map((r) => r.Permission))];
  // SQL Server 2016: no STRING_AGG — the role names are joined here.
  const holders = perms.length ? (await sql<{ PermissionKey: string; Name: string }>`
    SELECT DISTINCT rp.PermissionKey, r.Name FROM app.RolePermission rp JOIN app.Role r ON r.RoleId = rp.RoleId
    WHERE r.IsAdmin = 0 AND rp.PermissionKey IN (${sql.join(perms)})`.execute(db)).rows : [];
  const ownerOf = (p: string) => holders.filter((h) => h.PermissionKey === p).map((h) => h.Name).sort().join(' · ') || 'Administrators';
  const suffix = (t: string, p: string) => (t !== 'CR_TO_DECIDE' ? '' : p === 'cr.decide.sales' ? ' · raised by Sales' : p === 'cr.decide.procurement' ? ' · raised by Procurement' : '');
  const items = rows
    .map((r) => {
      const t = ITEM_TYPES[r.ItemType];
      return {
        itemType: r.ItemType, label: `${t?.label ?? r.ItemType}${suffix(r.ItemType, r.Permission)}`, category: t?.category ?? 'TASK', order: t?.order ?? 5000, owner: ownerOf(r.Permission),
        open: num(r.N), overdue: num(r.Overdue), oldestDueAt: iso(r.OldestDue), oldestCreatedAt: iso(r.OldestCreated), tab: t?.category === 'EXCEPTION' ? 'EXCEPTIONS' : r.ItemType,
      };
    })
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const groups: { title: string; rows: typeof items }[] = [];
  for (const it of items) {
    const title = it.category === 'EXCEPTION' ? 'Exceptions' : it.owner;
    const g = groups.find((x) => x.title === title) ?? groups[groups.push({ title, rows: [] }) - 1];
    g.rows.push(it);
  }
  groups.sort((a, b) => Number(a.title === 'Exceptions') - Number(b.title === 'Exceptions')); // tasks in business order, exceptions last
  return { open: items.reduce((s, r) => s + r.open, 0), overdue: items.reduce((s, r) => s + r.overdue, 0), groups };
}

/**
 * D3 · Shipping soon: the next `count` ETD weeks, containers ordered (behind a CREATED PO), awarded (not yet ordered), in RFQ or open,
 * plus the version-1 baseline. Awarded and ordered are the real shipment counts; the containers not yet awarded are split between
 * open and in RFQ by the week's quantity shares (an estimate — containers are awarded, quantity is sourced).
 */
export async function weeks(db: Db, actor: Actor, f: ReportFilter, count = 10) {
  const companies = scope(actor, f);
  const settings = await loadWfSettings(db);
  const first = isoWeekOf(new Date());
  const list = Array.from({ length: count }, (_, i) => addWeeks(first, i));
  const last = list[list.length - 1];
  const until = isoWeekOf(new Date(Date.now() + settings.agingWeeksBeforeEtd * 7 * DAY));
  const [now, base, awarded, shares] = await Promise.all([
    sql<{ DemandId: string; EtdWeek: string; C: number }>`
      SELECT w.DemandId, w.EtdWeek, w.ContainerCount AS C FROM scm.DemandWeek w JOIN scm.Demand d ON d.DemandId = w.DemandId
      WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${sql.join(companies)}) AND w.EtdWeek >= ${first} AND w.EtdWeek <= ${last}`.execute(db),
    sql<{ Wk: string; C: number }>`
      SELECT j.etdWeek AS Wk, SUM(j.containerCount) AS C FROM scm.Demand d
      JOIN scm.DemandVersion v ON v.DemandId = d.DemandId AND v.VersionNo = d.BaselineVersion
      CROSS APPLY OPENJSON(v.SnapshotJson, '$.weeks') WITH (etdWeek char(8) '$.etdWeek', containerCount int '$.containerCount') j
      WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${sql.join(companies)}) AND j.etdWeek >= ${first} AND j.etdWeek <= ${last}
      GROUP BY j.etdWeek`.execute(db),
    // SQL Server refuses an aggregate over a subquery: the "ordered" flag is worked out per shipment first (CROSS APPLY), then summed.
    sql<{ DemandId: string; EtdWeek: string; Awarded: number; Ordered: number }>`
      SELECT b.DemandId, sh.EtdWeek, SUM(sh.ContainerCount) AS Awarded, SUM(CASE WHEN o.Created = 1 THEN sh.ContainerCount ELSE 0 END) AS Ordered
      FROM scm.AwardShipment sh JOIN scm.AwardBatch b ON b.AwardBatchId = sh.AwardBatchId
      CROSS APPLY (SELECT CASE WHEN EXISTS (SELECT 1 FROM scm.Handoff h JOIN scm.PoDraft p ON p.HandoffId = h.HandoffId
                                            WHERE h.AwardBatchId = sh.AwardBatchId AND h.SupplierCode = sh.SupplierCode AND p.Status = 'CREATED') THEN 1 ELSE 0 END AS Created) o
      WHERE sh.IsActive = 1 AND b.CompanyCode IN (${sql.join(companies)}) AND sh.EtdWeek >= ${first} AND sh.EtdWeek <= ${last}
      GROUP BY b.DemandId, sh.EtdWeek`.execute(db),
    sql<{ DemandId: string; Wk: string; OpenQ: string; RfqQ: string }>`
      SELECT l.DemandId, s.ApprovedEtdWeek AS Wk,
        SUM(CASE WHEN s.ExecState = 'OPEN' THEN s.Qty ELSE 0 END) AS OpenQ, SUM(CASE WHEN s.ExecState IN ('IN_RFQ', 'QUOTED') THEN s.Qty ELSE 0 END) AS RfqQ
      FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId JOIN scm.Demand d ON d.DemandId = l.DemandId
      WHERE d.WorkflowStatus = 'ACCEPTED' AND l.IsActive = 1 AND d.CompanyCode IN (${sql.join(companies)}) AND s.ApprovedEtdWeek >= ${first} AND s.ApprovedEtdWeek <= ${last}
      GROUP BY l.DemandId, s.ApprovedEtdWeek`.execute(db),
  ]);
  const key = (d: string | number, w: string) => `${d}|${w}`;
  const awardedBy = new Map(awarded.rows.map((r) => [key(r.DemandId, r.EtdWeek), r]));
  const sharesBy = new Map(shares.rows.map((r) => [key(r.DemandId, r.Wk), r]));
  const out = list.map((week) => ({ week, monday: dateOnly(isoWeekMonday(week)), baseline: null as number | null, now: 0, ordered: 0, awarded: 0, inRfq: 0, open: 0, atRisk: false }));
  const at = (w: string) => out.find((o) => o.week === w);
  for (const b of base.rows) { const o = at(b.Wk); if (o) o.baseline = (o.baseline ?? 0) + num(b.C); }
  const seen = new Set<string>();
  for (const n of now.rows) {
    const o = at(n.EtdWeek);
    if (!o) continue;
    const k = key(n.DemandId, n.EtdWeek);
    seen.add(k);
    const a = awardedBy.get(k);
    const s = sharesBy.get(k);
    const containers = num(n.C);
    const aw = num(a?.Awarded);
    const ordered = num(a?.Ordered);
    o.now += containers;
    o.ordered += ordered;
    o.awarded += aw - ordered;
    const notAwarded = Math.max(0, containers - aw);
    const openQ = fromDb(s?.OpenQ ?? 0);
    const rfqQ = fromDb(s?.RfqQ ?? 0);
    if (openQ + rfqQ > 0) {
      const open = Math.round((notAwarded * openQ) / (openQ + rfqQ));
      o.open += open;
      o.inRfq += notAwarded - open;
    }
  }
  // A shipment in a week without a demand-week row (quantity shifted or merged): its containers still count.
  for (const a of awarded.rows) {
    if (seen.has(key(a.DemandId, a.EtdWeek))) continue;
    const o = at(a.EtdWeek);
    if (!o) continue;
    o.ordered += num(a.Ordered);
    o.awarded += num(a.Awarded) - num(a.Ordered);
  }
  for (const o of out) o.atRisk = o.week <= until && o.open > 0; // the Open-quantity-near-ETD rule (spec 18)
  return { agingWeeks: settings.agingWeeksBeforeEtd, weeks: out };
}

/** D4 · Not yet sourced, shipping soon: Open quantity whose ETD week is inside the aging window — the rule of the OPEN_QTY_AGING exception. */
export async function atRisk(db: Db, actor: Actor, f: ReportFilter, top = 10) {
  const companies = scope(actor, f);
  const agingWeeks = (await loadWfSettings(db)).agingWeeksBeforeEtd;
  const until = isoWeekOf(new Date(Date.now() + agingWeeks * 7 * DAY));
  const from = sql`FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId JOIN scm.Demand d ON d.DemandId = l.DemandId
    WHERE s.ExecState = 'OPEN' AND d.WorkflowStatus = 'ACCEPTED' AND l.IsActive = 1 AND d.CompanyCode IN (${sql.join(companies)}) AND s.ApprovedEtdWeek <= ${until}`;
  const [rows, totals, units] = await Promise.all([
    sql<{ LineId: string; DemandId: string; DemandNo: string; CompanyCode: string; Wk: string; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string; MaterialCode: string | null; Unit: string; Qty: string }>`
      SELECT TOP (${top}) l.LineId, d.DemandId, d.DemandNo, d.CompanyCode, MIN(s.ApprovedEtdWeek) AS Wk, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, l.Unit, SUM(s.Qty) AS Qty
      ${from}
      GROUP BY l.LineId, d.DemandId, d.DemandNo, d.CompanyCode, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, l.Unit, l.LineNumber
      ORDER BY MIN(s.ApprovedEtdWeek), d.DemandNo, l.LineNumber`.execute(db),
    sql<{ Lines: number; Demands: number }>`SELECT COUNT(DISTINCT l.LineId) AS Lines, COUNT(DISTINCT d.DemandId) AS Demands ${from}`.execute(db),
    sql<{ Unit: string; Qty: string }>`SELECT l.Unit, SUM(s.Qty) AS Qty ${from} GROUP BY l.Unit ORDER BY l.Unit`.execute(db),
  ]);
  const t = new Date();
  const today = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return {
    agingWeeks,
    lines: num(totals.rows[0]?.Lines), demands: num(totals.rows[0]?.Demands),
    totals: units.rows.map((u) => ({ unit: u.Unit, open: q3(u.Qty) })),
    rows: rows.rows.map((r) => ({
      lineId: String(r.LineId), demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode, week: r.Wk, monday: dateOnly(isoWeekMonday(r.Wk)),
      daysLeft: Math.round((isoWeekMonday(r.Wk).getTime() - today) / DAY),
      label: [r.SubMajorCategory, r.Size, r.MaterialClass, r.OriginCode, r.MaterialCode].filter(Boolean).join(' '), unit: r.Unit, open: q3(r.Qty),
    })),
  };
}

/** D5 · RFQs out, waiting for quotes: sent RFQs with quantity still to quote and at least one invited supplier without a current quote. */
export async function rfqsWaiting(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const rows = (await sql<{ RfqId: string; RfqNo: string; DemandId: string; DemandNo: string; CompanyCode: string; SentAt: Date | null; SentBy: string | null; Invited: number; Quoted: number; Containers: number | null; FirstWeek: string | null; LastWeek: string | null; Overdue: number }>`
    SELECT r.RfqId, r.RfqNo, d.DemandId, d.DemandNo, r.CompanyCode, r.SentAt, u.DisplayName AS SentBy,
      (SELECT COUNT(*) FROM scm.RfqSupplier s WHERE s.RfqId = r.RfqId) AS Invited,
      (SELECT COUNT(*) FROM scm.RfqSupplier s WHERE s.RfqId = r.RfqId AND EXISTS (SELECT 1 FROM scm.SupplierQuote q WHERE q.RfqId = s.RfqId AND q.SupplierCode = s.SupplierCode AND q.IsCurrent = 1)) AS Quoted,
      (SELECT SUM(w.ContainerCount) FROM scm.RfqWeek w WHERE w.RfqId = r.RfqId) AS Containers,
      (SELECT MIN(w.EtdWeek) FROM scm.RfqWeek w WHERE w.RfqId = r.RfqId) AS FirstWeek,
      (SELECT MAX(w.EtdWeek) FROM scm.RfqWeek w WHERE w.RfqId = r.RfqId) AS LastWeek,
      CASE WHEN EXISTS (SELECT 1 FROM scm.InboxItem i WHERE i.ItemType = 'RFQ_TO_QUOTE' AND i.EntityType = 'RFQ' AND i.EntityId = CAST(r.RfqId AS nvarchar(40))
                          AND i.IsOpen = 1 AND i.DueAt < SYSUTCDATETIME()) THEN 1 ELSE 0 END AS Overdue
    FROM scm.Rfq r JOIN scm.Demand d ON d.DemandId = r.DemandId LEFT JOIN app.[User] u ON u.UserId = r.SentBy
    WHERE r.ManualStatus = 'SENT' AND r.CompanyCode IN (${sql.join(companies)})
      AND EXISTS (SELECT 1 FROM scm.RfqSupplier s WHERE s.RfqId = r.RfqId
                  AND NOT EXISTS (SELECT 1 FROM scm.SupplierQuote q WHERE q.RfqId = s.RfqId AND q.SupplierCode = s.SupplierCode AND q.IsCurrent = 1))
      AND EXISTS (SELECT 1 FROM scm.RfqLine l JOIN scm.QtySlice s ON s.RfqLineId = l.RfqLineId WHERE l.RfqId = r.RfqId AND s.ExecState IN ('IN_RFQ', 'QUOTED'))
    ORDER BY r.SentAt, r.RfqId`.execute(db)).rows;
  const now = Date.now();
  return {
    waitingSuppliers: rows.reduce((s, r) => s + num(r.Invited) - num(r.Quoted), 0),
    rows: rows.map((r) => ({
      rfqId: String(r.RfqId), rfqNo: r.RfqNo, demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode, sentAt: iso(r.SentAt), sentBy: r.SentBy ?? '',
      daysOut: r.SentAt ? Math.floor((now - new Date(r.SentAt).getTime()) / DAY) : null, invited: num(r.Invited), quoted: num(r.Quoted), containers: num(r.Containers),
      weeks: r.FirstWeek ? (r.FirstWeek === r.LastWeek ? r.FirstWeek : `${r.FirstWeek} – ${r.LastWeek}`) : '', overdue: num(r.Overdue) === 1,
    })),
  };
}

/**
 * D10 · Flow in and out: containers accepted vs containers ordered (PO created) per ISO week of the period, and the backlog now.
 * "Accepted" is the containers as accepted — the version-1 baseline snapshot (`BaselineVersion`), bucketed by AcceptedAt — so a
 * later change request or merge does not rewrite past weeks. A demand without a baseline snapshot counts its current containers.
 */
export async function flow(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const thisWeek = isoWeekOf(new Date());
  const range = { from: f.from ?? dateOnly(isoWeekMonday(addWeeks(thisWeek, -11))), to: f.to ?? dateOnly(new Date()) };
  const list: string[] = [];
  const lastWeek = isoWeekOf(new Date(`${range.to}T00:00:00Z`));
  for (let w = isoWeekOf(new Date(`${range.from}T00:00:00Z`)); w <= lastWeek && list.length < 120; w = addWeeks(w, 1)) list.push(w);
  const [acc, ord, back] = await Promise.all([
    sql<{ At: Date; C: number }>`
      SELECT d.AcceptedAt AS At, ISNULL(CASE WHEN d.BaselineVersion IS NULL THEN cur.C ELSE base.C END, 0) AS C
      FROM scm.Demand d
      OUTER APPLY (SELECT SUM(j.containerCount) AS C FROM scm.DemandVersion v
                   CROSS APPLY OPENJSON(v.SnapshotJson, '$.weeks') WITH (containerCount int '$.containerCount') j
                   WHERE v.DemandId = d.DemandId AND v.VersionNo = d.BaselineVersion) base
      OUTER APPLY (SELECT SUM(w.ContainerCount) AS C FROM scm.DemandWeek w WHERE w.DemandId = d.DemandId) cur
      WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${sql.join(companies)}) ${between(sql`d.AcceptedAt`, range)}`.execute(db),
    sql<{ At: Date; C: number }>`
      SELECT COALESCE(p.SapCreatedAt, p.SubmittedAt, p.CreatedAt) AS At, ISNULL(SUM(sh.ContainerCount), 0) AS C
      FROM scm.PoDraft p JOIN scm.Handoff h ON h.HandoffId = p.HandoffId
      JOIN scm.AwardShipment sh ON sh.AwardBatchId = h.AwardBatchId AND sh.SupplierCode = h.SupplierCode AND sh.IsActive = 1
      WHERE p.Status = 'CREATED' AND p.CompanyCode IN (${sql.join(companies)}) ${between(sql`COALESCE(p.SapCreatedAt, p.SubmittedAt, p.CreatedAt)`, range)}
      GROUP BY p.PoDraftId, COALESCE(p.SapCreatedAt, p.SubmittedAt, p.CreatedAt)`.execute(db),
    sql<{ Now: number; Ordered: number }>`
      WITH inprog AS (
        SELECT DISTINCT l.DemandId FROM scm.DemandLine l JOIN scm.QtySlice s ON s.LineId = l.LineId WHERE l.IsActive = 1 AND s.ExecState IN ${IN_PROGRESS})
      SELECT
        (SELECT ISNULL(SUM(w.ContainerCount), 0) FROM scm.DemandWeek w JOIN scm.Demand d ON d.DemandId = w.DemandId JOIN inprog i ON i.DemandId = d.DemandId
          WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${sql.join(companies)})) AS [Now],
        (SELECT ISNULL(SUM(sh.ContainerCount), 0) FROM scm.AwardShipment sh JOIN scm.AwardBatch b ON b.AwardBatchId = sh.AwardBatchId JOIN inprog i ON i.DemandId = b.DemandId
          WHERE sh.IsActive = 1 AND b.CompanyCode IN (${sql.join(companies)})
            AND EXISTS (SELECT 1 FROM scm.Handoff h JOIN scm.PoDraft p ON p.HandoffId = h.HandoffId WHERE h.AwardBatchId = sh.AwardBatchId AND h.SupplierCode = sh.SupplierCode AND p.Status = 'CREATED')) AS Ordered`.execute(db),
  ]);
  const weeksOut = list.map((week) => ({ week, accepted: 0, ordered: 0 }));
  const add = (rows: { At: Date; C: number }[], k: 'accepted' | 'ordered') => {
    for (const r of rows) { const o = weeksOut.find((w) => w.week === isoWeekOf(new Date(r.At))); if (o) o[k] += num(r.C); }
  };
  add(acc.rows, 'accepted');
  add(ord.rows, 'ordered');
  return { from: range.from, to: range.to, weeks: weeksOut, backlog: Math.max(0, num(back.rows[0]?.Now) - num(back.rows[0]?.Ordered)) };
}

const DEPT: Record<string, string> = { SALES: 'Sales', PROCUREMENT: 'Procurement' };
const decider = (raisedBy: string) => (raisedBy === 'SALES' ? 'Procurement' : 'Sales');

/** D11 · Change requests: waiting for a decision (now), decided with response time (period), and the reasons (period). */
export async function changeRequests(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const [waiting, decided, reasons] = await Promise.all([
    sql<{ RaisedByDept: string; Status: string; N: number; Oldest: Date }>`
      SELECT c.RaisedByDept, c.Status, COUNT(*) AS N, MIN(c.SubmittedAt) AS Oldest FROM scm.ChangeRequest c
      WHERE c.CompanyCode IN (${sql.join(companies)}) AND c.Status IN ('SUBMITTED', 'BLOCKED') GROUP BY c.RaisedByDept, c.Status`.execute(db),
    sql<{ RaisedByDept: string; N: number; Avg: number | null }>`
      SELECT c.RaisedByDept, COUNT(*) AS N, AVG(DATEDIFF(minute, c.SubmittedAt, c.DecidedAt) / 60.0) AS [Avg] FROM scm.ChangeRequest c
      WHERE c.CompanyCode IN (${sql.join(companies)}) AND c.DecidedAt IS NOT NULL ${between(sql`c.SubmittedAt`, f)} GROUP BY c.RaisedByDept`.execute(db),
    sql<{ RaisedByDept: string; ReasonCode: string; Description: string | null; Counts: boolean | number | null; N: number }>`
      SELECT c.RaisedByDept, c.ReasonCode, r.Description, r.CountsAgainstProcurement AS Counts, COUNT(*) AS N
      FROM scm.ChangeRequest c LEFT JOIN scm.ReasonCode r ON r.ReasonCode = c.ReasonCode
      WHERE c.CompanyCode IN (${sql.join(companies)}) AND c.Status <> 'WITHDRAWN' ${between(sql`c.SubmittedAt`, f)}
      GROUP BY c.RaisedByDept, c.ReasonCode, r.Description, r.CountsAgainstProcurement ORDER BY COUNT(*) DESC, c.ReasonCode`.execute(db),
  ]);
  const submitted = waiting.rows.filter((r) => r.Status === 'SUBMITTED');
  return {
    waiting: ['SALES', 'PROCUREMENT'].map((dept) => {
      const r = submitted.find((x) => x.RaisedByDept === dept);
      return { raisedBy: DEPT[dept], decidedBy: decider(dept), count: num(r?.N), oldestAt: iso(r?.Oldest) };
    }),
    blocked: waiting.rows.filter((r) => r.Status === 'BLOCKED').reduce((s, r) => s + num(r.N), 0),
    decided: decided.rows.map((r) => ({ decidedBy: decider(r.RaisedByDept), count: num(r.N), avgHours: r.Avg == null ? null : Math.round(Number(r.Avg) * 10) / 10 })),
    reasons: reasons.rows.map((r) => ({ raisedBy: DEPT[r.RaisedByDept] ?? r.RaisedByDept, code: r.ReasonCode, description: r.Description ?? r.ReasonCode, countsAgainstProcurement: Boolean(Number(r.Counts ?? 0)), count: num(r.N) })),
  };
}

/** D12 · Demand stability: for demands accepted in the period, how many changed afterwards and how the quantity moved, per unit. */
export async function stability(db: Db, actor: Actor, f: ReportFilter) {
  const companies = scope(actor, f);
  const [head, units] = await Promise.all([
    // Per demand first (CROSS APPLY), then summed: SQL Server refuses an aggregate over a subquery.
    sql<{ Accepted: number; Changed: number; Merges: number }>`
      SELECT COUNT(*) AS Accepted, ISNULL(SUM(x.Changed), 0) AS Changed, ISNULL(SUM(x.Merges), 0) AS Merges
      FROM scm.Demand d
      CROSS APPLY (SELECT
        CASE WHEN EXISTS (SELECT 1 FROM scm.DemandVersion v WHERE v.DemandId = d.DemandId AND v.VersionNo > ISNULL(d.BaselineVersion, 0)
                            AND v.Reason NOT IN ('SUBMIT', 'RESUBMIT', 'ACCEPT')) THEN 1 ELSE 0 END AS Changed,
        (SELECT COUNT(*) FROM scm.DemandVersion v WHERE v.DemandId = d.DemandId AND v.Reason = 'MERGE_IN') AS Merges) x
      WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${sql.join(companies)}) ${between(sql`d.AcceptedAt`, f)}`.execute(db),
    sql<{ Unit: string; Committed: string; SalesCancelled: string; NotSourced: string; ProcAdded: string; MergedIn: string; MergedOut: string }>`
      SELECT l.Unit,
        SUM(CASE WHEN s.BusinessOrigin IN ('SALES', 'CHANGE') AND s.ExecState <> 'MERGED_OUT' AND NOT (s.ExecState = 'CANCELLED' AND s.CancelOrigin IN ('SALES', 'CHANGE')) THEN s.Qty ELSE 0 END) AS Committed,
        SUM(CASE WHEN s.ExecState = 'CANCELLED' AND s.CancelOrigin IN ('SALES', 'CHANGE') THEN s.Qty ELSE 0 END) AS SalesCancelled,
        SUM(CASE WHEN s.ExecState = 'CANCELLED' AND s.CancelOrigin = 'PROCUREMENT' THEN s.Qty ELSE 0 END) AS NotSourced,
        SUM(CASE WHEN s.BusinessOrigin = 'PROCUREMENT' AND s.ExecState <> 'MERGED_OUT' THEN s.Qty ELSE 0 END) AS ProcAdded,
        SUM(CASE WHEN s.ArrivedVia = 'MERGE' AND s.ExecState <> 'MERGED_OUT' THEN s.Qty ELSE 0 END) AS MergedIn,
        SUM(CASE WHEN s.ExecState = 'MERGED_OUT' THEN s.Qty ELSE 0 END) AS MergedOut
      FROM scm.Demand d JOIN scm.DemandLine l ON l.DemandId = d.DemandId JOIN scm.QtySlice s ON s.LineId = l.LineId
      WHERE d.WorkflowStatus = 'ACCEPTED' AND d.CompanyCode IN (${sql.join(companies)}) ${between(sql`d.AcceptedAt`, f)}
      GROUP BY l.Unit ORDER BY l.Unit`.execute(db),
  ]);
  const h = head.rows[0];
  return {
    accepted: num(h?.Accepted), changed: num(h?.Changed), changedRate: ratio(num(h?.Changed), num(h?.Accepted)), merges: num(h?.Merges),
    units: units.rows.map((u) => ({
      unit: u.Unit, committed: q3(u.Committed), salesCancelled: q3(u.SalesCancelled), notSourced: q3(u.NotSourced), procAdded: q3(u.ProcAdded), mergedIn: q3(u.MergedIn), mergedOut: q3(u.MergedOut),
      salesCancelledRate: ratio(fromDb(u.SalesCancelled), fromDb(u.Committed) + fromDb(u.SalesCancelled)),
    })),
  };
}

/** D14 · Top suppliers: containers awarded in the period (active shipments of award batches created in it), share, and handoffs the PO team returned (ReturnedBy set, as on Performance and the scorecard). */
export async function suppliers(db: Db, actor: Actor, f: ReportFilter, top = 6) {
  const companies = scope(actor, f);
  const rows = (await sql<{ SupplierCode: string; Name: string | null; Country: string | null; C: number; Returned: number }>`
    SELECT sh.SupplierCode, s.Name, s.Country, SUM(sh.ContainerCount) AS C,
      (SELECT COUNT(*) FROM scm.Handoff h WHERE h.SupplierCode = sh.SupplierCode AND h.Status = 'RETURNED' AND h.ReturnedBy IS NOT NULL AND h.CompanyCode IN (${sql.join(companies)}) ${between(sql`h.SentAt`, f)}) AS Returned
    FROM scm.AwardShipment sh JOIN scm.AwardBatch b ON b.AwardBatchId = sh.AwardBatchId LEFT JOIN md.Supplier s ON s.SupplierCode = sh.SupplierCode
    WHERE sh.IsActive = 1 AND b.CompanyCode IN (${sql.join(companies)}) ${between(sql`b.CreatedAt`, f)}
    GROUP BY sh.SupplierCode, s.Name, s.Country ORDER BY SUM(sh.ContainerCount) DESC, sh.SupplierCode`.execute(db)).rows;
  const total = rows.reduce((s, r) => s + num(r.C), 0);
  const shown = rows.slice(0, top).map((r) => ({ supplierCode: r.SupplierCode, name: r.Name ?? r.SupplierCode, country: r.Country ?? '', containers: num(r.C), share: ratio(num(r.C), total), returned: num(r.Returned) }));
  const rest = rows.slice(top);
  if (rest.length) {
    const c = rest.reduce((s, r) => s + num(r.C), 0);
    shown.push({ supplierCode: '', name: `Other suppliers (${rest.length})`, country: '', containers: c, share: ratio(c, total), returned: rest.reduce((s, r) => s + num(r.Returned), 0) });
  }
  return { total, suppliers: rows.length, rows: shown };
}
