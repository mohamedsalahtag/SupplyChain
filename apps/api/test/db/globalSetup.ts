/**
 * Recreates the test database and applies every migration to it, once per run.
 * Refuses to touch any database whose name does not end in "_test".
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/db.js';
import './env.js';

export default async function setup() {
  const name = process.env.DB_NAME!;
  if (!/_test$/.test(name)) throw new Error(`Refusing to recreate "${name}": test database names must end in _test`);

  const master = createDb({ ...loadConfig(), DB_NAME: 'master' });
  try {
    await sql
      .raw(`IF DB_ID('${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; END; CREATE DATABASE [${name}];`)
      .execute(master);
  } finally {
    await master.destroy();
  }

  const apiDir = resolve(import.meta.dirname, '../..');
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/migrate.ts'], { cwd: apiDir, env: process.env, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`Migrations failed on ${name}:\n${run.stdout}\n${run.stderr}`);
}
