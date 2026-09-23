/**
 * Active Directory over LDAP(S). Sign-in binds as the user themselves, so a
 * successful bind proves the password; searches (Users page) bind with the
 * configured search account.
 */
import { Client, InvalidCredentialsError, type Entry } from 'ldapts';

export type AdSettings = {
  url: string;
  baseDn: string;
  upnSuffix: string;
  allowSelfSigned: boolean;
};

export type DirectoryUser = {
  username: string; // sAMAccountName, lower case
  upn: string;
  displayName: string;
  email: string;
  department: string;
  title: string;
};

export class WrongCredentialsError extends Error {}
export class DirectoryUnreachableError extends Error {}

const ATTRIBUTES = ['sAMAccountName', 'userPrincipalName', 'displayName', 'mail', 'department', 'title'];

/**
 * "mohamed.tag", "Mohamed.Tag@sharbatlyfruit.com" or "SHARBATLY\mohamed.tag"
 * → the UPN to bind with, e.g. "mohamed.tag@sharbatlyfruit.com".
 */
export function normalizeUsername(input: string, upnSuffix: string): string {
  let name = input.trim().toLowerCase();
  if (name.includes('\\')) name = name.slice(name.lastIndexOf('\\') + 1);
  if (!name.includes('@')) name = `${name}@${upnSuffix.toLowerCase()}`;
  return name;
}

/** RFC 4515: escape a value placed inside an LDAP filter. */
export function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function client(s: AdSettings): Client {
  return new Client({
    url: s.url,
    connectTimeout: 5000,
    timeout: 10000,
    tlsOptions: s.url.startsWith('ldaps://') ? { rejectUnauthorized: !s.allowSelfSigned } : undefined,
  });
}

const first = (v: Entry[string] | undefined): string => {
  const x = Array.isArray(v) ? v[0] : v;
  return x == null ? '' : String(x).trim();
};

function toUser(e: Entry): DirectoryUser {
  return {
    username: first(e.sAMAccountName).toLowerCase(),
    upn: first(e.userPrincipalName).toLowerCase(),
    displayName: first(e.displayName),
    email: first(e.mail),
    department: first(e.department),
    title: first(e.title),
  };
}

async function bind(c: Client, dn: string, password: string): Promise<void> {
  // An empty password is an "unauthenticated bind" that AD accepts without checking — never allow it.
  if (!password) throw new WrongCredentialsError('Wrong username or password');
  try {
    await c.bind(dn, password);
  } catch (err) {
    if (err instanceof InvalidCredentialsError) throw new WrongCredentialsError('Wrong username or password');
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET/.test(code) || /timeout|connect/i.test(String(err))) {
      throw new DirectoryUnreachableError(`Cannot reach Active Directory (${String((err as Error).message ?? err)})`);
    }
    throw err;
  }
}

/** Checks a username and password by binding as that user, then reads their own entry. */
export async function signInToDirectory(s: AdSettings, username: string, password: string): Promise<DirectoryUser> {
  const upn = normalizeUsername(username, s.upnSuffix);
  const c = client(s);
  try {
    await bind(c, upn, password);
    const { searchEntries } = await c.search(s.baseDn, {
      scope: 'sub',
      filter: `(&(objectCategory=person)(objectClass=user)(userPrincipalName=${escapeFilter(upn)}))`,
      attributes: ATTRIBUTES,
      sizeLimit: 1,
    });
    if (searchEntries[0]) return toUser(searchEntries[0]);
    // Signed in but not under the Base DN (or a different UPN): keep what we know.
    return { username: upn.split('@')[0], upn, displayName: '', email: '', department: '', title: '' };
  } finally {
    await c.unbind().catch(() => undefined);
  }
}

/** Finds people whose name, username or email starts with the text (search account). */
export async function searchDirectory(
  s: AdSettings,
  searchUpn: string,
  searchPassword: string,
  text: string,
  limit = 25,
): Promise<DirectoryUser[]> {
  const q = escapeFilter(text.trim());
  const c = client(s);
  try {
    await bind(c, normalizeUsername(searchUpn, s.upnSuffix), searchPassword);
    const { searchEntries } = await c.search(s.baseDn, {
      scope: 'sub',
      filter:
        `(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))` +
        `(|(displayName=${q}*)(sAMAccountName=${q}*)(mail=${q}*)(givenName=${q}*)(sn=${q}*)))`,
      attributes: ATTRIBUTES,
      sizeLimit: limit,
    }).catch((err: Error) => {
      // AD returns "size limit exceeded" with the first results when there are more — keep those.
      if (/size ?limit/i.test(err.message) && 'searchEntries' in err) return err as unknown as { searchEntries: Entry[] };
      throw err;
    });
    return searchEntries.map(toUser).filter((u) => u.username);
  } finally {
    await c.unbind().catch(() => undefined);
  }
}

/** One person by exact sAMAccountName (search account), or null. */
export async function findDirectoryUser(
  s: AdSettings,
  searchUpn: string,
  searchPassword: string,
  username: string,
): Promise<DirectoryUser | null> {
  const c = client(s);
  try {
    await bind(c, normalizeUsername(searchUpn, s.upnSuffix), searchPassword);
    const { searchEntries } = await c.search(s.baseDn, {
      scope: 'sub',
      filter: `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${escapeFilter(username.trim())}))`,
      attributes: ATTRIBUTES,
      sizeLimit: 1,
    });
    return searchEntries[0] ? toUser(searchEntries[0]) : null;
  } finally {
    await c.unbind().catch(() => undefined);
  }
}

/** Binds with the search account and counts people under the Base DN (Test connection). */
export async function testDirectory(s: AdSettings, searchUpn: string, searchPassword: string): Promise<{ ms: number; people: number }> {
  const started = Date.now();
  const c = client(s);
  try {
    await bind(c, normalizeUsername(searchUpn, s.upnSuffix), searchPassword);
    const { searchEntries } = await c.search(s.baseDn, {
      scope: 'sub',
      filter: '(&(objectCategory=person)(objectClass=user))',
      attributes: ['sAMAccountName'],
      paged: { pageSize: 500 },
    });
    return { ms: Date.now() - started, people: searchEntries.length };
  } finally {
    await c.unbind().catch(() => undefined);
  }
}
