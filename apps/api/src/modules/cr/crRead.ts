/** Reading change requests (specs 14, 15): one CR with its items and allowed actions, the list, a demand's CRs. */
import { hasPermission, type Actor } from '../workflow/access.js';
import { NotFoundError } from '../workflow/errors.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { rowVerHex, type Db } from '../workflow/tx.js';
import { formatShare } from '../demand/compose.js';
import { decidePermission, P_CR } from './crService.js';
import type { Effect, GroupState } from './diff.js';
import { QTY_PARTIAL_KINDS } from './procApply.js';

const groupText = (g: GroupState | null) =>
  g ? `${g.name ? `${g.name}: ` : ''}${g.containerCount} × ${Number(formatQty(g.capacity)).toLocaleString('en-US')} ${g.unit} (${g.items.map((i) => `${i.subMajorCategory.replace(/^\S+ /, '')} ${i.size || 'any'} ${i.materialClass || 'any'} ${formatShare(i.shareBp)}%`).join(', ')})` : '—';

const effectText = (e: Effect) => `${e.subMajorCategory} ${e.size || 'any size'} ${e.materialClass || 'any class'} ${e.originCode}${e.materialCode ? ` ${e.materialCode}` : ''} ${e.delta > 0 ? '+' : '−'}${Number(formatQty(Math.abs(e.delta))).toLocaleString('en-GB')} ${e.unit}`;

function describe(kind: string, before: unknown, after: unknown, effect: Effect[], lineLabel: string | null) {
  const b = before as GroupState | null;
  const a = after as GroupState | null;
  switch (kind) {
    case 'GROUP_COUNT': return `${b?.name || 'Group'}: ${b?.containerCount} → ${a?.containerCount} containers × ${Number(formatQty(b!.capacity)).toLocaleString('en-US')} ${b?.unit}`;
    case 'GROUP_ADD': return `New group ${groupText(a)}`;
    case 'GROUP_REMOVE': return `Remove ${groupText(b)}`;
    case 'GROUP_COMPOSITION': return `Change ${groupText(b)} → ${groupText(a)}`;
    case 'QTY_NOT_SOURCED': return `Not sourced: ${lineLabel ?? ''} ${Number(formatQty(-(effect[0]?.delta ?? 0))).toLocaleString('en-GB')} ${effect[0]?.unit ?? ''}`;
    case 'WEEK_CONTAINERS': return `Week containers ${(before as { containerCount: number }).containerCount} → ${(after as { containerCount: number }).containerCount}`;
    // Procurement requests (spec 19)
    case 'ADD_QTY': return `Add ${effectText(effect[0])} to the demand (Procurement quantity, in the RFQ)`;
    case 'ADD_CONTAINERS': return `${(after as { containerCount: number }).containerCount - (before as { containerCount: number }).containerCount} extra container(s): week ${(before as { containerCount: number }).containerCount} → ${(after as { containerCount: number }).containerCount}`;
    case 'WEEK_SHIFT': { const a = after as { fromWeek: string; toWeek: string }; return `Move ${lineLabel ?? ''} from ${a.fromWeek} to ${a.toWeek}`; }
    case 'MIX_REDUCE': return `Less: ${effectText(effect[0])} (cancelled, origin Change)`;
    case 'MIX_ADD': return `More: ${effectText(effect[0])} (Open on the demand, origin Change)`;
    default: return kind;
  }
}

