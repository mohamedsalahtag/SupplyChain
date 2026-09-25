/**
 * Global invariant suite (plan v5 §6): every tests/invariants/*.sql must return
 * zero rows. Invariants are added from Stage 1 on (see §6.1); each file names
 * its invariant in a comment on the first line.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from './helpers.js';

const DIR = resolve(import.meta.dirname, '../../../../tests/invariants');
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

afterAll(() => db.destroy());

describe('global invariants', () => {
  it('the invariant folder exists', () => {
    expect(Array.isArray(files)).toBe(true);
  });
  for (const file of files) {
    it(file, async () => {
      const rows = (await sql.raw(readFileSync(join(DIR, file), 'utf8')).execute(db)).rows;
      expect(rows, `${file} returned violating rows`).toEqual([]);
    });
  }
});
