/** The login cookie: a signed token holding only the user id. */
import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'sc_session';
export const SESSION_HOURS = 10;

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(userId: number, secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key(secret));
}

/** The user id, or null when the token is missing, tampered with or expired. */
export async function verifySession(token: string | undefined, secret: string): Promise<number | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    const id = Number(payload.sub);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}
