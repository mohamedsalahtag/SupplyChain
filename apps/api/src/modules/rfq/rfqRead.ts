/** Reading RFQs (spec 18): builder data, shortlist, one RFQ with its supplier view and quotes, the list, history. */
import { rfqSteps } from '../workflow/lastStep.js';
import { sql } from 'kysely';
import { anyClass, anySize, skusForSpec } from '../demand/lookups.js';
import { hasPermission, type Actor } from '../workflow/access.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { rowVerHex, type Db } from '../workflow/tx.js';
import { P_RFQ } from './rfqService.js';
import { supplierShortlist, type Hint } from './shortlist.js';
import { rfqLineStatus, rfqStatus } from './status.js';

const label = (l: { SubMajorCategory: string; Size: string; MaterialClass: string; MaterialCode: string | null }) =>
  [l.SubMajorCategory, anySize(l.Size), anyClass(l.MaterialClass), l.MaterialCode].filter(Boolean).join(' ');
const AWARDED = ['AWARDED', 'HANDED_OFF', 'PO_PREPARATION', 'PO_SUBMITTED', 'PO_CREATED'];

/** An accepted demand the actor may source. */
async function sourceable(db: Db, actor: Actor, demandId: string) {
  const d = await db.selectFrom('scm.Demand').select(['DemandId', 'DemandNo', 'CompanyCode', 'WorkflowStatus']).where('DemandId', '=', demandId).executeTakeFirst();
  if (!d || !actor.companies.has(d.CompanyCode) || !hasPermission(actor, P_RFQ.manage)) throw new NotFoundError(`Demand ${demandId}`);
  if (d.WorkflowStatus !== 'ACCEPTED') throw new DomainError('BAD_STATE', `${d.DemandNo} is not accepted`, 409);
  return { ...d, DemandId: String(d.DemandId) };
}

/** Builder step 1 and 2: Open quantity per line and approved week, and each week's containers and live quantity. */
export async function builderData(db: Db, actor: Actor, demandId: string) {
  const d = await sourceable(db, actor, demandId);
  const [rows, weeks] = await Promise.all([
    sql<{ LineId: string; ApprovedEtdWeek: string; MajorCategory: string; SubMajorCategory: string; Size: string; MaterialClass: string; OriginCode: string; MaterialCode: string | null; Unit: string; HoldCrNo: string | null; OpenQty: string }>`
      SELECT l.LineId, s.ApprovedEtdWeek, l.MajorCategory, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, l.Unit, c.CrNo AS HoldCrNo, SUM(s.Qty) AS OpenQty
      FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId LEFT JOIN scm.ChangeRequest c ON c.CrId = l.ChangeHoldCrId
      WHERE l.DemandId = ${demandId} AND l.IsActive = 1 AND s.ExecState = 'OPEN'
      GROUP BY l.LineId, s.ApprovedEtdWeek, l.MajorCategory, l.SubMajorCategory, l.Size, l.MaterialClass, l.OriginCode, l.MaterialCode, l.Unit, c.CrNo, l.LineNumber
      ORDER BY s.ApprovedEtdWeek, l.LineNumber`.execute(db).then((r) => r.rows),
    sql<{ EtdWeek: string; ContainerCount: number; LiveQty: string }>`
      SELECT dw.EtdWeek, dw.ContainerCount, ISNULL(SUM(CASE WHEN s.ExecState NOT IN ('CANCELLED', 'MERGED_OUT') THEN s.Qty END), 0) AS LiveQty
      FROM scm.DemandWeek dw LEFT JOIN scm.DemandLine l ON l.DemandWeekId = dw.DemandWeekId AND l.IsActive = 1 LEFT JOIN scm.QtySlice s ON s.LineId = l.LineId
      WHERE dw.DemandId = ${demandId} GROUP BY dw.EtdWeek, dw.ContainerCount`.execute(db).then((r) => r.rows),
  ]);
  return {
    demand: { demandId: d.DemandId, demandNo: d.DemandNo, companyCode: d.CompanyCode },
    rows: rows.map((r) => ({
      lineId: String(r.LineId), week: r.ApprovedEtdWeek, label: label(r), majorCategory: r.MajorCategory, originCode: r.OriginCode, unit: r.Unit,
      open: formatQty(fromDb(r.OpenQty)), openMilli: fromDb(r.OpenQty), hold: r.HoldCrNo,
    })),
    weeks: weeks.map((w) => ({ etdWeek: w.EtdWeek, containers: Number(w.ContainerCount), liveMilli: fromDb(w.LiveQty) })),
  };
}

