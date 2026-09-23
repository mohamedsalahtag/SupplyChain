/** Read/write one JSON value in app.Setting (app-wide settings). */
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/schema.js';

export async function readSetting(db: Kysely<Database>, key: string): Promise<unknown> {
  const row = await db.selectFrom('app.Setting').select('SettingValue').where('SettingKey', '=', key).executeTakeFirst();
  return row?.SettingValue ? JSON.parse(row.SettingValue) : null;
}

export async function writeSetting(db: Kysely<Database>, key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('app.Setting')
      .set({ SettingValue: json, UpdatedAt: sql<Date>`SYSUTCDATETIME()` })
      .where('SettingKey', '=', key)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) {
      await trx.insertInto('app.Setting').values({ SettingKey: key, SettingValue: json, UpdatedAt: sql<Date>`SYSUTCDATETIME()` }).execute();
    }
  });
}
