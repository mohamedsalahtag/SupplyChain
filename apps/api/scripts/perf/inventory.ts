/** Schema inventory for the database review: tables, rows, keys, FKs, indexes, FK columns without an index. Read-only. */
import { sql } from 'kysely';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/db.js';

const db = createDb(loadConfig());
const q = async <T,>(s: ReturnType<typeof sql>) => (await (s as ReturnType<typeof sql<T>>).execute(db)).rows as T[];

const tables = await q<{ t: string; rows: number; kb: number; heap: number }>(sql`
  SELECT s.name + '.' + t.name AS t, SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows END) AS rows,
    SUM(a.total_pages) * 8 AS kb, MAX(CASE WHEN i.index_id = 0 THEN 1 ELSE 0 END) AS heap
  FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
  JOIN sys.indexes i ON i.object_id = t.object_id JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id = i.index_id
  JOIN sys.allocation_units a ON a.container_id = p.partition_id
  GROUP BY s.name, t.name ORDER BY SUM(a.total_pages) DESC`);
console.log('## TABLES (rows, KB, heap)');
for (const t of tables) console.log(`${t.t}\t${t.rows}\t${t.kb}\t${t.heap ? 'HEAP' : ''}`);

const idx = await q<{ t: string; name: string; type: string; uniq: boolean; cols: string; inc: string | null; filt: string | null }>(sql`
  SELECT OBJECT_SCHEMA_NAME(i.object_id) + '.' + OBJECT_NAME(i.object_id) AS t, i.name, i.type_desc AS type, i.is_unique AS uniq,
    (SELECT STUFF((SELECT ',' + c.name + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 1, '')) AS cols,
    (SELECT STUFF((SELECT ',' + c.name FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1 FOR XML PATH('')), 1, 1, '')) AS inc,
    i.filter_definition AS filt
  FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id WHERE i.index_id > 0 ORDER BY 1, i.index_id`);
console.log('\n## INDEXES');
for (const i of idx) console.log(`${i.t}\t${i.name}\t${i.type}${i.uniq ? ' UNIQUE' : ''}\t(${i.cols})${i.inc ? ` INCLUDE(${i.inc})` : ''}${i.filt ? ` WHERE ${i.filt}` : ''}`);

const fks = await q<{ fk: string; child: string; cols: string; parent: string; indexed: number }>(sql`
  SELECT f.name AS fk, OBJECT_SCHEMA_NAME(f.parent_object_id) + '.' + OBJECT_NAME(f.parent_object_id) AS child,
    (SELECT STUFF((SELECT ',' + c.name FROM sys.foreign_key_columns fc JOIN sys.columns c ON c.object_id = fc.parent_object_id AND c.column_id = fc.parent_column_id
      WHERE fc.constraint_object_id = f.object_id ORDER BY fc.constraint_column_id FOR XML PATH('')), 1, 1, '')) AS cols,
    OBJECT_SCHEMA_NAME(f.referenced_object_id) + '.' + OBJECT_NAME(f.referenced_object_id) AS parent,
    CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.foreign_key_columns fc ON fc.parent_object_id = ic.object_id AND fc.parent_column_id = ic.column_id
      WHERE fc.constraint_object_id = f.object_id AND fc.constraint_column_id = 1 AND ic.key_ordinal = 1) THEN 1 ELSE 0 END AS indexed
  FROM sys.foreign_keys f ORDER BY 2, 1`);
console.log('\n## FOREIGN KEYS (child cols -> parent, leading index on child?)');
for (const f of fks) console.log(`${f.child}(${f.cols}) -> ${f.parent}\t${f.indexed ? 'indexed' : 'NO INDEX'}`);

const opts = await q<{ name: string; rcsi: boolean; snap: string; compat: number; recovery: string; ver: string }>(sql`
  SELECT d.name, d.is_read_committed_snapshot_on AS rcsi, d.snapshot_isolation_state_desc AS snap, d.compatibility_level AS compat, d.recovery_model_desc AS recovery, @@VERSION AS ver
  FROM sys.databases d WHERE d.name = DB_NAME()`);
console.log('\n## DATABASE', JSON.stringify(opts[0]));
await db.destroy();
