import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGODB_URI: z.string().min(1),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  FRONTEND_URL: z.string().url(),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  AWS_REGION: z.string().min(1),
  AWS_S3_BUCKET: z.string().min(3),
  // Optional: leave empty to use the default credential provider chain (IAM role, SSO, env).
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  // Optional: S3-compatible endpoint for local development (e.g. MinIO). Leave empty for AWS.
  AWS_S3_ENDPOINT: z.string().url().optional(),
  AWS_S3_FORCE_PATH_STYLE: bool.default(false),

  MAX_FILE_SIZE_MB: z.coerce.number().positive().default(5120),
  MAX_USER_STORAGE_MB: z.coerce.number().positive().default(15360),
  MULTIPART_THRESHOLD_MB: z.coerce.number().positive().default(64),
  MULTIPART_PART_SIZE_MB: z.coerce.number().min(5).default(16),
  PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  UPLOAD_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).default(24 * 60),
  CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(15),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const raw = { ...process.env };
  for (const key of Object.keys(raw)) {
    if (raw[key] === '') delete raw[key];
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.FRONTEND_URL.startsWith('http://')) {
    throw new Error('FRONTEND_URL must use https in production');
  }
  if (Boolean(env.AWS_ACCESS_KEY_ID) !== Boolean(env.AWS_SECRET_ACCESS_KEY)) {
    throw new Error('Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or neither');
  }
  return env;
}

export const env = load();

const MB = 1024 * 1024;
export const limits = {
  maxFileSize: Math.floor(env.MAX_FILE_SIZE_MB * MB),
  defaultQuota: Math.floor(env.MAX_USER_STORAGE_MB * MB),
  multipartThreshold: Math.floor(env.MULTIPART_THRESHOLD_MB * MB),
  partSize: Math.floor(env.MULTIPART_PART_SIZE_MB * MB),
  maxParts: 10_000,
};
export const isProd = env.NODE_ENV === 'production';
