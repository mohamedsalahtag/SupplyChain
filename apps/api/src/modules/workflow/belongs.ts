/**
 * Ownership checks (plan v5 §0.5): every child id in a request must belong to
 * the parent object the action was authorized for. Each stage registers its
 * child kinds (Stage 1: WEEK, LINE; Stage 4: RFQ_LINE; …).
 */
import { sql, type RawBuilder } from 'kysely';
import { NotFoundError } from './errors.js';
import type { Tx } from './tx.js';

/** Given a child id, returns a query selecting its parent id as column `p`. */
export type ParentQuery = (childId: string | number) => RawBuilder<{ p: string | number }>;
const PARENTS = new Map<string, ParentQuery>();

export function registerParent(kind: string, query: ParentQuery): void {
  PARENTS.set(kind, query);
}

/** A kind whose parent is a column of the child's own table. */
export const parentBy =
  (table: string, idCol: string, parentCol: string): ParentQuery =>
  (id) =>
    sql<{ p: string | number }>`SELECT ${sql.ref(parentCol)} AS p FROM ${sql.table(table)} WHERE ${sql.ref(idCol)} = ${id}`;

/** 404 (never 403) for a child that is missing or belongs elsewhere, so nothing is disclosed. */
export async function assertBelongs(tx: Tx, kind: string, ids: readonly (string | number)[], parentId: string | number): Promise<void> {
  const query = PARENTS.get(kind);
  if (!query) throw new Error(`No parent query registered for ${kind}`);
  for (const id of ids) {
    const row = (await query(id).execute(tx)).rows[0];
    if (!row || String(row.p) !== String(parentId)) throw new NotFoundError(`${kind} ${id}`);
  }
}
