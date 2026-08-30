import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { McpWorkspaceService } from '../src/mcp-workspaces.js';
import type { AIProvider } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const provider: AIProvider = {
  supportsFiles: () => true,
  listModels: async () => [],
  checkAuthentication: async () => ({ available: true, authenticated: true }),
  sendMessage: async () => 'ok',
  async *streamMessage() { yield { type: 'complete' as const, text: 'ok', conversationId: 'test' }; },
  cancel: () => false
};

describe('MCP workspace isolation', () => {
  it('creates, edits, lists and recoverably removes workspace files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-mcp-'));
    dirs.push(dir);
    const config = loadConfig({
      NODE_ENV: 'test', NUMIA_SERVER_TOKEN: 'a'.repeat(64), DATA_DIR: dir,
      MCP_WORKSPACES_DIR: path.join(dir, 'workspaces'),
      ALLOWED_MODELS: 'gemini-3.7-flash-low', DEFAULT_MODEL: 'gemini-3.7-flash-low'
    });
    const workspaces = new McpWorkspaceService(config, provider);
    await workspaces.initialize();
    const created = await workspaces.create('Teste');
    const id = String(created.id);

    await workspaces.writeFile(id, 'docs/resposta.txt', 'original', false);
    await workspaces.editFile(id, 'docs/resposta.txt', 'original', 'corrigido', false);
    expect(await workspaces.readFile(id, 'docs/resposta.txt')).toMatchObject({ content: 'corrigido' });
    expect(await workspaces.listFiles(id)).toMatchObject({ entries: expect.arrayContaining([
      expect.objectContaining({ path: 'docs/resposta.txt', type: 'file' })
    ]) });
    await expect(workspaces.readFile(id, '../fora.txt')).rejects.toThrow('fora do workspace');
    expect(await workspaces.remove(id)).toMatchObject({ deleted: true, recoverable: true });
    await expect(workspaces.info(id)).rejects.toThrow('não encontrado');
  });
});
