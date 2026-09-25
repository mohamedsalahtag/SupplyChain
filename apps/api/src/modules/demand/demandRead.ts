/** Reading demands (specs 12, 13): one demand with its ledger and allowed actions, the list, and the history. */
import { demandSteps } from '../workflow/lastStep.js';
import { sql, type SqlBool } from 'kysely';
import type { DemandWorkflowStatus, SliceState } from '../../db/schema.js';
import { hasPermission, type Actor } from '../workflow/access.js';
import { NotFoundError } from '../workflow/errors.js';
import { addLedgers, buildLedger, deriveStatus, emptyLedger, inProgress, type QtyLedger } from '../workflow/ledger.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { rowVerHex, type Db } from '../workflow/tx.js';
import { P_DEMAND } from './demandService.js';
import { formatShare } from './compose.js';
import { mergeInfo } from '../merge/mergeInfo.js';
import { anyClass, anySize } from './lookups.js';

const LEDGER_COLS: [SliceState, string][] = [
  ['OPEN', 'OpenQty'], ['IN_RFQ', 'InRfqQty'], ['QUOTED', 'QuotedQty'], ['AWARDED', 'AwardedQty'], ['HANDED_OFF', 'HandedOffQty'],
  ['PO_PREPARATION', 'PoPrepQty'], ['PO_SUBMITTED', 'PoSubmittedQty'], ['PO_CREATED', 'PoCreatedQty'], ['CANCELLED', 'CancelledQty'], ['MERGED_OUT', 'MergedOutQty'],
];

/** Ledger as decimal strings for the UI (milli-units never leave the server as numbers). */
const shown = (l: QtyLedger) => ({
  requested: formatQty(l.requested),
  open: formatQty(l.OPEN),
  inProgress: formatQty(inProgress(l)),
  poCreated: formatQty(l.PO_CREATED),
  cancelled: formatQty(l.CANCELLED),
  mergedOut: formatQty(l.MERGED_OUT),
  byState: Object.fromEntries(LEDGER_COLS.map(([s]) => [s, formatQty(l[s])])) as Record<SliceState, string>,
});

/** What this user may do with this demand now (hard rule 2: the UI only renders this). */
export function allowedActions(actor: Actor, d: { CompanyCode: string; WorkflowStatus: DemandWorkflowStatus; CreatedBy?: number | string }) {
  const can = (p: string) => hasPermission(actor, p) && actor.companies.has(d.CompanyCode);
  const editable = d.WorkflowStatus === 'DRAFT' || d.WorkflowStatus === 'RETURNED';
  return {
    edit: editable && can(P_DEMAND.create),
    submit: editable && can(P_DEMAND.submit),
    accept: d.WorkflowStatus === 'SUBMITTED' && can(P_DEMAND.accept) && (actor.isAdmin || Number(d.CreatedBy) !== actor.id), // not one's own demand
    return: d.WorkflowStatus === 'SUBMITTED' && can(P_DEMAND.return),
    /** Change requests on an accepted demand (spec 14). */
    changeContainers: d.WorkflowStatus === 'ACCEPTED' && can('cr.raise.sales'),
    notSourced: d.WorkflowStatus === 'ACCEPTED' && can('cr.raise.procurement'),
    /** Sales takes a submitted demand back to change it, until Procurement accepts it. */
    recall: d.WorkflowStatus === 'SUBMITTED' && can(P_DEMAND.submit),
    /** Procurement merges other demands into an accepted one (spec 17). */
    merge: d.WorkflowStatus === 'ACCEPTED' && can('demand.merge'),
    /** Procurement asks suppliers for prices (spec 18). */
    createRfq: d.WorkflowStatus === 'ACCEPTED' && can('rfq.manage'),
    comment: can(P_DEMAND.comment),
    attach: can(P_DEMAND.attach),
  };
}

