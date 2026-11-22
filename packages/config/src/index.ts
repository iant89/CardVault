import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('postgres://cardvault:cardvault@localhost:5432/cardvault'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters').default(
    'dev-only-insecure-session-secret-change-me-please',
  ),
  STORAGE_DIR: z.string().default('./storage'),
  API_PORT: z.coerce.number().int().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  COOKIE_SECURE: bool.default(false),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 14),
  MAX_UPLOAD_MB: z.coerce.number().default(15),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().optional(),
  POKEMONTCG_API_KEY: z.string().optional(),
  EBAY_CLIENT_ID: z.string().optional(),
  EBAY_CLIENT_SECRET: z.string().optional(),
  EBAY_MARKETPLACE_ID: z.string().default('EBAY_US'),
  CRAWLER_USER_AGENT: z.string().default('CardVault/0.1 (self-hosted personal collection tool)'),
  RESEARCH_REFRESH_HOURS: z.coerce.number().default(24),
  WORKER_CONCURRENCY: z.coerce.number().int().default(2),
  OCR_ENABLED: bool.default(true),
  OCR_LANG_PATH: z.string().optional(),
  /** Developer menu (admins only): tools under tools/ that CardVault can start and open. */
  DEV_TOOLS: bool.default(true),
  /** TCGdex Harvester: localhost port, its folder (found automatically), and where it saves downloads. */
  HARVESTER_PORT: z.coerce.number().int().default(4777),
  HARVESTER_DIR: z.string().optional(),
  HARVESTER_OUT_DIR: z.string().optional(),
  /** Override the TCGdex API address (testing against tools/tcgdex-harvester/test/mock-tcgdex.mjs). */
  HARVESTER_API: z.string().url().optional(),
  /** OCR model live trial: confirmed lines needed before a model may be promoted (0 = no trial required). */
  OCR_TRIAL_MIN_LINES: z.coerce.number().int().min(0).default(40),
  /** OCR live watch: confirmed lines / scans needed on each side before judging an active model. */
  OCR_WATCH_MIN_LINES: z.coerce.number().int().min(1).default(30),
  OCR_WATCH_MIN_SCANS: z.coerce.number().int().min(1).default(20),
  /** Roll an active model back if live accuracy drops by more than this, or manual reviews rise by more than this. */
  OCR_WATCH_MAX_DROP: z.coerce.number().min(0).max(1).default(0.05),
  OCR_WATCH_MAX_REVIEW_RISE: z.coerce.number().min(0).max(1).default(0.15),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(clean);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid CardVault configuration:\n${msg}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.SESSION_SECRET.startsWith('dev-only')) {
    throw new Error('SESSION_SECRET must be set in production');
  }
  if (env === process.env) cached = parsed.data;
  return parsed.data;
}
