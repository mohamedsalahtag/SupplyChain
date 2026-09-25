/** Reading awards (spec 20): one award batch, the Awards list. (The award grid is containerGrid.ts.) */
import { sql } from 'kysely';
import { hasPermission, type Actor } from '../workflow/access.js';
import { NotFoundError } from '../workflow/errors.js';
import { formatQty, fromDb } from '../workflow/qty.js';
import { rowVerHex, type Db } from '../workflow/tx.js';
import { P_ACK } from './ack.js';
import { lineLabel } from './awardCheck.js';
import { P_AWARD } from './awardService.js';

export async function getBatch(db: Db, actor: Actor, batchId: string) {
  const b = await db.selectFrom('scm.AwardBatch as b').innerJoin('scm.Rfq as r', 'r.RfqId', 'b.RfqId').innerJoin('scm.Demand as d', 'd.DemandId', 'b.DemandId')
    .leftJoin('app.User as u', 'u.UserId', 'b.CreatedBy')
    .select(['b.AwardBatchId', 'b.AbNo', 'b.RfqId', 'r.RfqNo', 'b.DemandId', 'd.DemandNo', 'b.CompanyCode', 'b.Comment', 'b.CreatedAt', 'u.DisplayName as CreatedByName'])
    .where('b.AwardBatchId', '=', batchId).executeTakeFirst();
  if (!b || !actor.companies.has(b.CompanyCode) || !hasPermission(actor, P_AWARD.open)) throw new NotFoundError(`Award ${batchId}`);
  const [items, shipments, ack, history, changes, allocs, containers, containerChanges] = await Promise.all([
    db.selectFrom('scm.AwardItem as i').innerJoin('scm.RfqLine as l', 'l.RfqLineId', 'i.RfqLineId').innerJoin('md.Supplier as s', 's.SupplierCode', 'i.SupplierCode')
      .select(['i.AwardItemId', 'i.SupplierCode', 's.Name', 'i.EtdWeek', 'l.SubMajorCategory', 'l.Size', 'l.MaterialClass', 'l.MaterialCode', 'l.OriginCode', 'l.Origin', 'i.Qty', 'i.Unit',
        'i.UnitPrice', 'i.Currency', 'i.OverrideReason', 'i.SkuStatus', 'i.IsActive', 'i.ByContainers', 'l.MajorCategory', rowVerHex('i.RowVer').as('RowVer')])
      .where('i.AwardBatchId', '=', batchId).orderBy('i.EtdWeek').orderBy('s.Name').execute(),
    db.selectFrom('scm.AwardShipment as h').innerJoin('md.Supplier as s', 's.SupplierCode', 'h.SupplierCode')
      .select(['h.ShipmentId', 'h.SupplierCode', 's.Name', 'h.EtdWeek', 'h.ContainerCount', 'h.ConfirmedEtd', 'h.IsActive', rowVerHex('h.RowVer').as('RowVer')])
      .where('h.AwardBatchId', '=', batchId).orderBy('h.EtdWeek').execute(),
    db.selectFrom('scm.SalesAck as a').leftJoin('app.User as u', 'u.UserId', 'a.RespondedBy')
      .select(['a.AckId', 'a.Status', 'a.Revision', 'a.RespondedAt', 'a.Comment', 'a.HandedOffWithoutAck', 'u.DisplayName as RespondedByName', rowVerHex('a.RowVer').as('RowVer')])
      .where('a.AwardBatchId', '=', batchId).executeTakeFirst(),
    db.selectFrom('scm.SalesAckHistory as h').innerJoin('scm.SalesAck as a', 'a.AckId', 'h.AckId').leftJoin('app.User as u', 'u.UserId', 'h.ActorUserId')
      .select(['h.Revision', 'h.FromStatus', 'h.ToStatus', 'h.Cause', 'h.Comment', 'h.ChangedAt', 'h.AwardSnapshotJson', 'u.DisplayName'])
      .where('a.AwardBatchId', '=', batchId).orderBy('h.AckHistoryId', 'desc').execute(),
    db.selectFrom('scm.AwardItemChange as c').innerJoin('scm.AwardItem as i', 'i.AwardItemId', 'c.AwardItemId').leftJoin('app.User as u', 'u.UserId', 'c.ActorUserId')
      .leftJoin('scm.ChangeRequest as cr', 'cr.CrId', 'c.CrId')
      .select(['c.AwardItemId', 'c.ChangeType', 'c.Qty', 'c.ReasonCode', 'c.DetailJson', 'cr.CrNo', 'c.ChangedAt', 'u.DisplayName', 'i.SupplierCode', 'i.Unit'])
      .where('i.AwardBatchId', '=', batchId).orderBy('c.ChangeId', 'desc').execute(),
    db.selectFrom('scm.AwardItemSku as k').innerJoin('scm.AwardItem as i', 'i.AwardItemId', 'k.AwardItemId').select(['k.AwardItemId', 'k.MaterialCode', 'k.SetStage'])
      .where('i.AwardBatchId', '=', batchId).where('k.IsActive', '=', true).execute(),
    db.selectFrom('scm.AwardContainer as c').innerJoin('scm.ContainerGroup as g', 'g.ContainerGroupId', 'c.ContainerGroupId').innerJoin('md.Supplier as s', 's.SupplierCode', 'c.SupplierCode')
      .select(['c.AwardContainerId', 'c.ContainerGroupId', 'c.SupplierCode', 's.Name', 'c.EtdWeek', 'c.Containers', 'c.IsActive', 'g.Name as GroupName', 'g.CapacityQty', 'g.Unit', rowVerHex('c.RowVer').as('RowVer')])
      .where('c.AwardBatchId', '=', batchId).orderBy('c.EtdWeek').orderBy('g.GroupNumber').orderBy('s.Name').execute(),
    db.selectFrom('scm.AwardContainerChange as c').leftJoin('scm.ContainerGroup as g', 'g.ContainerGroupId', 'c.ContainerGroupId').leftJoin('app.User as u', 'u.UserId', 'c.ActorUserId')
      .select(['c.ChangeId', 'c.ChangeType', 'c.SupplierCode', 'c.EtdWeek', 'c.Containers', 'c.Offered', 'c.Note', 'c.ReasonCode', 'c.ChangedAt', 'g.Name as GroupName', 'u.DisplayName'])
      .where('c.AwardBatchId', '=', batchId).orderBy('c.ChangeId', 'desc').execute(),
  ]);
  const groupIds = [...new Set(containers.map((c) => String(c.ContainerGroupId)))];
  const mixRows = groupIds.length ? await db.selectFrom('scm.ContainerGroupItem as i').innerJoin('scm.ContainerGroup as g', 'g.ContainerGroupId', 'i.ContainerGroupId')
    .select(['i.ContainerGroupId', 'i.SubMajorCategory', 'i.Size', 'i.MaterialClass', 'i.MaterialCode', 'i.ComputedQty', 'g.ContainerCount'])
    .where('i.ContainerGroupId', 'in', groupIds).orderBy('i.ContainerGroupItemId').execute() : [];
  const mixOf = (groupId: string) => mixRows.filter((m) => String(m.ContainerGroupId) === groupId)
    .map((m) => `${lineLabel(m)} ${formatQty(fromDb(m.ComputedQty) / m.ContainerCount).replace(/\.000$/, '')}`).join(' · ');
  const later = await db.selectFrom('scm.QtySlice as s').innerJoin('scm.AwardItem as i', 'i.AwardItemId', 's.AwardItemId').select('s.AwardItemId')
    .where('i.AwardBatchId', '=', batchId).where('s.ExecState', 'not in', ['AWARDED', 'CANCELLED']).distinct().execute();
  const handedOff = new Set(later.map((x) => String(x.AwardItemId)));
  const manage = hasPermission(actor, P_AWARD.manage);
  const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  return {
    awardBatchId: String(b.AwardBatchId), abNo: b.AbNo, rfqId: String(b.RfqId), rfqNo: b.RfqNo, demandId: String(b.DemandId), demandNo: b.DemandNo, companyCode: b.CompanyCode,
    comment: b.Comment, createdBy: b.CreatedByName ?? '', createdAt: b.CreatedAt.toISOString(),
    items: items.map((i) => {
      const id = String(i.AwardItemId);
      const sku = allocs.filter((k) => String(k.AwardItemId) === id);
      return {
        awardItemId: id, supplierCode: i.SupplierCode, supplierName: i.Name, week: i.EtdWeek, label: lineLabel(i), originCode: i.OriginCode, procurementAdded: i.Origin === 'PROCUREMENT',
        qty: formatQty(fromDb(i.Qty)), unit: i.Unit, unitPrice: Number(i.UnitPrice).toFixed(2), currency: i.Currency, overrideReason: i.OverrideReason,
        skuStatus: i.SkuStatus, skus: sku.map((k) => k.MaterialCode), isActive: i.IsActive, rowVer: i.RowVer, byContainers: i.ByContainers,
        spec: { majorCategory: i.MajorCategory, subMajorCategory: i.SubMajorCategory, size: i.Size, materialClass: i.MaterialClass, originCode: i.OriginCode, unit: i.Unit },
        canChange: manage && i.IsActive && !handedOff.has(id),
      };
    }),
    /** Spec 20 revision 1: containers per group and supplier (un-award works on these), and the container log. */
    containers: containers.map((c) => ({
      awardContainerId: String(c.AwardContainerId), groupName: c.GroupName || 'Container group', mix: mixOf(String(c.ContainerGroupId)), unit: c.Unit,
      capacity: formatQty(fromDb(c.CapacityQty)).replace(/\.000$/, ''), supplierCode: c.SupplierCode, supplierName: c.Name, week: c.EtdWeek, containers: c.Containers,
      isActive: c.IsActive, rowVer: c.RowVer, canChange: manage && c.IsActive,
    })),
    containerChanges: containerChanges.map((c) => ({
      changeId: String(c.ChangeId), type: c.ChangeType, supplierCode: c.SupplierCode, week: c.EtdWeek, containers: c.Containers, offered: c.Offered, note: c.Note,
      reason: c.ReasonCode, groupName: c.GroupName, at: c.ChangedAt.toISOString(), by: c.DisplayName ?? '',
    })),
    shipments: shipments.map((s) => ({
      shipmentId: String(s.ShipmentId), supplierCode: s.SupplierCode, supplierName: s.Name, week: s.EtdWeek, containers: s.ContainerCount, confirmedEtd: day(s.ConfirmedEtd),
      isActive: s.IsActive, rowVer: s.RowVer, canEdit: manage && s.IsActive,
    })),
    ack: ack ? {
      ackId: String(ack.AckId), status: ack.Status, revision: Number(ack.Revision), respondedBy: ack.RespondedByName ?? null, respondedAt: ack.RespondedAt?.toISOString() ?? null,
      comment: ack.Comment, rowVer: ack.RowVer, handedOffWithoutAck: ack.HandedOffWithoutAck,
      canRespond: hasPermission(actor, P_ACK) && ['PENDING', 'QUERY_RAISED'].includes(ack.Status),
      canAnswer: manage && ack.Status === 'QUERY_RAISED',
    } : null,
    ackHistory: history.map((h) => ({ revision: h.Revision, from: h.FromStatus, to: h.ToStatus, cause: h.Cause, comment: h.Comment, at: h.ChangedAt.toISOString(), by: h.DisplayName ?? 'System', snapshot: !!h.AwardSnapshotJson })),
    changes: changes.map((c) => ({
      awardItemId: String(c.AwardItemId), type: c.ChangeType, qty: c.Qty == null ? null : `${formatQty(fromDb(c.Qty))} ${c.Unit}`, reason: c.ReasonCode, crNo: c.CrNo,
      detail: c.DetailJson ? JSON.parse(c.DetailJson) : null, at: c.ChangedAt.toISOString(), by: c.DisplayName ?? '', supplierCode: c.SupplierCode,
    })),
    actions: { manage },
  };
}

