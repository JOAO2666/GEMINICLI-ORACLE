import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { AppDatabase } from './database.js';
import { AppError } from './errors.js';
import { chatSchema, conversationIdSchema, conversationMessageSchema, createConversationSchema } from './schemas.js';
import { ChatService } from './services/chat.js';
import { FileService } from './services/files.js';
import { AntigravityCLIProvider } from './services/antigravity-provider.js';
import type { ProviderEvent } from './types.js';
import { openAIChunk, openAICompletion, openAIModelList, prepareOpenAIRequest } from './openai-compat.js';
import { McpAuthStore } from './mcp-auth.js';
import { mcpPublicUrls, registerMcpOAuthRoutes } from './mcp-oauth-routes.js';
import { createWorkspaceMcpEndpoint, type McpEndpoint } from './mcp-server.js';
import { McpWorkspaceService } from './mcp-workspaces.js';

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function bearerToken(header: string | undefined): string | null {
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

function publicError(error: unknown) {
  if (error instanceof AppError) return { statusCode: error.statusCode, code: error.code, message: error.message };
  if (error instanceof ZodError) return { statusCode: 400, code: 'VALIDATION_ERROR', message: error.issues.map((i) => i.message).join('; ') };
  if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'REQUEST_ERROR';
    return { statusCode: error.statusCode, code, message: error.statusCode === 413 ? 'Upload maior que o limite permitido.' : 'Requisição inválida.' };
  }
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Erro interno do servidor.' };
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'request.headers.authorization'] }, trustProxy: config.TRUST_PROXY });
  const db = new AppDatabase(config.dataDir);
  const files = new FileService(config, db);
  const chats = new ChatService(config, db);
  const provider = new AntigravityCLIProvider(config);
  let mcpAuth: McpAuthStore | undefined;
  let mcpEndpoint: McpEndpoint | undefined;
  let mcpWorkspaces: McpWorkspaceService | undefined;
  let mcpResource = '';

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(formbody);
  const trustedOrigins = new Set(config.allowedOrigins);
  if (config.PUBLIC_BASE_URL) trustedOrigins.add(new URL(config.PUBLIC_BASE_URL).origin);
  if (config.DOMAIN) trustedOrigins.add(`https://${config.DOMAIN}`);
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || trustedOrigins.has(origin)) callback(null, true);
      else callback(new Error('Origem CORS não permitida'), false);
    },
    methods: ['GET', 'POST', 'DELETE']
  });
  await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_BYTES, files: config.MAX_FILES_PER_UPLOAD, fields: 4, parts: config.MAX_FILES_PER_UPLOAD + 4 }
  });

  if (config.MCP_ENABLED) {
    if (config.MCP_WORKER_TOKEN.length < 32) throw new Error('MCP_WORKER_TOKEN precisa ter pelo menos 32 caracteres.');
    mcpAuth = new McpAuthStore(config.dataDir);
    mcpWorkspaces = new McpWorkspaceService(config, provider);
    await mcpWorkspaces.initialize();
    await registerMcpOAuthRoutes(app, config, mcpAuth);
    mcpResource = mcpPublicUrls(config).resource;
    mcpEndpoint = createWorkspaceMcpEndpoint(mcpWorkspaces, (error) => app.log.error({ err: error }, 'MCP error'));
  }

  app.addHook('onRequest', async (request, reply) => {
    if (config.NODE_ENV === 'production' && config.REQUIRE_HTTPS && request.protocol !== 'https') {
      throw new AppError(426, 'HTTPS_REQUIRED', 'HTTPS é obrigatório.');
    }
    const pathname = request.url.split('?')[0];
    const protectedRoute = request.url.startsWith('/api/') || pathname === '/models' || pathname === '/chat/completions'
      || pathname === '/v1/models' || pathname === '/v1/chat/completions';
    if (protectedRoute && !tokenMatches(request.headers.authorization, config.NUMIA_SERVER_TOKEN)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Token de acesso inválido.');
    }
    if (pathname === '/mcp') {
      const token = bearerToken(request.headers.authorization);
      const staticAccess = tokenMatches(request.headers.authorization, config.NUMIA_SERVER_TOKEN);
      const oauthAccess = token && mcpAuth?.validateAccessToken(token, mcpResource);
      if (!staticAccess && !oauthAccess) {
        reply.header('WWW-Authenticate', `Bearer resource_metadata="${mcpPublicUrls(config).protectedMetadata}", scope="mcp:tools"`);
        throw new AppError(401, 'UNAUTHORIZED', 'Autorize a conexão MCP.');
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const safe = publicError(error);
    if (safe.statusCode >= 500) request.log.error({ err: error, code: safe.code }, 'request failed');
    reply.code(safe.statusCode).send({ error: safe.code, message: safe.message });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  if (mcpEndpoint && mcpWorkspaces) {
    const endpoint = mcpEndpoint;
    const workspaces = mcpWorkspaces;
    app.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/mcp',
      handler: async (request, reply) => {
        reply.hijack();
        await endpoint.nodeHandler(request.raw, reply.raw, request.body);
      }
    });
    app.get('/artifacts/:workspaceId/:artifactId/:name', async (request, reply) => {
      const params = request.params as { workspaceId: string; artifactId: string; name: string };
      const filePath = await workspaces.artifactPath(params.workspaceId, params.artifactId, params.name);
      reply.header('Cache-Control', 'private, max-age=86400');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`);
      return reply.type('application/octet-stream').send(createReadStream(filePath));
    });
  }
  app.get('/api/provider/status', async () => provider.checkAuthentication());
  app.get('/api/gemini/status', async () => provider.checkAuthentication());
  app.get('/api/models', async () => ({ models: await provider.listModels(), discovery: 'agy models + allowlist' }));

  const listCompatibleModels = async () => openAIModelList(config.allowedModels);
  app.get('/models', listCompatibleModels);
  app.get('/v1/models', listCompatibleModels);

  async function compatibleChat(body: unknown, request: FastifyRequest, reply: FastifyReply) {
    const prepared = await prepareOpenAIRequest(body, config);
    const requestedModel = chats.validateModel(prepared.input.model);
    // Antigravity currently exposes vision reliably only through the low Flash profile.
    // NumIA may send the selected chat/thinking model with an image, so route image turns
    // through the configured vision model while leaving text turns untouched.
    const model = prepared.imageCount > 0 ? config.visionModel : requestedModel;
    const id = `chatcmpl-${prepared.conversationId}`;
    const created = Math.floor(Date.now() / 1000);

    if (!prepared.input.stream) {
      try {
        const text = await provider.sendMessage({
          conversationId: prepared.conversationId,
          prompt: prepared.prompt,
          model,
          workingDirectory: prepared.workingDirectory,
          autoApprove: prepared.imageCount > 0
        });
        return openAICompletion(id, created, model, text);
      } finally {
        await prepared.cleanup();
      }
    }

    const controller = new AbortController();
    let finished = false;
    reply.raw.on('close', () => { if (!finished) controller.abort(); });
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const emit = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    emit(openAIChunk(id, created, model, { role: 'assistant', content: '' }));
    try {
      for await (const event of provider.streamMessage({
        conversationId: prepared.conversationId,
        prompt: prepared.prompt,
        model,
        workingDirectory: prepared.workingDirectory,
        autoApprove: prepared.imageCount > 0,
        signal: controller.signal
      })) {
        if (event.type === 'delta') emit(openAIChunk(id, created, model, { content: event.text }));
        if (event.type === 'complete') emit(openAIChunk(id, created, model, {}, 'stop'));
      }
      reply.raw.write('data: [DONE]\n\n');
    } catch (error) {
      const safe = publicError(error);
      emit({ error: { message: safe.message, type: 'server_error', code: safe.code } });
      reply.raw.write('data: [DONE]\n\n');
    } finally {
      finished = true;
      await prepared.cleanup();
      if (!reply.raw.destroyed) reply.raw.end();
    }
  }

  app.post('/chat/completions', async (request, reply) => compatibleChat(request.body, request, reply));
  app.post('/v1/chat/completions', async (request, reply) => compatibleChat(request.body, request, reply));

  app.post('/api/conversations', async (request, reply) => {
    const body = createConversationSchema.parse(request.body);
    const model = chats.validateModel(body.model);
    return reply.code(201).send(db.createConversation(model));
  });
  app.get('/api/conversations', async () => db.listConversations());
  app.get('/api/conversations/:id', async (request) => {
    const id = conversationIdSchema.parse((request.params as { id: string }).id);
    return db.getConversationDetail(id);
  });
  app.delete('/api/conversations/:id', async (request, reply) => {
    const id = conversationIdSchema.parse((request.params as { id: string }).id);
    provider.cancel(id);
    db.deleteConversation(id);
    await files.deleteConversationFiles(id);
    return reply.code(204).send();
  });
  app.delete('/api/conversations/:id/generation', async (request, reply) => {
    const id = conversationIdSchema.parse((request.params as { id: string }).id);
    const cancelled = provider.cancel(id);
    return reply.code(cancelled ? 202 : 404).send({ cancelled });
  });

  app.post('/api/files', async (request, reply) => {
    const conversationId = conversationIdSchema.parse((request.query as { conversationId?: string }).conversationId);
    const saved = [];
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;
      saved.push(await files.save(part, conversationId));
    }
    if (saved.length === 0) throw new AppError(400, 'NO_FILES', 'Nenhum arquivo foi enviado.');
    return reply.code(201).send({ attachments: saved });
  });

  async function execute(body: unknown, signal?: AbortSignal) {
    const input = chatSchema.parse(body);
    const model = chats.validateModel(input.model ?? db.getConversation(input.conversationId).model);
    const turn = chats.createUserTurn(input.conversationId, input.message, model, input.attachmentIds);
    const workingDirectory = files.conversationDirectory(input.conversationId);
    await fs.mkdir(workingDirectory, { recursive: true, mode: 0o700 });
    const text = await provider.sendMessage({ conversationId: input.conversationId, prompt: turn.prompt, model, workingDirectory, signal });
    const assistant = db.addMessage(input.conversationId, 'assistant', text);
    return { conversationId: input.conversationId, message: assistant, text };
  }

  async function stream(body: unknown, request: FastifyRequest, reply: FastifyReply) {
    const input = chatSchema.parse(body);
    const model = chats.validateModel(input.model ?? db.getConversation(input.conversationId).model);
    const turn = chats.createUserTurn(input.conversationId, input.message, model, input.attachmentIds);
    const workingDirectory = files.conversationDirectory(input.conversationId);
    await fs.mkdir(workingDirectory, { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    let finished = false;
    reply.raw.on('close', () => { if (!finished) controller.abort(); });
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const emit = (event: ProviderEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      for await (const event of provider.streamMessage({ conversationId: input.conversationId, prompt: turn.prompt, model, workingDirectory, signal: controller.signal })) {
        emit(event);
        if (event.type === 'complete') {
          db.addMessage(input.conversationId, 'assistant', event.text);
          if (event.sessionId) db.updateConversation(input.conversationId, { sessionId: event.sessionId });
        }
      }
    } catch (error) {
      const safe = publicError(error);
      if (!reply.raw.destroyed) emit({ type: 'error', code: safe.code, message: safe.message });
    } finally {
      finished = true;
      if (!reply.raw.destroyed) reply.raw.end();
    }
  }

  app.post('/api/chat', async (request) => execute(request.body));
  app.post('/api/chat/stream', async (request, reply) => stream(request.body, request, reply));
  app.post('/api/conversations/:id/message', async (request) => {
    const id = conversationIdSchema.parse((request.params as { id: string }).id);
    return execute({ ...conversationMessageSchema.parse(request.body), conversationId: id });
  });
  app.post('/api/conversations/:id/message/stream', async (request, reply) => {
    const id = conversationIdSchema.parse((request.params as { id: string }).id);
    return stream({ ...conversationMessageSchema.parse(request.body), conversationId: id }, request, reply);
  });

  const cleanup = setInterval(() => files.cleanupExpired().then((count) => {
    if (count) app.log.info({ count }, 'expired attachments removed');
  }).catch((error) => app.log.error({ err: error }, 'attachment cleanup failed')), 60 * 60 * 1000);
  cleanup.unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
    await mcpEndpoint?.handler.close();
    mcpAuth?.close();
    db.close();
  });
  return app;
}
