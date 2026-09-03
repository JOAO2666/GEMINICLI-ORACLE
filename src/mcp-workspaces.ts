import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import type { AIProvider } from './types.js';
import { resolveModelAlias } from './services/antigravity-provider.js';

export interface WorkspaceExecutionMetrics {
  timestamp: string;
  model: string;
  durationSeconds?: number;
  goalSummary?: string;
  usage?: Record<string, unknown>;
}

export interface WorkspaceMetadata {
  id: string;
  name: string;
  createdAt: string;
  selectedModel?: string;
  lastExecution?: WorkspaceExecutionMetrics;
}

export interface WorkspaceHistoryEntry {
  timestamp?: string;
  command: string;
  status: 'sucesso' | 'erro';
  summary: string;
  durationMs?: number;
}

const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const skillNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const maxTextBytes = 1024 * 1024;

function cleanName(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100);
  return cleaned || fallback;
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function skillDescription(content: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? '';
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => /^description:\s*/.test(line));
  if (index === -1) return '';

  let value = lines[index]!.replace(/^description:\s*/, '').trim();
  if (value === '|' || value === '>') {
    const separator = value === '>' ? ' ' : '\n';
    const parts: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (!/^\s+/.test(line)) break;
      parts.push(line.trim());
    }
    value = parts.join(separator).trim();
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.trim().slice(0, 1_000);
}

async function pathSize(target: string): Promise<{ files: number; directories: number; bytes: number }> {
  const totals = { files: 0, directories: 0, bytes: 0 };
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        totals.directories += 1;
        await walk(full);
      } else if (entry.isFile()) {
        totals.files += 1;
        totals.bytes += (await fs.stat(full)).size;
      }
    }
  };
  await walk(target);
  return totals;
}

export class McpWorkspaceService {
  private readonly root: string;
  private readonly trashRoot: string;
  private readonly artifactsRoot: string;
  private readonly skillCatalogRoot: string;