export async function getCr(db: Db, actor: Actor, crId: string) {
  const cr = await db.selectFrom('scm.ChangeRequest as c')
    .innerJoin('scm.Demand as d', 'd.DemandId', 'c.DemandId')
    .leftJoin('app.User as r', 'r.UserId', 'c.RaisedBy')
    .leftJoin('app.User as x', 'x.UserId', 'c.DecidedBy')
    .leftJoin('scm.ReasonCode as rc', 'rc.ReasonCode', 'c.ReasonCode')
    .leftJoin('scm.Rfq as q', 'q.RfqId', 'c.RfqId')
    .select(['c.RfqId', 'q.RfqNo', 'c.CrId', 'c.CrNo', 'c.DemandId', 'd.DemandNo', 'c.CompanyCode', 'c.CrType', 'c.RaisedByDept', 'c.Status', 'c.ApplyStatus', 'c.ReasonCode', 'rc.Description as ReasonText',
      'c.Comment', 'c.BlockedReason', 'c.RaisedBy', 'r.DisplayName as RaisedByName', 'c.SubmittedAt', 'x.DisplayName as DecidedByName', 'c.DecidedAt', 'c.DecisionComment', 'c.AppliedAt',
      rowVerHex('c.RowVer').as('RowVer')])
    .where('c.CrId', '=', crId).executeTakeFirst();
  if (!cr || !actor.companies.has(cr.CompanyCode) || !hasPermission(actor, P_CR.open)) throw new NotFoundError(`Change request ${crId}`);

  const items = await db.selectFrom('scm.ChangeRequestItem as i')
    .leftJoin('scm.DemandLine as l', 'l.LineId', 'i.LineId')
    .select(['i.CrItemId', 'i.ItemNo', 'i.ItemKind', 'i.EtdWeek', 'i.BeforeJson', 'i.AfterJson', 'i.EffectJson', 'i.RequestedCount', 'i.RequestedQty', 'i.Decision', 'i.ApprovedCount', 'i.ApprovedQty', 'i.AppliedQty', 'i.ApplyMessage',
      'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.OriginCode'])
    .where('i.CrId', '=', crId).orderBy('i.ItemNo').execute();

  const mine = Number(cr.RaisedBy) === actor.id;
  const open = cr.Status === 'SUBMITTED';
  return {
    crId: String(cr.CrId), crNo: cr.CrNo, demandId: String(cr.DemandId), demandNo: cr.DemandNo, companyCode: cr.CompanyCode, crType: cr.CrType, raisedByDept: cr.RaisedByDept,
    status: cr.Status, applyStatus: cr.ApplyStatus, reasonCode: cr.ReasonCode, reasonText: cr.ReasonText ?? '', comment: cr.Comment,
    problems: cr.BlockedReason ? (JSON.parse(cr.BlockedReason) as string[]) : [],
    raisedBy: cr.RaisedByName ?? '', raisedAt: cr.SubmittedAt.toISOString(), decidedBy: cr.DecidedByName ?? null, decidedAt: cr.DecidedAt?.toISOString() ?? null,
    decisionComment: cr.DecisionComment, appliedAt: cr.AppliedAt?.toISOString() ?? null, rowVer: cr.RowVer, mine,
    rfq: cr.RfqId ? { rfqId: String(cr.RfqId), rfqNo: cr.RfqNo ?? '' } : null,
    items: items.map((i) => {
      const before = i.BeforeJson ? JSON.parse(i.BeforeJson) : null;
      const after = i.AfterJson ? JSON.parse(i.AfterJson) : null;
      const effect = JSON.parse(i.EffectJson) as Effect[];
      const lineLabel = i.SubMajorCategory ? `${i.SubMajorCategory} ${i.Size || 'any size'} ${i.MaterialClass || 'any class'} ${i.OriginCode}` : null;
      const beforeCount = (before as GroupState | null)?.containerCount ?? 0;
      return {
        crItemId: String(i.CrItemId), itemNo: Number(i.ItemNo), kind: i.ItemKind, etdWeek: i.EtdWeek,
        what: describe(i.ItemKind, before, after, effect, lineLabel),
        effect: i.ItemKind === 'QTY_NOT_SOURCED' ? [] : i.ItemKind === 'WEEK_SHIFT' ? [`${Number(formatQty(fromDb(i.RequestedQty))).toLocaleString('en-GB')} approved for ${(after as { toWeek: string }).toWeek}`] : effect.map(effectText),
        /** What the decider may choose for this item. */
        partial: i.ItemKind === 'QTY_NOT_SOURCED' || QTY_PARTIAL_KINDS.includes(i.ItemKind)
          ? { type: 'qty' as const, max: formatQty(fromDb(i.RequestedQty)) }
          : i.ItemKind === 'ADD_CONTAINERS'
            ? ((i.RequestedCount ?? 0) > 1 ? { type: 'count' as const, min: 1, max: (i.RequestedCount ?? 0) - 1 } : null)
          : i.ItemKind === 'GROUP_ADD' || (i.ItemKind === 'GROUP_COUNT' && (i.RequestedCount ?? 0) > beforeCount)
            ? { type: 'count' as const, min: beforeCount + 1, max: (i.RequestedCount ?? 0) - 1 }
            : null,
        decision: i.Decision, approvedCount: i.ApprovedCount, approvedQty: i.ApprovedQty == null ? null : formatQty(fromDb(i.ApprovedQty)),
        appliedQty: i.AppliedQty == null ? null : formatQty(fromDb(i.AppliedQty)), applyMessage: i.ApplyMessage,
      };
    }),
    actions: {
      decide: open && !mine && hasPermission(actor, decidePermission(cr.RaisedByDept)),
      withdraw: open && mine && hasPermission(actor, P_CR.withdraw),
    },
  };
}

