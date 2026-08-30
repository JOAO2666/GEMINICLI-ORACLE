import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import Fastify from 'fastify';
import { z } from 'zod';

const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const root = path.resolve(process.env.WORKSPACES_DIR ?? '/workspaces');
const workerToken = process.env.MCP_WORKER_TOKEN ?? '';
const maximumTimeout = Math.max(1_000, Number(process.env.MCP_COMMAND_TIMEOUT_MS ?? 60_000));
const maximumOutputBytes = 1024 * 1024;

if (workerToken.length < 32) throw new Error('MCP_WORKER_TOKEN precisa ter pelo menos 32 caracteres.');

function tokenMatches(header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(workerToken);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function workspace(workspaceId: string): Promise<string> {
  if (!workspaceIdPattern.test(workspaceId)) throw new Error('Workspace inválido.');
  const target = path.resolve(root, workspaceId);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative) throw new Error('Workspace inválido.');
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace não encontrado.');
  return target;
}

function safeDestination(workspaceRoot: string, requested: string): string {
  const normalized = requested.replaceAll('\\', '/').replace(/^\/+/, '');
  const target = path.resolve(workspaceRoot, normalized);
  const relative = path.relative(workspaceRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Destino inválido.');
  return target;
}

function safeChildOptions(cwd: string): SpawnOptionsWithoutStdio {
  return {
    cwd,
    detached: process.platform !== 'win32',
    windowsHide: true,
    uid: process.platform === 'win32' ? undefined : 1000,
    gid: process.platform === 'win32' ? undefined : 1000,
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/tmp',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      CI: 'true'
    },
  };
}

async function execute(program: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(program, args, { ...safeChildOptions(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;

    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.length >= maximumOutputBytes) {
        truncated = true;
        return current;
      }
      const remaining = maximumOutputBytes - current.length;
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        truncated,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8')
      });
    });
  });
}

const app = Fastify({ logger: true, bodyLimit: 32 * 1024 });
app.addHook('onRequest', async (request, reply) => {
  if (!tokenMatches(request.headers.authorization)) return reply.code(401).send({ message: 'Não autorizado.' });
});

app.post('/run', async (request, reply) => {
  const input = z.object({
    workspaceId: z.string(),
    command: z.string().min(1).max(4_000),
    timeoutSeconds: z.number().int().min(1).max(Math.ceil(maximumTimeout / 1000)).default(60)
  }).parse(request.body);
  const cwd = await workspace(input.workspaceId);
  const result = await execute('/bin/bash', ['-lc', input.command], cwd, Math.min(input.timeoutSeconds * 1000, maximumTimeout));
  return reply.send({ workspaceId: input.workspaceId, command: input.command, ...result });
});

app.post('/git-clone', async (request, reply) => {
  const input = z.object({
    workspaceId: z.string(),
    repositoryUrl: z.string().url().max(500),
    destination: z.string().min(1).max(180),
    ref: z.string().min(1).max(180).optional()
  }).parse(request.body);
  const repository = new URL(input.repositoryUrl);
  if (repository.protocol !== 'https:' || repository.hostname !== 'github.com' || repository.username || repository.password) {
    return reply.code(400).send({ message: 'Somente repositórios públicos HTTPS do github.com são permitidos.' });
  }
  const cwd = await workspace(input.workspaceId);
  const destination = safeDestination(cwd, input.destination);
  if (await fs.lstat(destination).catch(() => null)) return reply.code(409).send({ message: 'O destino já existe.' });
  const args = ['clone', '--depth', '1'];
  if (input.ref) args.push('--branch', input.ref);
  args.push(repository.toString(), destination);
  const result = await execute('/usr/bin/git', args, cwd, maximumTimeout);
  return reply.code(result.exitCode === 0 ? 200 : 400).send({ workspaceId: input.workspaceId, destination: input.destination, ...result });
});

app.get('/health', async () => ({ status: 'ok' }));

await fs.mkdir(root, { recursive: true, mode: 0o700 });
await app.listen({ host: '0.0.0.0', port: 3010 });
