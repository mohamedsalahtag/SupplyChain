/**
 * Delete a user (Users page, 2026-09-26). Two endings, stated before the administrator confirms:
 * - **delete**: nothing in the workflow carries the user's id → the account and its roles, companies and preferences go.
 * - **archive**: the user's name is on records (a demand they created, a quote they recorded …) → the row stays so history
 *   still names them, but it is hidden from the Users list, cannot sign in, loses roles and companies, and its username is
 *   freed (prefixed "deleted.<id>.") so the same person can be registered again.
 * Refused: yourself, the last active administrator, an administrator (unless you are one), the demo accounts (View as).
 */
import { TRPCError } from '@trpc/server';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import { countActiveAdmins } from './usersService.js';

type Db = Kysely<Database>;
type Ref = { table: string; column: string };

/** Account-owned rows: removed with the user in both endings. */
const OWNED = new Set(['app.UserRole.UserId', 'scm.UserCompany.UserId']);
/** Provenance columns without a foreign key (the rest are read from the catalog, so a new one is never missed). */
const EXTRA: Ref[] = [
  { table: 'scm.DomainEvent', column: 'ActorUserId' }, { table: 'scm.ThreadEntry', column: 'AuthorUserId' }, { table: 'scm.Attachment', column: 'UploadedBy' },
  { table: 'scm.SliceHistory', column: 'ActorUserId' }, { table: 'scm.DemandVersion', column: 'CreatedBy' }, { table: 'scm.InboxItem', column: 'RaisedBy' },
  { table: 'scm.InboxItem', column: 'ClosedBy' },
];
const LABEL: Record<string, string> = {
  'scm.Demand': 'demands', 'scm.Rfq': 'RFQs', 'scm.SupplierQuote': 'quotes', 'scm.AwardBatch': 'awards', 'scm.Handoff': 'handoffs', 'scm.PoDraft': 'PO drafts',
  'scm.ChangeRequest': 'change requests', 'scm.MergeRecord': 'merges', 'scm.DomainEvent': 'history events', 'scm.ThreadEntry': 'comments', 'scm.Attachment': 'attachments',
  'scm.SliceHistory': 'quantity history', 'scm.DemandVersion': 'demand versions', 'scm.InboxItem': 'work items',
};

const quote = (name: string) => name.split('.').map((p) => `[${p.replace(/]/g, ']]')}]`).join('.');

async function provenanceRefs(db: Db): Promise<Ref[]> {
  const fks = (await sql<{ T: string; C: string }>`
    SELECT SCHEMA_NAME(ct.schema_id) + '.' + ct.name AS T, c.name AS C
    FROM sys.foreign_key_columns fkc JOIN sys.tables ct ON ct.object_id = fkc.parent_object_id JOIN sys.tables pt ON pt.object_id = fkc.referenced_object_id
    JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
    WHERE SCHEMA_NAME(pt.schema_id) = 'app' AND pt.name = 'User'`.execute(db)).rows;
  return [...fks.map((f) => ({ table: f.T, column: f.C })).filter((r) => !OWNED.has(`${r.table}.${r.column}`)), ...EXTRA];
}

/** Where the user's id appears (catalog names only, never user input, so building the SQL text is safe). */
async function references(db: Db, userId: number) {
  const refs = await provenanceRefs(db);
  const parts = refs.map((r) => `SELECT '${r.table}' AS T, COUNT(*) AS N FROM ${quote(r.table)} WHERE ${quote(r.column)} = @uid`);
  const rows = (await sql<{ T: string; N: number }>`DECLARE @uid int = ${userId}; ${sql.raw(parts.join(' UNION ALL '))}`.execute(db)).rows;
  const byTable = new Map<string, number>();
  for (const r of rows) if (Number(r.N)) byTable.set(r.T, (byTable.get(r.T) ?? 0) + Number(r.N));
  return [...byTable].map(([table, count]) => ({ table, label: LABEL[table] ?? table.split('.')[1], count })).sort((a, b) => b.count - a.count);
}

