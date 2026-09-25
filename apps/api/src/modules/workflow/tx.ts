/**
 * Transactions for workflow commands (plan v5 §0.6): one business command =
 * one transaction, retried on SQL Server deadlock (1205), plus optimistic
 * concurrency on RowVer.
 */
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import type { Database } from '../../db/schema.js';
import { ConcurrencyError } from './errors.js';

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

/** SQL Server error number from an mssql/msnodesqlv8 error (it may be nested). */
export function sqlErrorNumber(err: unknown): number | null {
  let e = err as { number?: unknown; originalError?: unknown; cause?: unknown } | null;
  for (let depth = 0; e && depth < 5; depth++) {
    if (typeof e.number === 'number') return e.number;
    e = (e.originalError ?? e.cause) as typeof e;
  }
  const m = /\b(1205|2601|2627)\b/.exec(String((err as Error)?.message ?? ''));
  return m ? Number(m[1]) : null;
}

export const isDeadlock = (err: unknown) => sqlErrorNumber(err) === 1205;
export const isDuplicateKey = (err: unknown) => [2601, 2627].includes(sqlErrorNumber(err) ?? 0);

/** Runs `fn` in a READ COMMITTED transaction; up to 3 attempts on deadlock. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, attempt = 1): Promise<T> {
  try {
    return await db.transaction().setIsolationLevel('read committed').execute(fn);
  } catch (err) {
    if (isDeadlock(err) && attempt < 3) return withTx(db, fn, attempt + 1);
    throw err;
  }
}

/** RowVer as the UI sees it: 16 hex characters (rowversion must be cast to binary for style 2 to apply). */
export const rowVerHex = (col = 'RowVer') => sql<string>`CONVERT(varchar(16), CAST(${sql.ref(col)} AS binary(8)), 2)`;

const HEX16 = /^[0-9A-Fa-f]{16}$/;

/**
 * UPDATE <table> SET <set> WHERE <idCol> = id AND RowVer = rowVer.
 * Throws ConcurrencyError when no row matched (changed or gone). Table and
 * column names come from code, never from input.
 */
export async function updateWithRowVer(
  tx: Tx,
  table: string,
  idCol: string,
  id: string | number,
  rowVer: string,
  set: RawBuilder<unknown>,
): Promise<void> {
  if (!HEX16.test(rowVer)) throw new ConcurrencyError(table, id);
  const r = await sql`UPDATE ${sql.table(table)} SET ${set} WHERE ${sql.ref(idCol)} = ${id} AND RowVer = CONVERT(binary(8), ${rowVer}, 2)`.execute(tx);
  if (Number(r.numAffectedRows ?? 0) !== 1) throw new ConcurrencyError(table, id);
}
