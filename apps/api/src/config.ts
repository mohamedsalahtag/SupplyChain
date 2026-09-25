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
  /** Where PO drafts go is chosen in Configuration → SAP purchase orders. On a production server (NODE_ENV=production)
   *  the simulator is refused at submit unless this is true — set it only on a UAT/test server. */
  ALLOW_SAP_STUB: bool,
  /** Address the API listens on. Behind a reverse proxy use 127.0.0.1. */
  HOST: z.string().default('0.0.0.0'),
  /** HTTPS directly in the API: a .pfx/.p12 file (+ passphrase), or a PEM certificate + key. Paths on the server. */
  TLS_PFX_FILE: z.string().default(''),
  TLS_PFX_PASSPHRASE: z.string().default(''),
  TLS_CERT_FILE: z.string().default(''),
  TLS_KEY_FILE: z.string().default(''),
  /** true when an HTTPS reverse proxy (IIS ARR, nginx) is in front: the proxy's https is trusted for secure cookies. */
  TRUST_PROXY: bool,
  /** Production: the API also serves the built web app (npm run build) from this folder; empty = <repo>/apps/web/dist. */
  SERVE_WEB: bool,
  WEB_DIST: z.string().default(''),
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
    !(cfg.TLS_PFX_FILE || (cfg.TLS_CERT_FILE && cfg.TLS_KEY_FILE) || cfg.TRUST_PROXY) &&
      'no HTTPS: set TLS_PFX_FILE (or TLS_CERT_FILE + TLS_KEY_FILE), or TRUST_PROXY=true behind an HTTPS reverse proxy — passwords must never cross the network in clear text',
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
