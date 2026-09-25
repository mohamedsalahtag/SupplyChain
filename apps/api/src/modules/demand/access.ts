/** Demand registrations: child ownership (plan v5 §0.5) and thread/attachment access (spec 12). Imported once by the router. */
import { hasPermission } from '../workflow/access.js';
import { parentBy, registerParent } from '../workflow/belongs.js';
import { registerEntityAccess } from '../workflow/entityAccess.js';
import { P_DEMAND } from './demandService.js';

registerParent('WEEK', parentBy('scm.DemandWeek', 'DemandWeekId', 'DemandId'));
registerParent('LINE', parentBy('scm.DemandLine', 'LineId', 'DemandId'));

registerEntityAccess('DEMAND', async (db, actor, entityId, write) => {
  if (!/^\d+$/.test(entityId)) return null;
  const d = await db.selectFrom('scm.Demand').select('CompanyCode').where('DemandId', '=', entityId).executeTakeFirst();
  if (!d || !actor.companies.has(d.CompanyCode)) return null;
  const ok = write ? hasPermission(actor, P_DEMAND.attach) : hasPermission(actor, P_DEMAND.open);
  return ok ? { companyCode: d.CompanyCode } : null;
});
