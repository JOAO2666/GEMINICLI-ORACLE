import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import type { AIProvider } from './types.js';
import { AntigravityCommandRegistry } from './services/antigravity-command-registry.js';
import { formatUsageBars } from './services/antigravity-provider.js';
import { McpWorkspaceService } from './mcp-workspaces.js';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const localWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const openWorld = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function result(data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function formattedResult(text: string, data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], structuredContent: data };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'Falha inesperada.';
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function guarded<T extends Record<string, unknown>>(callback: () => Promise<T>) {
  return callback().then(result).catch(failure);
}

function guardedFormatted(callback: () => Promise<{ text: string; data: Record<string, unknown> }>) {
  return callback()
    .then(({ text, data }) => formattedResult(text, data))
    .catch(failure);
}

export interface McpEndpoint {
  handler: McpHttpHandler;
  nodeHandler: NodeMcpRequestHandler;
}

export function createWorkspaceMcpEndpoint(
  workspaces: McpWorkspaceService,
  provider: AIProvider,
  commandRegistry: AntigravityCommandRegistry,
  config: Config,
  onerror: (error: Error) => void
): McpEndpoint {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'numia-workspace', version: '1.0.0', title: 'NumIA Workspace' });

    server.registerTool('workspace_create', {
      title: 'Criar workspace',
      description: 'Cria uma área de trabalho privada e isolada para arquivos e automações. Faça isso antes das demais ações.',
      inputSchema: z.object({ name: z.string().min(1).max(100).default('Novo workspace') }),
      annotations: localWrite
    }, ({ name }) => guarded(() => workspaces.create(name)));

    server.registerTool('workspace_delete', {
      title: 'Excluir workspace',
      description: 'Move um workspace para a lixeira recuperável. Remove o workspace ativo das automações.',
      inputSchema: z.object({ workspace_id: z.string().uuid() }),
      annotations: destructive
    }, ({ workspace_id }) => guarded(() => workspaces.remove(workspace_id)));

    server.registerTool('workspace_info', {
      title: 'Informações do workspace',
      description: 'Mostra nome, data, número de arquivos, diretórios e tamanho de um workspace.',
      inputSchema: z.object({ workspace_id: z.string().uuid() }),
      annotations: readOnly
    }, ({ workspace_id }) => guarded(() => workspaces.info(workspace_id)));

    server.registerTool('file_list', {
      title: 'Listar arquivos',
      description: 'Lista arquivos e diretórios dentro de um workspace, sem acessar caminhos externos.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(),
        path: z.string().max(500).default('.'),
        recursive: z.boolean().default(true)
      }),
      annotations: readOnly
    }, ({ workspace_id, path, recursive }) => guarded(() => workspaces.listFiles(workspace_id, path, recursive)));

    server.registerTool('file_read', {
      title: 'Ler arquivo',
      description: 'Lê um arquivo de texto de até 1 MB dentro do workspace.',
      inputSchema: z.object({ workspace_id: z.string().uuid(), path: z.string().min(1).max(500) }),
      annotations: readOnly
    }, ({ workspace_id, path }) => guarded(() => workspaces.readFile(workspace_id, path)));

    server.registerTool('file_write', {
      title: 'Criar arquivo',
      description: 'Cria ou sobrescreve, quando autorizado, um arquivo de texto dentro do workspace.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(), path: z.string().min(1).max(500),
        content: z.string().max(1_048_576), overwrite: z.boolean().default(false)
      }),
      annotations: localWrite
    }, ({ workspace_id, path, content, overwrite }) => guarded(() => workspaces.writeFile(workspace_id, path, content, overwrite)));

    server.registerTool('file_edit', {
      title: 'Editar arquivo',
      description: 'Substitui texto exato em um arquivo. Recusa edições ambíguas por padrão.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(), path: z.string().min(1).max(500),
        old_text: z.string().min(1).max(1_048_576), new_text: z.string().max(1_048_576),
        replace_all: z.boolean().default(false)
      }),
      annotations: localWrite
    }, ({ workspace_id, path, old_text, new_text, replace_all }) =>
      guarded(() => workspaces.editFile(workspace_id, path, old_text, new_text, replace_all)));

    server.registerTool('shell_execute', {
      title: 'Executar comando isolado',
      description: 'Executa um comando em um contêiner isolado, limitado ao workspace e sem credenciais do servidor. Use para instalar dependências, testar e compilar.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(), command: z.string().min(1).max(4_000),
        timeout_seconds: z.number().int().min(1).max(60).default(60)
      }),
      annotations: openWorld
    }, ({ workspace_id, command, timeout_seconds }) => guarded(() => workspaces.shellExecute(workspace_id, command, timeout_seconds)));

    server.registerTool('git_clone', {
      title: 'Clonar repositório GitHub',
      description: 'Clona um repositório público HTTPS do GitHub dentro do workspace usando o executor isolado.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(), repository_url: z.string().url().max(500),
        destination: z.string().min(1).max(180), ref: z.string().min(1).max(180).optional()
      }),
      annotations: { ...localWrite, openWorldHint: true }
    }, ({ workspace_id, repository_url, destination, ref }) =>
      guarded(() => workspaces.gitClone(workspace_id, repository_url, destination, ref)));

    server.registerTool('goal_run', {
      title: 'Executar objetivo automaticamente',
      description: 'Delega um objetivo completo ao agente Gemini dentro do workspace. Ele pode inspecionar, criar, editar e testar arquivos até concluir.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(), goal: z.string().min(1).max(40_000),
        model: z.string().max(100).optional(), effort: z.enum(['low', 'medium', 'high']).default('high')
      }),
      annotations: openWorld
    }, ({ workspace_id, goal, model, effort }) => guarded(() => workspaces.goalRun(workspace_id, goal, model, effort)));

    server.registerTool('skill_list', {
      title: 'Listar skills',
      description: 'Lista as skills instaladas no workspace e informa o tamanho do catálogo disponível.',
      inputSchema: z.object({ workspace_id: z.string().uuid() }),
      annotations: readOnly
    }, ({ workspace_id }) => guarded(() => workspaces.skillList(workspace_id)));

    server.registerTool('skill_catalog', {
      title: 'Catálogo de skills',
      description: 'Lista as skills oficiais e gratuitas disponíveis para instalação, com descrição e origem.',
      inputSchema: z.object({}),
      annotations: readOnly
    }, () => guarded(() => workspaces.skillCatalog()));

    server.registerTool('skill_read', {
      title: 'Ler skill',
      description: 'Lê todas as instruções SKILL.md de uma skill instalada.',
      inputSchema: z.object({ workspace_id: z.string().uuid(), name: z.string().min(1).max(64) }),
      annotations: readOnly
    }, ({ workspace_id, name }) => guarded(() => workspaces.skillRead(workspace_id, name)));

    server.registerTool('skill_resources', {
      title: 'Listar recursos da skill',
      description: 'Lista os arquivos e recursos pertencentes a uma skill instalada.',
      inputSchema: z.object({ workspace_id: z.string().uuid(), name: z.string().min(1).max(64) }),
      annotations: readOnly
    }, ({ workspace_id, name }) => guarded(() => workspaces.skillResources(workspace_id, name)));

    server.registerTool('skill_install', {
      title: 'Instalar skill',
      description: 'Instala instruções e recursos fornecidos pelo usuário em uma skill privada compatível com Agent Skills.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(), name: z.string().min(1).max(64),
        instructions: z.string().min(1).max(100_000),
        resources: z.record(z.string().max(300), z.string().max(1_048_576)).default({})
      }),
      annotations: localWrite
    }, ({ workspace_id, name, instructions, resources }) =>
      guarded(() => workspaces.skillInstall(workspace_id, name, instructions, resources)));

    server.registerTool('skill_install_catalog', {
      title: 'Instalar skills do catálogo',
      description: 'Instala no workspace uma seleção do catálogo gratuito. Uma lista vazia instala todas. Não usa APIs pagas.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(),
        names: z.array(z.string().min(1).max(64)).max(64).default([]),
        overwrite: z.boolean().default(false)
      }),
      annotations: localWrite
    }, ({ workspace_id, names, overwrite }) =>
      guarded(() => workspaces.installCatalogSkills(workspace_id, names, overwrite)));

    server.registerTool('skill_remove', {
      title: 'Remover skill',
      description: 'Move uma skill instalada para a lixeira recuperável do workspace.',
      inputSchema: z.object({ workspace_id: z.string().uuid(), name: z.string().min(1).max(64) }),
      annotations: destructive
    }, ({ workspace_id, name }) => guarded(() => workspaces.skillRemove(workspace_id, name)));

    server.registerTool('artifact_list', {
      title: 'Listar artefatos',
      description: 'Lista arquivos que já foram publicados a partir de um workspace.',
      inputSchema: z.object({ workspace_id: z.string().uuid() }),
      annotations: readOnly
    }, ({ workspace_id }) => guarded(() => workspaces.listArtifacts(workspace_id)));

    server.registerTool('artifact_publish', {
      title: 'Publicar artefato',
      description: 'Publica uma cópia de um arquivo do workspace e devolve uma URL HTTPS de download difícil de adivinhar.',
      inputSchema: z.object({ workspace_id: z.string().uuid(), path: z.string().min(1).max(500) }),
      annotations: { ...localWrite, openWorldHint: true }
    }, ({ workspace_id, path }) => guarded(() => workspaces.publishArtifact(workspace_id, path)));

    server.registerTool('commands', {
      title: 'Comandos rápidos e catálogo de ferramentas',
      description: 'Exibe o catálogo de comandos rápidos de chat (/models, /model, /usage, /quota, /status, /help, /update), ferramentas MCP do workspace e comandos do Antigravity CLI detectados.',
      inputSchema: z.object({}),
      annotations: readOnly
    }, () => guardedFormatted(async () => {
      const cliCommands = await commandRegistry.discoverCommands().catch(() => []);
      const slashCommands = [
        { command: '/models', description: 'Lista modelos de IA disponíveis' },
        { command: '/model', description: 'Exibe o modelo ativo do workspace ou do servidor' },
        { command: '/model <modelo>', description: 'Altera o modelo do workspace (aceita aliases como pro, flash, sonnet)' },
        { command: '/usage ou /quota', description: 'Consulta cotas e consumo atual com gráfico visual' },
        { command: '/status', description: 'Exibe visão consolidada do servidor, CLI, autenticação e cotas' },
        { command: '/help', description: 'Exibe a ajuda geral dos comandos do Antigravity CLI' },
        { command: '/help <comando>', description: 'Exibe a ajuda detalhada e flags de um comando específico' },
        { command: '/update', description: 'Executa a atualização protegida do Antigravity CLI' }
      ];
      const workspaceTools = [
        'workspace_create', 'workspace_delete', 'workspace_info', 'file_list', 'file_read',
        'file_write', 'file_edit', 'shell_execute', 'git_clone', 'goal_run', 'skill_list',
        'skill_catalog', 'skill_read', 'skill_resources', 'skill_install',
        'skill_install_catalog', 'skill_remove', 'artifact_list', 'artifact_publish'
      ];
      const lines = [
        '# Comandos Disponíveis',
        '',
        '## Comandos Rápidos de Chat',
        ...slashCommands.map((s) => `• \`${s.command}\`: ${s.description}`),
        '',
        '## Ferramentas MCP de Workspace',
        workspaceTools.join(', '),
        '',
        '## Comandos do Antigravity CLI'
      ];
      if (cliCommands.length === 0) {
        lines.push('• Nenhum comando retornado pelo CLI.');
      } else {
        for (const cmd of cliCommands) {
          const status = cmd.executable ? '[executável]' : `[restrito: ${cmd.restriction ?? 'interativo'}]`;
          lines.push(`• **${cmd.name}**: ${cmd.description} ${status}`);
        }
      }
      return {
        text: lines.join('\n'),
        data: { slashCommands, workspaceTools, cliCommands }
      };
    }));

    server.registerTool('models', {
      title: 'Listar modelos disponíveis',
      description: 'Lista todos os modelos de IA disponíveis no Antigravity CLI e marca o modelo atualmente ativo. Use quando o usuário pedir /models ou quiser saber os modelos suportados.',
      inputSchema: z.object({ workspace_id: z.string().uuid().optional() }),
      annotations: readOnly
    }, ({ workspace_id }) => guardedFormatted(async () => {
      const available = await provider.listModels();
      let current = config.DEFAULT_MODEL;
      let isCustom = false;
      if (workspace_id) {
        const wsModel = await workspaces.getWorkspaceModel(workspace_id);
        if (wsModel && available.includes(wsModel)) {
          current = wsModel;
          isCustom = true;
        } else if (!available.includes(current) && available.length > 0) {
          current = available[0]!;
        }
      } else if (!available.includes(current) && available.length > 0) {
        current = available[0]!;
      }

      const lines = ['Modelos disponíveis:'];
      available.forEach((model, index) => {
        const isCurrent = model === current;
        lines.push(`${index + 1}. ${model}${isCurrent ? '  ← atual' : ''}`);
      });
      lines.push('');
      lines.push('Modelo atual:');
      lines.push(current + (isCustom ? ' (personalizado para este workspace)' : ''));
      lines.push('');
      lines.push('Para trocar:');
      lines.push('/model <modelo>');

      return {
        text: lines.join('\n'),
        data: { models: available, currentModel: current, workspaceId: workspace_id, isCustom }
      };
    }));

    server.registerTool('model_current', {
      title: 'Consultar modelo atual',
      description: 'Informa o modelo de IA configurado para o workspace ou o padrão global do servidor. Use quando o usuário digitar /model ou perguntar qual modelo está em uso.',
      inputSchema: z.object({ workspace_id: z.string().uuid().optional() }),
      annotations: readOnly
    }, ({ workspace_id }) => guardedFormatted(async () => {
      let current = config.DEFAULT_MODEL;
      let isCustom = false;
      if (workspace_id) {
        const wsModel = await workspaces.getWorkspaceModel(workspace_id);
        if (wsModel) {
          current = wsModel;
          isCustom = true;
        }
      }
      const text = `Modelo atual:\n${current}${isCustom ? ' (definido para este workspace)' : ' (padrão global)'}`;
      return {
        text,
        data: { currentModel: current, workspaceId: workspace_id, isCustom }
      };
    }));

    server.registerTool('model_set', {
      title: 'Definir modelo do workspace',
      description: 'Define e persiste o modelo de IA para um workspace específico, suportando atalhos inteligentes (como pro, flash, flash-high, flash-medium, sonnet, opus). Use quando o usuário digitar /model <modelo>.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(),
        model: z.string().min(1).max(100)
      }),
      annotations: localWrite
    }, ({ workspace_id, model }) => guardedFormatted(async () => {
      const { previous, current } = await workspaces.setWorkspaceModel(workspace_id, model);
      const text = [
        '✅ Modelo alterado',
        '',
        'Anterior:',
        previous ?? `padrão (${config.DEFAULT_MODEL})`,
        '',
        'Atual:',
        current
      ].join('\n');
      return {
        text,
        data: { workspaceId: workspace_id, previousModel: previous, currentModel: current }
      };
    }));

    server.registerTool('usage', {
      title: 'Consultar quota e uso do Antigravity',
      description: 'Consulta cotas e consumo atual de modelos do Antigravity CLI com gráfico de barras visual e porcentagens. Use quando o usuário digitar /usage ou /quota.',
      inputSchema: z.object({}),
      annotations: readOnly
    }, () => guardedFormatted(async () => {
      if (!provider.getUsage) {
        throw new AppError(501, 'USAGE_UNSUPPORTED', 'O provedor não oferece consulta de uso.');
      }
      const rawUsage = await provider.getUsage() as Record<string, unknown>;
      const text = formatUsageBars(rawUsage);
      return { text, data: rawUsage };
    }));

    server.registerTool('usage_last', {
      title: 'Consultar métricas da última execução',
      description: 'Exibe detalhes de consumo de tokens (entrada, saída, total) e duração da última execução de objetivo (goal_run) realizada no workspace.',
      inputSchema: z.object({ workspace_id: z.string().uuid() }),
      annotations: readOnly
    }, ({ workspace_id }) => guardedFormatted(async () => {
      const last = await workspaces.getLastExecution(workspace_id);
      if (!last) {
        return {
          text: 'Nenhuma execução registrada para este workspace ainda.',
          data: { workspaceId: workspace_id, hasExecution: false }
        };
      }
      const usage = last.usage ?? {};
      const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 'N/D';
      const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 'N/D';
      const totalTokens = usage.total_tokens ?? 'N/D';
      const text = [
        '📊 Uso da Última Execução',
        '',
        `Modelo utilizado: ${last.model}`,
        `Data: ${new Date(last.timestamp).toLocaleString('pt-BR')}`,
        `Duração: ${last.durationSeconds !== undefined ? `${last.durationSeconds}s` : 'N/D'}`,
        `Tokens de entrada: ${promptTokens}`,
        `Tokens de saída: ${completionTokens}`,
        `Total de tokens: ${totalTokens}`
      ].join('\n');
      return {
        text,
        data: { workspaceId: workspace_id, execution: last }
      };
    }));

    server.registerTool('status', {
      title: 'Status consolidado do servidor e Antigravity CLI',
      description: 'Apresenta visão completa e consolidada da saúde do servidor, autenticação do CLI, versão instalada, modelo ativo, contagem de modelos, dados do workspace e cotas. Use quando o usuário digitar /status.',
      inputSchema: z.object({ workspace_id: z.string().uuid().optional() }),
      annotations: readOnly
    }, ({ workspace_id }) => guardedFormatted(async () => {
      const auth = await provider.checkAuthentication();
      const models = await provider.listModels().catch(() => []);
      const maintenance = provider.maintenanceStatus?.() ?? {};
      const wsInfo = workspace_id ? await workspaces.info(workspace_id).catch(() => null) : null;
      const wsModel = workspace_id ? await workspaces.getWorkspaceModel(workspace_id) : undefined;
      const currentModel = wsModel ?? config.DEFAULT_MODEL;

      const lines = [
        '# Status do Antigravity Server',
        '',
        'Servidor: online',
        `Antigravity CLI: ${auth.authenticated ? 'autenticado' : 'não autenticado'}`,
        `Versão: ${auth.version ?? 'desconhecida'}`,
        `Modelo atual: ${currentModel}${wsModel ? ' (workspace)' : ' (padrão)'}`,
        `Modelos disponíveis: ${models.length} modelos detectados`
      ];
      if (wsInfo) {
        lines.push(`Workspace: ${String(wsInfo.name)} (${String(wsInfo.files ?? 0)} arquivos, ${String(wsInfo.bytes ?? 0)} bytes)`);
      }
      const refreshedAt = maintenance.modelsRefreshedAt ?? commandRegistry.lastRefreshedAt();
      if (refreshedAt) {
        lines.push(`Última atualização do catálogo: ${new Date(refreshedAt).toLocaleString('pt-BR')}`);
      }

      return {
        text: lines.join('\n'),
        data: {
          server: 'online',
          auth,
          modelCount: models.length,
          currentModel,
          workspace: wsInfo,
          maintenance
        }
      };
    }));

    server.registerTool('cli_help', {
      title: 'Ajuda dos comandos do Antigravity CLI',
      description: 'Exibe a ajuda geral dos comandos do Antigravity CLI quando chamada sem argumentos (como /help) ou exibe a documentação completa e flags de um comando específico (como /help models).',
      inputSchema: z.object({ command: z.string().min(1).max(64).optional() }),
      annotations: readOnly
    }, ({ command }) => guardedFormatted(async () => {
      const helpData = await commandRegistry.getCommandHelp(command);
      if (!command) {
        const commands = (helpData.commands as Array<{ name: string; description: string; executable: boolean; restriction?: string }>) || [];
        const lines = [
          'Antigravity CLI',
          '',
          'Comandos disponíveis:'
        ];
        for (const cmd of commands) {
          const status = cmd.executable ? '' : ` (${cmd.restriction ?? 'restrito'})`;
          lines.push(`• ${cmd.name}: ${cmd.description}${status}`);
        }
        lines.push('');
        lines.push('Para ver detalhes de um comando específico:');
        lines.push('/help <comando>');
        return { text: lines.join('\n'), data: helpData };
      }
      const text = [
        `Ajuda: agy ${command}`,
        '',
        String(helpData.documentation || '(sem documentação disponível)')
      ].join('\n');
      return { text, data: helpData };
    }));

    server.registerTool('cli_update', {
      title: 'Atualizar Antigravity CLI',
      description: 'Executa atualização protegida do Antigravity CLI no servidor, com proteção de concorrência e atualização imediata do catálogo de modelos. Use quando o usuário digitar /update.',
      inputSchema: z.object({}),
      annotations: localWrite
    }, () => guardedFormatted(async () => {
      if (!provider.updateCLI) {
        throw new AppError(501, 'UPDATE_UNSUPPORTED', 'O provedor não oferece atualização automática.');
      }
      const maint = await provider.updateCLI();
      commandRegistry.invalidate();
      const text = [
        'Antigravity CLI',
        '',
        `Antes: ${maint.previousVersion ?? 'N/D'}`,
        `Depois: ${maint.installedVersion ?? 'N/D'}`,
        '',
        `Modelos atualizados: ${maint.modelsUpdated ? 'sim' : 'não'}`,
        `Mensagem: ${maint.message ?? 'Verificação concluída.'}`
      ].join('\n');
      return { text, data: maint as unknown as Record<string, unknown> };
    }));

    server.registerTool('cli_execute', {
      title: 'Executar comando seguro do Antigravity CLI',
      description: 'Executa diretamente um comando do executável oficial "agy" no servidor (sem passar por interpretadores de shell), com validação estrita, redação de credenciais e controle de timeout. Use para subcomandos como "models", "changelog", "agent", "mcp list", "plugin list".',
      inputSchema: z.object({
        command: z.string().min(1).max(64),
        args: z.array(z.string().min(1).max(500)).max(20).default([]),
        timeout_seconds: z.number().int().min(1).max(120).default(30)
      }),
      annotations: openWorld
    }, ({ command, args, timeout_seconds }) => guardedFormatted(async () => {
      const execResult = await commandRegistry.executeCommand(command, args, timeout_seconds);
      const text = [
        `agy ${command} ${args.join(' ')}`.trim(),
        `Código de saída: ${execResult.exitCode ?? 'N/D'} | Duração: ${execResult.durationMs}ms`,
        '',
        execResult.stdout || execResult.stderr || '(executado com sucesso, sem saída)'
      ].join('\n');
      return { text, data: execResult as unknown as Record<string, unknown> };
    }));

    server.registerTool('cli_history', {
      title: 'Histórico de comandos do workspace',
      description: 'Consulta o histórico recente de comandos e execuções no workspace de forma segura e higienizada.',
      inputSchema: z.object({
        workspace_id: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(10)
      }),
      annotations: readOnly
    }, ({ workspace_id, limit }) => guardedFormatted(async () => {
      const history = await workspaces.getCommandHistory(workspace_id, limit);
      if (history.length === 0) {
        return {
          text: 'Nenhum comando registrado no histórico deste workspace ainda.',
          data: { workspaceId: workspace_id, history: [] }
        };
      }
      const lines = ['Últimos comandos:'];
      for (const item of history) {
        const time = item.timestamp ? new Date(item.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--';
        lines.push(`${time}  ${item.command.padEnd(20)}  ${item.status}  ${item.summary}`);
      }
      return {
        text: lines.join('\n'),
        data: { workspaceId: workspace_id, count: history.length, history }
      };
    }));

    return server;
  }, { legacy: 'stateless', responseMode: 'auto', onerror });

  return { handler, nodeHandler: toNodeHandler(handler, { onerror }) };
}
