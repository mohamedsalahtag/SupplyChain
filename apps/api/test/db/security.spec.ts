/**
 * Security review 2026-09-26 against a real database: SAP purchase orders scoped to the reader's companies (F05),
 * re-activating a role (F06), revocable sessions (F07), archived users (F07a), and audit rows that commit with the change.
 */
import { P } from '@supplychain/shared';
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { endSessions, loadAuthUser, resolveSessionUser, type AuthUser } from '../../src/auth/authUser.js';
import { signSession } from '../../src/auth/session.js';
import { loadConfig } from '../../src/config.js';
import { deleteUser } from '../../src/modules/users/userDelete.js';
import { updateUser } from '../../src/modules/users/usersService.js';
import { setUserCompanies } from '../../src/modules/workflowSetup/companies.js';
import { appRouter } from '../../src/trpc/router.js';
import { createCallerFactory, type Context } from '../../src/trpc/trpc.js';
import { count, db, makeUser, uid } from './helpers.js';

const SECRET = 's'.repeat(40);
const cfg = { SESSION_SECRET: SECRET, ALLOW_VIEW_AS: false };

afterAll(async () => {
  await db.destroy();
});

const authUser = (id: number, permissions: string[], isAdmin = false): AuthUser => ({
  id, username: `u${id}`, displayName: `U${id}`, isAdmin, isDemo: false, viewAs: null, permissions: new Set(permissions),
});
const callerFor = (user: AuthUser) =>
  createCallerFactory(appRouter)({
    db, cfg: { ...loadConfig(), SESSION_SECRET: SECRET }, user, encKey: '', log: console,
    req: { ip: '127.0.0.1', protocol: 'http' }, res: { setCookie: () => undefined, clearCookie: () => undefined },
  } as unknown as Context);

async function roleId(name: string) {
  return Number((await db.selectFrom('app.Role').select('RoleId').where('Name', '=', name).executeTakeFirstOrThrow()).RoleId);
}

