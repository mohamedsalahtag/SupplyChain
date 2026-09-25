/**
 * Workflow settings (spec 11, Configuration → Workflow). One JSON value in
 * app.Setting; its UpdatedAt is the version the UI sends back on save.
 */
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { readSetting } from '../../settings/store.js';
import { ConcurrencyError } from './errors.js';
import type { Db, Tx } from './tx.js';

const KEY = 'wf.settings';
const DECIMAL = /^\d{1,9}(\.\d{1,3})?$/;

export const wfSettingsSchema = z.object({
  /** Hours from creation until an item of that type is due; null = no due date. */
  dueHours: z.record(z.string().max(60), z.number().int().min(1).max(24 * 90).nullable()).default({}),
  agingWeeksBeforeEtd: z.number().int().min(0).max(52).default(4),
  masterDataMaxAgeHours: z.number().int().min(1).max(24 * 30).default(26),
  historyLookbackMonths: z.number().int().min(1).max(120).default(36),
  /** Minimum quantity increment per unit of measure, as a decimal string ("1", "0.001"). */
  minIncrement: z.record(z.string().max(10), z.string().regex(DECIMAL)).default({ CT: '1' }), // SAP's carton unit is CT
  attachmentMaxMb: z.number().int().min(1).max(100).default(20),
  /** Spec 24: a PO is on time when SAP created it at least this many days before the confirmed ETD. */
  kpiOnTimeDaysBeforeEtd: z.number().int().min(0).max(90).default(7),
});
export type WfSettings = z.infer<typeof wfSettingsSchema>;

export async function loadWfSettings(db: Db | Tx): Promise<WfSettings> {
  const parsed = wfSettingsSchema.safeParse((await readSetting(db as Db, KEY)) ?? {});
  return parsed.success ? parsed.data : wfSettingsSchema.parse({});
}

/**
 * The version token of the saved settings ('' when never saved): the save time
 * plus a hash of the value, because UpdatedAt only has whole seconds.
 */
export async function wfSettingsVersion(db: Db | Tx): Promise<string> {
  const row = await db.selectFrom('app.Setting').select(['UpdatedAt', 'SettingValue']).where('SettingKey', '=', KEY).executeTakeFirst();
  return tokenOf(row);
}
const tokenOf = (row: { UpdatedAt: Date; SettingValue: string | null } | undefined) =>
  row ? `${row.UpdatedAt.toISOString()}|${createHash('sha256').update(row.SettingValue ?? '').digest('hex').slice(0, 16)}` : '';

/** Saves only if nobody saved since `version` was read. */
export async function saveWfSettings(db: Db, input: WfSettings, version: string): Promise<void> {
  const json = JSON.stringify(wfSettingsSchema.parse(input));
  await db.transaction().execute(async (trx) => {
    const current = (await sql<{ UpdatedAt: Date; SettingValue: string | null }>`
      SELECT UpdatedAt, SettingValue FROM app.Setting WITH (UPDLOCK, HOLDLOCK) WHERE SettingKey = ${KEY}`.execute(trx)).rows[0];
    if (tokenOf(current) !== version) throw new ConcurrencyError('Workflow settings', KEY);
    if (current) {
      await trx.updateTable('app.Setting').set({ SettingValue: json, UpdatedAt: sql<Date>`SYSUTCDATETIME()` }).where('SettingKey', '=', KEY).execute();
    } else {
      await trx.insertInto('app.Setting').values({ SettingKey: KEY, SettingValue: json, UpdatedAt: sql<Date>`SYSUTCDATETIME()` }).execute();
    }
  });
}
