/**
 * "Load the list from SAP, then choose": the codes SAP offers (with how many
 * rows use each), cached in app.Setting so the page shows them without asking
 * SAP again.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/schema.js';
import { readSetting, writeSetting } from '../../settings/store.js';

const codeCountsSchema = z.object({
  codes: z.array(z.object({ code: z.string(), count: z.number() })),
  checkedAt: z.string(),
});
export type CodeCounts = z.infer<typeof codeCountsSchema>;

export async function loadCodeCounts(db: Kysely<Database>, key: string): Promise<CodeCounts | null> {
  const parsed = codeCountsSchema.safeParse(await readSetting(db, key));
  return parsed.success ? parsed.data : null;
}

/** Counts one field over SAP rows, keeping only codes that pass `keep`, largest first, and stores the result. */
export async function storeCodeCounts(
  db: Kysely<Database>,
  key: string,
  rows: Record<string, unknown>[],
  field: string,
  keep: (code: string) => boolean,
): Promise<CodeCounts> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const code = String(r[field] ?? '').trim();
    if (code && keep(code)) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const result: CodeCounts = {
    codes: [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    checkedAt: new Date().toISOString(),
  };
  await writeSetting(db, key, result);
  return result;
}
