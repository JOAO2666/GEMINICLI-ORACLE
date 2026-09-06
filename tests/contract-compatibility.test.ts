import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const ORIGINAL_30_TOOLS = [
  'artifact_list',
  'artifact_publish',
  'cli_execute',
  'cli_help',
  'cli_history',
  'cli_update',
  'commands',
  'file_edit',
  'file_list',
  'file_read',
  'file_write',
  'git_clone',
  'goal_run',
  'model_current',
  'model_set',
  'models',
  'shell_execute',
  'skill_catalog',
  'skill_install',
  'skill_install_catalog',
  'skill_list',
  'skill_read',
  'skill_remove',
  'skill_resources',
  'status',
  'usage',
  'usage_last',
  'workspace_create',
  'workspace_delete',
  'workspace_info'
];

const MANDATORY_REQUIRED_PARAMS: Record<string, string[]> = {
  workspace_delete: ['workspace_id'],
  workspace_info: ['workspace_id'],
  file_list: ['workspace_id'],
  file_read: ['workspace_id', 'path'],
  file_write: ['workspace_id', 'path', 'content'],
  file_edit: ['workspace_id', 'path', 'old_text', 'new_text'],
  shell_execute: ['workspace_id', 'command'],
  git_clone: ['workspace_id', 'repository_url', 'destination'],
  goal_run: ['workspace_id', 'goal'],
  skill_list: ['workspace_id'],
  skill_read: ['workspace_id', 'name'],
  skill_resources: ['workspace_id', 'name'],
  skill_install: ['workspace_id', 'name', 'instructions'],
  skill_remove: ['workspace_id', 'name'],
  artifact_list: ['workspace_id'],
  artifact_publish: ['workspace_id', 'path'],
  model_set: ['workspace_id', 'model'],
  usage_last: ['workspace_id'],
  cli_execute: ['command'],
  cli_history: ['workspace_id']
};

describe('Compatibility Contract (YhikkaHub, Gemini Spark & Dual-Era MCP)', () => {
  it('preserves all original 30 tools and their exact required parameter contracts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-test-'));
    const token = 'c'.repeat(64);
    const app = await buildApp(loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: token,
      DATA_DIR: dir,
      PUBLIC_BASE_URL: 'https://example.test',
      MCP_ENABLED: 'true',
      MCP_WORKSPACES_DIR: path.join(dir, 'workspaces'),
      MCP_WORKER_TOKEN: 'd'.repeat(64),
      SKILL_CATALOG_DIR: path.join(dir, 'catalog'),
      MCP_AUTO_INSTALL_SKILLS: 'false',
      ALLOWED_MODELS: 'gemini-3.7-flash-low',
      DEFAULT_MODEL: 'gemini-3.7-flash-low'
    }));

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'contract-verifier', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token }
    });

    try {
      await client.connect(transport);
      const toolsResult = await client.listTools();
      const toolMap = new Map(toolsResult.tools.map((t) => [t.name, t]));

      // 1. Every single one of the original 30 tools MUST be present
      for (const name of ORIGINAL_30_TOOLS) {
        expect(toolMap.has(name), `Original tool "${name}" must never be deleted or renamed`).toBe(true);
      }

      // 2. Additive high-level tools must also be present
      expect(toolMap.has('artifact_create')).toBe(true);
      expect(toolMap.has('task_run')).toBe(true);
      expect(toolMap.has('artifact_revise')).toBe(true);
      expect(toolMap.has('artifact_get')).toBe(true);

      // 3. Verify required parameter contract for original tools
      for (const [toolName, requiredParams] of Object.entries(MANDATORY_REQUIRED_PARAMS)) {
        const tool = toolMap.get(toolName);
        expect(tool).toBeDefined();
        const schema = tool!.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
        const toolRequired = schema.required || [];
        for (const req of requiredParams) {
          expect(toolRequired, `Tool "${toolName}" must require param "${req}"`).toContain(req);
        }
      }
    } finally {
      await client.close();
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves both MCP 2025-era stateless requests and MCP 2026-07-28 on the same /mcp endpoint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-era-test-'));
    const token = 'e'.repeat(64);
    const app = await buildApp(loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: token,
      DATA_DIR: dir,
      PUBLIC_BASE_URL: 'https://example.test',
      MCP_ENABLED: 'true',
      MCP_WORKSPACES_DIR: path.join(dir, 'workspaces'),
      MCP_WORKER_TOKEN: 'f'.repeat(64),
      ALLOWED_MODELS: 'gemini-3.7-flash-low',
      DEFAULT_MODEL: 'gemini-3.7-flash-low'
    }));

    try {
      const parseResponse = (res: { headers: Record<string, unknown>; payload: string }) => {
        const ct = String(res.headers['content-type'] || '');
        if (ct.includes('application/json')) return JSON.parse(res.payload);
        const match = res.payload.match(/data:\s*(\{.*\})/);
        return match ? JSON.parse(match[1]!) : JSON.parse(res.payload);
      };

      // Legacy 2025 stateless JSON-RPC call without modern headers
      const legacyResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream;q=0.9'
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {}
        }
      });

      expect(legacyResponse.statusCode).toBe(200);
      const legacyBody = parseResponse(legacyResponse);
      expect(legacyBody).toMatchObject({ jsonrpc: '2.0', id: 1 });
      expect(legacyBody.result?.tools).toBeDefined();

      // Modern 2026 request with Mcp-Method header
      const modernResponse = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream;q=0.9',
          'mcp-method': 'tools/list'
        },
        payload: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        }
      });

      expect(modernResponse.statusCode).toBe(200);
      const modernBody = parseResponse(modernResponse);
      expect(modernBody).toMatchObject({ jsonrpc: '2.0', id: 2 });
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('provides live and ready health endpoints without regressions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
    const token = 'g'.repeat(64);
    const app = await buildApp(loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: token,
      DATA_DIR: dir,
      PUBLIC_BASE_URL: 'https://example.test'
    }));

    try {
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok' });

      const live = await app.inject({ method: 'GET', url: '/health/live' });
      expect(live.statusCode).toBe(200);
      expect(live.json().status).toBe('ok');

      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().status).toBe('ok');
      expect(ready.json().database).toBe('ok');
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
