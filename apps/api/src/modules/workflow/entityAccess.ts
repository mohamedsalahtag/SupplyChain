/**
 * Who may read or write the threads and attachments of a business object.
 * Each object kind registers its rule (Stage 1: DEMAND). Access follows the
 * parent object's company scope; unknown or hidden objects answer "not found".
 */
import type { Actor } from './access.js';
import { NotFoundError } from './errors.js';
import type { Db } from './tx.js';

type Rule = (db: Db, actor: Actor, entityId: string, write: boolean) => Promise<{ companyCode: string } | null>;
const RULES = new Map<string, Rule>();

export function registerEntityAccess(entityType: string, rule: Rule): void {
  RULES.set(entityType, rule);
}

/** The object's company when the actor may read (or write) it; otherwise NOT_FOUND. */
export async function assertEntityAccess(db: Db, actor: Actor, entityType: string, entityId: string, write: boolean): Promise<{ companyCode: string }> {
  const rule = RULES.get(entityType);
  const ok = rule ? await rule(db, actor, entityId, write) : null;
  if (!ok) throw new NotFoundError(`${entityType} ${entityId}`);
  return ok;
}