/** Builder step 3: the shortlist per origin of the chosen lines. */
export async function shortlistFor(db: Db, actor: Actor, demandId: string, lineIds: string[]) {
  const d = await sourceable(db, actor, demandId);
  if (!lineIds.length) return [];
  const lines = await db.selectFrom('scm.DemandLine').select(['LineId', 'MajorCategory', 'SubMajorCategory', 'Size', 'OriginCode', 'MaterialCode', 'Unit'])
    .where('DemandId', '=', demandId).where('LineId', 'in', lineIds).execute();
  const groups = await supplierShortlist(db, d.CompanyCode, lines.map((l) => ({
    lineId: String(l.LineId), majorCategory: l.MajorCategory, subMajorCategory: l.SubMajorCategory, size: l.Size, originCode: l.OriginCode, materialCode: l.MaterialCode, unit: l.Unit,
  })));
  return groups;
}

type LineQty = { RfqLineId: string; ProposedEtdWeek: string; LineKey: string; AskedQty: string; IsCancelled: boolean; InRfq: string; Quoted: string; Awarded: string; Cancelled: string };

export async function getRfq(db: Db, actor: Actor, rfqId: string) {
  const r = await db.selectFrom('scm.Rfq as r').innerJoin('scm.Demand as d', 'd.DemandId', 'r.DemandId')
    .leftJoin('app.User as cu', 'cu.UserId', 'r.CreatedBy').leftJoin('app.User as su', 'su.UserId', 'r.SentBy').leftJoin('app.User as xu', 'xu.UserId', 'r.CancelledBy')
    .select(['r.RfqId', 'r.RfqNo', 'r.DemandId', 'd.DemandNo', 'r.CompanyCode', 'r.ManualStatus', 'r.CreatedAt', 'r.SentAt', 'r.CancelledAt', 'r.CancelReason', 'r.CancelComment',
      'cu.DisplayName as CreatedByName', 'su.DisplayName as SentByName', 'xu.DisplayName as CancelledByName', rowVerHex('r.RowVer').as('RowVer')])
    .where('r.RfqId', '=', rfqId).executeTakeFirst();
  if (!r || !actor.companies.has(r.CompanyCode) || !hasPermission(actor, P_RFQ.open)) throw new NotFoundError(`RFQ ${rfqId}`);

  const weekOffers = await db.selectFrom('scm.SupplierQuoteWeek').select(['SupplierCode', 'EtdWeek', 'ContainersOffered']).where('RfqId', '=', rfqId).execute();
  const [lines, qty, weeks, suppliers, quotes] = await Promise.all([
    db.selectFrom('scm.RfqLine').selectAll().where('RfqId', '=', rfqId).orderBy('ProposedEtdWeek').orderBy('RfqLineId').execute(),
    sql<LineQty>`SELECT l.RfqLineId, l.ProposedEtdWeek, l.LineKey, l.AskedQty, l.IsCancelled,
        ISNULL(SUM(CASE WHEN s.ExecState = 'IN_RFQ' THEN s.Qty END), 0) AS InRfq, ISNULL(SUM(CASE WHEN s.ExecState = 'QUOTED' THEN s.Qty END), 0) AS Quoted,
        ISNULL(SUM(CASE WHEN s.ExecState IN (${sql.join(AWARDED)}) THEN s.Qty END), 0) AS Awarded, ISNULL(SUM(CASE WHEN s.ExecState = 'CANCELLED' THEN s.Qty END), 0) AS Cancelled
      FROM scm.RfqLine l LEFT JOIN scm.QtySlice s ON s.RfqLineId = l.RfqLineId WHERE l.RfqId = ${rfqId}
      GROUP BY l.RfqLineId, l.ProposedEtdWeek, l.LineKey, l.AskedQty, l.IsCancelled`.execute(db).then((x) => x.rows),
    db.selectFrom('scm.RfqWeek').select(['EtdWeek', 'ContainerCount', 'DefaultCount']).where('RfqId', '=', rfqId).orderBy('EtdWeek').execute(),
    db.selectFrom('scm.RfqSupplier as rs').innerJoin('md.Supplier as s', 's.SupplierCode', 'rs.SupplierCode')
      .select(['rs.SupplierCode', 's.Name', 's.Currency', 'rs.OriginsAtInvite', 'rs.ShortlistRank', 'rs.HintJson', 'rs.InvitedAt', 'rs.OutsideShortlist']).where('rs.RfqId', '=', rfqId).orderBy('s.Name').execute(),
    db.selectFrom('scm.SupplierQuote as q').leftJoin('app.User as u', 'u.UserId', 'q.RecordedBy').selectAll('q').select('u.DisplayName as RecordedByName')
      .where('q.RfqId', '=', rfqId).orderBy('q.QuoteId', 'desc').execute(),
  ]);
  const qtyOf = new Map(qty.map((x) => [String(x.RfqLineId), x]));
  // Spec 19: Procurement requests on this RFQ's lines (proposed quantity, week shift).
  const crIds = [...new Set(lines.flatMap((l) => [l.AddCrId, l.WeekShiftCrId]).filter((x): x is string => !!x).map(String))];
  const crs = new Map((crIds.length ? await db.selectFrom('scm.ChangeRequest').select(['CrId', 'CrNo', 'Status']).where('CrId', 'in', crIds).execute() : [])
    .map((c) => [String(c.CrId), c]));
  const pendingCr = (id: string | null) => { const c = id ? crs.get(String(id)) : undefined; return c && c.Status === 'SUBMITTED' ? { crId: String(c.CrId), crNo: c.CrNo } : null; };
  let inRfq = 0; let quoted = 0; let awarded = 0;
  const lineViews = lines.map((l) => {
    const x = qtyOf.get(String(l.RfqLineId))!;
    const q = { inRfq: fromDb(x.InRfq), quoted: fromDb(x.Quoted), awarded: fromDb(x.Awarded) };
    const proposed = l.Origin === 'PROCUREMENT' && !l.DemandLineId && !l.IsCancelled ? fromDb(l.ProposedQty) : 0; // waiting for Sales
    inRfq += q.inRfq + proposed; quoted += q.quoted; awarded += q.awarded;
    const released = proposed ? 0 : fromDb(l.AskedQty) - q.inRfq - q.quoted - q.awarded - fromDb(x.Cancelled);
    const shift = pendingCr(l.WeekShiftCrId);
    return {
      rfqLineId: String(l.RfqLineId), week: l.ProposedEtdWeek, key: l.LineKey, label: label(l), originCode: l.OriginCode, unit: l.Unit,
      asked: formatQty(fromDb(l.AskedQty)), inRfq: formatQty(q.inRfq), quoted: formatQty(q.quoted), awarded: formatQty(q.awarded),
      cancelled: formatQty(fromDb(x.Cancelled)), released: formatQty(Math.max(0, released)),
      status: proposed ? ('PENDING_SALES' as const) : rfqLineStatus(l.IsCancelled, q),
      proposed: formatQty(proposed), origin: l.Origin,
      pending: ((c: { crId: string; crNo: string } | null, fromWeek: string | null) => (c ? { ...c, fromWeek } : null))(
        proposed ? pendingCr(l.AddCrId) : shift, proposed ? null : l.PreviousEtdWeek),
      canRelease: r.ManualStatus !== 'CANCELLED' && q.inRfq + q.quoted > 0,
      canShift: r.ManualStatus !== 'CANCELLED' && l.Origin === 'DEMAND' && !l.IsCancelled && !shift && q.inRfq + q.quoted > 0, // a partly awarded line splits (spec 20)
      spec: { majorCategory: l.MajorCategory, subMajorCategory: l.SubMajorCategory, size: l.Size, materialClass: l.MaterialClass, originCode: l.OriginCode, unit: l.Unit },
    };
  });
  // The supplier view: per week and material, the live quantity, plus the week's containers. No demand numbers.
  const view = new Map<string, { week: string; key: string; label: string; originCode: string; unit: string; qty: number; spec: (typeof lineViews)[number]['spec'] }>();
  for (const l of lineViews) {
    const live = Number(l.inRfq) + Number(l.quoted) + Number(l.awarded) + Number(l.proposed);
    const k = `${l.week}|${l.key}`;
    const v = view.get(k) ?? { week: l.week, key: l.key, label: l.label, originCode: l.originCode, unit: l.unit, qty: 0, spec: l.spec };
    v.qty += Math.round(live * 1000);
    view.set(k, v);
  }
  const supplierView = await Promise.all([...view.values()].filter((v) => v.qty > 0).sort((a, b) => a.week.localeCompare(b.week) || a.label.localeCompare(b.label)).map(async (v) => ({
    week: v.week, key: v.key, label: v.label, originCode: v.originCode, unit: v.unit, qty: formatQty(v.qty),
    weekContainers: weeks.find((w) => w.EtdWeek === v.week)?.ContainerCount ?? 0,
    skus: (await skusForSpec(db, v.spec)).map((m) => ({ code: m.MaterialCode, description: m.Description })),
  })));
  const quoteView = (q: (typeof quotes)[number]) => ({
    quoteId: String(q.QuoteId), supplierCode: q.SupplierCode, week: q.EtdWeek, key: q.LineKey, unitPrice: Number(q.UnitPrice).toFixed(4).replace(/0{1,2}$/, ''),
    currency: q.Currency, available: formatQty(fromDb(q.AvailableQty)), quotedSku: q.QuotedSku, containersOffered: q.ContainersOffered,
    recordedBy: q.RecordedByName ?? '', recordedAt: q.RecordedAt.toISOString(), isCurrent: q.IsCurrent,
  });
  const status = rfqStatus(r.ManualStatus, { inRfq, quoted, awarded });
  const manage = hasPermission(actor, P_RFQ.manage);
  const propose = manage && hasPermission(actor, 'cr.raise.procurement') && r.ManualStatus !== 'CANCELLED';
  return {
    rfqId: String(r.RfqId), rfqNo: r.RfqNo, demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode, status, manualStatus: r.ManualStatus, rowVer: r.RowVer,
    createdBy: r.CreatedByName ?? '', createdAt: r.CreatedAt.toISOString(), sentBy: r.SentByName, sentAt: r.SentAt?.toISOString() ?? null,
    cancelled: r.CancelledAt ? { by: r.CancelledByName ?? '', at: r.CancelledAt.toISOString(), reason: r.CancelReason, comment: r.CancelComment } : null,
    weeks: weeks.map((w) => ({ etdWeek: w.EtdWeek, containerCount: w.ContainerCount, defaultCount: w.DefaultCount })),
    lines: lineViews,
    supplierView,
    suppliers: suppliers.map((s) => ({
      supplierCode: s.SupplierCode, name: s.Name, currency: s.Currency || 'USD', originsAtInvite: s.OriginsAtInvite.split(',').filter(Boolean), rank: s.ShortlistRank,
      hints: (s.HintJson ? JSON.parse(s.HintJson) : {}) as Record<string, Hint>, invitedAt: s.InvitedAt.toISOString(), outsideShortlist: !!s.OutsideShortlist,
      quotedRows: quotes.filter((q) => q.IsCurrent && q.SupplierCode === s.SupplierCode).length,
    })),
    quotes: quotes.filter((q) => q.IsCurrent).map(quoteView),
    /** Spec 21: every business step, oldest first. */
    steps: (await rfqSteps(db, [String(r.RfqId)])).get(String(r.RfqId)) ?? [],
    /** Containers each supplier offers per week (spec 18 revision). */
    weekOffers: weekOffers.map((w) => ({ supplierCode: w.SupplierCode, week: w.EtdWeek, containers: w.ContainersOffered })),
    replacedQuotes: quotes.filter((q) => !q.IsCurrent).map(quoteView),
    actions: {
      send: manage && r.ManualStatus === 'DRAFT' && status !== 'CLOSED',
      recordQuotes: manage && r.ManualStatus === 'SENT' && inRfq + quoted > 0,
      cancel: manage && r.ManualStatus !== 'CANCELLED' && awarded === 0 && status !== 'CLOSED',
      release: manage && r.ManualStatus !== 'CANCELLED',
      /** Spec 18 addition: more suppliers after creation, while something is left to quote. */
      invite: manage && r.ManualStatus !== 'CANCELLED' && inRfq + quoted > 0,
      /** Spec 19: Procurement change requests from this RFQ. */
      addQuantity: propose, mixChange: propose, weekShift: propose,
      /** Spec 20: award quoted quantity. */
      award: hasPermission(actor, 'award.manage') && r.ManualStatus === 'SENT' && quoted > 0,
    },
  };
}

