import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import type { AIProvider } from './types.js';

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

  constructor(private readonly config: Config, private readonly provider: AIProvider) {
    this.root = config.mcpWorkspacesDir;
    this.trashRoot = path.join(this.root, '.trash');
    this.artifactsRoot = path.join(config.dataDir, 'mcp-artifacts');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.root, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.trashRoot, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.artifactsRoot, { recursive: true, mode: 0o700 })
    ]);
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
    await fs.mkdir(root, { recursive: false, mode: 0o700 });
    await fs.writeFile(path.join(root, '.workspace.json'), JSON.stringify(metadata, null, 2), { mode: 0o600, flag: 'wx' });
    return metadata;
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
    const selectedModel = model && this.config.allowedModels.includes(model) ? model : this.config.DEFAULT_MODEL;
    const prompt = [
      'Execute o objetivo solicitado dentro do workspace atual.',
      'Trabalhe somente dentro deste workspace. Não tente acessar credenciais, diretórios externos ou serviços não solicitados.',
      'Você pode criar e editar arquivos, executar verificações e corrigir problemas até concluir o objetivo.',
      '',
      `OBJETIVO:\n${goal}`
    ].join('\n');
    const response = await this.provider.sendMessage({
      conversationId: crypto.randomUUID(),
      prompt,
      model: selectedModel,
      workingDirectory: root,
      executionMode: 'accept-edits',
      effort,
      autoApprove: true
    });
    return { workspaceId, model: selectedModel, response, workspace: await this.info(workspaceId) };
  }

  async skillList(workspaceId: string): Promise<Record<string, unknown>> {
    const { target } = await this.safePath(workspaceId, '.skills', true);
    const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
    return { workspaceId, skills: entries.filter((entry) => entry.isDirectory() && skillNamePattern.test(entry.name)).map((entry) => entry.name) };
  }

  async skillRead(workspaceId: string, name: string): Promise<Record<string, unknown>> {
    if (!skillNamePattern.test(name)) throw new AppError(400, 'INVALID_SKILL_NAME', 'Nome de skill inválido.');
    return this.readFile(workspaceId, `.skills/${name}/SKILL.md`);
  }

  async skillResources(workspaceId: string, name: string): Promise<Record<string, unknown>> {
    if (!skillNamePattern.test(name)) throw new AppError(400, 'INVALID_SKILL_NAME', 'Nome de skill inválido.');
    return this.listFiles(workspaceId, `.skills/${name}`, true);
  }

  async skillInstall(workspaceId: string, name: string, instructions: string, resources: Record<string, string>): Promise<Record<string, unknown>> {
    if (!skillNamePattern.test(name)) throw new AppError(400, 'INVALID_SKILL_NAME', 'Use letras minúsculas, números, hífen ou sublinhado no nome.');
    if (Buffer.byteLength(instructions) > 100_000) throw new AppError(413, 'SKILL_TOO_LARGE', 'Instruções da skill maiores que 100 KB.');
    await this.writeFile(workspaceId, `.skills/${name}/SKILL.md`, instructions, false);
    for (const [resourcePath, content] of Object.entries(resources)) {
      await this.writeFile(workspaceId, `.skills/${name}/resources/${resourcePath}`, content, false);
    }
    return { workspaceId, name, installed: true, resourceCount: Object.keys(resources).length };
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
