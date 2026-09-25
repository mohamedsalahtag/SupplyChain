/**
 * Invite more suppliers to an RFQ that already exists (spec 18 addition, 2026-09-25): from the RFQ's own shortlist, or
 * any usable supplier in SAP outside it (a first contact; its origins are recorded, as at create). Allowed while the RFQ
 * is not cancelled and still has quantity to quote. On a sent RFQ, "Record quotes" comes back on My work for the newcomer.
 */
import { sql } from 'kysely';
import { hasPermission, type Actor } from '../workflow/access.js';
import { runCommand } from '../workflow/command.js';
import { DomainError, NotFoundError } from '../workflow/errors.js';
import { recordEvent } from '../workflow/events.js';
import { openInbox } from '../workflow/inbox.js';
import { assertVendorUsable } from '../workflow/masterData.js';
import { addThreadEntry } from '../workflow/threads.js';
import { updateWithRowVer, type Db, type Tx } from '../workflow/tx.js';
import { recordRfqOrigins } from './outsideSuppliers.js';
import { lockRfq, P_RFQ, rfqLive } from './rfqService.js';
import { supplierShortlist, type OriginShortlist, type ShortLine } from './shortlist.js';

/** The RFQ's live lines as shortlist lines (Procurement-added lines included). */
async function rfqShortLines(db: Db | Tx, rfqId: string): Promise<ShortLine[]> {
  const lines = await db.selectFrom('scm.RfqLine').select(['RfqLineId', 'MajorCategory', 'SubMajorCategory', 'Size', 'OriginCode', 'MaterialCode', 'Unit'])
    .where('RfqId', '=', rfqId).where('IsCancelled', '=', false).execute();
  return lines.map((l) => ({ lineId: String(l.RfqLineId), majorCategory: l.MajorCategory, subMajorCategory: l.SubMajorCategory, size: l.Size, originCode: l.OriginCode, materialCode: l.MaterialCode, unit: l.Unit }));
}

/** The shortlist of an existing RFQ, per origin, with who is invited already. */
export async function inviteOptions(db: Db, actor: Actor, rfqId: string): Promise<{ groups: (OriginShortlist & { invited: string[] })[]; origins: string[] }> {
  const r = await db.selectFrom('scm.Rfq').select(['CompanyCode']).where('RfqId', '=', rfqId).executeTakeFirst();
  if (!r || !actor.companies.has(r.CompanyCode) || !hasPermission(actor, P_RFQ.manage)) throw new NotFoundError(`RFQ ${rfqId}`);
  const lines = await rfqShortLines(db, rfqId);
  const invited = (await db.selectFrom('scm.RfqSupplier').select('SupplierCode').where('RfqId', '=', rfqId).execute()).map((s) => s.SupplierCode);
  const groups = await supplierShortlist(db, r.CompanyCode, lines);
  return { groups: groups.map((g) => ({ ...g, invited: g.entries.filter((e) => invited.includes(e.supplierCode)).map((e) => e.supplierCode) })), origins: [...new Set(lines.map((l) => l.originCode))].sort() };
}

