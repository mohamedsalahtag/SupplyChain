/**
 * Active Directory connection (Configuration → Active Directory). Until it is
 * saved, sign-in uses the AD_* defaults from .env, so nobody is locked out.
 * The search account password is stored encrypted.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { adTransportProblem, type AdSettings } from '../auth/ldap.js';
import type { Config } from '../config.js';
import type { Database } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './secret.js';
import { readSetting, writeSetting } from './store.js';

const KEY = 'ad.connection';

const adConnectionFields = z.object({
  url: z.string().regex(/^ldaps?:\/\/[^\s/]+(:\d+)?\/?$/i, 'Use ldaps://server:636 (or ldap://server:389)'),
  baseDn: z.string().trim().min(3, 'Enter the Base DN'),
  upnSuffix: z.string().trim().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Enter a domain such as sharbatlyfruit.com'),
  allowSelfSigned: z.boolean(),
  searchUser: z.string().trim(),
  searchPassword: z.string(),
});
/** On a production server: ldaps:// only, and the certificate is checked (adTransportProblem). */
export const adConnectionSchema = adConnectionFields.superRefine((c, ctx) => {
  const problem = adTransportProblem(c);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: [/^ldaps:/i.test(c.url) ? 'allowSelfSigned' : 'url'] });
});
export type AdConnection = z.infer<typeof adConnectionFields>;

const storedSchema = adConnectionFields.omit({ searchPassword: true }).extend({ searchPasswordEnc: z.string() });

/** Saved settings, or the .env defaults (no search account) when nothing is saved yet. */
export async function loadAdConnection(db: Kysely<Database>, cfg: Config): Promise<AdConnection & { saved: boolean }> {
  const parsed = storedSchema.safeParse(await readSetting(db, KEY));
  if (!parsed.success) {
    return {
      url: cfg.AD_URL,
      baseDn: cfg.AD_BASE_DN,
      upnSuffix: cfg.AD_UPN_SUFFIX,
      // Until settings are saved: certificates are checked on a production server (a forged directory could collect passwords).
      allowSelfSigned: process.env.NODE_ENV !== 'production',
      searchUser: '',
      searchPassword: '',
      saved: false,
    };
  }
  const { searchPasswordEnc, ...rest } = parsed.data;
  return { ...rest, searchPassword: searchPasswordEnc ? decryptSecret(searchPasswordEnc, cfg.SETTINGS_ENCRYPTION_KEY) : '', saved: true };
}

export async function saveAdConnection(db: Kysely<Database>, encKey: string, input: AdConnection): Promise<void> {
  const { searchPassword, ...rest } = adConnectionSchema.parse(input);
  await writeSetting(db, KEY, { ...rest, searchPasswordEnc: searchPassword ? encryptSecret(searchPassword, encKey) : '' });
}

export const toAdSettings = (c: AdConnection): AdSettings => ({
  url: c.url,
  baseDn: c.baseDn,
  upnSuffix: c.upnSuffix,
  allowSelfSigned: c.allowSelfSigned,
});
