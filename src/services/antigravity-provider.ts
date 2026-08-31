import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AppError, publicProviderError } from '../errors.js';
import type { AIProvider, ProviderEvent, ProviderRequest, ProviderStatus } from '../types.js';
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

  constructor(private readonly config: Config) {
    this.semaphore = new Semaphore(config.MAX_GEMINI_PROCESSES);
  }

  supportsFiles(): boolean { return true; }

  async listModels(): Promise<string[]> {
    const result = await this.run(['models'], 20_000);
    if (!result || result.code !== 0) return this.config.allowedModels;
    const discovered = result.stdout.split(/\r?\n/).map((line) => line.split(/\s+/)[0]).filter((v): v is string => Boolean(v));
    return discovered.filter((model) => this.config.allowedModels.includes(model));
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
