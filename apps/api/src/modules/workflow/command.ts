/**
 * Duplicate-safe commands (plan v5 §0.6). Every mutating workflow call carries
 * a client-generated commandId. The first call runs and stores its result in
 * the same transaction; a repeat (double click, retry) returns that stored
 * result without changing anything again.
 */
import { sql } from 'kysely';
import { DomainError } from './errors.js';
import { isDuplicateKey, withTx, type Db, type Tx } from './tx.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Stored<T> = { found: false } | { found: true; result: T };

async function storedResult<T>(db: Db | Tx, commandId: string, userId: number, lock: boolean): Promise<Stored<T>> {
  const row = lock
    ? (await sql<{ ResultJson: string | null; UserId: number }>`
        SELECT ResultJson, UserId FROM scm.CommandLog WITH (UPDLOCK, HOLDLOCK) WHERE CommandId = ${commandId}`.execute(db)).rows[0]
    : await db.selectFrom('scm.CommandLog').select(['ResultJson', 'UserId']).where('CommandId', '=', commandId).executeTakeFirst();
  if (!row) return { found: false };
  if (Number(row.UserId) !== userId) throw new DomainError('BAD_COMMAND', 'This command id belongs to another user', 409);
  return { found: true, result: (row.ResultJson ? JSON.parse(row.ResultJson) : undefined) as T };
}

export async function runCommand<T>(db: Db, userId: number, commandId: string, name: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(commandId)) throw new DomainError('BAD_COMMAND', 'commandId must be a UUID');
  try {
    return await withTx(db, async (tx) => {
      const prev = await storedResult<T>(tx, commandId, userId, true);
      if (prev.found) return prev.result;
      const result = await fn(tx);
      await tx
        .insertInto('scm.CommandLog')
        .values({ CommandId: commandId, UserId: userId, CommandName: name, ResultJson: result === undefined ? null : JSON.stringify(result) })
        .execute();
      return result;
    });
  } catch (err) {
    // Two identical commands raced: the loser's work was rolled back; return the winner's result.
    if (isDuplicateKey(err)) {
      const prev = await storedResult<T>(db, commandId, userId, false);
      if (prev.found) return prev.result;
    }
    throw err;
  }
}