export async function getDemand(db: Db, actor: Actor, demandId: string) {
  const d = await db
    .selectFrom('scm.Demand as d')
    .innerJoin('scm.Company as c', 'c.CompanyCode', 'd.CompanyCode')
    .leftJoin('app.User as cu', 'cu.UserId', 'd.CreatedBy')
    .leftJoin('app.User as au', 'au.UserId', 'd.AcceptedBy')
    .select(['d.DemandId', 'd.DemandNo', 'd.CompanyCode', 'c.Name as CompanyName', 'd.WorkflowStatus', 'd.CurrentVersion', 'd.BaselineVersion', 'd.Notes',
      'd.CreatedAt', 'd.SubmittedAt', 'd.AcceptedAt', 'cu.DisplayName as CreatedByName', 'au.DisplayName as AcceptedByName', 'd.CreatedBy', rowVerHex('d.RowVer').as('RowVer')])
    .where('d.DemandId', '=', demandId)
    .executeTakeFirst();
  if (!d || !actor.companies.has(d.CompanyCode) || !hasPermission(actor, P_DEMAND.open)) throw new NotFoundError(`Demand ${demandId}`);

  const [weeks, lines, groups, items] = await Promise.all([
    db.selectFrom('scm.DemandWeek').select(['DemandWeekId', 'EtdWeek', 'ContainerCount']).where('DemandId', '=', demandId).orderBy('EtdWeek').execute(),
    db.selectFrom('scm.DemandLine as l')
      .innerJoin('scm.vLineLedger as g', 'g.LineId', 'l.LineId')
      .leftJoin('md.Material as m', 'm.MaterialCode', 'l.MaterialCode')
      .selectAll('g')
      .select(['l.LineNumber', 'l.SpecMode', 'l.MajorCategory', 'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.OriginCode', 'l.MaterialCode', 'l.ChangeHoldCrId', 'm.Description as MaterialDescription'])
      .where('l.DemandId', '=', demandId).where('l.IsActive', '=', true).orderBy('l.LineNumber').execute(),
    db.selectFrom('scm.ContainerGroup').select(['ContainerGroupId', 'DemandWeekId', 'GroupNumber', 'Name', 'ContainerCount', 'CapacityQty', 'Unit'])
      .where('DemandId', '=', demandId).where('IsActive', '=', true).orderBy('GroupNumber').execute(),
    db.selectFrom('scm.ContainerGroupItem as i').innerJoin('scm.ContainerGroup as g', 'g.ContainerGroupId', 'i.ContainerGroupId')
      .leftJoin('md.Material as m', 'm.MaterialCode', 'i.MaterialCode')
      .select(['i.ContainerGroupItemId', 'i.ContainerGroupId', 'i.SpecMode', 'i.MajorCategory', 'i.SubMajorCategory', 'i.Size', 'i.MaterialClass', 'i.OriginCode',
        'i.MaterialCode', 'i.Unit', 'i.ShareBp', 'i.ComputedQty', 'i.LineKey', 'm.Description as MaterialDescription'])
      .where('g.DemandId', '=', demandId).where('g.IsActive', '=', true).orderBy('i.ContainerGroupItemId').execute(),
  ]);
  // Open change requests holding weeks or lines of this demand (spec 14).
  const [weekHolds, holdCrs] = await Promise.all([
    db.selectFrom('scm.WeekHold as h').innerJoin('scm.ChangeRequest as c', 'c.CrId', 'h.CrId').select(['h.EtdWeek', 'c.CrId', 'c.CrNo']).where('h.DemandId', '=', demandId).execute(),
    db.selectFrom('scm.ChangeRequest').select(['CrId', 'CrNo']).where('DemandId', '=', demandId).where('Status', '=', 'SUBMITTED').execute(),
  ]);
  const merges = await mergeInfo(db, demandId);
  // Spec 19: live quantity approved for another week than its line's (an approved week shift).
  const shifted = (await sql<{ LineId: string; ApprovedEtdWeek: string; Qty: string; Unit: string; EtdWeek: string }>`
    SELECT s.LineId, s.ApprovedEtdWeek, SUM(s.Qty) AS Qty, l.Unit, w.EtdWeek FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId JOIN scm.DemandWeek w ON w.DemandWeekId = l.DemandWeekId
    WHERE l.DemandId = ${demandId} AND s.ExecState NOT IN ('CANCELLED', 'MERGED_OUT') AND s.ApprovedEtdWeek <> w.EtdWeek
    GROUP BY s.LineId, s.ApprovedEtdWeek, l.Unit, w.EtdWeek`.execute(db)).rows;
  const crNo = (id: string | null) => (id ? (holdCrs.find((c) => String(c.CrId) === String(id))?.CrNo ?? null) : null);

  const status = d.WorkflowStatus;
  let total = emptyLedger();
  const weekViews = weeks.map((w) => {
    let wl = emptyLedger();
    const ls = lines.filter((l) => String(l.DemandWeekId) === String(w.DemandWeekId)).map((l) => {
      const ledger = buildLedger(fromDb(l.RequestedQty), LEDGER_COLS.map(([state, col]) => ({ state, qty: fromDb((l as unknown as Record<string, string>)[col]) })));
      wl = addLedgers(wl, ledger);
      return {
        lineId: String(l.LineId), key: l.LineKey, lineNumber: Number(l.LineNumber), specMode: l.SpecMode, majorCategory: l.MajorCategory, subMajorCategory: l.SubMajorCategory,
        size: l.Size, sizeLabel: anySize(l.Size), materialClass: l.MaterialClass, classLabel: anyClass(l.MaterialClass), originCode: l.OriginCode, materialCode: l.MaterialCode, materialDescription: l.MaterialDescription ?? '',
        unit: l.Unit, mergedIn: merges.lineIn(String(l.LineId)),
        approvedFor: shifted.filter((x) => String(x.LineId) === String(l.LineId)).map((x) => `${Number(formatQty(fromDb(x.Qty))).toLocaleString('en-GB')} ${x.Unit} approved for ${x.ApprovedEtdWeek}`), onHold: !!l.ChangeHoldCrId, hold: l.ChangeHoldCrId ? { crId: String(l.ChangeHoldCrId), crNo: crNo(String(l.ChangeHoldCrId)) } : null, ledger: shown(ledger), status: deriveStatus(status, ledger),
      };
    });
    total = addLedgers(total, wl);
    // The container groups the lines were worked out from (spec 12). Old demands may have none.
    const gs = groups.filter((g) => String(g.DemandWeekId) === String(w.DemandWeekId)).map((g) => {
      const its = items.filter((i) => String(i.ContainerGroupId) === String(g.ContainerGroupId));
      const containers = Number(g.ContainerCount);
      return {
        groupId: String(g.ContainerGroupId), groupNumber: Number(g.GroupNumber), name: g.Name, mergedFrom: merges.groupFrom.get(String(g.ContainerGroupId)) ?? null, containerCount: containers, capacity: formatQty(fromDb(g.CapacityQty)), unit: g.Unit,
        totalShare: formatShare(its.reduce((s, i) => s + Number(i.ShareBp), 0)),
        items: its.map((i) => ({
          key: i.LineKey, specMode: i.SpecMode, majorCategory: i.MajorCategory, subMajorCategory: i.SubMajorCategory, size: i.Size, sizeLabel: anySize(i.Size),
          materialClass: i.MaterialClass, classLabel: anyClass(i.MaterialClass), originCode: i.OriginCode, materialCode: i.MaterialCode,
          materialDescription: i.MaterialDescription ?? '', unit: i.Unit, share: formatShare(Number(i.ShareBp)),
          groupQty: formatQty(fromDb(i.ComputedQty)),
          perContainerQty: formatQty(fromDb(i.ComputedQty) / containers), // exact: the split is made per container in whole units
        })),
      };
    });
    const wh = weekHolds.find((h) => h.EtdWeek === w.EtdWeek);
    return {
      etdWeek: w.EtdWeek, containerCount: Number(w.ContainerCount), status: deriveStatus(status, wl), groups: gs, lines: ls,
      hold: wh ? { crId: String(wh.CrId), crNo: wh.CrNo } : null, mergedInto: merges.weekTo(w.EtdWeek),
    };
  });

  return {
    demandId: String(d.DemandId), demandNo: d.DemandNo, companyCode: d.CompanyCode, companyName: d.CompanyName, workflowStatus: status,
    status: deriveStatus(status, total), currentVersion: Number(d.CurrentVersion), baselineVersion: d.BaselineVersion, notes: d.Notes,
    createdBy: d.CreatedByName ?? '', createdAt: d.CreatedAt.toISOString(), submittedAt: d.SubmittedAt?.toISOString() ?? null,
    acceptedAt: d.AcceptedAt?.toISOString() ?? null, acceptedBy: d.AcceptedByName ?? null, mine: Number(d.CreatedBy) === actor.id,
    rowVer: d.RowVer, weeks: weekViews, actions: allowedActions(actor, { CompanyCode: d.CompanyCode, WorkflowStatus: status, CreatedBy: d.CreatedBy }),
    /** Spec 21: every business step (oldest first) and, for a merged demand, where it went. */
    steps: (await demandSteps(db, [String(d.DemandId)])).get(String(d.DemandId)) ?? [],
    mergedIntoDemand: (await mergedIntoOf(db, [String(d.DemandId)])).get(String(d.DemandId)) ?? null,
  };
}

