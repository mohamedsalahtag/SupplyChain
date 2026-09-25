/**
 * Runs the DB integration tests with enough Node worker threads (see dev.mjs for why
 * UV_THREADPOOL_SIZE must be set before Node starts). Extra arguments go to vitest.
 */
import { spawn } from 'node:child_process';

const env = { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32' };
const child = spawn('npx', ['vitest', 'run', '--config', 'vitest.db.config.ts', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
