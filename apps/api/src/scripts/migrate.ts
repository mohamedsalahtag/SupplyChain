/**
 * Applies db/migrations/*.sql in filename order. Each file runs once, inside a
 * transaction, and is recorded in dbo.SchemaMigration. Batches are separated
 * by a line containing only GO.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { loadConfig } from '../config.js';
import { createDb } from '../db/db.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');

const db = createDb(loadConfig());

try {
  await sql`
    IF OBJECT_ID('dbo.SchemaMigration', 'U') IS NULL
      CREATE TABLE dbo.SchemaMigration (
        FileName  nvarchar(200) NOT NULL PRIMARY KEY,
        AppliedAt datetime2(0)  NOT NULL DEFAULT SYSUTCDATETIME()
      )`.execute(db);

  const applied = new Set(
    (await sql<{ FileName: string }>`SELECT FileName FROM dbo.SchemaMigration`.execute(db)).rows.map(
      (r) => r.FileName,
    ),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) console.log('Database is up to date.');

  for (const file of pending) {
    const text = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const batches = text
      .split(/^\s*GO\s*$/im)
      .map((b) => b.trim())
      .filter(Boolean);

    await db.transaction().execute(async (trx) => {
      for (const batch of batches) await sql.raw(batch).execute(trx);
      await sql`INSERT INTO dbo.SchemaMigration (FileName) VALUES (${file})`.execute(trx);
    });
    console.log(`Applied ${file}`);
  }
} finally {
  await db.destroy();
}