export type ListFilter = {
  mine: boolean; q?: string; company?: string[]; status?: string[]; weekFrom?: string; weekTo?: string; page: number; pageSize: number;
};

export async function listDemands(db: Db, actor: Actor, f: ListFilter) {
  const companies = [...actor.companies];
  if (companies.length === 0) return { total: 0, rows: [] };
  // The status is only computed for the page — or, with a status filter, as a filter (database review 2026-09: joining it
  // before paging worked out the status of every demand of the company to show 50).
  let q = db.selectFrom('scm.Demand as d').where('d.CompanyCode', 'in', companies);
  if (f.mine) q = q.where('d.CreatedBy', '=', actor.id);
  if (f.company?.length) q = q.where('d.CompanyCode', 'in', f.company);
  if (f.status?.length) {
    const wanted = f.status;
    q = q.where((eb) => eb.exists(eb.selectFrom('scm.vDemandStatus as s').select('s.DemandId').whereRef('s.DemandId', '=', 'd.DemandId').where('s.Status', 'in', wanted)));
  }
  if (f.q) {
    const p = `%${f.q.replace(/[[%_]/g, '[$&]')}%`;
    q = q.where((eb) => eb.or([
      eb('d.DemandNo', 'like', p),
      eb.exists(eb.selectFrom('scm.DemandLine as l').select('l.LineId').whereRef('l.DemandId', '=', 'd.DemandId')
        .where((e) => e.or([e('l.MaterialCode', 'like', p), e('l.SubMajorCategory', 'like', p), e('l.MajorCategory', 'like', p)]))),
    ]));
  }
  if (f.weekFrom || f.weekTo) {
    q = q.where((eb) => eb.exists(eb.selectFrom('scm.DemandWeek as w').select('w.DemandWeekId').whereRef('w.DemandId', '=', 'd.DemandId')
      .where(sql<SqlBool>`w.EtdWeek >= ${f.weekFrom ?? '0000-W00'} AND w.EtdWeek <= ${f.weekTo ?? '9999-W99'}`)));
  }
  const [rows, count] = await Promise.all([
    q.leftJoin('app.User as u', 'u.UserId', 'd.CreatedBy')
      .select(['d.DemandId', 'd.DemandNo', 'd.CompanyCode', 'd.CreatedAt', 'd.SubmittedAt', 'd.AcceptedAt', 'd.CurrentVersion', 'u.DisplayName as CreatedByName'])
      .orderBy('d.DemandId', 'desc').offset((f.page - 1) * f.pageSize).fetch(f.pageSize).execute(),
    q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  const ids = rows.map((r) => String(r.DemandId));
  const statusOf = new Map((ids.length ? await db.selectFrom('scm.vDemandStatus').select(['DemandId', 'Status']).where('DemandId', 'in', ids).execute() : [])
    .map((x) => [String(x.DemandId), x.Status]));
  const [weeks, qty] = ids.length
    ? await Promise.all([
        db.selectFrom('scm.DemandWeek').select(['DemandId', 'EtdWeek', 'ContainerCount']).where('DemandId', 'in', ids).orderBy('EtdWeek').execute(),
        db.selectFrom('scm.vLineLedger').select(['DemandId', 'Unit'])
          .select((eb) => [eb.fn.sum<string>('RequestedQty').as('req'), eb.fn.sum<string>('OpenQty').as('open'), eb.fn.countAll<number>().as('lines')])
          .where('DemandId', 'in', ids).where('IsActive', '=', true).groupBy(['DemandId', 'Unit']).execute(),
      ])
    : [[], []];
  // Spec 21: the last business step, the progress (share of the quantity per stage) and, for a merged demand, where it went.
  const [steps, progressRows, mergedRows] = ids.length ? await Promise.all([
    demandSteps(db, ids),
    sql<{ DemandId: string; ExecState: string; Q: string }>`SELECT l.DemandId, s.ExecState, SUM(s.Qty) AS Q FROM scm.QtySlice s JOIN scm.DemandLine l ON l.LineId = s.LineId
      WHERE l.DemandId IN (${sql.join(ids)}) AND l.IsActive = 1 AND s.ExecState <> 'MERGED_OUT' GROUP BY l.DemandId, s.ExecState`.execute(db).then((r) => r.rows),
    mergedIntoOf(db, ids),
  ]) : [new Map(), [], new Map()] as const;
  const perUnit = (id: string, col: 'req' | 'open') =>
    qty.filter((x) => String(x.DemandId) === id && fromDb(x[col]) > 0)
      .map((x) => `${Number(formatQty(fromDb(x[col]))).toLocaleString('en-GB', { maximumFractionDigits: 3 })} ${x.Unit}`).join(' · ');
  return {
    total: Number(count.n),
    rows: rows.map((r) => {
      const id = String(r.DemandId);
      const ws = weeks.filter((w) => String(w.DemandId) === id);
      const status = statusOf.get(id) ?? 'DRAFT';
      return {
        demandId: id, demandNo: r.DemandNo, companyCode: r.CompanyCode, status, createdBy: r.CreatedByName ?? '', createdAt: r.CreatedAt.toISOString(),
        submittedAt: r.SubmittedAt?.toISOString() ?? null, acceptedAt: r.AcceptedAt?.toISOString() ?? null, currentVersion: Number(r.CurrentVersion),
        weeks: ws.map((w) => w.EtdWeek.slice(5)).join(', '), containers: ws.reduce((s, w) => s + Number(w.ContainerCount), 0),
        lines: qty.filter((x) => String(x.DemandId) === id).reduce((s, x) => s + Number(x.lines), 0),
        requested: perUnit(id, 'req'), open: status === 'DRAFT' || status === 'SUBMITTED' || status === 'RETURNED' ? '' : perUnit(id, 'open'),
        lastStep: steps.get(id)?.at(-1) ?? null,
        progress: progressOf(progressRows.filter((x) => String(x.DemandId) === id)),
        mergedInto: mergedRows.get(id) ?? null,
      };
    }),
  };
}

/** Domain events of the demand and the slice history of its lines, newest first. */
export async function demandHistory(db: Db, demandId: string) {
  const [events, slices] = await Promise.all([
    db.selectFrom('scm.DomainEvent as e').leftJoin('app.User as u', 'u.UserId', 'e.ActorUserId')
      .select(['e.EventId', 'e.EventType', 'e.PayloadJson', 'e.OccurredAt', 'u.DisplayName'])
      .where((eb) => eb.or([eb.and([eb('e.EntityType', '=', 'DEMAND'), eb('e.EntityId', '=', demandId)]), eb('e.DemandId', '=', demandId)]))
      .orderBy('e.EventId', 'desc').execute(),
    db.selectFrom('scm.SliceHistory as h')
      .innerJoin('scm.QtySlice as s', 's.SliceId', 'h.SliceId')
      .innerJoin('scm.DemandLine as l', 'l.LineId', 's.LineId')
      .innerJoin('scm.DemandWeek as w', 'w.DemandWeekId', 'l.DemandWeekId')
      .leftJoin('app.User as u', 'u.UserId', 'h.ActorUserId')
      .select(['h.HistoryId', 'h.Action', 'h.TriggerName', 'h.FromState', 'h.ToState', 'h.Qty', 'h.ChangedAt', 'h.Comment', 'l.Unit', 'l.LineNumber', 'w.EtdWeek', 'u.DisplayName'])
      .where('l.DemandId', '=', demandId).orderBy('h.HistoryId', 'desc').execute(),
  ]);
  const rows = [
    ...events.map((e) => ({ at: e.OccurredAt.toISOString(), by: e.DisplayName ?? 'System', kind: 'event' as const, text: e.EventType, payload: e.PayloadJson ? JSON.parse(e.PayloadJson) : null })),
    ...slices.map((h) => ({
      at: h.ChangedAt.toISOString(), by: h.DisplayName ?? 'System', kind: 'quantity' as const,
      text: `${h.EtdWeek} line ${h.LineNumber}: ${formatQty(fromDb(h.Qty))} ${h.Unit} ${h.Action === 'CREATE' ? `created ${h.ToState}` : h.Action === 'SPLIT' ? `split (${h.ToState})` : `${h.FromState} → ${h.ToState}`}${h.Comment ? ` — ${h.Comment}` : ''}`,
      payload: null,
    })),
  ];
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** Spec 21: the share of a demand's quantity per stage (for the progress bar), in percent. */
export function progressOf(rows: { ExecState: string; Q: string }[]) {
  const bucket: Record<string, string> = {
    OPEN: 'open', IN_RFQ: 'inRfq', QUOTED: 'inRfq', AWARDED: 'awarded', HANDED_OFF: 'awarded', PO_PREPARATION: 'awarded',
    PO_SUBMITTED: 'onPo', PO_CREATED: 'onPo', CANCELLED: 'cancelled',
  };
  const sum: Record<string, number> = { open: 0, inRfq: 0, awarded: 0, onPo: 0, cancelled: 0 };
  for (const r of rows) if (bucket[r.ExecState]) sum[bucket[r.ExecState]] += Number(r.Q);
  const total = Object.values(sum).reduce((a, b) => a + b, 0);
  if (!total) return null;
  return Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round((v / total) * 1000) / 10])) as Record<'open' | 'inRfq' | 'awarded' | 'onPo' | 'cancelled', number>;
}

/** The demand a whole demand was merged into (spec 17), per source demand. */
async function mergedIntoOf(db: Db, ids: string[]): Promise<Map<string, { demandId: string; demandNo: string }>> {
  const rows = await db.selectFrom('scm.MergeRecord as m').innerJoin('scm.Demand as t', 't.DemandId', 'm.TargetDemandId')
    .select(['m.SourceDemandId', 'm.TargetDemandId', 't.DemandNo']).where('m.SourceDemandId', 'in', ids).where('m.Status', '=', 'EXECUTED').where('m.Scope', '=', 'DEMAND').execute();
  return new Map(rows.map((r) => [String(r.SourceDemandId), { demandId: String(r.TargetDemandId), demandNo: r.DemandNo }]));
}
