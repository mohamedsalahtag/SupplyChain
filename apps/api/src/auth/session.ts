/**
 * The login cookie: a signed token holding the user id, the session version of the person signed in (sv) and, in View as,
 * the administrator's id.
 */
import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'sc_session';
/**
 * 30 days (user decision 2026-09-26; was 10 h). A session ends early when the person's app.User.SessionVersion is raised
 * (migration 0030): on sign-out — which therefore signs them out on every device — when the user is disabled or archived,
 * and when their roles or companies change. Disabling or deleting also ends it because the user is reloaded every request.
 */
export const SESSION_HOURS = 30 * 24;

const key = (secret: string) => new TextEncoder().encode(secret);

/**
 * @param sessionVersion the SessionVersion of the person signed in — in View as, the administrator's (viewAsBy).
 */
export async function signSession(userId: number, secret: string, viewAsBy?: number, sessionVersion = 0): Promise<string> {
  return new SignJWT({ sv: sessionVersion, ...(viewAsBy ? { vab: viewAsBy } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key(secret));
}

export type SessionClaims = {
  userId: number;
  /** The administrator who is viewing as this (demo) user. */
  viewAsBy: number | null;
  /** Session version of the person signed in (viewAsBy ?? userId). Tokens from before migration 0030 have none: 0. */
  sessionVersion: number;
};

/** The claims, or null when the token is missing, tampered with or expired. */
export async function readSession(token: string | undefined, secret: string): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    const id = Number(payload.sub);
    const by = Number(payload.vab);
    const sv = payload.sv === undefined ? 0 : Number(payload.sv);
    if (!Number.isInteger(sv) || sv < 0) return null;
    return Number.isInteger(id) && id > 0 ? { userId: id, viewAsBy: Number.isInteger(by) && by > 0 ? by : null, sessionVersion: sv } : null;
  } catch {
    return null;
  }
}

/** The user id, or null when the token is missing, tampered with or expired. */
export async function verifySession(token: string | undefined, secret: string): Promise<number | null> {
  return (await readSession(token, secret))?.userId ?? null;
}
