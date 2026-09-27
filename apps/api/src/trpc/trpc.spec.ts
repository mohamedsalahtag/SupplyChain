import { ALL_PERMISSION_KEYS, PERMISSION_CATALOG, SIGNED_IN } from '@supplychain/shared';
import type { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/authUser.js';
import { DomainError } from '../modules/workflow/errors.js';
import { appRouter } from './router.js';
import { createCallerFactory, procedure, router, type Context } from './trpc.js';

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 1, username: 'u', displayName: 'U', isAdmin: false, isDemo: false, viewAs: null, permissions: new Set(), ...over,
});
const ctx = (u: AuthUser | null) => ({ user: u, log: console }) as unknown as Context;

const r = router({
  noPerm: procedure.query(() => 'x'),
  materials: procedure.meta({ permission: 'materials.open' }).query(() => 'ok'),
  anyone: procedure.meta({ permission: SIGNED_IN }).query(() => 'ok'),
  crash: procedure.meta({ permission: SIGNED_IN }).query(() => { throw new Error('Invalid object name scm.Secret at line 3'); }),
  refuse: procedure.meta({ permission: SIGNED_IN }).query(() => { throw new DomainError('RULE', 'Quantity must be positive'); }),
});
const call = (u: AuthUser | null) => createCallerFactory(r)(ctx(u));

describe('permission guard', () => {
  it('rejects a procedure that declares no permission', async () => {
    await expect(call(user()).noPerm()).rejects.toThrow(/does not declare a permission/);
  });
  it('asks for sign-in when nobody is signed in', async () => {
    await expect(call(null).materials()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(call(null).anyone()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('refuses a signed-in user without the permission', async () => {
    await expect(call(user()).materials()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('allows the permission, SIGNED_IN, and admins', async () => {
    await expect(call(user({ permissions: new Set(['materials.open']) })).materials()).resolves.toBe('ok');
    await expect(call(user()).anyone()).resolves.toBe('ok');
    await expect(call(user({ isAdmin: true })).materials()).resolves.toBe('ok');
  });
});

describe('error replies', () => {
  // The formatter runs when a reply is built (HTTP), so check it through the router's own error shaping.
  const shape = async (fn: () => Promise<unknown>, u: AuthUser) => {
    const errors: unknown[] = [];
    const logged = { error: (o: unknown) => errors.push(o), info: () => undefined, warn: () => undefined };
    const err = await fn().catch((e: unknown) => e as TRPCError);
    const formatted = r._def._config.errorFormatter({
      error: err as TRPCError, type: 'query', path: 'x', input: undefined, ctx: { user: u, log: logged } as unknown as Context,
      shape: { message: (err as TRPCError).message, code: -32603, data: { code: (err as TRPCError).code, httpStatus: 500 } },
    }) as { message: string; data: Record<string, unknown> };
    return { formatted, errors };
  };

  it('an unexpected fault answers with an error id only, and logs the full error under that id', async () => {
    const u = user();
    const { formatted, errors } = await shape(() => call(u).crash(), u);
    expect(formatted.message).not.toMatch(/scm\.Secret/);
    expect(formatted.message).toMatch(/E-[0-9A-F]{10}/);
    expect(errors).toEqual([expect.objectContaining({ errorId: formatted.data.errorId })]);
  });

  it('a business-rule error keeps its message and code', async () => {
    const u = user();
    const { formatted } = await shape(() => call(u).refuse(), u);
    expect(formatted.message).toBe('Quantity must be positive');
    expect(formatted.data.domainCode).toBe('RULE');
  });
});

describe('permission catalogue', () => {
  /** Procedures anyone may call without signing in. Keep this list short. */
  const PUBLIC = ['auth.me', 'auth.login', 'auth.logout', 'auth.testLogin', 'health', 'settings.getUi'];
  const procedures = Object.entries(appRouter._def.procedures as unknown as Record<string, { _def: { meta?: { permission?: string } } }>);

  it('every procedure uses a catalogue key or SIGNED_IN, or is on the public list', () => {
    const wrong = procedures
      .filter(([path, p]) => {
        const perm = p._def.meta?.permission;
        if (!perm) return !PUBLIC.includes(path);
        return perm !== SIGNED_IN && !ALL_PERMISSION_KEYS.includes(perm);
      })
      .map(([path, p]) => `${path} (${p._def.meta?.permission ?? 'no permission'})`);
    expect(wrong).toEqual([]);
  });

  it('keys are unique and every screen has an open key', () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSION_KEYS.length);
    for (const s of PERMISSION_CATALOG) expect(s.open).toMatch(new RegExp(`^${s.key}\\.`));
  });
});
