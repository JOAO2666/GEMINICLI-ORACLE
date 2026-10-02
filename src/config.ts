import path from 'node:path';
import { z } from 'zod';

const bool = z.string().optional().transform((v) => v === 'true');
const boolWithDefault = (fallback: boolean) => z.string().optional().transform((v) => v === undefined ? fallback : v === 'true');
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DOMAIN: z.string().default(''),
  PUBLIC_BASE_URL: z.string().default(''),
  HOST: z.string().default('0.0.0.0'),
  PORT: positiveInt(3000),
  NUMIA_SERVER_TOKEN: z.string().min(32),
  ALLOWED_ORIGINS: z.string().default(''),
  // Empty means every model currently returned by `agy models` is available.
  ALLOWED_MODELS: z.string().default(''),
  DEFAULT_MODEL: z.string().default('gemini-3.8-flash-high'),
  VISION_MODEL: z.string().default(''),
  MODEL_REFRESH_INTERVAL_MS: positiveInt(15 * 60 * 1000),
  CLI_COMMAND_REFRESH_INTERVAL_MS: positiveInt(15 * 60 * 1000),
  AGY_AUTO_UPDATE: boolWithDefault(true),
  AGY_UPDATE_INTERVAL_MS: positiveInt(6 * 60 * 60 * 1000),
  MCP_ENABLED: bool,
  MCP_WORKSPACES_DIR: z.string().default(''),
  MCP_WORKER_URL: z.string().url().default('http://workspace-worker:3010'),
  MCP_WORKER_TOKEN: z.string().default(''),
  MCP_COMMAND_TIMEOUT_MS: positiveInt(60_000),
  SKILL_CATALOG_DIR: z.string().default(path.resolve('skill-catalog')),
  MCP_AUTO_INSTALL_SKILLS: boolWithDefault(true),
  MAX_GEMINI_PROCESSES: positiveInt(2),
  AGY_TIMEOUT_MS: positiveInt(300_000),
  STREAM_HEARTBEAT_MS: positiveInt(5_000),
  IMAGE_OCR_TIMEOUT_MS: positiveInt(30_000),
  AGY_COMMAND: z.string().default('agy'),
  DATA_DIR: z.string().default(path.resolve('data')),
  MAX_UPLOAD_BYTES: positiveInt(25 * 1024 * 1024),
  MAX_FILES_PER_UPLOAD: positiveInt(20),
  MAX_TOTAL_IMAGE_BYTES: positiveInt(64 * 1024 * 1024),
  FILE_RETENTION_HOURS: positiveInt(24),
  MAX_HISTORY_CHARS: positiveInt(120_000),
  RATE_LIMIT_MAX: positiveInt(60),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  MAX_QUEUE_DEPTH: positiveInt(50),
  QUEUE_WAIT_TIMEOUT_MS: positiveInt(60_000),
  ARTIFACT_SIGNING_KEY: z.string().default(''),
  ARTIFACT_RETENTION_HOURS: positiveInt(24),
  TEMP_WORKSPACE_RETENTION_HOURS: positiveInt(24),
  TRASH_RETENTION_HOURS: positiveInt(24),
  STORAGE_GUARDIAN_ENABLED: boolWithDefault(true),
  STORAGE_CHECK_INTERVAL_MINUTES: positiveInt(15),
  STORAGE_WARN_PERCENT: positiveInt(75),
  STORAGE_CLEANUP_PERCENT: positiveInt(85),
  STORAGE_AGGRESSIVE_PERCENT: positiveInt(90),
  STORAGE_CRITICAL_PERCENT: positiveInt(95),
  STORAGE_HARD_STOP_PERCENT: positiveInt(98),
  STORAGE_MIN_FREE_BYTES: positiveInt(5 * 1024 * 1024 * 1024),
  MAX_ARTIFACT_BYTES: positiveInt(100 * 1024 * 1024),
  MAX_TOTAL_ARTIFACT_BYTES: positiveInt(5 * 1024 * 1024 * 1024),
  MAX_WORKSPACE_BYTES: positiveInt(500 * 1024 * 1024),
  MCP_WORKER_ISOLATION: z.enum(['strict', 'compat']).default('compat'),
  TRUST_PROXY: bool,
  REQUIRE_HTTPS: bool,
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_SESSION_TTL_HOURS: positiveInt(2)
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const allowedModels = parsed.ALLOWED_MODELS.split(',').map((v) => v.trim()).filter(Boolean);
  if (allowedModels.length > 0 && !allowedModels.includes(parsed.DEFAULT_MODEL)) {
    throw new Error('DEFAULT_MODEL precisa estar em ALLOWED_MODELS');
  }
  const visionModel = parsed.VISION_MODEL || parsed.DEFAULT_MODEL;
  if (allowedModels.length > 0 && !allowedModels.includes(visionModel)) {
    throw new Error('VISION_MODEL precisa estar em ALLOWED_MODELS');
  }
  const artifactSigningKey = parsed.ARTIFACT_SIGNING_KEY ||
    (parsed.NUMIA_SERVER_TOKEN ? `sig-${parsed.NUMIA_SERVER_TOKEN.slice(0, 32)}` : 'numia-default-artifact-key');

  return {
    ...parsed,
    allowedModels,
    visionModel,
    artifactSigningKey,
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(',').map((v) => v.trim()).filter(Boolean),
    dataDir: path.resolve(parsed.DATA_DIR),
    skillCatalogDir: path.resolve(parsed.SKILL_CATALOG_DIR),
    mcpWorkspacesDir: path.resolve(parsed.MCP_WORKSPACES_DIR || path.join(parsed.DATA_DIR, 'mcp-workspaces'))
  };
}
