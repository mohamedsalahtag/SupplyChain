/**
 * Configuration → SAP purchase orders (spec 23): where the PO outbox sends purchase orders.
 * "stub" = the built-in simulator; "api" = the company's PO API (provided later), called by the HTTP adapter.
 * Stored as one JSON row in app.Setting, the password encrypted like the SAP connection.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/schema.js';
import { DomainError } from '../modules/workflow/errors.js';
import { decryptSecret, encryptSecret } from './secret.js';
import { readSetting, writeSetting } from './store.js';

const KEY = 'sap.poApi';

/**
 * The whole budget of one SAP call (CSRF fetch + POST, or the lookup), in seconds. It must stay well inside the outbox
 * lease (OUTBOX.leaseMinutes = 5): the worker records the reply only while it still holds the claim, and a budget of
 * at most 2 minutes leaves 3 minutes for the database writes around the call.
 */
export const MAX_TIMEOUT_SECONDS = 120;

export const sapPoApiSchema = z.object({
  mode: z.enum(['stub', 'api']).default('stub'),
  /** e.g. https://sapgw.example.com:44300 */
  baseUrl: z.string().trim().max(300).default(''),
  /** POST: creates one PO. Relative to the base URL. */
  createPath: z.string().trim().max(300).default(''),
  /** GET: finds a PO by the portal reference; {reference} is replaced by POD-… */
  lookupPath: z.string().trim().max(300).default(''),
  sapClient: z.string().trim().max(10).default(''),
  authType: z.enum(['basic', 'none']).default('basic'),
  user: z.string().trim().max(100).default(''),
  password: z.string().max(200).default(''),
  /** SAP Gateway services want an X-CSRF-Token fetched before a POST. */
  csrf: z.boolean().default(true),
  allowSelfSigned: z.boolean().default(false),
  /** One budget for the whole call (CSRF + POST); well below the outbox lease (5 minutes), or a slow reply could race a re-claim. */
  timeoutSeconds: z.number().int().min(5).max(MAX_TIMEOUT_SECONDS).default(60),
  /** The SAP PO field that stores the portal reference (POD-…); required so unknown outcomes can be found. */
  referenceField: z.string().trim().max(60).default(''),
  /** Where the PO number is in SAP's reply, as a dot path (e.g. "d.PurchaseOrder" or "PurchaseOrder"). */
  poNumberPath: z.string().trim().max(100).default('PurchaseOrder'),
});
export type SapPoApi = z.infer<typeof sapPoApiSchema>;

// A value saved before the cap (up to 240 s) is read as the cap, so an old setting still loads.
const storedSchema = sapPoApiSchema.omit({ password: true }).extend({
  passwordEnc: z.string().default(''),
  timeoutSeconds: z.number().int().default(60).transform((n) => Math.min(MAX_TIMEOUT_SECONDS, Math.max(5, n))),
});

export async function loadSapPoApi(db: Kysely<Database>, encKey: string): Promise<SapPoApi> {
  const stored = await readSetting(db, KEY);
  if (!stored) return sapPoApiSchema.parse({});
  const { passwordEnc, ...rest } = storedSchema.parse(stored);
  return { ...rest, password: passwordEnc ? decryptSecret(passwordEnc, encKey) : '' };
}

export async function saveSapPoApi(db: Kysely<Database>, encKey: string, input: SapPoApi, env = process.env.NODE_ENV): Promise<void> {
  const refused = sapPoApiProductionProblems(input, env);
  if (refused.length) throw new DomainError('SAP_PO_INSECURE', `Not saved: ${refused.join('; ')}.`, 422);
  const { password, ...rest } = sapPoApiSchema.parse(input);
  await writeSetting(db, KEY, { ...rest, passwordEnc: password ? encryptSecret(password, encKey) : '' });
}

/** A production server only talks to SAP over verified HTTPS: purchase orders and the SAP password never cross in clear text. */
export function sapPoApiProductionProblems(c: Pick<SapPoApi, 'mode' | 'baseUrl' | 'allowSelfSigned'>, env = process.env.NODE_ENV): string[] {
  if (env !== 'production' || c.mode !== 'api') return [];
  return [
    /^http:\/\//i.test(c.baseUrl.trim()) && 'a production server needs an https:// base URL',
    c.allowSelfSigned && 'a production server does not accept self-signed certificates',
  ].filter((x): x is string => !!x);
}

/** What is still missing (or refused on a production server) before "api" mode can send anything (empty = complete). */
export function sapPoApiProblems(c: SapPoApi, env = process.env.NODE_ENV): string[] {
  if (c.mode !== 'api') return [];
  return [
    ...sapPoApiProductionProblems(c, env),
    !/^https?:\/\//i.test(c.baseUrl) && 'Base URL (https://…)',
    !c.createPath && 'Create path',
    !c.lookupPath.includes('{reference}') && 'Lookup path with {reference}',
    !c.referenceField && 'SAP field for the portal reference',
    !c.poNumberPath && 'Where the PO number is in the reply',
    c.authType === 'basic' && (!c.user || !c.password) && 'User and password',
  ].filter((x): x is string => !!x);
}
