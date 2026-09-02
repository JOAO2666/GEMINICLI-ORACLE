import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AppError, publicProviderError } from '../errors.js';
import type { AIProvider, ProviderEvent, ProviderMaintenance, ProviderRequest, ProviderStatus } from '../types.js';
import type { Config } from '../config.js';
import { Semaphore } from './queue.js';
import { parseJsonLine } from './stream-parser.js';

type ChannelItem = { event: ProviderEvent } | { error: Error } | { done: true };

class AsyncChannel {
  private items: ChannelItem[] = [];
  private waiters: Array<(item: ChannelItem) => void> = [];
  push(item: ChannelItem) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }
  next(): Promise<ChannelItem> {
    const item = this.items.shift();
    return item ? Promise.resolve(item) : new Promise((resolve) => this.waiters.push(resolve));
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM ?? 'dumb',
    TMPDIR: process.env.TMPDIR ?? '/tmp'
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function parseAntigravityModels(stdout: string): string[] {
  return [...new Set(stdout.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((model): model is string => Boolean(model && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(model))))];
}

export function parseAntigravityUsage(stdout: string): Record<string, unknown> {
  const payload = JSON.parse(stdout) as Record<string, unknown>;
  const data = objectValue(objectValue(payload.command).data);
  const groups = Array.isArray(data.groups) ? data.groups.map((rawGroup) => {
    const group = objectValue(rawGroup);
    const buckets = Array.isArray(group.buckets) ? group.buckets.map((rawBucket) => {
      const bucket = objectValue(rawBucket);
      const remaining = typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction : undefined;
      return {
        id: bucket.id, name: bucket.name, window: bucket.window,
        remainingFraction: remaining,
        remainingPercent: remaining === undefined ? undefined : Math.round(remaining * 10_000) / 100,
        usedPercent: remaining === undefined ? undefined : Math.round((1 - remaining) * 10_000) / 100,
        resetTime: bucket.reset_time
      };
    }) : [];
    return { name: group.name, description: group.description, buckets };
  }) : [];
  return { checkedAt: new Date().toISOString(), description: data.description, groups };
}

export function buildAntigravityArgs(request: ProviderRequest, timeoutMs: number): string[] {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = [
    '--prompt', request.prompt,
    '--model', request.model,
    '--output-format', 'stream-json',
    '--mode', request.executionMode ?? 'plan',
    '--sandbox',
    '--print-timeout', `${timeoutSeconds}s`
  ];
  if (request.effort) args.push('--effort', request.effort);
  if (request.autoApprove) args.push('--dangerously-skip-permissions');
  if (request.jsonSchema) args.push('--json-schema', JSON.stringify(request.jsonSchema));
  return args;
}

export class AntigravityCLIProvider implements AIProvider {
  private readonly semaphore: Semaphore;
  private readonly active = new Map<string, AbortController>();
  private modelCache: string[] = [];
  private modelsRefreshedAt = 0;
  private modelRefreshPromise?: Promise<string[]>;
  private updatePromise?: Promise<ProviderMaintenance>;
  private lastMaintenance: ProviderMaintenance = {};

  constructor(private readonly config: Config) {
    this.semaphore = new Semaphore(config.MAX_GEMINI_PROCESSES);
  }

  supportsFiles(): boolean { return true; }

  async listModels(): Promise<string[]> {
    return this.refreshModels(false);
  }

  async refreshModels(force = true): Promise<string[]> {
    const fresh = Date.now() - this.modelsRefreshedAt < this.config.MODEL_REFRESH_INTERVAL_MS;
    if (!force && fresh && this.modelCache.length > 0) return [...this.modelCache];
    if (this.modelRefreshPromise) return this.modelRefreshPromise;
    this.modelRefreshPromise = (async () => {
      const result = await this.run(['models'], 20_000);
      if (result?.code === 0) {
        const unique = parseAntigravityModels(result.stdout);
        this.modelCache = this.config.allowedModels.length > 0
          ? unique.filter((model) => this.config.allowedModels.includes(model))
          : unique;
        this.modelsRefreshedAt = Date.now();
        this.lastMaintenance.modelsRefreshedAt = new Date(this.modelsRefreshedAt).toISOString();
      }
      const fallback = this.config.allowedModels.length > 0 ? this.config.allowedModels : [this.config.DEFAULT_MODEL];
      return [...(this.modelCache.length > 0 ? this.modelCache : fallback)];
    })().finally(() => { this.modelRefreshPromise = undefined; });
    return this.modelRefreshPromise;
  }

  async getUsage(): Promise<unknown> {
    const result = await this.run(['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'], 30_000);
    if (!result || result.code !== 0) {
      throw new AppError(503, 'USAGE_UNAVAILABLE', 'Não foi possível consultar o uso do Antigravity CLI.');
    }
    return parseAntigravityUsage(result.stdout);
  }

  maintenanceStatus(): ProviderMaintenance {
    return { ...this.lastMaintenance };
  }

  async updateCLI(): Promise<ProviderMaintenance> {
    if (this.updatePromise) return this.updatePromise;
    if (this.active.size > 0) {
      return { ...this.lastMaintenance, skipped: true, message: 'Atualização adiada: há gerações em andamento.' };
    }
    this.updatePromise = (async () => {
      const before = await this.run(['--version'], 10_000);
      const update = await this.run(['update'], 120_000);
      const after = await this.run(['--version'], 10_000);
      const beforeVersion = before?.stdout.trim();
      const installedVersion = after?.stdout.trim() || beforeVersion;
      const status: ProviderMaintenance = {
        installedVersion,
        updated: Boolean(beforeVersion && installedVersion && beforeVersion !== installedVersion),
        skipped: false,
        message: update?.code === 0 ? 'Verificação de atualização concluída.' : 'Não foi possível atualizar o CLI; a versão instalada foi mantida.'
      };
      this.lastMaintenance = { ...this.lastMaintenance, ...status };
      await this.refreshModels(true);
      return { ...this.lastMaintenance };
    })().finally(() => { this.updatePromise = undefined; });
    return this.updatePromise;
  }

  async checkAuthentication(): Promise<ProviderStatus> {
    const version = await this.run(['--version'], 10_000);
    if (!version || version.code !== 0) return { available: false, authenticated: null, message: 'Executável agy não encontrado.' };
    const models = await this.run(['models'], 20_000);
    return {
      available: true,
      authenticated: models?.code === 0,
      version: version.stdout.trim(),
      message: models?.code === 0 ? 'Antigravity CLI autenticado.' : 'Execute agy interativamente para autenticar.'
    };
  }

  private run(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string } | null> {
    return new Promise((resolve) => {
      const child = spawn(this.config.AGY_COMMAND, args, {
        env: safeEnvironment(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (chunk) => { if (stdout.length < 32_768) stdout += String(chunk); });
      child.once('error', () => { clearTimeout(timer); resolve(null); });
      child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    });
  }

  cancel(conversationId: string): boolean {
    const controller = this.active.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async sendMessage(request: ProviderRequest): Promise<string> {
    let result = '';
    for await (const event of this.streamMessage(request)) {
      if (event.type === 'delta') result += event.text;
      if (event.type === 'complete') result = event.text;
    }
    return result;
  }

  async *streamMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    if (this.active.has(request.conversationId)) throw new AppError(409, 'CONVERSATION_BUSY', 'Já existe uma geração ativa para esta conversa.');
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    request.signal?.addEventListener('abort', forwardAbort, { once: true });
    this.active.set(request.conversationId, controller);
    let release: (() => void) | undefined;

    try {
      release = await this.semaphore.acquire(controller.signal);
      const args = buildAntigravityArgs(request, this.config.AGY_TIMEOUT_MS);
      const channel = new AsyncChannel();
      const child = spawn(this.config.AGY_COMMAND, args, {
        cwd: request.workingDirectory,
        env: safeEnvironment(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let response = '';
      let stderr = '';
      let sessionId: string | undefined;
      let stats: unknown;
      let structuredOutput: unknown;
      let resultFailure: string | undefined;
      let settled = false;

      const terminate = () => {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3_000).unref();
        }
      };
      controller.signal.addEventListener('abort', terminate, { once: true });
      const timeout = setTimeout(() => {
        controller.abort();
        if (!settled) channel.push({ error: new AppError(504, 'AI_TIMEOUT', 'O Antigravity CLI excedeu o tempo limite.') });
      }, this.config.AGY_TIMEOUT_MS + 5_000);

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        const event = parseJsonLine(line);
        if (!event) return;
        if (event.event === 'init') {
          sessionId = typeof event.conversation_id === 'string' ? event.conversation_id : undefined;
          channel.push({ event: { type: 'start', conversationId: request.conversationId, model: request.model, sessionId } });
        } else if (event.event === 'step_update') {
          const step = objectValue(event.step_update);
          if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
            response += step.text_delta;
            channel.push({ event: { type: 'delta', text: step.text_delta } });
          } else if (step.step_type === 'tool') {
            channel.push({ event: {
              type: 'tool',
              name: typeof step.tool_name === 'string' ? step.tool_name : 'tool',
              status: step.state === 'DONE' ? 'success' : 'running'
            } });
          }
        } else if (event.event === 'result') {
          const result = objectValue(event.result);
          sessionId = typeof result.conversation_id === 'string' ? result.conversation_id : sessionId;
          stats = result.usage;
          structuredOutput = result.structured_output;
          if (typeof result.response === 'string') response = result.response;
          if (result.status !== 'SUCCESS') resultFailure = typeof result.error === 'string' ? result.error : `Status ${String(result.status)}`;
        }
      });
      child.stderr.on('data', (chunk) => { if (stderr.length < 32_768) stderr += String(chunk); });
      child.once('error', (error: NodeJS.ErrnoException) => {
        settled = true;
        clearTimeout(timeout);
        channel.push({ error: error.code === 'ENOENT'
          ? new AppError(503, 'ANTIGRAVITY_NOT_INSTALLED', 'O executável oficial agy não foi encontrado no servidor.')
          : error });
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (controller.signal.aborted) channel.push({ error: new AppError(499, 'REQUEST_CANCELLED', 'Geração cancelada.') });
        else if (code !== 0) channel.push({ error: publicProviderError(`${stderr}\n${resultFailure ?? ''}`, code) });
        else if (resultFailure) channel.push({ error: publicProviderError(resultFailure, code) });
        else channel.push({ event: {
          type: 'complete', text: response, conversationId: request.conversationId, sessionId, stats, structuredOutput
        } });
        channel.push({ done: true });
      });

      while (true) {
        const item = await channel.next();
        if ('done' in item) break;
        if ('error' in item) throw item.error;
        yield item.event;
      }
    } finally {
      release?.();
      this.active.delete(request.conversationId);
      request.signal?.removeEventListener('abort', forwardAbort);
    }
  }
}
