import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { readSession, signSession, verifySession } from './session.js';

const secret = 'x'.repeat(40);

describe('session token', () => {
  it('round-trips the user id', async () => {
    expect(await verifySession(await signSession(7, secret), secret)).toBe(7);
  });
  it('rejects a token signed with another secret', async () => {
    expect(await verifySession(await signSession(7, 'y'.repeat(40)), secret)).toBeNull();
  });
  it('rejects an expired or missing token', async () => {
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('7')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(secret));
    expect(await verifySession(expired, secret)).toBeNull();
    expect(await verifySession(undefined, secret)).toBeNull();
  });
});

describe('session version (sv, migration 0030)', () => {
  it('carries the session version, and the View as administrator', async () => {
    expect(await readSession(await signSession(7, secret, 3, 5), secret)).toEqual({ userId: 7, viewAsBy: 3, sessionVersion: 5 });
  });
  it('a token from before sv existed counts as version 0', async () => {
    const legacy = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('7').setExpirationTime('1h').sign(new TextEncoder().encode(secret));
    expect(await readSession(legacy, secret)).toEqual({ userId: 7, viewAsBy: null, sessionVersion: 0 });
  });
  it('rejects a malformed version', async () => {
    const bad = await new SignJWT({ sv: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject('7').setExpirationTime('1h').sign(new TextEncoder().encode(secret));
    expect(await readSession(bad, secret)).toBeNull();
  });
});
