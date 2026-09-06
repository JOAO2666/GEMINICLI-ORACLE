import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { McpWorkspaceService } from '../src/mcp-workspaces.js';
import { buildWorkerApp, detectSandboxEngine } from '../src/worker-server.js';
import type { AIProvider } from '../src/types.js';

const tempDirs: string[] = [];
afterEach(() => {
  tempDirs.splice(0).forEach((dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});

const mockProvider: AIProvider = {
  supportsFiles: () => true,
  listModels: async () => ['gemini-3.7-flash-low'],
  checkAuthentication: async () => ({ available: true, authenticated: true }),
  sendMessage: async () => 'ok',
  async *streamMessage() { yield { type: 'complete' as const, text: 'ok', conversationId: 'test' }; },
  cancel: () => false
};

describe('Phase 6: Workspace Confinement & Isolation', () => {
  it('prevents workspace A from reading workspace B secrets via filesystem path traversal', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-isolation-'));
    tempDirs.push(rootDir);

    const workspacesDir = path.join(rootDir, 'workspaces');
    const catalogDir = path.join(rootDir, 'catalog');
    fs.mkdirSync(catalogDir, { recursive: true });

    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'a'.repeat(64),
      DATA_DIR: rootDir,
      MCP_WORKSPACES_DIR: workspacesDir,
      SKILL_CATALOG_DIR: catalogDir,
      DEFAULT_MODEL: 'gemini-3.7-flash-low',
      ALLOWED_MODELS: 'gemini-3.7-flash-low'
    });

    const workspaces = new McpWorkspaceService(config, mockProvider);
    await workspaces.initialize();

    // 1. Create workspace A and write secret-a.txt
    const wsA = await workspaces.create('Workspace A');
    const idA = String(wsA.id);
    await workspaces.writeFile(idA, 'secret-a.txt', 'CLASSIFIED-SECRET-A', false);

    // 2. Create workspace B and write secret-b.txt
    const wsB = await workspaces.create('Workspace B');
    const idB = String(wsB.id);
    await workspaces.writeFile(idB, 'secret-b.txt', 'CLASSIFIED-SECRET-B', false);

    // Verify each workspace can read its own secret
    const readA = await workspaces.readFile(idA, 'secret-a.txt');
    expect(readA.content).toBe('CLASSIFIED-SECRET-A');
    const readB = await workspaces.readFile(idB, 'secret-b.txt');
    expect(readB.content).toBe('CLASSIFIED-SECRET-B');

    // Attempting to read Workspace B's secret from Workspace A via path traversal MUST fail
    await expect(workspaces.readFile(idA, `../${idB}/secret-b.txt`)).rejects.toThrow('fora do workspace');
    await expect(workspaces.readFile(idA, '..\\..\\secret.txt')).rejects.toThrow('fora do workspace');
  });

  it('detects sandbox engine status and refuses to declare strict active if engine is missing', () => {
    // In compat mode, status is always 'compat'
    const compatResult = detectSandboxEngine('compat');
    expect(compatResult.status).toBe('compat');
    expect(compatResult.error).toBeNull();

    // In strict mode without a valid bwrap binary, status must be 'failed' with descriptive error
    const strictMissingResult = detectSandboxEngine('strict', '/nonexistent/path/to/bwrap');
    expect(strictMissingResult.status).toBe('failed');
    expect(strictMissingResult.engine).toBe('none');
    expect(strictMissingResult.error).toContain('indisponível');
  });

  it('worker-server reports failure and refuses execution in strict mode when sandbox cannot initialize', async () => {
    const workerToken = 'b'.repeat(32);
    const workerApp = await buildWorkerApp({
      workerToken,
      isolationMode: 'strict',
      bwrapBinaryPath: '/nonexistent/fake-bwrap'
    });

    // Check /health reports degraded and failed isolation
    const healthRes = await workerApp.inject({
      method: 'GET',
      url: '/health'
    });
    expect(healthRes.statusCode).toBe(200);
    const health = JSON.parse(healthRes.body);
    expect(health.status).toBe('degraded');
    expect(health.isolation).toBe('failed');
    expect(health.error).toBeTruthy();

    // Executing commands in strict mode when sandbox failed MUST return 503
    const runRes = await workerApp.inject({
      method: 'POST',
      url: '/run',
      headers: { authorization: `Bearer ${workerToken}` },
      payload: {
        workspaceId: '11111111-1111-4111-8111-111111111111',
        command: 'ls -la'
      }
    });
    expect(runRes.statusCode).toBe(503);
    const runBody = JSON.parse(runRes.body);
    expect(runBody.isolation).toBe('failed');
    expect(runBody.message).toContain('Isolamento estrito');

    await workerApp.close();
  });
});