/** lock: inside the delete's transaction, the row is held (UPDLOCK) so nothing changes it between the checks and the delete. */
async function target(db: Db, userId: number, lock = false) {
  const u = (await sql<{ UserId: number; Username: string; DisplayName: string; IsActive: boolean; IsDemo: boolean; DeletedAt: Date | null }>`
    SELECT UserId, Username, DisplayName, IsActive, IsDemo, DeletedAt FROM app.[User] ${sql.raw(lock ? 'WITH (UPDLOCK, ROWLOCK)' : '')}
    WHERE UserId = ${userId}`.execute(db)).rows[0];
  if (!u || u.DeletedAt) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  const admin = await db.selectFrom('app.UserRole as ur').innerJoin('app.Role as r', 'r.RoleId', 'ur.RoleId').select('r.RoleId')
    .where('ur.UserId', '=', userId).where('r.IsAdmin', '=', true).executeTakeFirst();
  return { ...u, isAdmin: !!admin };
}

type Actor = { id: number; isAdmin: boolean };

function refusal(actor: Actor, u: Awaited<ReturnType<typeof target>>): string | null {
  if (Number(u.UserId) === Number(actor.id)) return 'You cannot delete your own account.'; // the driver returns IDENTITY ids as strings
  if (u.IsDemo) return 'Demo accounts are used by View as and cannot be deleted.';
  if (u.isAdmin && !actor.isAdmin) return 'Only an administrator can delete an administrator.';
  return null;
}

/** What deleting would do, shown before the confirmation. */
export async function deletePreview(db: Db, actor: Actor, userId: number) {
  const u = await target(db, userId);
  const refs = await references(db, userId);
  return { userId, displayName: u.DisplayName || u.Username, mode: refs.length ? ('archive' as const) : ('delete' as const), references: refs, refusal: refusal(actor, u) };
}

type Result = { mode: 'delete' | 'archive'; displayName: string; username: string; references: Awaited<ReturnType<typeof references>> };

/** `inTx` runs in the same transaction (the audit row), so the deletion and its audit commit together. */
export async function deleteUser(db: Db, actor: Actor, userId: number, inTx?: (trx: Db, r: Result) => Promise<void>): Promise<Result> {
  return db.transaction().execute(async (trx) => {
    const u = await target(trx, userId, true);
    const why = refusal(actor, u);
    if (why) throw new TRPCError({ code: 'FORBIDDEN', message: why });
    const refs = await references(trx as unknown as Db, userId);
    await trx.deleteFrom('app.UserRole').where('UserId', '=', userId).execute();
    await trx.deleteFrom('scm.UserCompany').where('UserId', '=', userId).execute();
    await sql`DELETE FROM app.UserPreference WHERE UserId = ${userId}`.execute(trx);
    await sql`UPDATE scm.InboxItem SET ExcludeUserId = NULL WHERE ExcludeUserId = ${userId}`.execute(trx);
    let mode: 'delete' | 'archive';
    if (refs.length) {
      mode = 'archive';
      // SessionVersion + 1: any cookie of the archived user is dead even before DeletedAt is checked.
      await sql`UPDATE app.[User] SET IsActive = 0, DeletedAt = SYSUTCDATETIME(), Upn = '', Email = '', SessionVersion = SessionVersion + 1,
        Username = LEFT(CONCAT('deleted.', UserId, '.', Username), 100) WHERE UserId = ${userId}`.execute(trx);
    } else {
      mode = 'delete';
      await trx.deleteFrom('app.User').where('UserId', '=', userId).execute();
    }
    // Only deleting an administrator can remove the last one (other deletions leave the count as it was).
    if (u.isAdmin && u.IsActive && (await countActiveAdmins(trx)) === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'At least one active user must keep the Administrator role.' });
    const result: Result = { mode, displayName: u.DisplayName || u.Username, username: u.Username, references: refs };
    await inTx?.(trx, result);
    return result;
  });
}
