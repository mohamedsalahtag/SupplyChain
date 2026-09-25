/**
 * Object-level access (plan v5 §0.5 and §2). A user may act on an object when
 * they hold the permission key and the object's company is one of theirs.
 * Administrators hold every permission and every active company.
 */
import type { AuthUser } from '../../auth/authUser.js';
import { ForbiddenError } from './errors.js';
import type { Db, Tx } from './tx.js';

export type Actor = Pick<AuthUser, 'id' | 'isAdmin' | 'permissions'> & { companies: ReadonlySet<string> };

export async function userCompanies(db: Db | Tx, userId: number): Promise<Set<string>> {
  const rows = await db
    .selectFrom('scm.UserCompany as uc')
    .innerJoin('scm.Company as c', 'c.CompanyCode', 'uc.CompanyCode')
    .select('uc.CompanyCode')
    .where('uc.UserId', '=', userId)
    .where('c.IsActive', '=', true)
    .execute();
  return new Set(rows.map((r) => r.CompanyCode));
}

export async function allCompanies(db: Db | Tx): Promise<Set<string>> {
  const rows = await db.selectFrom('scm.Company').select('CompanyCode').where('IsActive', '=', true).execute();
  return new Set(rows.map((r) => r.CompanyCode));
}

/** The signed-in user as a workflow actor. */
export async function loadActor(db: Db | Tx, user: Pick<AuthUser, 'id' | 'isAdmin' | 'permissions'>): Promise<Actor> {
  const companies = user.isAdmin ? await allCompanies(db) : await userCompanies(db, user.id);
  return { id: user.id, isAdmin: user.isAdmin, permissions: user.permissions, companies };
}

export const hasPermission = (a: Pick<Actor, 'isAdmin' | 'permissions'>, permission: string) => a.isAdmin || a.permissions.has(permission);

/** Throws FORBIDDEN unless the actor holds the permission for this company. */
export function assertCan(actor: Actor, permission: string, companyCode: string): void {
  if (!hasPermission(actor, permission) || !actor.companies.has(companyCode)) throw new ForbiddenError(permission);
}
