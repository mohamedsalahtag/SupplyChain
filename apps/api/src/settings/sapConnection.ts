/** The SAP connection, stored as one JSON row in app.Setting with the password encrypted. */
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './secret.js';
import { readSetting, writeSetting } from './store.js';

const KEY = 'sap.connection';

/** Service roots on the same SAP gateway (same base URL and login). */
export const DEFAULT_SUPPLIERS_PATH = '/sap/opu/odata/sap/API_BUSINESS_PARTNER';
export const DEFAULT_PURCHASE_ORDERS_PATH = '/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001';

export const sapConnectionSchema = z.object({
  baseUrl: z.string().url(),
  /** Full path to the materials entity set (OData v2). */
  materialsPath: z.string().min(1),
  /** Service root of API_BUSINESS_PARTNER (OData v2). */
  suppliersPath: z.string().min(1).default(DEFAULT_SUPPLIERS_PATH),
  /** Service root of API_PURCHASEORDER_2 (OData v4) — the data root, not its $metadata. */
  purchaseOrdersPath: z.string().min(1).default(DEFAULT_PURCHASE_ORDERS_PATH),
  sapClient: z.string().default(''),
  user: z.string().min(1),
  password: z.string().min(1),
  allowSelfSigned: z.boolean().default(false),
});
export type SapConnection = z.infer<typeof sapConnectionSchema>;

const storedSchema = sapConnectionSchema.omit({ password: true }).extend({ passwordEnc: z.string() });

export async function loadSapConnection(db: Kysely<Database>, encKey: string): Promise<SapConnection | null> {
  const stored = await readSetting(db, KEY);
  if (!stored) return null;
  const { passwordEnc, ...rest } = storedSchema.parse(stored);
  return { ...rest, password: decryptSecret(passwordEnc, encKey) };
}

export async function saveSapConnection(db: Kysely<Database>, encKey: string, input: SapConnection): Promise<void> {
  const { password, ...rest } = sapConnectionSchema.parse(input);
  await writeSetting(db, KEY, { ...rest, passwordEnc: encryptSecret(password, encKey) });
}
