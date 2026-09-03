import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError } from '../errors.js';
import type { Config } from '../config.js';

const commandPattern = /^[a-z][a-z0-9-]{0,63}$/;
const maxOutputBytes = 128 * 1024;
const interactiveMessage = 'Este comando exige sessão interativa ou altera a configuração do host e não pode ser executado diretamente pelo MCP.';

export interface CliProcessResult {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

export interface DiscoveredCliCommand {
  name: string;
  description: string;
  executable: boolean;
  restriction?: string;
}

export type CliRunner = (args: string[], timeoutMs: number) => Promise<CliProcessResult>;

function cleanAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
}

export function parseAgyHelp(stdout: string): Array<{ name: string; description: string }> {
  const lines = cleanAnsi(stdout).split(/\r?\n/);
  const start = lines.findIndex((line) => /^(?:Available subcommands|Commands):\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const commands: Array<{ name: string; description: string }> = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) {
      if (commands.length) break;
      continue;
    }
    const match = /^\s{2,}([a-z][a-z0-9-]*)(?:[^\S\r\n]+[^\r\n]*?)?(?:\s{2,}|\t+)(.+?)\s*$/i.exec(line);
    if (!match) {
      if (commands.length && /^\S/.test(line)) break;
      continue;
    }
    commands.push({ name: match[1]!.toLowerCase(), description: match[2]!.trim() });
  }
  return [...new Map(commands.map((entry) => [entry.name, entry])).values()];
}

