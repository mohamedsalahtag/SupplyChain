/** Every database test uses the throw-away test database, never the real one. */
import { resolve } from 'node:path';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../../.env'));
} catch {
  /* the variables may already be set */
}
process.env.DB_NAME = process.env.TEST_DB_NAME || 'supplychain_test';
