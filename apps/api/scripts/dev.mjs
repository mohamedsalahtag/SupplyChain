/**
 * Starts the API in watch mode with enough Node worker threads.
 * The ODBC driver runs every query on a worker thread. UV_THREADPOOL_SIZE must be in the real
 * environment before Node starts (a value from --env-file comes too late), and above DB_POOL_MAX:
 * otherwise reads blocked behind a transaction's locks can take every thread, so that transaction
 * never sends its next statement — a stall SQL Server cannot see, ended only by the query timeout.
 */
import { spawn } from 'node:child_process';

const env = { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32' };
const child = spawn('npx', ['tsx', 'watch', '--env-file-if-exists=../../.env', 'src/server.ts'], { stdio: 'inherit', env, shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
