/** Operations status (spec 25) against a real database: runs on SQL Server 2016, lists separation-of-duties conflicts and users without a company. */
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { opsStatus } from '../../src/modules/ops/opsStatus.js';
import { db, makeUser, uid } from './helpers.js';

afterAll(() => db.destroy());

describe('operations status (spec 25)', () => {
  it('reports the outbox, master data, overdue work; flags a user who can submit and accept demands, and one without a company', async () => {
    const name = uid('Both');
    const userId = await makeUser(name);
    const role = await db.insertInto('app.Role').values({ Name: uid('SoD'), Description: 'test' }).output('inserted.RoleId').executeTakeFirstOrThrow();
    await db.insertInto('app.RolePermission').values([{ RoleId: Number(role.RoleId), PermissionKey: 'demand.submit' }, { RoleId: Number(role.RoleId), PermissionKey: 'demand.accept' }]).execute();
    await db.insertInto('app.UserRole').values({ UserId: userId, RoleId: Number(role.RoleId) }).execute();

    const s = await opsStatus(db, loadConfig());
    expect(s.masterData.sources.map((x) => x.source)).toEqual(['sap.materials', 'sap.suppliers', 'sap.purchaseOrders']);
    expect(typeof s.sap.unknown).toBe('number');
    expect(s.separationOfDuties.find((u) => u.userId === userId)?.conflicts).toEqual(['raises and accepts the same demand']);
    expect(s.usersWithoutCompany.map((u) => u.userId)).toContain(userId);

    await db.insertInto('scm.UserCompany').values({ UserId: userId, CompanyCode: '1000' }).execute();
    expect((await opsStatus(db, loadConfig())).usersWithoutCompany.map((u) => u.userId)).not.toContain(userId);
  });
});
