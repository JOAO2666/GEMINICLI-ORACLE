import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AntigravityCommandRegistry } from '../src/services/antigravity-command-registry.js';
import type { AIProvider, ProviderEvent, ProviderMaintenance, ProviderRequest, ProviderResult, ProviderStatus } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

class MockTestProvider implements AIProvider {
  public models = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.1-pro-high', 'claude-sonnet-4-6'];
  public listeners: Array<() => void> = [];

  onCatalogUpdate(listener: () => void) {
    this.listeners.push(listener);
  }

  async listModels(): Promise<string[]> {
    return [...this.models];
  }

  async refreshModels(): Promise<string[]> {
    this.listeners.forEach((l) => l());
    return [...this.models];
  }

  async getUsage(): Promise<unknown> {
    return {
      checkedAt: '2026-09-02T21:00:00Z',
      groups: [{
        name: 'Gemini Quota',
        buckets: [{
          id: 'gemini-flash',
          name: 'Gemini Flash',
          remainingPercent: 82.5,
          usedPercent: 17.5,
          resetTime: '2026-09-03T04:00:00Z'
        }]
      }]
    };
  }

  async updateCLI(): Promise<ProviderMaintenance> {
    this.models.push('gemini-3.9-ultra-high');
    this.listeners.forEach((l) => l());
    return {
      previousVersion: '1.2.0',
      installedVersion: '1.3.0',
      updated: true,
      modelsUpdated: true,
      message: 'Atualizado com sucesso.'
    };
  }

  maintenanceStatus(): ProviderMaintenance {
    return {
      installedVersion: '1.2.0',
      modelsRefreshedAt: '2026-09-02T21:00:00Z'
    };
  }

  async checkAuthentication(): Promise<ProviderStatus> {
    return {
      available: true,
      authenticated: true,
      version: '1.2.0',
      message: 'Antigravity CLI autenticado.'
    };
  }

  async sendMessage(request: ProviderRequest): Promise<string> {
    return `Resposta para: ${request.prompt}`;
  }

  async sendMessageDetailed(request: ProviderRequest): Promise<ProviderResult> {
    return {
      text: `Objetivo concluído com sucesso usando ${request.model}.`,
      usage: {
        prompt_tokens: 1250,
        completion_tokens: 420,
        total_tokens: 1670
      },
      durationSeconds: 3.4
    };
  }

  async *streamMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    yield { type: 'complete', text: `Stream: ${request.prompt}`, conversationId: request.conversationId };
  }

  cancel(): boolean { return false; }
  supportsFiles(): boolean { return true; }
}

