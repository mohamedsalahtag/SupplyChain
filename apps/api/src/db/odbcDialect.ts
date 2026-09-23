/**
 * Kysely dialect for SQL Server over ODBC (mssql + msnodesqlv8), so the app
 * can sign in with the Windows account it runs under. Kysely's built-in
 * MssqlDialect uses tedious, which cannot do Windows integrated auth.
 * SQL generation is Kysely's own MSSQL compiler; only the transport differs.
 */
import {
  CompiledQuery,
  MssqlAdapter,
  MssqlIntrospector,
  MssqlQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';
import sql from 'mssql/msnodesqlv8.js';

const ISOLATION: Record<string, sql.IIsolationLevel> = {
  'read uncommitted': sql.ISOLATION_LEVEL.READ_UNCOMMITTED,
  'read committed': sql.ISOLATION_LEVEL.READ_COMMITTED,
  'repeatable read': sql.ISOLATION_LEVEL.REPEATABLE_READ,
  serializable: sql.ISOLATION_LEVEL.SERIALIZABLE,
  snapshot: sql.ISOLATION_LEVEL.SNAPSHOT,
};

class OdbcConnection implements DatabaseConnection {
  #tx: sql.Transaction | null = null;

  constructor(private readonly pool: sql.ConnectionPool) {}

  async begin(settings: TransactionSettings): Promise<void> {
    this.#tx = new sql.Transaction(this.pool);
    const level = settings.isolationLevel ? ISOLATION[settings.isolationLevel] : undefined;
    await this.#tx.begin(level);
  }

  async end(commit: boolean): Promise<void> {
    const tx = this.#tx;
    this.#tx = null;
    if (!tx) return;
    await (commit ? tx.commit() : tx.rollback());
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const request = this.#tx ? new sql.Request(this.#tx) : this.pool.request();
    // Kysely's MSSQL compiler names parameters @1, @2, …
    query.parameters.forEach((value, i) => request.input(String(i + 1), value));
    const result = await request.query(query.sql);
    const affected = result.rowsAffected.reduce((a, b) => a + b, 0);
    return {
      rows: (result.recordset ?? []) as R[],
      numAffectedRows: BigInt(affected),
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming queries are not supported by the ODBC driver');
  }
}

class OdbcDriver implements Driver {
  #pool: sql.ConnectionPool;

  constructor(connectionString: string) {
    // msnodesqlv8 accepts a raw ODBC connection string; @types/mssql doesn't model it.
    this.#pool = new sql.ConnectionPool({ connectionString } as unknown as sql.config);
  }

  async init(): Promise<void> {
    await this.#pool.connect();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new OdbcConnection(this.#pool);
  }

  async beginTransaction(conn: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    await (conn as OdbcConnection).begin(settings);
  }

  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as OdbcConnection).end(true);
  }

  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as OdbcConnection).end(false);
  }

  async releaseConnection(): Promise<void> {
    // Connections come from the shared pool per request; nothing to release.
  }

  async destroy(): Promise<void> {
    await this.#pool.close();
  }
}

export class OdbcMssqlDialect implements Dialect {
  constructor(private readonly connectionString: string) {}

  createDriver(): Driver {
    return new OdbcDriver(this.connectionString);
  }
  createQueryCompiler() {
    return new MssqlQueryCompiler();
  }
  createAdapter() {
    return new MssqlAdapter();
  }
  createIntrospector(db: Kysely<any>) {
    return new MssqlIntrospector(db);
  }
}
