import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from './session.js';

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
