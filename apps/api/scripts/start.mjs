/**
 * Production start (npm start): the API without watch mode, with enough Node worker threads (see dev.mjs).
 * With SERVE_WEB=true it also serves the built web app (npm run build) — one process, one HTTPS port.
 */
import { spawn } from 'node:child_process';

const env = { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '32' };
const child = spawn('npx', ['tsx', '--env-file-if-exists=../../.env', 'src/server.ts'], { stdio: 'inherit', env, shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
