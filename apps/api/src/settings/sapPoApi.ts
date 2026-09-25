/**
 * Configuration → SAP purchase orders (spec 23): where the PO outbox sends purchase orders.
 * "stub" = the built-in simulator; "api" = the company's PO API (provided later), called by the HTTP adapter.
 * Stored as one JSON row in app.Setting, the password encrypted like the SAP connection.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './secret.js';
import { readSetting, writeSetting } from './store.js';

const KEY = 'sap.poApi';

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
  /** Must stay below the outbox lease (5 minutes), or a slow reply could race a re-claim. */
  timeoutSeconds: z.number().int().min(5).max(240).default(60),
  /** The SAP PO field that stores the portal reference (POD-…); required so unknown outcomes can be found. */
  referenceField: z.string().trim().max(60).default(''),
  /** Where the PO number is in SAP's reply, as a dot path (e.g. "d.PurchaseOrder" or "PurchaseOrder"). */
  poNumberPath: z.string().trim().max(100).default('PurchaseOrder'),
});
export type SapPoApi = z.infer<typeof sapPoApiSchema>;

const storedSchema = sapPoApiSchema.omit({ password: true }).extend({ passwordEnc: z.string().default('') });

export async function loadSapPoApi(db: Kysely<Database>, encKey: string): Promise<SapPoApi> {
  const stored = await readSetting(db, KEY);
  if (!stored) return sapPoApiSchema.parse({});
  const { passwordEnc, ...rest } = storedSchema.parse(stored);
  return { ...rest, password: passwordEnc ? decryptSecret(passwordEnc, encKey) : '' };
}

export async function saveSapPoApi(db: Kysely<Database>, encKey: string, input: SapPoApi): Promise<void> {
  const { password, ...rest } = sapPoApiSchema.parse(input);
  await writeSetting(db, KEY, { ...rest, passwordEnc: password ? encryptSecret(password, encKey) : '' });
}

/** What is still missing before "api" mode can send anything (empty = complete). */
export function sapPoApiProblems(c: SapPoApi): string[] {
  if (c.mode !== 'api') return [];
  return [
    !/^https?:\/\//i.test(c.baseUrl) && 'Base URL (https://…)',
    !c.createPath && 'Create path',
    !c.lookupPath.includes('{reference}') && 'Lookup path with {reference}',
    !c.referenceField && 'SAP field for the portal reference',
    !c.poNumberPath && 'Where the PO number is in the reply',
    c.authType === 'basic' && (!c.user || !c.password) && 'User and password',
  ].filter((x): x is string => !!x);
}
