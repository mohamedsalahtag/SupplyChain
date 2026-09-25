/** View as (spec 16): who a session cookie resolves to, and when View as is refused. */
import { describe, expect, it } from 'vitest';
import { resolveSessionUser } from '../../src/auth/authUser.js';
import { signSession } from '../../src/auth/session.js';
import { db, makeUser, uid } from './helpers.js';

const SECRET = 'v'.repeat(40);
const cfg = (allow = true) => ({ SESSION_SECRET: SECRET, ALLOW_VIEW_AS: allow });

async function roleId(name: string) {
  return Number((await db.selectFrom('app.Role').select('RoleId').where('Name', '=', name).executeTakeFirstOrThrow()).RoleId);
}
async function admin() {
  const id = await makeUser(uid('adm'));
  await db.insertInto('app.UserRole').values({ UserId: id, RoleId: await roleId('Administrator') }).execute();
  return id;
}
async function demo(isDemo = true) {
  const id = await makeUser(uid('demo'));
  await db.updateTable('app.User').set({ IsDemo: isDemo }).where('UserId', '=', id).execute();
  await db.insertInto('app.UserRole').values({ UserId: id, RoleId: await roleId('Procurement') }).execute();
  return id;
}

describe('View as', () => {
  it('seeds the three demo accounts with their roles and every company', async () => {
    const rows = await db.selectFrom('app.User').select(['Username', 'UserId']).where('IsDemo', '=', true).where('Username', 'like', 'demo.%').execute();
    expect(rows.map((r) => r.Username).sort()).toEqual(expect.arrayContaining(['demo.both', 'demo.procurement', 'demo.sales']));
    const both = rows.find((r) => r.Username === 'demo.both')!;
    const roles = await db.selectFrom('app.UserRole as ur').innerJoin('app.Role as r', 'r.RoleId', 'ur.RoleId').select('r.Name').where('ur.UserId', '=', both.UserId).execute();
    expect(roles.map((r) => r.Name).sort()).toEqual(['Procurement', 'Sales']);
  });

  it('an administrator viewing as a demo account acts as that account, not as an admin', async () => {
    const [a, d] = [await admin(), await demo()];
    const u = await resolveSessionUser(db, cfg(), await signSession(d, SECRET, a));
    expect(u).toMatchObject({ id: d, isAdmin: false, isDemo: true, viewAs: { realUserId: a } });
    expect(u!.permissions.has('cr.decide.sales')).toBe(true); // Procurement decides what Sales raised
    expect(u!.permissions.has('users.open')).toBe(false);
  });

  it('falls back to the administrator when View as is switched off or the target is not a demo account', async () => {
    const [a, d, real] = [await admin(), await demo(), await demo(false)];
    expect(await resolveSessionUser(db, cfg(false), await signSession(d, SECRET, a))).toMatchObject({ id: a, viewAs: null });
    expect(await resolveSessionUser(db, cfg(), await signSession(real, SECRET, a))).toMatchObject({ id: a, viewAs: null });
  });

  it('a session claiming View as by someone who is not an administrator is worthless', async () => {
    const [notAdmin, d] = [await makeUser(), await demo()];
    expect(await resolveSessionUser(db, cfg(), await signSession(d, SECRET, notAdmin))).toBeNull();
  });

  it('an ordinary session resolves to its own user', async () => {
    const a = await admin();
    expect(await resolveSessionUser(db, cfg(), await signSession(a, SECRET))).toMatchObject({ id: a, isAdmin: true, viewAs: null });
  });
});
