/**
 * Duplicate-safe commands (plan v5 §0.6). Every mutating workflow call carries
 * a client-generated commandId. The first call runs and stores its result in
 * the same transaction; a repeat (double click, retry) returns that stored
 * result without changing anything again.
 *
 * A repeat must be the same command: same user, same command name and — when the caller passes its input — the same
 * input (SHA-256 of its canonical JSON, migration 0031). A reused id for anything else is refused (COMMAND_KEY_REUSED)
 * instead of silently answering with another command's result.
 */
import { createHash } from 'node:crypto';
import { DomainError } from './errors.js';
import { isDuplicateKey, withTx, type Db, type Tx } from './tx.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON with object keys sorted at every level, so the same input always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** The stored hash of a command's input; null when the caller passes none (then only user and name are compared). */
export const inputHash = (input: unknown): string | null =>
  input === undefined ? null : createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');

type Row = { ResultJson: string | null; UserId: number; CommandName: string; InputHash: string | null };

/** A stored command may be replayed only for the same user, command name and input. */
export function assertSameCommand(row: Pick<Row, 'UserId' | 'CommandName' | 'InputHash'>, userId: number, name: string, hash: string | null): void {
  if (Number(row.UserId) !== userId) throw new DomainError('BAD_COMMAND', 'This command id belongs to another user', 409);
  if (row.CommandName !== name || (row.InputHash !== null && hash !== null && row.InputHash.trim() !== hash)) {
    throw new DomainError('COMMAND_KEY_REUSED', 'This command id was already used for a different action. Reload and try again.', 409);
  }
}

async function storedResult<T>(db: Db, commandId: string, userId: number, name: string, hash: string | null): Promise<{ found: false } | { found: true; result: T }> {
  const row = await db.selectFrom('scm.CommandLog').select(['ResultJson', 'UserId', 'CommandName', 'InputHash']).where('CommandId', '=', commandId).executeTakeFirst();
  if (!row) return { found: false };
  assertSameCommand(row, userId, name, hash);
  return { found: true, result: (row.ResultJson ? JSON.parse(row.ResultJson) : undefined) as T };
}

/**
 * Runs `fn` once per commandId, in one transaction (retried on deadlock).
 * `input` (optional) is what the command was asked to do; a repeat with a different input is refused.
 *
 * Insert first (CLAUDE.md: never UPDLOCK, HOLDLOCK on a key that may not exist yet): the command's log row is written
 * before its work, inside the same transaction. A second call with the same id then waits on that row's key lock; when
 * the first commits it gets a duplicate key and returns the stored result, when the first rolls back it runs itself.
 */
export async function runCommand<T>(db: Db, userId: number, commandId: string, name: string, fn: (tx: Tx) => Promise<T>, input?: unknown): Promise<T> {
  if (!UUID.test(commandId)) throw new DomainError('BAD_COMMAND', 'commandId must be a UUID');
  const hash = inputHash(input);
  try {
    return await withTx(db, async (tx) => {
      await tx.insertInto('scm.CommandLog').values({ CommandId: commandId, UserId: userId, CommandName: name, InputHash: hash, ResultJson: null }).execute();
      const result = await fn(tx);
      if (result !== undefined) {
        await tx.updateTable('scm.CommandLog').set({ ResultJson: JSON.stringify(result) }).where('CommandId', '=', commandId).execute();
      }
      return result;
    });
  } catch (err) {
    // The id is already used (a repeat, or an identical command that raced and won): its stored result, if it is the
    // same command. A duplicate key from the command's own work finds no committed log row and is rethrown.
    if (isDuplicateKey(err)) {
      const prev = await storedResult<T>(db, commandId, userId, name, hash);
      if (prev.found) return prev.result;
    }
    throw err;
  }
}
