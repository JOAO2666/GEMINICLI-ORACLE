import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { McpWorkspaceService } from './mcp-workspaces.js';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const localWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const openWorld = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function result(data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'Falha inesperada.';
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function guarded<T extends Record<string, unknown>>(callback: () => Promise<T>) {
  return callback().then(result).catch(failure);
}

export interface McpEndpoint {
  handler: McpHttpHandler;
  nodeHandler: NodeMcpRequestHandler;
}

export function createWorkspaceMcpEndpoint(workspaces: McpWorkspaceService, onerror: (error: Error) => void): McpEndpoint {
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

    return server;
  }, { legacy: 'stateless', responseMode: 'auto', onerror });

  return { handler, nodeHandler: toNodeHandler(handler, { onerror }) };
}
