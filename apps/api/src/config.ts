import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  DB_SERVER: z.string().min(1),
  DB_PORT: z.coerce.number().int().default(1433),
  DB_NAME: z.string().min(1),
  /** Leave empty to sign in with the Windows account running the app. */
  DB_USER: z.string().default(''),
  DB_PASSWORD: z.string().default(''),
  DB_ENCRYPT: bool,
  DB_TRUST_SERVER_CERT: bool,
  SETTINGS_ENCRYPTION_KEY: z.string().min(1, 'SETTINGS_ENCRYPTION_KEY is empty — see .env.example'),
  API_PORT: z.coerce.number().int().default(4300),
  /** Database connections in the pool. Must stay below UV_THREADPOOL_SIZE (see .env.example). */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  LOG_LEVEL: z.string().default('info'),
  /** Signs the login cookie. 32+ random bytes, base64. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET is missing or too short — see .env.example'),
  /** Created as Administrator when the app has no users yet. */
  BOOTSTRAP_ADMIN: z.string().default(''),
  /** Active Directory defaults, used until Configuration → Active Directory is saved. */
  AD_URL: z.string().default('ldaps://192.168.2.19:636'),
  AD_BASE_DN: z.string().default('DC=sharbatlyfruit,DC=com'),
  AD_UPN_SUFFIX: z.string().default('sharbatlyfruit.com'),
  /** Local test runs only: allows signing in as a registered user without a password, from localhost. Never on a server. */
  ALLOW_TEST_LOGIN: bool,
  /** Administrators may switch into demo accounts (View as, spec 16) to test other departments. Off on the live server. */
  ALLOW_VIEW_AS: bool,
  /** Where PO drafts are sent. Only the stub exists until the SAP (ZCON) adapter (plan v5 Stage 9). */
  SAP_PO_ADAPTER: z.enum(['stub']).default('stub'),
  /** A production server (NODE_ENV=production) refuses the stub unless this is set, e.g. for a UAT server. */
  ALLOW_SAP_STUB: bool,
  /** Folder for workflow attachments; empty = <repo>/data/attachments. */
  ATTACHMENTS_DIR: z.string().default(''),
});

export type Config = z.infer<typeof schema>;

/** Settings a live server must never run with (security review 2026-09): refuses to start instead of warning. */
export function productionProblems(cfg: Config, env = process.env.NODE_ENV): string[] {
  if (env !== 'production') return [];
  return [
    cfg.ALLOW_TEST_LOGIN && 'ALLOW_TEST_LOGIN must be false',
    cfg.ALLOW_VIEW_AS && 'ALLOW_VIEW_AS must be false',
    cfg.SAP_PO_ADAPTER === 'stub' && !cfg.ALLOW_SAP_STUB && 'SAP_PO_ADAPTER is the stub: purchase orders would not reach SAP (set ALLOW_SAP_STUB=true only on a test server)',
  ].filter((x): x is string => !!x);
}

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration (.env at repo root):\n${problems}`);
  }
  return parsed.data;
}