export async function listBatches(db: Db, actor: Actor, f: { q?: string; rfqId?: string; demandId?: string; ack?: string[]; page: number; pageSize: number }) {
  const companies = [...actor.companies];
  if (!companies.length) return { rows: [], total: 0 };
  let q = db.selectFrom('scm.AwardBatch as b').innerJoin('scm.Rfq as r', 'r.RfqId', 'b.RfqId').innerJoin('scm.Demand as d', 'd.DemandId', 'b.DemandId')
    .leftJoin('scm.SalesAck as a', 'a.AwardBatchId', 'b.AwardBatchId').leftJoin('app.User as u', 'u.UserId', 'b.CreatedBy').where('b.CompanyCode', 'in', companies);
  if (f.rfqId) q = q.where('b.RfqId', '=', f.rfqId);
  if (f.demandId) q = q.where('b.DemandId', '=', f.demandId);
  if (f.ack?.length) q = q.where('a.Status', 'in', f.ack as never[]);
  if (f.q) { const p = `%${f.q.replace(/[[%_]/g, '[$&]')}%`; q = q.where((eb) => eb.or([eb('b.AbNo', 'like', p), eb('r.RfqNo', 'like', p), eb('d.DemandNo', 'like', p)])); }
  const [rows, count] = await Promise.all([
    q.select(['b.AwardBatchId', 'b.AbNo', 'r.RfqNo', 'b.RfqId', 'd.DemandNo', 'b.DemandId', 'b.CompanyCode', 'b.CreatedAt', 'u.DisplayName as CreatedByName', 'a.Status as AckStatus', 'a.Revision'])
      .select(sql<number>`(SELECT COUNT(DISTINCT i.SupplierCode) FROM scm.AwardItem i WHERE i.AwardBatchId = b.AwardBatchId AND i.IsActive = 1)`.as('Suppliers'))
      .orderBy('b.AwardBatchId', 'desc').offset((f.page - 1) * f.pageSize).fetch(f.pageSize).execute(),
    q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  const ids = rows.map((r) => String(r.AwardBatchId));
  const qty = ids.length ? await db.selectFrom('scm.AwardItem').select(['AwardBatchId', 'Unit']).select((eb) => eb.fn.sum<string>('Qty').as('Q'))
    .where('AwardBatchId', 'in', ids).where('IsActive', '=', true).groupBy(['AwardBatchId', 'Unit']).execute() : [];
  return {
    total: Number(count.n),
    rows: rows.map((r) => ({
      awardBatchId: String(r.AwardBatchId), abNo: r.AbNo, rfqId: String(r.RfqId), rfqNo: r.RfqNo, demandId: String(r.DemandId), demandNo: r.DemandNo, companyCode: r.CompanyCode,
      createdBy: r.CreatedByName ?? '', createdAt: r.CreatedAt.toISOString(), ackStatus: r.AckStatus ?? 'PENDING', revision: Number(r.Revision ?? 1), suppliers: Number(r.Suppliers ?? 0),
      quantity: qty.filter((x) => String(x.AwardBatchId) === String(r.AwardBatchId)).map((x) => `${Number(formatQty(fromDb(x.Q))).toLocaleString('en-GB')} ${x.Unit}`).join(' · '),
    })),
  };
}