describe('Antigravity CLI MCP Tools & Workspaces', () => {
  it('exercises all 11 new tools via MCP protocol', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-tools-test-'));
    dirs.push(dir);
    const token = 'a'.repeat(64);
    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: token,
      DATA_DIR: dir,
      PUBLIC_BASE_URL: 'https://example.test',
      MCP_ENABLED: 'true',
      MCP_WORKSPACES_DIR: path.join(dir, 'workspaces'),
      MCP_WORKER_TOKEN: 'b'.repeat(64),
      SKILL_CATALOG_DIR: path.join(dir, 'catalog'),
      MCP_AUTO_INSTALL_SKILLS: 'false',
      DEFAULT_MODEL: 'gemini-3.8-flash-high'
    });

    const mockProvider = new MockTestProvider();
    const mockRunner = async (args: string[]) => {
      if (args[0] === '--help') {
        return {
          args,
          stdout: `Available subcommands:\n  models  List available models\n  changelog  Show changelog\n  update  Update CLI\n  install  Configure shell\n`,
          stderr: '',
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          truncated: false
        };
      }
      if (args[0] === 'models' && args[1] === '--help') {
        return {
          args,
          stdout: 'Usage: agy models [options]\n  --verbose  Show detailed info',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          truncated: false
        };
      }
      if (args[0] === 'models') {
        return {
          args,
          stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          durationMs: 15,
          truncated: false
        };
      }
      return { args, stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 10, truncated: false };
    };

    const commandRegistry = new AntigravityCommandRegistry(config, mockRunner);
    const app = await buildApp(config, { provider: mockProvider, commandRegistry });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'cli-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token }
    });

    try {
      await client.connect(transport);

      // 1. Create a workspace
      const wsCreate = await client.callTool({ name: 'workspace_create', arguments: { name: 'Workspace CLI' } });
      const workspaceId = String((wsCreate.structuredContent as Record<string, unknown>).id);

      // 2. Test 'commands'
      const cmdCall = await client.callTool({ name: 'commands', arguments: {} });
      const cmdContent = (cmdCall.content as Array<{ text: string }>)[0]!.text;
      expect(cmdContent).toContain('/models');
      expect(cmdContent).toContain('/model');
      expect(cmdContent).toContain('/usage');
      expect(cmdContent).toContain('/status');
      expect(cmdCall.structuredContent).toBeDefined();

      // 3. Test 'models' without and with workspace_id
      const modelsCall = await client.callTool({ name: 'models', arguments: { workspace_id: workspaceId } });
      const modelsContent = (modelsCall.content as Array<{ text: string }>)[0]!.text;
      expect(modelsContent).toContain('gemini-3.8-flash-high  ← atual');
      expect(modelsContent).toContain('/model <modelo>');
      expect(modelsCall.structuredContent).toMatchObject({ currentModel: 'gemini-3.8-flash-high' });

      // 4. Test 'model_current'
      const currentCall = await client.callTool({ name: 'model_current', arguments: { workspace_id: workspaceId } });
      expect((currentCall.content as Array<{ text: string }>)[0]!.text).toContain('gemini-3.8-flash-high');

      // 5. Test 'model_set' with alias 'pro'
      const setCall = await client.callTool({ name: 'model_set', arguments: { workspace_id: workspaceId, model: 'pro' } });
      const setContent = (setCall.content as Array<{ text: string }>)[0]!.text;
      expect(setContent).toContain('✅ Modelo alterado');
      expect(setContent).toContain('gemini-3.1-pro-high');
      expect(setCall.structuredContent).toMatchObject({ currentModel: 'gemini-3.1-pro-high' });

      // Verify model_current now returns the workspace model
      const currentAfterSet = await client.callTool({ name: 'model_current', arguments: { workspace_id: workspaceId } });
      expect((currentAfterSet.content as Array<{ text: string }>)[0]!.text).toContain('gemini-3.1-pro-high');
      expect(currentAfterSet.structuredContent).toMatchObject({ currentModel: 'gemini-3.1-pro-high', isCustom: true });

      // 6. Test 'model_set' with invalid model
      const invalidSet = await client.callTool({ name: 'model_set', arguments: { workspace_id: workspaceId, model: 'modelo-inexistente' } });
      expect(invalidSet.isError).toBe(true);

      // 7. Test 'usage'
      const usageCall = await client.callTool({ name: 'usage', arguments: {} });
      const usageContent = (usageCall.content as Array<{ text: string }>)[0]!.text;
      expect(usageContent).toContain('📊 Uso do Antigravity');
      expect(usageContent).toContain('Gemini Flash');
      expect(usageContent).toContain('82.5% restante');
      expect(usageCall.structuredContent).toMatchObject({
        groups: [{ name: 'Gemini Quota' }]
      });

      // 8. Test 'usage_last' before any goal_run
      const usageLastInitial = await client.callTool({ name: 'usage_last', arguments: { workspace_id: workspaceId } });
      expect((usageLastInitial.content as Array<{ text: string }>)[0]!.text).toContain('Nenhuma execução registrada');

      // 9. Run goal_run to test persistent model and execution metrics
      const goalCall = await client.callTool({
        name: 'goal_run',
        arguments: { workspace_id: workspaceId, goal: 'Criar documentação e testes' }
      });
      expect(goalCall.structuredContent).toMatchObject({
        model: 'gemini-3.1-pro-high',
        usage: { prompt_tokens: 1250, completion_tokens: 420, total_tokens: 1670 }
      });

      // 10. Test 'usage_last' after goal_run
      const usageLastAfter = await client.callTool({ name: 'usage_last', arguments: { workspace_id: workspaceId } });
      const usageLastText = (usageLastAfter.content as Array<{ text: string }>)[0]!.text;
      expect(usageLastText).toContain('📊 Uso da Última Execução');
      expect(usageLastText).toContain('gemini-3.1-pro-high');
      expect(usageLastText).toContain('Tokens de entrada: 1250');
      expect(usageLastText).toContain('Total de tokens: 1670');

      // 11. Test 'cli_history'
      const historyCall = await client.callTool({ name: 'cli_history', arguments: { workspace_id: workspaceId } });
      const historyText = (historyCall.content as Array<{ text: string }>)[0]!.text;
      expect(historyText).toContain('Últimos comandos:');
      expect(historyText).toContain('model_set');
      expect(historyText).toContain('goal_run');

      // 12. Test 'status'
      const statusCall = await client.callTool({ name: 'status', arguments: { workspace_id: workspaceId } });
      const statusText = (statusCall.content as Array<{ text: string }>)[0]!.text;
      expect(statusText).toContain('Status do Antigravity Server');
      expect(statusText).toContain('Servidor: online');
      expect(statusText).toContain('Antigravity CLI: autenticado');
      expect(statusText).toContain('Workspace: Workspace CLI');

      // 13. Test 'cli_help' without args and with command='models'
      const generalHelp = await client.callTool({ name: 'cli_help', arguments: {} });
      expect((generalHelp.content as Array<{ text: string }>)[0]!.text).toContain('Antigravity CLI');
      expect((generalHelp.content as Array<{ text: string }>)[0]!.text).toContain('models: List available models');

      const specificHelp = await client.callTool({ name: 'cli_help', arguments: { command: 'models' } });
      expect((specificHelp.content as Array<{ text: string }>)[0]!.text).toContain('Usage: agy models');

      // 14. Test 'cli_update'
      const updateCall = await client.callTool({ name: 'cli_update', arguments: {} });
      const updateText = (updateCall.content as Array<{ text: string }>)[0]!.text;
      expect(updateText).toContain('Antes: 1.2.0');
      expect(updateText).toContain('Depois: 1.3.0');
      expect(updateText).toContain('Modelos atualizados: sim');

      // 15. Test 'cli_execute' with allowed command
      const execCall = await client.callTool({ name: 'cli_execute', arguments: { command: 'models' } });
      expect((execCall.content as Array<{ text: string }>)[0]!.text).toContain('gemini-3.8-flash-high');

      // 16. Test 'cli_execute' with restricted interactive command
      const blockedExec = await client.callTool({ name: 'cli_execute', arguments: { command: 'install' } });
      expect(blockedExec.isError).toBe(true);
      expect((blockedExec.content as Array<{ text: string }>)[0]!.text).toContain('sessão interativa');

    } finally {
      await client.close();
      await app.close();
    }
  }, 25_000);

  it('safely falls back when a workspace selected model is removed in CLI update', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-fallback-test-'));
    dirs.push(dir);
    const token = 'a'.repeat(64);
    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: token,
      DATA_DIR: dir,
      PUBLIC_BASE_URL: 'https://example.test',
      MCP_ENABLED: 'true',
      MCP_WORKSPACES_DIR: path.join(dir, 'workspaces'),
      MCP_WORKER_TOKEN: 'b'.repeat(64),
      SKILL_CATALOG_DIR: path.join(dir, 'catalog'),
      MCP_AUTO_INSTALL_SKILLS: 'false',
      DEFAULT_MODEL: 'gemini-3.8-flash-high'
    });

    const mockProvider = new MockTestProvider();
    const app = await buildApp(config, { provider: mockProvider });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'cli-fallback-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token }
    });

    try {
      await client.connect(transport);
      const wsCreate = await client.callTool({ name: 'workspace_create', arguments: { name: 'Fallback WS' } });
      const workspaceId = String((wsCreate.structuredContent as Record<string, unknown>).id);

      // Set model to claude-sonnet-4-6
      await client.callTool({ name: 'model_set', arguments: { workspace_id: workspaceId, model: 'sonnet' } });

      // Simulate model vanishing from CLI
      mockProvider.models = ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'];

      // Run goal_run - it must NOT throw; it should fallback gracefully and provide notice!
      const goalCall = await client.callTool({
        name: 'goal_run',
        arguments: { workspace_id: workspaceId, goal: 'Verificar fallback' }
      });
      expect(goalCall.isError).toBeFalsy();
      expect(goalCall.structuredContent).toMatchObject({
        model: 'gemini-3.8-flash-high'
      });
      expect(String((goalCall.structuredContent as Record<string, unknown>).notice)).toContain('não está mais disponível');
    } finally {
      await client.close();
      await app.close();
    }
  });
});
