/**
 * Origin map (spec 11): SAP material origin names ("Ecuador") → ISO country
 * codes ("EC"), because a supplier's origin is its SAP Country code. New names
 * are added and matched automatically after each materials sync; a manual
 * choice (a country or "Not a country") is never overwritten.
 */
import { sql } from 'kysely';
import { closeInbox, openInbox } from './inbox.js';
import { ConcurrencyError, NotFoundError } from './errors.js';
import { rowVerHex, type Db, type Tx } from './tx.js';

export const ORIGIN_PERMISSION = 'configuration.workflow.origins.edit';

/** "Côte d’Ivoire" → "cote d'ivoire"; "Bosnia & Herzegovina" → "bosnia and herzegovina". */
export const normalizeName = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

let byName: Map<string, string> | null = null;
/** English country name (normalized) → ISO 3166 alpha-2 code, from the runtime's region names. */
function countryNames(): Map<string, string> {
  if (byName) return byName;
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  byName = new Map();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      // Skip deprecated codes that share a name with the current one (FX = France, UK, SU, YU, …).
      if (Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`) continue;
      try {
        const n = names.of(code);
        if (n && n !== code) byName.set(normalizeName(n), code);
      } catch {
        /* not a region code */
      }
    }
  }
  return byName;
}

/** The ISO code for a country name, or null when it doesn't match exactly. */
export const matchCountryCode = (name: string): string | null => (name.trim() ? (countryNames().get(normalizeName(name)) ?? null) : null);

/** Country name for display ("EC" → "Ecuador"). */
export const countryName = (code: string | null) => {
  if (!code) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/**
 * Adds new origin names from md.Material, refreshes material counts, re-matches
 * Auto/Unmatched rows, and keeps the "Origins to map" exception in step.
 */
export async function refreshOrigins(db: Db): Promise<{ total: number; unmatched: number }> {
  const names = (await sql<{ Origin: string; n: number }>`SELECT Origin, COUNT(*) AS n FROM md.Material GROUP BY Origin`.execute(db)).rows;
  const rows = names.map((r) => {
    const code = matchCountryCode(r.Origin);
    return { OriginName: r.Origin, MaterialCount: Number(r.n), CountryCode: code, Source: code ? 'Auto' : 'Unmatched' };
  });
  await db.transaction().execute(async (tx) => {
    await sql`
      MERGE scm.RefOrigin AS t
      USING (SELECT * FROM OPENJSON(${JSON.stringify(rows)}) WITH (
        OriginName nvarchar(80), MaterialCount int, CountryCode nvarchar(3), Source nvarchar(12))) AS s
      ON t.OriginName = s.OriginName
      WHEN MATCHED THEN
        -- A manual choice (Manual / NotCountry) is never overwritten; only its material count changes.
        UPDATE SET MaterialCount = s.MaterialCount,
                   CountryCode = CASE WHEN t.Source IN ('Auto', 'Unmatched') THEN s.CountryCode ELSE t.CountryCode END,
                   Source = CASE WHEN t.Source IN ('Auto', 'Unmatched') THEN s.Source ELSE t.Source END,
                   UpdatedAt = SYSUTCDATETIME()
      WHEN NOT MATCHED BY TARGET THEN
        INSERT (OriginName, MaterialCount, CountryCode, Source) VALUES (s.OriginName, s.MaterialCount, s.CountryCode, s.Source)
      WHEN NOT MATCHED BY SOURCE THEN
        UPDATE SET MaterialCount = 0;`.execute(tx);
    await syncOriginException(tx);
  });
  const unmatched = await countUnmatched(db);
  return { total: rows.length, unmatched };
}

const countUnmatched = async (db: Db | Tx) =>
  Number((await db.selectFrom('scm.RefOrigin').select((eb) => eb.fn.countAll<number>().as('n')).where('Source', '=', 'Unmatched').where('MaterialCount', '>', 0).executeTakeFirstOrThrow()).n);

/** Opens or closes the single "Origins to map" exception. */
async function syncOriginException(db: Db | Tx): Promise<void> {
  const n = await countUnmatched(db);
  if (n > 0) {
    await openInbox(db, {
      itemType: 'ORIGIN_UNMATCHED', permission: ORIGIN_PERMISSION, companyCode: null, entityType: 'REF_ORIGIN', entityId: 'ALL',
      number: 'ORIGINS', title: `${n} material origin name(s) not mapped to a country`,
      note: 'Pick a country or mark "Not a country" in Configuration → Origins.', link: '/settings?tab=origins', raisedBy: null,
    });
  } else {
    await closeInbox(db, 'ORIGIN_UNMATCHED', 'REF_ORIGIN', 'ALL', null);
  }
}

export async function listOrigins(db: Db, unmatchedOnly: boolean) {
  let q = db.selectFrom('scm.RefOrigin').select(['OriginName', 'CountryCode', 'Source', 'MaterialCount', rowVerHex().as('RowVer')]);
  if (unmatchedOnly) q = q.where('Source', '=', 'Unmatched');
  const rows = await q
    .orderBy(sql`CASE Source WHEN 'Unmatched' THEN 0 ELSE 1 END`)
    .orderBy('MaterialCount', 'desc')
    .orderBy('OriginName')
    .execute();
  return rows.map((r) => ({ ...r, MaterialCount: Number(r.MaterialCount), CountryName: countryName(r.CountryCode) }));
}

/** Manual choice: a country code, or "not a country" (countryCode null). */
export async function setOrigin(db: Db, originName: string, countryCode: string | null, rowVer: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const r = await sql`
      UPDATE scm.RefOrigin
      SET CountryCode = ${countryCode}, Source = ${countryCode ? 'Manual' : 'NotCountry'}, UpdatedAt = SYSUTCDATETIME()
      WHERE OriginName = ${originName} AND RowVer = CONVERT(binary(8), ${rowVer}, 2)`.execute(tx);
    if (Number(r.numAffectedRows ?? 0) !== 1) {
      const exists = await tx.selectFrom('scm.RefOrigin').select('OriginName').where('OriginName', '=', originName).executeTakeFirst();
      throw exists ? new ConcurrencyError('Origin', originName) : new NotFoundError(`Origin ${originName}`);
    }
    await syncOriginException(tx);
  });
}

/** Every ISO country, for the picker. */
export const countryOptions = () =>
  [...countryNames().entries()].map(([, code]) => ({ code, name: countryName(code) })).filter((c, i, a) => a.findIndex((x) => x.code === c.code) === i).sort((a, b) => a.name.localeCompare(b.name));
