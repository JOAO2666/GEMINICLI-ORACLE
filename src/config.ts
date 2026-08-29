import path from 'node:path';
import { z } from 'zod';

const bool = z.string().optional().transform((v) => v === 'true');
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: positiveInt(3000),
  NUMIA_SERVER_TOKEN: z.string().min(32),
  ALLOWED_ORIGINS: z.string().default(''),
  ALLOWED_MODELS: z.string().default('gemini-3.1-pro-high,gemini-3.1-pro-low'),
  DEFAULT_MODEL: z.string().default('gemini-3.1-pro-high'),
  MAX_GEMINI_PROCESSES: positiveInt(2),
  AGY_TIMEOUT_MS: positiveInt(300_000),
  AGY_COMMAND: z.string().default('agy'),
  DATA_DIR: z.string().default(path.resolve('data')),
  MAX_UPLOAD_BYTES: positiveInt(25 * 1024 * 1024),
  MAX_FILES_PER_UPLOAD: positiveInt(8),
  FILE_RETENTION_HOURS: positiveInt(24),
  MAX_HISTORY_CHARS: positiveInt(120_000),
  RATE_LIMIT_MAX: positiveInt(60),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  TRUST_PROXY: bool,
  REQUIRE_HTTPS: bool
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const allowedModels = parsed.ALLOWED_MODELS.split(',').map((v) => v.trim()).filter(Boolean);
  if (!allowedModels.includes(parsed.DEFAULT_MODEL)) {
    throw new Error('DEFAULT_MODEL precisa estar em ALLOWED_MODELS');
  }
  return {
    ...parsed,
    allowedModels,
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(',').map((v) => v.trim()).filter(Boolean),
    dataDir: path.resolve(parsed.DATA_DIR)
  };
}
