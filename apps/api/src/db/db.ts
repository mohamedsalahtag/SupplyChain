import { Kysely } from 'kysely';
import type { Config } from '../config.js';
import { OdbcMssqlDialect } from './odbcDialect.js';
import type { Database } from './schema.js';

/** ODBC connection string. No DB_USER → Windows login of the account running the app. */
export function connectionString(cfg: Config): string {
  const parts = [
    'Driver={ODBC Driver 18 for SQL Server}',
    `Server=${cfg.DB_SERVER},${cfg.DB_PORT}`,
    `Database=${cfg.DB_NAME}`,
    cfg.DB_USER ? `UID=${cfg.DB_USER};PWD=${cfg.DB_PASSWORD}` : 'Trusted_Connection=Yes',
    `Encrypt=${cfg.DB_ENCRYPT ? 'Yes' : 'No'}`,
    `TrustServerCertificate=${cfg.DB_TRUST_SERVER_CERT ? 'Yes' : 'No'}`,
  ];
  return parts.join(';') + ';';
}

export function createDb(cfg: Config): Kysely<Database> {
  return new Kysely<Database>({ dialect: new OdbcMssqlDialect(connectionString(cfg)) });
}