export async function inviteSuppliers(db: Db, actor: Actor, commandId: string, rfqId: string, rowVer: string, input: { suppliers: string[]; extraSuppliers: string[] }) {
  return runCommand(db, actor.id, commandId, 'rfq.invite', async (tx) => {
    const r = await lockRfq(tx, actor, rfqId);
    if (r.ManualStatus === 'CANCELLED') throw new DomainError('BAD_STATE', `${r.RfqNo} is cancelled`, 409);
    const live = await rfqLive(tx, rfqId);
    if (live.inRfq + live.quoted === 0) throw new DomainError('NOTHING_TO_QUOTE', `${r.RfqNo} has nothing left to quote`, 409);
    const already = new Set((await tx.selectFrom('scm.RfqSupplier').select('SupplierCode').where('RfqId', '=', rfqId).execute()).map((s) => s.SupplierCode));
    const listed = [...new Set(input.suppliers)].filter((s) => !already.has(s));
    const extras = [...new Set(input.extraSuppliers)].filter((s) => !already.has(s) && !listed.includes(s));
    if (!listed.length && !extras.length) throw new DomainError('NO_SUPPLIER', 'Choose at least one supplier who is not invited yet');
    await updateWithRowVer(tx, 'scm.Rfq', 'RfqId', rfqId, rowVer, sql`RfqNo = RfqNo`); // someone else changed the RFQ meanwhile → reload

    const lines = await rfqShortLines(tx, rfqId);
    const shortlist = await supplierShortlist(tx, r.CompanyCode, lines);
    for (const s of listed) {
      await assertVendorUsable(tx, s, r.CompanyCode);
      const seen = shortlist.flatMap((g) => g.entries.filter((e) => e.supplierCode === s).map((e) => ({ origin: g.originCode, rank: e.rank, hint: e.hint, origins: e.origins })));
      if (!seen.length) throw new DomainError('SUPPLIER_ORIGIN_MISMATCH', `Supplier ${s} cannot supply ${shortlist.map((g) => g.originCode).join(', ')} — add it as a supplier not on the list`);
      const ranks = seen.map((x) => x.rank).filter((x): x is number => x != null);
      await tx.insertInto('scm.RfqSupplier').values({
        RfqId: rfqId, SupplierCode: s, OriginsAtInvite: seen[0].origins.join(','), ShortlistRank: ranks.length ? Math.min(...ranks) : null,
        HintJson: JSON.stringify(Object.fromEntries(seen.map((x) => [x.origin, x.hint]))), InvitedBy: actor.id,
      }).execute();
    }
    const needed = [...new Set(lines.map((l) => l.originCode))].sort();
    const added: Record<string, string[]> = {};
    for (const s of extras) {
      await assertVendorUsable(tx, s, r.CompanyCode);
      const o = await recordRfqOrigins(tx, actor, r.CompanyCode, s, needed);
      added[s] = o.added;
      await tx.insertInto('scm.RfqSupplier').values({ RfqId: rfqId, SupplierCode: s, OriginsAtInvite: o.origins.join(','), ShortlistRank: null, HintJson: null, InvitedBy: actor.id, OutsideShortlist: true }).execute();
    }

    const all = [...listed, ...extras];
    const eventId = await recordEvent(tx, { type: 'RFQ_SUPPLIERS_INVITED', entityType: 'RFQ', entityId: rfqId, demandId: r.DemandId, payload: { rfqNo: r.RfqNo, suppliers: all, outsideShortlist: added }, actorUserId: actor.id });
    const names = await tx.selectFrom('md.Supplier').select(['SupplierCode', 'Name']).where('SupplierCode', 'in', all).execute();
    const label = (s: string) => `${s} ${names.find((n) => n.SupplierCode === s)?.Name ?? ''}`.trim();
    await addThreadEntry(tx, { entityType: 'RFQ', entityId: rfqId, kind: 'SYSTEM', authorUserId: actor.id, eventId,
      body: `Invited after creation: ${all.map((s) => `${label(s)}${added[s] ? ` (first contact${added[s].length ? `; now recorded as supplying ${added[s].join(', ')}` : ''})` : ''}`).join('; ')}${r.ManualStatus === 'SENT' ? ' — send them the supplier view' : ''}` });
    if (r.ManualStatus === 'SENT') { // the newcomers' quotes are to be recorded: the task comes back
      const d = await tx.selectFrom('scm.Demand').select('DemandNo').where('DemandId', '=', r.DemandId).executeTakeFirstOrThrow();
      const n = already.size + all.length;
      await openInbox(tx, {
        itemType: 'RFQ_TO_QUOTE', permission: P_RFQ.manage, companyCode: r.CompanyCode, entityType: 'RFQ', entityId: rfqId,
        number: r.RfqNo, title: `${d.DemandNo} · ${n} supplier(s)`, link: `/rfqs/${rfqId}`, raisedBy: actor.id,
      });
    }
    return { invited: all.length };
  });
}
