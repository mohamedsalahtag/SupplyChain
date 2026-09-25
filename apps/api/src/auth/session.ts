/** The login cookie: a signed token holding the user id (and, in View as, the administrator's id). */
import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'sc_session';
export const SESSION_HOURS = 10;

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(userId: number, secret: string, viewAsBy?: number): Promise<string> {
  return new SignJWT(viewAsBy ? { vab: viewAsBy } : {})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key(secret));
}

export type SessionClaims = { userId: number; /** The administrator who is viewing as this (demo) user. */ viewAsBy: number | null };

/** The claims, or null when the token is missing, tampered with or expired. */
export async function readSession(token: string | undefined, secret: string): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    const id = Number(payload.sub);
    const by = Number(payload.vab);
    return Number.isInteger(id) && id > 0 ? { userId: id, viewAsBy: Number.isInteger(by) && by > 0 ? by : null } : null;
  } catch {
    return null;
  }
}

/** The user id, or null when the token is missing, tampered with or expired. */
export async function verifySession(token: string | undefined, secret: string): Promise<number | null> {
  return (await readSession(token, secret))?.userId ?? null;
}
