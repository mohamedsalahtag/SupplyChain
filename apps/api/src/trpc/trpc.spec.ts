import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { createCallerFactory, DEV_USER, procedure, router } from './trpc.js';

const ctx = { db: {} as Kysely<Database>, user: DEV_USER, encKey: '', log: console };

describe('permission guard', () => {
  it('rejects a procedure that declares no permission', async () => {
    const r = router({ open: procedure.query(() => 'ok') });
    await expect(createCallerFactory(r)(ctx).open()).rejects.toThrow(/does not declare a permission/);
  });

  it('allows a procedure that declares a permission', async () => {
    const r = router({ ok: procedure.meta({ permission: 'test.view' }).query(() => 'ok') });
    await expect(createCallerFactory(r)(ctx).ok()).resolves.toBe('ok');
  });
});
