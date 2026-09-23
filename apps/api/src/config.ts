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
