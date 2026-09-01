import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpWorkspaceService } from '../src/mcp-workspaces.js';
import type { Config } from '../src/config.js';
import type { AIProvider } from '../src/types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('skill catalog', () => {
  it('lists and installs the complete bundled catalog', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'numia-catalog-'));
    temporaryRoots.push(root);
    const config = {
      mcpWorkspacesDir: path.join(root, 'workspaces'),
      dataDir: path.join(root, 'data'),
      skillCatalogDir: path.resolve('skill-catalog'),
      MCP_AUTO_INSTALL_SKILLS: true,
      MCP_WORKER_TOKEN: 'test',
      MCP_WORKER_URL: 'http://worker',
      MCP_COMMAND_TIMEOUT_MS: 1_000,
      allowedModels: ['test-model'],
      DEFAULT_MODEL: 'test-model',
      PUBLIC_BASE_URL: 'https://example.test',
      DOMAIN: ''
    } as Config;
    const provider = {} as AIProvider;
    const service = new McpWorkspaceService(config, provider);

    await service.initialize();
    const catalog = await service.skillCatalog() as { count: number; skills: Array<{ name: string; description: string }> };
    expect(catalog.count).toBe(18);
    expect(catalog.skills.every((skill) => skill.description.length > 10)).toBe(true);

    const workspace = await service.create('Catálogo completo') as { id: string; skillsInstalled: string[] };
    expect(workspace.skillsInstalled).toHaveLength(18);
    await expect(fs.stat(path.join(config.mcpWorkspacesDir, workspace.id, '.agents', 'skills', 'anki-apkg', 'SKILL.md'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(config.mcpWorkspacesDir, workspace.id, '.agents', 'skills', 'canvas-design', 'SKILL.md'))).resolves.toBeTruthy();
  });
});
