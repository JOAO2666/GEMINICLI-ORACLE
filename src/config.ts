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
  ALLOWED_MODELS: z.string().default('gemini-3.1-pro-high,gemini-3.1-pro-low,gemini-3.7-flash-high,gemini-3.7-flash-medium,gemini-3.7-flash-low,gemini-3.6-flash-high,gemini-3.6-flash-medium'),
  DEFAULT_MODEL: z.string().default('gemini-3.1-pro-high'),
  VISION_MODEL: z.string().default(''),
  MCP_ENABLED: bool,
  MCP_WORKSPACES_DIR: z.string().default(''),
  MCP_WORKER_URL: z.string().url().default('http://workspace-worker:3010'),
  MCP_WORKER_TOKEN: z.string().default(''),
  MCP_COMMAND_TIMEOUT_MS: positiveInt(60_000),
  SKILL_CATALOG_DIR: z.string().default(path.resolve('skill-catalog')),
  MCP_AUTO_INSTALL_SKILLS: boolWithDefault(true),
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
  const visionModel = parsed.VISION_MODEL || (allowedModels.includes('gemini-3.7-flash-low')
    ? 'gemini-3.7-flash-low'
    : parsed.DEFAULT_MODEL);
  if (!allowedModels.includes(visionModel)) {
    throw new Error('VISION_MODEL precisa estar em ALLOWED_MODELS');
  }
  return {
    ...parsed,
    allowedModels,
    visionModel,
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(',').map((v) => v.trim()).filter(Boolean),
    dataDir: path.resolve(parsed.DATA_DIR),
    skillCatalogDir: path.resolve(parsed.SKILL_CATALOG_DIR),
    mcpWorkspacesDir: path.resolve(parsed.MCP_WORKSPACES_DIR || path.join(parsed.DATA_DIR, 'mcp-workspaces'))
  };
}
