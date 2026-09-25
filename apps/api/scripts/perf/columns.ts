import { sql } from 'kysely';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/db.js';
const db = createDb(loadConfig());
const tabs = process.argv.slice(2);
for (const t of tabs) {
  const [s, n] = t.split('.');
  const cols = (await sql<{ c: string; ty: string; nul: boolean; def: string | null; comp: number; ident: number }>`
    SELECT c.name AS c, TYPE_NAME(c.user_type_id) + CASE WHEN TYPE_NAME(c.user_type_id) LIKE '%char' THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / CASE WHEN TYPE_NAME(c.user_type_id) LIKE 'n%' THEN 2 ELSE 1 END AS varchar) END + ')' ELSE '' END AS ty,
      c.is_nullable AS nul, OBJECT_DEFINITION(c.default_object_id) AS def, c.is_computed AS comp, c.is_identity AS ident
    FROM sys.columns c WHERE c.object_id = OBJECT_ID(${t}) ORDER BY c.column_id`.execute(db)).rows;
  const checks = (await sql<{ d: string }>`SELECT definition AS d FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID(${t})`.execute(db)).rows;
  console.log(`\n${t}: ` + cols.map((c) => `${c.c} ${c.ty}${c.ident ? ' IDENT' : ''}${c.comp ? ' COMPUTED' : ''}${c.nul ? ' null' : ''}${c.def ? ' =' + c.def : ''}`).join(' | '));
  if (checks.length) console.log('  CHECK ' + checks.map((c) => c.d).join(' ; '));
}
await db.destroy();
