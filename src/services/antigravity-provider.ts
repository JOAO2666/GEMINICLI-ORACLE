import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AppError, publicProviderError } from '../errors.js';
import type { AIProvider, ProviderEvent, ProviderMaintenance, ProviderRequest, ProviderResult, ProviderStatus } from '../types.js';
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

export function formatUsageBars(usageData: Record<string, unknown>): string {
  const groups = Array.isArray(usageData.groups) ? usageData.groups : [];
  if (groups.length === 0) {
    return '📊 Uso do Antigravity\n\nNenhuma métrica de quota reportada pelo Antigravity CLI no momento.';
  }

  const sections: string[] = ['📊 Uso do Antigravity', ''];
  for (const group of groups as Array<{ name?: string; description?: string; buckets?: Array<Record<string, unknown>> }>) {
    if (group.name) {
      sections.push(`### ${group.name}`);
    }
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      const name = String(bucket.name || bucket.id || 'Quota');
      const rem = typeof bucket.remainingPercent === 'number' ? bucket.remainingPercent : undefined;
      const used = typeof bucket.usedPercent === 'number' ? bucket.usedPercent : undefined;
      sections.push(name);
      if (rem !== undefined) {
        const filled = Math.max(0, Math.min(10, Math.round(rem / 10)));
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        sections.push(`${bar} ${rem}% restante`);
      }
      if (used !== undefined) {
        sections.push(`Usado: ${used}%`);
      }
      if (rem !== undefined) {
        sections.push(`Restante: ${rem}%`);
      }
      if (bucket.resetTime) {
        const date = new Date(String(bucket.resetTime));
        const formattedDate = !Number.isNaN(date.getTime())
          ? date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })
          : String(bucket.resetTime);
        sections.push(`Reset: ${formattedDate}`);
      }
      sections.push('');
    }
  }
  return sections.join('\n').trim();
}

function extractVersionWeight(name: string): number {
  const matches = name.match(/\d+(?:\.\d+)?/g);
  if (!matches) return 0;
  return Number(matches[matches.length - 1] ?? 0) || 0;
}

export function resolveModelAlias(
  alias: string,
  availableModels: string[],
  defaultModel?: string
): { model?: string; ambiguous?: string[] } {
  const clean = alias.trim().toLowerCase();
  if (!clean) return {};

  // 1. Exact match
  const exact = availableModels.find((m) => m.toLowerCase() === clean);
  if (exact) return { model: exact };

  // 2. Specific known shortcuts
  if (clean === 'flash' || clean === 'gemini-flash') {
    const candidates = availableModels.filter((m) => /flash/i.test(m));
    if (candidates.length === 1) return { model: candidates[0] };
    if (candidates.length > 1) {
      const highCandidates = candidates.filter((m) => /-high$/i.test(m));
      const pool = highCandidates.length > 0 ? highCandidates : candidates;
      if (defaultModel && pool.includes(defaultModel)) return { model: defaultModel };
      pool.sort((a, b) => extractVersionWeight(b) - extractVersionWeight(a));
      return { model: pool[0] };
    }
  }

  if (clean === 'pro' || clean === 'gemini-pro') {
    const candidates = availableModels.filter((m) => /pro/i.test(m));
    if (candidates.length === 1) return { model: candidates[0] };
    if (candidates.length > 1) {
      const highCandidates = candidates.filter((m) => /-high$/i.test(m));
      const pool = highCandidates.length > 0 ? highCandidates : candidates;
      if (defaultModel && pool.includes(defaultModel)) return { model: defaultModel };
      pool.sort((a, b) => extractVersionWeight(b) - extractVersionWeight(a));
      return { model: pool[0] };
    }
  }

  if (clean === 'flash-high' || clean === 'flash-medium' || clean === 'flash-low') {
    const tier = clean.split('-')[1];
    const candidates = availableModels.filter((m) => /flash/i.test(m) && m.toLowerCase().endsWith(`-${tier}`));
    if (candidates.length === 1) return { model: candidates[0] };
    if (candidates.length > 1) {
      candidates.sort((a, b) => extractVersionWeight(b) - extractVersionWeight(a));
      return { model: candidates[0] };
    }
  }

  if (clean === 'sonnet' || clean === 'claude-sonnet') {
    const candidates = availableModels.filter((m) => /sonnet/i.test(m));
    if (candidates.length === 1) return { model: candidates[0] };
    if (candidates.length > 1) {
      candidates.sort((a, b) => extractVersionWeight(b) - extractVersionWeight(a));
      return { model: candidates[0] };
    }
  }

  if (clean === 'opus' || clean === 'claude-opus') {
    const candidates = availableModels.filter((m) => /opus/i.test(m));
    if (candidates.length === 1) return { model: candidates[0] };
    if (candidates.length > 1) {
      candidates.sort((a, b) => extractVersionWeight(b) - extractVersionWeight(a));
      return { model: candidates[0] };
    }
  }

  // 3. Substring search
  const substringMatches = availableModels.filter((m) => m.toLowerCase().includes(clean));
  if (substringMatches.length === 1) return { model: substringMatches[0] };
  if (substringMatches.length > 1) return { ambiguous: substringMatches };

  return {};
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
  private readonly catalogUpdateListeners: Array<() => void> = [];
  private modelCache: string[] = [];
  private modelsRefreshedAt = 0;
  private modelRefreshPromise?: Promise<string[]>;
  private updatePromise?: Promise<ProviderMaintenance>;
  private lastMaintenance: ProviderMaintenance = {};

  constructor(private readonly config: Config) {
    this.semaphore = new Semaphore(config.MAX_GEMINI_PROCESSES);
  }

  onCatalogUpdate(listener: () => void): void {
    this.catalogUpdateListeners.push(listener);
  }

  private notifyCatalogUpdate(): void {
    for (const listener of this.catalogUpdateListeners) {
      try { listener(); } catch { /* ignore */ }
    }
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
        this.notifyCatalogUpdate();
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
        previousVersion: beforeVersion,
        installedVersion,
        updated: Boolean(beforeVersion && installedVersion && beforeVersion !== installedVersion),
        skipped: false,
        message: update?.code === 0 ? 'Verificação de atualização concluída.' : 'Não foi possível atualizar o CLI; a versão instalada foi mantida.',
        modelsUpdated: update?.code === 0
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
    return (await this.sendMessageDetailed(request)).text;
  }

  async sendMessageDetailed(request: ProviderRequest): Promise<ProviderResult> {
    let result: ProviderResult = { text: '' };
    for await (const event of this.streamMessage(request)) {
      if (event.type === 'delta') result.text += event.text;
      if (event.type === 'complete') result = {
        text: event.text,
        ...(event.stats !== undefined ? { usage: event.stats } : {}),
        ...(event.structuredOutput !== undefined ? { structuredOutput: event.structuredOutput } : {}),
        ...(event.sessionId ? { sessionId: event.sessionId } : {})
      };
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