  constructor(private readonly config: Config, private readonly provider: AIProvider) {
    this.root = config.mcpWorkspacesDir;
    this.trashRoot = path.join(this.root, '.trash');
    this.artifactsRoot = path.join(config.dataDir, 'mcp-artifacts');
    this.skillCatalogRoot = config.skillCatalogDir;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.root, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.trashRoot, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.artifactsRoot, { recursive: true, mode: 0o700 })
    ]);
    if (this.config.MCP_AUTO_INSTALL_SKILLS) {
      for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
        if (entry.isDirectory() && workspaceIdPattern.test(entry.name)) {
          await this.installCatalogSkills(entry.name, [], false);
        }
      }
    }
  }

  private async workspaceRoot(workspaceId: string): Promise<string> {
    if (!workspaceIdPattern.test(workspaceId)) throw new AppError(400, 'INVALID_WORKSPACE', 'ID de workspace inválido.');
    const root = path.resolve(this.root, workspaceId);
    if (!inside(this.root, root) || root === this.root) throw new AppError(400, 'INVALID_WORKSPACE', 'Workspace inválido.');
    const stat = await fs.lstat(root).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Workspace não encontrado.');
    return root;
  }

  private async safePath(workspaceId: string, relativePath: string, allowRoot = false): Promise<{ root: string; target: string }> {
    const root = await this.workspaceRoot(workspaceId);
    if (relativePath.includes('\0')) throw new AppError(400, 'INVALID_PATH', 'Caminho inválido.');
    const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
    const target = path.resolve(root, normalized || '.');
    if (!inside(root, target) || (!allowRoot && target === root)) throw new AppError(400, 'INVALID_PATH', 'Caminho fora do workspace.');
    const relative = path.relative(root, target);
    let cursor = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      const stat = await fs.lstat(cursor).catch(() => null);
      if (!stat) break;
      if (stat.isSymbolicLink()) throw new AppError(400, 'SYMLINK_NOT_ALLOWED', 'Links simbólicos não são permitidos.');
    }
    return { root, target };
  }

  async create(name: string): Promise<Record<string, unknown>> {
    const id = crypto.randomUUID();
    const root = path.join(this.root, id);
    const createdAt = new Date().toISOString();
    const metadata = { id, name: cleanName(name, 'Novo workspace'), createdAt };
    // The worker supervisor starts as a credential-less root process and drops to
    // UID 1000 for commands. It needs traverse-only access before dropping UID;
    // files themselves remain private (0600) and the volume is not public.
    await fs.mkdir(root, { recursive: false, mode: 0o755 });
    try {
      await fs.writeFile(path.join(root, '.workspace.json'), JSON.stringify(metadata, null, 2), { mode: 0o600, flag: 'wx' });
      const skills = this.config.MCP_AUTO_INSTALL_SKILLS ? await this.installCatalogSkills(id, [], false) : undefined;
      return { ...metadata, ...(skills ? { skillsInstalled: skills.installed } : {}) };
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async remove(workspaceId: string): Promise<Record<string, unknown>> {
    const root = await this.workspaceRoot(workspaceId);
    const trashedAt = new Date().toISOString();
    const destination = path.join(this.trashRoot, `${workspaceId}-${Date.now()}`);
    await fs.rename(root, destination);
    return { workspaceId, deleted: true, recoverable: true, trashedAt };
  }

  async info(workspaceId: string): Promise<Record<string, unknown>> {
    const root = await this.workspaceRoot(workspaceId);
    const metadata = JSON.parse(await fs.readFile(path.join(root, '.workspace.json'), 'utf8')) as Record<string, unknown>;
    return { ...metadata, ...(await pathSize(root)) };
  }

  async getMetadata(workspaceId: string): Promise<WorkspaceMetadata> {
    const root = await this.workspaceRoot(workspaceId);
    const metadata = JSON.parse(await fs.readFile(path.join(root, '.workspace.json'), 'utf8')) as WorkspaceMetadata;
    return metadata;
  }

  async saveMetadata(workspaceId: string, metadata: WorkspaceMetadata): Promise<void> {
    const root = await this.workspaceRoot(workspaceId);
    const temporary = path.join(root, `.workspace.json.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(metadata, null, 2), { mode: 0o600 });
    await fs.rename(temporary, path.join(root, '.workspace.json'));
  }

  async getWorkspaceModel(workspaceId: string): Promise<string | undefined> {
    const metadata = await this.getMetadata(workspaceId);
    return metadata.selectedModel;
  }

  async setWorkspaceModel(workspaceId: string, requestedModel: string): Promise<{ previous?: string; current: string }> {
    const metadata = await this.getMetadata(workspaceId);
    const previous = metadata.selectedModel;
    const discovered = await this.provider.listModels();
    const available = discovered.length > 0 ? discovered : (this.config.allowedModels.length > 0 ? this.config.allowedModels : [this.config.DEFAULT_MODEL]);
    const resolved = resolveModelAlias(requestedModel, available, this.config.DEFAULT_MODEL);
    if (!resolved.model) {
      if (resolved.ambiguous && resolved.ambiguous.length > 0) {
        throw new AppError(400, 'AMBIGUOUS_MODEL', `Atalho de modelo ambíguo. Opções disponíveis: ${resolved.ambiguous.join(', ')}`);
      }
      throw new AppError(400, 'MODEL_NOT_AVAILABLE', `Modelo não disponível no Antigravity CLI. Disponíveis: ${available.join(', ')}`);
    }
    metadata.selectedModel = resolved.model;
    await this.saveMetadata(workspaceId, metadata);
    await this.appendCommandHistory(workspaceId, {
      command: `model_set ${resolved.model}`,
      status: 'sucesso',
      summary: `Modelo alterado de ${previous ?? 'padrão'} para ${resolved.model}`
    });
    return { previous, current: resolved.model };
  }

  async getLastExecution(workspaceId: string): Promise<WorkspaceExecutionMetrics | null> {
    const metadata = await this.getMetadata(workspaceId);
    return metadata.lastExecution ?? null;
  }

  async appendCommandHistory(workspaceId: string, entry: WorkspaceHistoryEntry): Promise<void> {
    const root = await this.workspaceRoot(workspaceId);
    const historyFile = path.join(root, '.cli_history.json');
    let history: WorkspaceHistoryEntry[] = [];
    try {
      const content = await fs.readFile(historyFile, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) history = parsed;
    } catch {
      history = [];
    }
    history.unshift({
      timestamp: entry.timestamp || new Date().toISOString(),
      command: entry.command,
      status: entry.status,
      summary: entry.summary.slice(0, 300),
      durationMs: entry.durationMs
    });
    if (history.length > 50) history = history.slice(0, 50);
    const temporary = `${historyFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(history, null, 2), { mode: 0o600 });
    await fs.rename(temporary, historyFile);
  }

  async getCommandHistory(workspaceId: string, limit = 10): Promise<WorkspaceHistoryEntry[]> {
    const root = await this.workspaceRoot(workspaceId);
    const historyFile = path.join(root, '.cli_history.json');
    try {
      const content = await fs.readFile(historyFile, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed.slice(0, Math.max(1, Math.min(50, limit)));
      }
    } catch {
      // ignore
    }
    return [];
  }

  async listFiles(workspaceId: string, relativePath = '.', recursive = true): Promise<Record<string, unknown>> {
    const { root, target } = await this.safePath(workspaceId, relativePath, true);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isDirectory()) throw new AppError(404, 'DIRECTORY_NOT_FOUND', 'Diretório não encontrado.');
    const entries: Array<Record<string, unknown>> = [];
    const walk = async (directory: string, depth: number) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entries.length >= 500) return;
        const full = path.join(directory, entry.name);
        const relative = path.relative(root, full).replaceAll('\\', '/');
        if (entry.isSymbolicLink()) {
          entries.push({ path: relative, type: 'symlink', accessible: false });
        } else if (entry.isDirectory()) {
          entries.push({ path: relative, type: 'directory' });
          if (recursive && depth < 8) await walk(full, depth + 1);
        } else if (entry.isFile()) {
          const fileStat = await fs.stat(full);
          entries.push({ path: relative, type: 'file', size: fileStat.size, modifiedAt: fileStat.mtime.toISOString() });
        }
      }
    };
    await walk(target, 0);
    return { workspaceId, path: path.relative(root, target).replaceAll('\\', '/') || '.', entries, truncated: entries.length >= 500 };
  }

  async readFile(workspaceId: string, relativePath: string): Promise<Record<string, unknown>> {
    const { root, target } = await this.safePath(workspaceId, relativePath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) throw new AppError(404, 'FILE_NOT_FOUND', 'Arquivo não encontrado.');
    if (stat.size > maxTextBytes) throw new AppError(413, 'FILE_TOO_LARGE', 'Arquivo de texto maior que 1 MB.');
    const data = await fs.readFile(target);
    if (data.includes(0)) throw new AppError(415, 'BINARY_FILE', 'Use artifact_publish para arquivos binários.');
    return { workspaceId, path: path.relative(root, target).replaceAll('\\', '/'), content: data.toString('utf8'), size: stat.size };
  }

  async writeFile(workspaceId: string, relativePath: string, content: string, overwrite: boolean): Promise<Record<string, unknown>> {
    if (Buffer.byteLength(content) > maxTextBytes) throw new AppError(413, 'CONTENT_TOO_LARGE', 'Conteúdo maior que 1 MB.');
    const { root, target } = await this.safePath(workspaceId, relativePath);
    if (path.basename(target) === '.workspace.json') throw new AppError(403, 'PROTECTED_FILE', 'Metadados do workspace são protegidos.');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await this.safePath(workspaceId, path.relative(root, path.dirname(target)), true);
    if (!overwrite) {
      await fs.writeFile(target, content, { mode: 0o600, flag: 'wx' });
    } else {
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, target);
    }
    return { workspaceId, path: path.relative(root, target).replaceAll('\\', '/'), bytes: Buffer.byteLength(content) };
  }

  async editFile(workspaceId: string, relativePath: string, oldText: string, newText: string, replaceAll: boolean): Promise<Record<string, unknown>> {
    if (!oldText) throw new AppError(400, 'EMPTY_SEARCH', 'O texto procurado não pode estar vazio.');
    const current = await this.readFile(workspaceId, relativePath);
    const content = String(current.content);
    const matches = content.split(oldText).length - 1;
    if (matches === 0) throw new AppError(409, 'TEXT_NOT_FOUND', 'O texto procurado não foi encontrado.');
    if (!replaceAll && matches !== 1) throw new AppError(409, 'AMBIGUOUS_EDIT', 'O texto aparece mais de uma vez; use replace_all ou forneça mais contexto.');
    const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    await this.writeFile(workspaceId, relativePath, updated, true);
    return { workspaceId, path: relativePath, replacements: replaceAll ? matches : 1 };
  }

  private async callWorker(endpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.config.MCP_WORKER_TOKEN) throw new AppError(503, 'WORKER_UNAVAILABLE', 'Executor isolado não configurado.');
    const response = await fetch(`${this.config.MCP_WORKER_URL}${endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.MCP_WORKER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.config.MCP_COMMAND_TIMEOUT_MS + 10_000)
    }).catch(() => null);
    if (!response) throw new AppError(503, 'WORKER_UNAVAILABLE', 'Executor isolado indisponível.');
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new AppError(response.status, 'WORKER_ERROR', typeof result.message === 'string' ? result.message : 'Falha no executor isolado.');
    return result;
  }

  async shellExecute(workspaceId: string, command: string, timeoutSeconds: number): Promise<Record<string, unknown>> {
    await this.workspaceRoot(workspaceId);
    return this.callWorker('/run', { workspaceId, command, timeoutSeconds });
  }

  async gitClone(workspaceId: string, repositoryUrl: string, destination: string, ref?: string): Promise<Record<string, unknown>> {
    await this.workspaceRoot(workspaceId);
    return this.callWorker('/git-clone', { workspaceId, repositoryUrl, destination, ref });
  }

  async goalRun(workspaceId: string, goal: string, model?: string, effort: 'low' | 'medium' | 'high' = 'high'): Promise<Record<string, unknown>> {
    const root = await this.workspaceRoot(workspaceId);
    const metadata = await this.getMetadata(workspaceId);
    const discoveredModels = await this.provider.listModels();
    const availableModels = discoveredModels.length > 0
      ? discoveredModels
      : (this.config.allowedModels.length > 0 ? this.config.allowedModels : [this.config.DEFAULT_MODEL]);

    let resolvedModel: string | undefined;
    let notice: string | undefined;

    if (model) {
      const aliasMatch = resolveModelAlias(model, availableModels, this.config.DEFAULT_MODEL);
      if (!aliasMatch.model) {
        if (aliasMatch.ambiguous && aliasMatch.ambiguous.length > 0) {
          throw new AppError(400, 'AMBIGUOUS_MODEL', `Atalho de modelo ambíguo. Opções disponíveis: ${aliasMatch.ambiguous.join(', ')}`);
        }
        throw new AppError(400, 'MODEL_NOT_AVAILABLE', `O modelo solicitado não está disponível no Antigravity CLI. Disponíveis: ${availableModels.join(', ')}`);
      }
      resolvedModel = aliasMatch.model;
    } else if (metadata.selectedModel) {
      if (availableModels.includes(metadata.selectedModel)) {
        resolvedModel = metadata.selectedModel;
      } else {
        const fallback = availableModels.includes(this.config.DEFAULT_MODEL) ? this.config.DEFAULT_MODEL : availableModels[0];
        resolvedModel = fallback;
        notice = `O modelo selecionado anteriormente para este workspace (${metadata.selectedModel}) não está mais disponível no Antigravity CLI. Usando ${resolvedModel}.`;
      }
    } else {
      resolvedModel = availableModels.includes(this.config.DEFAULT_MODEL) ? this.config.DEFAULT_MODEL : availableModels[0];
    }

    if (!resolvedModel) {
      throw new AppError(400, 'MODEL_NOT_AVAILABLE', 'Nenhum modelo disponível no Antigravity CLI.');
    }

    const prompt = [
      'Execute o objetivo solicitado dentro do workspace atual.',
      `O único workspace autorizado é exatamente: ${root}`,
      `Use sempre caminhos absolutos iniciados por ${root}${path.sep} ao criar, ler, editar ou executar arquivos.`,
      'Nunca use o diretório scratch do Antigravity. Não tente acessar credenciais, diretórios externos ou serviços não solicitados.',
      'Você pode criar e editar arquivos, executar verificações e corrigir problemas até concluir o objetivo.',
      `As skills disponíveis ficam em ${path.join(root, '.agents', 'skills')}. Consulte o SKILL.md da skill relevante antes de agir e use seus recursos somente quando forem úteis ao objetivo.`,
      'Algumas skills foram originalmente escritas para Claude. Nesse conteúdo, interprete "Claude" como o agente atual e adapte Read/Write/Bash/create_file às ferramentas locais disponíveis.',
      'Não chame APIs externas nem use chaves próprias. Use somente o modelo selecionado e autenticado pelo Antigravity CLI do servidor.',
      '',
      `OBJETIVO:\n${goal}`
    ].join('\n');

    const started = Date.now();
    let responseText = '';
    let usage: unknown;

    if (this.provider.sendMessageDetailed) {
      const detailed = await this.provider.sendMessageDetailed({
        conversationId: crypto.randomUUID(),
        prompt,
        model: resolvedModel,
        workingDirectory: root,
        executionMode: 'accept-edits',
        effort,
        autoApprove: true
      });
      responseText = detailed.text;
      usage = detailed.usage;
    } else {
      responseText = await this.provider.sendMessage({
        conversationId: crypto.randomUUID(),
        prompt,
        model: resolvedModel,
        workingDirectory: root,
        executionMode: 'accept-edits',
        effort,
        autoApprove: true
      });
    }

    const durationSeconds = Math.round((Date.now() - started) / 100) / 10;
    const executionUsage = usage && typeof usage === 'object' ? usage as Record<string, unknown> : undefined;

    metadata.lastExecution = {
      timestamp: new Date().toISOString(),
      model: resolvedModel,
      durationSeconds,
      goalSummary: goal.slice(0, 100),
      ...(executionUsage ? { usage: executionUsage } : {})
    };
    await this.saveMetadata(workspaceId, metadata);

    await this.appendCommandHistory(workspaceId, {
      command: `goal_run [${resolvedModel}]`,
      status: 'sucesso',
      summary: `Concluído em ${durationSeconds}s. Objetivo: ${goal.slice(0, 80)}`,
      durationMs: Date.now() - started
    });

    return {
      workspaceId,
      model: resolvedModel,
      ...(notice ? { notice } : {}),
      response: responseText,
      ...(executionUsage ? { usage: executionUsage } : {}),
      durationSeconds,
      workspace: await this.info(workspaceId)
    };
  }

  async skillList(workspaceId: string): Promise<Record<string, unknown>> {
    const names = new Set<string>();
    for (const relative of ['.agents/skills', '.skills']) {
      const { target } = await this.safePath(workspaceId, relative, true);
      for (const entry of await fs.readdir(target, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && skillNamePattern.test(entry.name)) names.add(entry.name);
      }
    }
    return { workspaceId, skills: [...names].sort(), catalogCount: (await this.catalogEntries()).length };
  }

  async skillRead(workspaceId: string, name: string): Promise<Record<string, unknown>> {
    if (!skillNamePattern.test(name)) throw new AppError(400, 'INVALID_SKILL_NAME', 'Nome de skill inválido.');
    const relative = await this.installedSkillPath(workspaceId, name);
    return this.readFile(workspaceId, `${relative}/SKILL.md`);
  }

  async skillResources(workspaceId: string, name: string): Promise<Record<string, unknown>> {
    if (!skillNamePattern.test(name)) throw new AppError(400, 'INVALID_SKILL_NAME', 'Nome de skill inválido.');
    return this.listFiles(workspaceId, await this.installedSkillPath(workspaceId, name), true);
  }

  async skillInstall(workspaceId: string, name: string, instructions: string, resources: Record<string, string>): Promise<Record<string, unknown>> {
    if (!skillNamePattern.test(name)) throw new AppError(400, 'INVALID_SKILL_NAME', 'Use letras minúsculas, números, hífen ou sublinhado no nome.');
    if (Buffer.byteLength(instructions) > 100_000) throw new AppError(413, 'SKILL_TOO_LARGE', 'Instruções da skill maiores que 100 KB.');
    await this.writeFile(workspaceId, `.agents/skills/${name}/SKILL.md`, instructions, false);
    for (const [resourcePath, content] of Object.entries(resources)) {
      await this.writeFile(workspaceId, `.agents/skills/${name}/resources/${resourcePath}`, content, false);
    }
    return { workspaceId, name, installed: true, resourceCount: Object.keys(resources).length };
  }

  async skillCatalog(): Promise<Record<string, unknown>> {
    const skills = await this.catalogEntries();
    return { count: skills.length, skills };
  }

  async installCatalogSkills(
    workspaceId: string,
    requestedNames: string[] = [],
    overwrite = false
  ): Promise<{ workspaceId: string; installed: string[]; skipped: string[] }> {
    const root = await this.workspaceRoot(workspaceId);
    const catalog = await this.catalogEntries();
    const available = new Map(catalog.map((entry) => [entry.name, entry]));
    const names = requestedNames.length ? [...new Set(requestedNames)] : [...available.keys()];
    const installed: string[] = [];
    const skipped: string[] = [];
    for (const name of names) {
      if (!skillNamePattern.test(name)) throw new AppError(400, 'INVALID_SKILL_NAME', `Nome de skill inválido: ${name}.`);
      const entry = available.get(name);
      if (!entry) throw new AppError(404, 'SKILL_NOT_IN_CATALOG', `Skill não encontrada no catálogo: ${name}.`);
      const source = path.join(this.skillCatalogRoot, name);
      const destination = path.join(root, '.agents', 'skills', name);
      const existing = await fs.lstat(destination).catch(() => null);
      if (existing && !overwrite) {
        skipped.push(name);
        continue;
      }
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await this.copySkillTree(source, temporary);
      if (existing) {
        const backup = `${destination}.${crypto.randomUUID()}.bak`;
        await fs.rename(destination, backup);
        try {
          await fs.rename(temporary, destination);
          await fs.rm(backup, { recursive: true, force: true });
        } catch (error) {
          await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
          await fs.rename(backup, destination).catch(() => undefined);
          throw error;
        }
      } else {
        await fs.rename(temporary, destination);
      }
      installed.push(name);
    }
    return { workspaceId, installed, skipped };
  }

  async skillRemove(workspaceId: string, name: string): Promise<Record<string, unknown>> {
    if (!skillNamePattern.test(name)) throw new AppError(400, 'INVALID_SKILL_NAME', 'Nome de skill inválido.');
    const root = await this.workspaceRoot(workspaceId);
    const relative = await this.installedSkillPath(workspaceId, name);
    const source = path.join(root, relative);
    const destination = path.join(root, '.trash', 'skills', `${name}-${Date.now()}`);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.rename(source, destination);
    return { workspaceId, name, removed: true, recoverable: true };
  }

  private async installedSkillPath(workspaceId: string, name: string): Promise<string> {
    for (const relative of [`.agents/skills/${name}`, `.skills/${name}`]) {
      const { target } = await this.safePath(workspaceId, relative, true);
      const stat = await fs.lstat(target).catch(() => null);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) return relative;
    }
    throw new AppError(404, 'SKILL_NOT_FOUND', `Skill não instalada: ${name}.`);
  }

  private async catalogEntries(): Promise<Array<{ name: string; description: string; source: 'anthropic' | 'numia' }>> {
    const entries: Array<{ name: string; description: string; source: 'anthropic' | 'numia' }> = [];
    for (const entry of await fs.readdir(this.skillCatalogRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !skillNamePattern.test(entry.name)) continue;
      const skillFile = path.join(this.skillCatalogRoot, entry.name, 'SKILL.md');
      const stat = await fs.lstat(skillFile).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 100_000) continue;
      const content = await fs.readFile(skillFile, 'utf8');
      entries.push({
        name: entry.name,
        description: skillDescription(content),
        source: await fs.stat(path.join(this.skillCatalogRoot, entry.name, 'LICENSE.txt')).then(() => 'anthropic' as const).catch(() => 'numia' as const)
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async copySkillTree(source: string, destination: string): Promise<void> {
    const totals = { files: 0, bytes: 0 };
    const walk = async (from: string, to: string, depth: number): Promise<void> => {
      if (depth > 12) throw new AppError(413, 'SKILL_TOO_LARGE', 'Skill excede a profundidade permitida.');
      await fs.mkdir(to, { recursive: true, mode: 0o700 });
      for (const entry of await fs.readdir(from, { withFileTypes: true })) {
        const sourcePath = path.join(from, entry.name);
        const destinationPath = path.join(to, entry.name);
        if (entry.isSymbolicLink()) throw new AppError(400, 'SKILL_SYMLINK_NOT_ALLOWED', 'Skills com links simbólicos não são permitidas.');
        if (entry.isDirectory()) {
          await walk(sourcePath, destinationPath, depth + 1);
        } else if (entry.isFile()) {
          const stat = await fs.stat(sourcePath);
          totals.files += 1;
          totals.bytes += stat.size;
          if (totals.files > 500 || stat.size > 5 * 1024 * 1024 || totals.bytes > 20 * 1024 * 1024) {
            throw new AppError(413, 'SKILL_TOO_LARGE', 'Skill excede os limites seguros do catálogo.');
          }
          await fs.copyFile(sourcePath, destinationPath);
          await fs.chmod(destinationPath, 0o600);
        }
      }
    };
    try {
      await walk(source, destination, 0);
      const skillFile = path.join(destination, 'SKILL.md');
      const skillStat = await fs.stat(skillFile).catch(() => null);
      if (!skillStat?.isFile()) throw new AppError(400, 'INVALID_SKILL', 'Skill sem SKILL.md.');
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private publicBaseUrl(): string {
    const configured = this.config.PUBLIC_BASE_URL.trim().replace(/\/$/, '');
    if (configured) return configured;
    if (this.config.DOMAIN) return `https://${this.config.DOMAIN}`;
    throw new AppError(503, 'PUBLIC_URL_MISSING', 'PUBLIC_BASE_URL não configurada.');
  }

  async publishArtifact(workspaceId: string, relativePath: string): Promise<Record<string, unknown>> {
    const { target } = await this.safePath(workspaceId, relativePath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) throw new AppError(404, 'FILE_NOT_FOUND', 'Arquivo não encontrado.');
    if (stat.size > 100 * 1024 * 1024) throw new AppError(413, 'ARTIFACT_TOO_LARGE', 'Artefato maior que 100 MB.');
    const artifactId = crypto.randomUUID();
    const name = cleanName(path.basename(target), 'artifact.bin');
    const destination = path.join(this.artifactsRoot, workspaceId, artifactId, name);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(target, destination);
    return {
      workspaceId, artifactId, name, size: stat.size,
      url: `${this.publicBaseUrl()}/artifacts/${workspaceId}/${artifactId}/${encodeURIComponent(name)}`
    };
  }

  async listArtifacts(workspaceId: string): Promise<Record<string, unknown>> {
    await this.workspaceRoot(workspaceId);
    const root = path.join(this.artifactsRoot, workspaceId);
    const artifacts: Array<Record<string, unknown>> = [];
    for (const idEntry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!idEntry.isDirectory() || !workspaceIdPattern.test(idEntry.name)) continue;
      for (const fileEntry of await fs.readdir(path.join(root, idEntry.name), { withFileTypes: true })) {
        if (!fileEntry.isFile()) continue;
        const full = path.join(root, idEntry.name, fileEntry.name);
        const stat = await fs.stat(full);
        artifacts.push({
          artifactId: idEntry.name, name: fileEntry.name, size: stat.size, createdAt: stat.birthtime.toISOString(),
          url: `${this.publicBaseUrl()}/artifacts/${workspaceId}/${idEntry.name}/${encodeURIComponent(fileEntry.name)}`
        });
      }
    }
    return { workspaceId, artifacts };
  }

  async artifactPath(workspaceId: string, artifactId: string, name: string): Promise<string> {
    if (!workspaceIdPattern.test(workspaceId) || !workspaceIdPattern.test(artifactId)) throw new AppError(404, 'ARTIFACT_NOT_FOUND', 'Artefato não encontrado.');
    const root = path.resolve(this.artifactsRoot, workspaceId, artifactId);
    const target = path.resolve(root, cleanName(name, 'invalid'));
    if (!inside(root, target) || target === root) throw new AppError(404, 'ARTIFACT_NOT_FOUND', 'Artefato não encontrado.');
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) throw new AppError(404, 'ARTIFACT_NOT_FOUND', 'Artefato não encontrado.');
    return target;
  }
}