describe('SAP purchase orders are scoped to the reader’s companies (F05)', () => {
  it('another company’s order is left out of the list and the filter options, and its lines are not found', async () => {
    const [poNo, type] = [uid('45'), uid('ZT')];
    await db.insertInto('md.PurchaseOrder').values({ PurchaseOrder: poNo, OrderType: type, SupplierCode: 'S1', OrderDate: new Date(), Currency: 'USD', CompanyCode: '2000', SapLastChangedAt: null, SapChangedAt: new Date() }).execute();
    await db.insertInto('md.PurchaseOrderLine').values({ PurchaseOrder: poNo, ItemNo: 10, Material: 'M1', Quantity: 5, Unit: 'CT', NetPrice: 1, PriceQuantity: 1 }).execute();

    const [outsider, insider] = [await makeUser(), await makeUser()];
    await db.insertInto('scm.UserCompany').values([{ UserId: outsider, CompanyCode: '1000' }, { UserId: insider, CompanyCode: '2000' }]).execute();
    const out = callerFor(authUser(outsider, [P.purchaseOrdersOpen]));
    const ins = callerFor(authUser(insider, [P.purchaseOrdersOpen]));

    expect((await out.purchaseOrders.list({ q: poNo })).total).toBe(0);
    expect((await out.purchaseOrders.filterOptions()).types).not.toContain(type);
    await expect(out.purchaseOrders.lines({ purchaseOrder: poNo })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // a reader with no company at all sees nothing
    const nobody = callerFor(authUser(await makeUser(), [P.purchaseOrdersOpen]));
    expect((await nobody.purchaseOrders.list({})).total).toBe(0);
    await expect(nobody.purchaseOrders.lines({ purchaseOrder: poNo })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // the own company's reader (and an administrator: every active company) sees it
    expect((await ins.purchaseOrders.list({ q: poNo })).total).toBe(1);
    expect((await ins.purchaseOrders.filterOptions()).types).toContain(type);
    expect(await ins.purchaseOrders.lines({ purchaseOrder: poNo })).toHaveLength(1);
    expect((await callerFor(authUser(await makeUser(), [], true)).purchaseOrders.list({ q: poNo })).total).toBe(1);
  });
});

describe('re-activating a role (F06)', () => {
  it('a non-administrator may only re-activate a role whose keys they all hold; the audit row commits with the change', async () => {
    const name = uid('Role ');
    const created = await db.insertInto('app.Role').values({ Name: name, Description: '', IsActive: false }).output('inserted.RoleId').executeTakeFirstOrThrow();
    const id = Number(created.RoleId);
    await db.insertInto('app.RolePermission').values([{ RoleId: id, PermissionKey: P.usersEdit }, { RoleId: id, PermissionKey: P.securityOpen }]).execute();
    const editor = await makeUser();
    const audits = () => count('app.AuditLog', sql`Action = 'role.update' AND Target = ${name}`);

    const weak = callerFor(authUser(editor, [P.securityOpen, P.securityRolesEdit]));
    await expect(weak.security.updateRole({ roleId: id, name, description: '', isActive: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await db.selectFrom('app.Role').select('IsActive').where('RoleId', '=', id).executeTakeFirstOrThrow()).IsActive).toBe(false);
    expect(await audits()).toBe(0);

    // renaming while it stays inactive grants nothing, so it is allowed
    await weak.security.updateRole({ roleId: id, name, description: 'still off', isActive: false });
    expect(await audits()).toBe(1);

    const strong = callerFor(authUser(editor, [P.securityOpen, P.securityRolesEdit, P.usersEdit]));
    await strong.security.updateRole({ roleId: id, name, description: '', isActive: true });
    expect((await db.selectFrom('app.Role').select('IsActive').where('RoleId', '=', id).executeTakeFirstOrThrow()).IsActive).toBe(true);
    expect(await audits()).toBe(2);
  });
});

describe('sessions can be ended (F07)', () => {
  it('a cookie stops working once the SessionVersion is raised; a cookie from before migration 0030 counts as version 0', async () => {
    const u = await makeUser();
    const legacy = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(String(u)).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(SECRET));
    const current = await signSession(u, SECRET, undefined, 0);
    expect(await resolveSessionUser(db, cfg, legacy)).toMatchObject({ id: u });
    expect(await resolveSessionUser(db, cfg, current)).toMatchObject({ id: u });

    await endSessions(db, u);
    expect(await resolveSessionUser(db, cfg, legacy)).toBeNull();
    expect(await resolveSessionUser(db, cfg, current)).toBeNull();
    expect(await resolveSessionUser(db, cfg, await signSession(u, SECRET, undefined, 1))).toMatchObject({ id: u });
  });

  it('signing out ends the sessions on every device', async () => {
    const u = await makeUser();
    const other = await signSession(u, SECRET, undefined, 0); // e.g. the user's other PC
    await callerFor(authUser(u, [])).auth.logout();
    expect(await resolveSessionUser(db, cfg, other)).toBeNull();
    expect(await count('app.AuditLog', sql`Action = 'logout' AND UserId = ${u}`)).toBe(1);
  });

  it('changing a user’s roles, disabling them or changing their companies ends their sessions; saving without a change does not', async () => {
    const [admin, u] = [await makeUser(), await makeUser()];
    await db.insertInto('app.UserRole').values([{ UserId: admin, RoleId: await roleId('Administrator') }, { UserId: u, RoleId: await roleId('Sales') }]).execute();
    const version = async () => Number((await db.selectFrom('app.User').select('SessionVersion').where('UserId', '=', u).executeTakeFirstOrThrow()).SessionVersion);

    expect((await updateUser(db, admin, { userId: u, roleIds: [await roleId('Sales')], isActive: true })).sessionsEnded).toBe(false);
    expect(await version()).toBe(0);
    await updateUser(db, admin, { userId: u, roleIds: [await roleId('Sales'), await roleId('Procurement')], isActive: true });
    expect(await version()).toBe(1);
    await updateUser(db, admin, { userId: u, roleIds: [await roleId('Sales'), await roleId('Procurement')], isActive: false });
    expect(await version()).toBe(2);

    const admins = callerFor(authUser(admin, [], true));
    await admins.users.setCompanies({ userId: u, companyCodes: ['1000'] });
    expect(await version()).toBe(3);
    await admins.users.setCompanies({ userId: u, companyCodes: ['1000'] });
    expect(await version()).toBe(3);
    expect(await count('app.AuditLog', sql`Action = 'users.companies' AND Target = ${String(u)}`)).toBe(2);
  });
});

describe('archived users (F07a, F07b)', () => {
  it('cannot sign in, and can no longer be edited or given companies', async () => {
    const [admin, u] = [await makeUser(), await makeUser()];
    await db.insertInto('app.UserRole').values({ UserId: admin, RoleId: await roleId('Administrator') }).execute();
    await db.insertInto('scm.DomainEvent').values({ EventType: 'TEST', EntityType: 'TEST', EntityId: '1', DemandId: null, PayloadJson: null, ActorUserId: u }).execute(); // on records → archived
    const cookie = await signSession(u, SECRET, undefined, 0);
    const audits = () => count('app.AuditLog', sql`Action = 'user.archive' AND Details LIKE ${`%"userId":${u},%`}`);

    await callerFor(authUser(admin, [], true)).users.delete({ userId: u });
    expect(await audits()).toBe(1);
    expect(await resolveSessionUser(db, cfg, cookie)).toBeNull();

    // even if the active flag were set again by hand, DeletedAt keeps the account out
    await db.updateTable('app.User').set({ IsActive: true }).where('UserId', '=', u).execute();
    const sv = Number((await db.selectFrom('app.User').select('SessionVersion').where('UserId', '=', u).executeTakeFirstOrThrow()).SessionVersion);
    expect(await loadAuthUser(db, u, sv)).toBeNull();

    await expect(updateUser(db, admin, { userId: u, roleIds: [], isActive: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setUserCompanies(db, u, ['1000'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteUser(db, { id: admin, isAdmin: true }, u)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a refused delete writes no audit row and changes nothing', async () => {
    const u = await makeUser();
    let audited = 0;
    await expect(deleteUser(db, { id: u, isAdmin: true }, u, async () => { audited++; })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(audited).toBe(0);
    expect(await db.selectFrom('app.User').select('UserId').where('UserId', '=', u).executeTakeFirst()).toBeDefined();
  });
});
