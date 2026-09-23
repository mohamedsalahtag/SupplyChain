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
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration (.env at repo root):\n${problems}`);
  }
  return parsed.data;
}