export type RfqFilters = { q?: string; company?: string[]; status?: string[]; demandId?: string; page: number; pageSize: number };

export async function listRfqs(db: Db, actor: Actor, f: RfqFilters) {
  const companies = [...actor.companies];
  if (!companies.length) return { rows: [], total: 0 };
  let q = db.selectFrom('scm.Rfq as r').innerJoin('scm.Demand as d', 'd.DemandId', 'r.DemandId').leftJoin('app.User as u', 'u.UserId', 'r.CreatedBy')
    .where('r.CompanyCode', 'in', f.company?.length ? f.company.filter((c) => actor.companies.has(c)) : companies);
  if (f.q) { const p = `%${f.q.replace(/[[%_]/g, '[$&]')}%`; q = q.where((eb) => eb.or([eb('r.RfqNo', 'like', p), eb('d.DemandNo', 'like', p)])); }
  if (f.demandId) q = q.where('r.DemandId', '=', f.demandId);
  const rows = await q.select(['r.RfqId', 'r.RfqNo', 'r.DemandId', 'd.DemandNo', 'r.CompanyCode', 'r.ManualStatus', 'r.CreatedAt', 'u.DisplayName as CreatedByName'])
    .select((eb) => [
      eb.selectFrom('scm.RfqSupplier as s').whereRef('s.RfqId', '=', 'r.RfqId').select(eb.fn.countAll<number>().as('n')).as('Suppliers'),
      eb.selectFrom('scm.RfqSupplier as s').whereRef('s.RfqId', '=', 'r.RfqId')
        .where((e2) => e2.exists(e2.selectFrom('scm.SupplierQuote as x').select('x.QuoteId').whereRef('x.RfqId', '=', 's.RfqId').whereRef('x.SupplierCode', '=', 's.SupplierCode').where('x.IsCurrent', '=', true)))
        .select(eb.fn.countAll<number>().as('n')).as('Quoted'),
    ])
    .orderBy('r.RfqId', 'desc').execute();
  const ids = rows.map((r) => String(r.RfqId));
  const agg = ids.length ? (await sql<{ RfqId: string; Weeks: string | null; InRfq: string; Quoted: string; Awarded: string }>`
    SELECT l.RfqId, MIN(l.ProposedEtdWeek) + CASE WHEN MIN(l.ProposedEtdWeek) <> MAX(l.ProposedEtdWeek) THEN ' – ' + MAX(l.ProposedEtdWeek) ELSE '' END AS Weeks,
      ISNULL(SUM(CASE WHEN s.ExecState = 'IN_RFQ' THEN s.Qty END), 0) AS InRfq, ISNULL(SUM(CASE WHEN s.ExecState = 'QUOTED' THEN s.Qty END), 0) AS Quoted,
      ISNULL(SUM(CASE WHEN s.ExecState IN (${sql.join(AWARDED)}) THEN s.Qty END), 0) AS Awarded
    FROM scm.RfqLine l LEFT JOIN scm.QtySlice s ON s.RfqLineId = l.RfqLineId WHERE l.RfqId IN (${sql.join(ids)}) GROUP BY l.RfqId`.execute(db)).rows : [];
  const steps = await rfqSteps(db, ids); // spec 21: the last step per RFQ
  let out = rows.map((r) => {
    const a = agg.find((x) => String(x.RfqId) === String(r.RfqId));
    return {
      rfqId: String(r.RfqId), rfqNo: r.RfqNo, demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode,
      status: rfqStatus(r.ManualStatus, { inRfq: fromDb(a?.InRfq ?? 0), quoted: fromDb(a?.Quoted ?? 0), awarded: fromDb(a?.Awarded ?? 0) }),
      weeks: a?.Weeks ?? '', suppliers: Number(r.Suppliers ?? 0), quoted: Number(r.Quoted ?? 0), createdBy: r.CreatedByName ?? '', createdAt: r.CreatedAt.toISOString(),
      lastStep: steps.get(String(r.RfqId))?.at(-1) ?? null,
    };
  });
  if (f.status?.length) out = out.filter((r) => f.status!.includes(r.status));
  return { total: out.length, rows: out.slice((f.page - 1) * f.pageSize, f.page * f.pageSize) };
}

export async function rfqHistory(db: Db, rfqId: string) {
  const rows = await db.selectFrom('scm.DomainEvent as e').leftJoin('app.User as u', 'u.UserId', 'e.ActorUserId')
    .select(['e.EventType', 'e.PayloadJson', 'e.OccurredAt', 'u.DisplayName']).where('e.EntityType', '=', 'RFQ').where('e.EntityId', '=', rfqId).orderBy('e.EventId', 'desc').execute();
  return rows.map((r) => ({ at: r.OccurredAt.toISOString(), by: r.DisplayName ?? 'System', event: r.EventType, payload: r.PayloadJson ? JSON.parse(r.PayloadJson) : null }));
}