export type CrListFilter = { mine: boolean; q?: string; type?: string[]; status?: string[]; company?: string[]; demandId?: string; page: number; pageSize: number };

export async function listCrs(db: Db, actor: Actor, f: CrListFilter) {
  const companies = [...actor.companies];
  if (!companies.length) return { total: 0, rows: [] };
  let q = db.selectFrom('scm.ChangeRequest as c').innerJoin('scm.Demand as d', 'd.DemandId', 'c.DemandId').where('c.CompanyCode', 'in', companies);
  if (f.mine) q = q.where('c.RaisedBy', '=', actor.id);
  if (f.demandId) q = q.where('c.DemandId', '=', f.demandId);
  if (f.type?.length) q = q.where('c.CrType', 'in', f.type as never[]);
  if (f.status?.length) q = q.where('c.Status', 'in', f.status as never[]);
  if (f.company?.length) q = q.where('c.CompanyCode', 'in', f.company);
  if (f.q) {
    const p = `%${f.q.replace(/[[%_]/g, '[$&]')}%`;
    q = q.where((eb) => eb.or([eb('c.CrNo', 'like', p), eb('d.DemandNo', 'like', p)]));
  }
  const [rows, count] = await Promise.all([
    q.leftJoin('app.User as r', 'r.UserId', 'c.RaisedBy').leftJoin('app.User as x', 'x.UserId', 'c.DecidedBy')
      .select(['c.CrId', 'c.CrNo', 'c.DemandId', 'd.DemandNo', 'c.CompanyCode', 'c.CrType', 'c.Status', 'c.ApplyStatus', 'c.ReasonCode', 'c.Comment', 'c.SubmittedAt', 'c.DecidedAt',
        'r.DisplayName as RaisedByName', 'x.DisplayName as DecidedByName'])
      .orderBy('c.CrId', 'desc').offset((f.page - 1) * f.pageSize).fetch(f.pageSize).execute(),
    q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  return {
    total: Number(count.n),
    rows: rows.map((r) => ({
      crId: String(r.CrId), crNo: r.CrNo, demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode, crType: r.CrType, status: r.Status,
      applyStatus: r.ApplyStatus, reasonCode: r.ReasonCode, comment: r.Comment, raisedBy: r.RaisedByName ?? '', raisedAt: r.SubmittedAt.toISOString(),
      decidedBy: r.DecidedByName ?? null, decidedAt: r.DecidedAt?.toISOString() ?? null,
      responseHours: r.DecidedAt ? Math.round((r.DecidedAt.getTime() - r.SubmittedAt.getTime()) / 3_600_000) : null,
    })),
  };
}

export async function reasonOptions(db: Db, context: 'CR_SALES' | 'CR_PROC') {
  return db.selectFrom('scm.ReasonCode').select(['ReasonCode', 'Description']).where('Context', '=', context).where('IsActive', '=', true).orderBy('ReasonCode').execute();
}

export async function crHistory(db: Db, crId: string) {
  const rows = await db.selectFrom('scm.DomainEvent as e').leftJoin('app.User as u', 'u.UserId', 'e.ActorUserId')
    .select(['e.EventType', 'e.PayloadJson', 'e.OccurredAt', 'u.DisplayName']).where('e.EntityType', '=', 'CR').where('e.EntityId', '=', crId).orderBy('e.EventId', 'desc').execute();
  return rows.map((r) => ({ at: r.OccurredAt.toISOString(), by: r.DisplayName ?? 'System', event: r.EventType, payload: r.PayloadJson ? JSON.parse(r.PayloadJson) : null }));
}
