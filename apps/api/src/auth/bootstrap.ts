/**
 * First start: when the app has no users, create BOOTSTRAP_ADMIN (.env) as an
 * Administrator so someone can sign in and register everyone else.
 */
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Database } from '../db/schema.js';
import { audit } from './audit.js';

export async function ensureBootstrapAdmin(db: Kysely<Database>, cfg: Config, log: { info: (o: object, m: string) => void }): Promise<void> {
  const username = cfg.BOOTSTRAP_ADMIN.trim().toLowerCase().replace(/@.*$/, '').replace(/^.*\\/, '');
  if (!username) return;
  const { n } = await db.selectFrom('app.User').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  if (Number(n) > 0) return;

  const admin = await db.selectFrom('app.Role').select('RoleId').where('IsAdmin', '=', true).where('IsBuiltIn', '=', true).executeTakeFirstOrThrow();
  await db.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto('app.User')
      .values({ Username: username, DisplayName: username, CreatedBy: 'bootstrap', IsActive: true, Upn: '', Email: '', Department: '', Title: '', LastLoginAt: null })
      .output('inserted.UserId')
      .executeTakeFirstOrThrow();
    const userId = Number(created.UserId);
    await trx.insertInto('app.UserRole').values({ UserId: userId, RoleId: Number(admin.RoleId) }).execute();
    // Table preferences saved before sign-in existed belonged to the "dev" user.
    await trx.updateTable('app.UserPreference').set({ UserId: String(userId) }).where('UserId', '=', 'dev').execute();
  });
  await audit(db, { userId: null, action: 'user.bootstrap', target: username });
  log.info({ username }, 'Bootstrap administrator created');
}
