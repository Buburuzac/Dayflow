import { z } from 'zod'

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true')

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(/[,\s;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PUBLIC_URL: z.string().url().default('http://localhost:8790'),
  PORT: z.coerce.number().int().default(8790),
  HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_WEB_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_TOKEN_URL: z.string().url().default('https://oauth2.googleapis.com/token'),
  GOOGLE_JWKS_URL: z.string().url().default('https://www.googleapis.com/oauth2/v3/certs'),
  ALLOWED_EMAIL_DOMAINS: list,
  BOOTSTRAP_ADMIN_EMAILS: list,
  DEV_AUTH: bool,
  ODOO_URL: z.string().optional().default(''),
  ODOO_DB: z.string().optional().default(''),
  ODOO_LOGIN: z.string().optional().default(''),
  ODOO_API_KEY: z.string().optional().default(''),
  WEB_DIST: z.string().optional().default(''),
  LOG_LEVEL: z.string().default('info'),
  /** requests per minute and IP on sign-in / web-link / invite endpoints */
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(20),
  /** Trust X-Forwarded-For (only behind a reverse proxy). */
  TRUST_PROXY: bool,
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid configuration: ${msg}`)
  }
  return parsed.data
}