export function validateCliInvocation(command: string, args: string[]): void {
  if (!commandPattern.test(command) || command === '..') {
    throw new AppError(400, 'INVALID_CLI_COMMAND', 'Comando do Antigravity inválido.');
  }
  if (args.length > 20) throw new AppError(400, 'INVALID_CLI_ARGUMENT', 'Quantidade de argumentos excede o limite seguro.');
  let total = 0;
  for (const argument of args) {
    total += Buffer.byteLength(argument);
    if (!argument || argument.length > 500 || argument.includes('\0') || argument.includes('..') || /[\r\n]/.test(argument)
      || /(?:&&|\|\||[|;`<>]|\$\(|\$\{|%[A-Za-z_][A-Za-z0-9_]*%)/.test(argument)
      || path.isAbsolute(argument) || /^[A-Za-z]:[\\/]/.test(argument) || argument.startsWith('~')
      || /^--?(?:env|header|add-dir|log-file|project|prompt|conversation)(?:=|$)/.test(argument)) {
      throw new AppError(400, 'INVALID_CLI_ARGUMENT', 'Argumento recusado pela política de segurança do Antigravity MCP.');
    }
  }
  if (total > 4_096) throw new AppError(400, 'INVALID_CLI_ARGUMENT', 'Argumentos excedem o limite seguro.');
}

function executionPolicy(command: string, args: string[]): { allowed: boolean; reason?: string } {
  if (['models', 'agent', 'agents', 'changelog'].includes(command)) {
    return args.length === 0 || (args.length === 1 && ['-h', '--help'].includes(args[0]!))
      ? { allowed: true } : { allowed: false, reason: interactiveMessage };
  }
  if (command === 'help') {
    return args.length <= 1 && (!args[0] || commandPattern.test(args[0]))
      ? { allowed: true } : { allowed: false, reason: interactiveMessage };
  }
  if (command === 'plugin' || command === 'plugins') {
    return args.length === 1 && args[0] === 'list'
      ? { allowed: true } : { allowed: false, reason: interactiveMessage };
  }
  if (command === 'mcp') {
    return args.length === 1 && args[0] === 'list'
      ? { allowed: true } : { allowed: false, reason: interactiveMessage };
  }
  if (command === 'update') return { allowed: false, reason: 'Use a ferramenta cli_update, que protege gerações em andamento e atualiza o catálogo.' };
  return { allowed: false, reason: interactiveMessage };
}

export class AntigravityCommandRegistry {
  private cache: DiscoveredCliCommand[] = [];
  private refreshedAt = 0;
  private discoveryPromise?: Promise<DiscoveredCliCommand[]>;
  private readonly runner: CliRunner;

  constructor(private readonly config: Config, runner?: CliRunner) {
    this.runner = runner ?? ((args, timeoutMs) => this.spawnAgy(args, timeoutMs));
  }

  invalidate(): void {
    this.cache = [];
    this.refreshedAt = 0;
  }

  lastRefreshedAt(): string | undefined {
    return this.refreshedAt ? new Date(this.refreshedAt).toISOString() : undefined;
  }

  async discoverCommands(force = false): Promise<DiscoveredCliCommand[]> {
    const fresh = Date.now() - this.refreshedAt < this.config.CLI_COMMAND_REFRESH_INTERVAL_MS;
    if (!force && fresh && this.cache.length) return structuredClone(this.cache);
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = (async () => {
      const result = await this.runner(['--help'], 15_000);
      if (result.timedOut) throw new AppError(504, 'CLI_TIMEOUT', 'A descoberta de comandos do Antigravity excedeu o tempo limite.');
      if (result.exitCode !== 0) throw new AppError(503, 'CLI_UNAVAILABLE', 'Não foi possível consultar os comandos do Antigravity CLI.');
      const parsed = parseAgyHelp(result.stdout || result.stderr);
      if (!parsed.length) throw new AppError(502, 'CLI_HELP_PARSE_ERROR', 'O formato de ajuda do Antigravity CLI não pôde ser interpretado.');
      this.cache = parsed.map((entry) => {
        const policy = executionPolicy(entry.name, []);
        return { ...entry, executable: policy.allowed, ...(!policy.allowed ? { restriction: policy.reason } : {}) };
      });
      this.refreshedAt = Date.now();
      return structuredClone(this.cache);
    })().finally(() => { this.discoveryPromise = undefined; });
    return this.discoveryPromise;
  }

  async getCommandHelp(command?: string): Promise<Record<string, unknown>> {
    const commands = await this.discoverCommands();
    if (!command) return { title: 'Antigravity CLI', commands, refreshedAt: this.lastRefreshedAt() };
    validateCliInvocation(command, []);
    if (!commands.some((entry) => entry.name === command)) throw new AppError(404, 'CLI_COMMAND_NOT_FOUND', 'Comando não encontrado no Antigravity CLI instalado.');
    const result = await this.runner([command, '--help'], 15_000);
    const documentation = this.redact(`${result.stdout}${result.stderr ? `${result.stdout ? '\n' : ''}${result.stderr}` : ''}`).trim();
    return { command, documentation, exitCode: result.exitCode, timedOut: result.timedOut };
  }

  async executeCommand(command: string, args: string[] = [], timeoutSeconds = 30): Promise<CliProcessResult> {
    validateCliInvocation(command, args);
    const commands = await this.discoverCommands();
    if (!commands.some((entry) => entry.name === command)) throw new AppError(404, 'CLI_COMMAND_NOT_FOUND', 'Comando não encontrado no Antigravity CLI instalado.');
    const policy = executionPolicy(command, args);
    if (!policy.allowed) throw new AppError(403, 'CLI_COMMAND_NOT_ALLOWED', policy.reason ?? interactiveMessage);
    const seconds = Math.max(1, Math.min(120, Math.trunc(timeoutSeconds)));
    const result = await this.runner([command, ...args], seconds * 1_000);
    return { ...result, stdout: this.redact(result.stdout), stderr: this.redact(result.stderr) };
  }

  private redact(value: string): string {
    let safe = cleanAnsi(value);
    const secrets = Object.entries(process.env)
      .filter(([key, secret]) => secret && /(TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE)/i.test(key) && secret.length >= 8)
      .map(([, secret]) => secret as string)
      .concat([this.config.NUMIA_SERVER_TOKEN, this.config.MCP_WORKER_TOKEN].filter(Boolean));
    for (const secret of new Set(secrets)) safe = safe.split(secret).join('[REDACTED]');
    safe = safe
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:access|refresh|oauth)[_-]?token\s*[:=]\s*\S+/gi, '$&'.replace(/\S+$/, '[REDACTED]'))
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) safe = safe.split(home).join('[HOME]');
    return safe.replace(/(?:\[HOME\]|[A-Za-z]:[\\/]|\/)[^\r\n\s"']*\.gemini[^\r\n\s"']*/gi, '[REDACTED_AUTH_PATH]');
  }

  private spawnAgy(args: string[], timeoutMs: number): Promise<CliProcessResult> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(this.config.AGY_COMMAND, args, {
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
          LANG: process.env.LANG ?? 'C.UTF-8', LC_ALL: process.env.LC_ALL, TERM: 'dumb', TMPDIR: process.env.TMPDIR ?? '/tmp'
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const append = (current: string, chunk: unknown) => {
        const next = current + String(chunk);
        if (Buffer.byteLength(next) <= maxOutputBytes) return next;
        truncated = true;
        return Buffer.from(next).subarray(0, maxOutputBytes).toString('utf8');
      };
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000).unref();
      }, timeoutMs);
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ args: [...args], stdout, stderr, exitCode, timedOut, durationMs: Date.now() - started, truncated });
      });
    });
  }
}
