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
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { AppDatabase } from './database.js';
import { AppError } from './errors.js';
import { chatSchema, conversationIdSchema, conversationMessageSchema, createConversationSchema } from './schemas.js';
import { ChatService } from './services/chat.js';
import { FileService } from './services/files.js';
import { AntigravityCLIProvider } from './services/antigravity-provider.js';
import { AntigravityCommandRegistry } from './services/antigravity-command-registry.js';
import type { AIProvider, ProviderEvent } from './types.js';
import {
  formatOpenAIUsage,
  openAIChunk,
  openAICompletion,
  openAIModelList,
  openAIUsageChunk,
  prepareOpenAIRequest
} from './openai-compat.js';
import { addLocalImageOcr } from './services/image-ocr.js';
import { openAIToolCompletion, parseOpenAIToolDecision, type OpenAIToolDecision } from './openai-tools.js';
import { McpAuthStore } from './mcp-auth.js';
import { mcpPublicUrls, registerMcpOAuthRoutes } from './mcp-oauth-routes.js';
import { createWorkspaceMcpEndpoint, type McpEndpoint } from './mcp-server.js';
import { McpWorkspaceService } from './mcp-workspaces.js';
import { detectMimeType, verifyArtifactUrl } from './services/artifact-service.js';
import { StorageGuardian } from './services/storage-guardian.js';
import {
  SENSITIVE_TOOLS,
  sendApproval,
  getApproval,
  listApprovals,
  resumeApprovalExecution,
  handleTelegramWebhook,
  setDatabase,
  registerResumptionHandler,
  registerTelegramPromptHandler,
  initTelegramBot
} from './telegram.js';

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

export async function buildApp(
  config: Config,
  options: { provider?: AIProvider; commandRegistry?: AntigravityCommandRegistry; storageGuardian?: StorageGuardian } = {}
): Promise<FastifyInstance> {
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  // OpenAI-compatible clients embed images as Base64 inside JSON. Account for
  // the ~4/3 Base64 expansion plus JSON/text overhead while keeping a strict
  // decoded-image ceiling in prepareOpenAIRequest.
  const bodyLimit = Math.ceil(config.MAX_TOTAL_IMAGE_BYTES * 4 / 3) + 2 * 1024 * 1024;
  const app = Fastify({
    logger: { redact: ['req.headers.authorization', 'request.headers.authorization'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit
  });
  const db = new AppDatabase(config.dataDir);
  const files = new FileService(config, db);
  const chats = new ChatService(config, db);
  const provider = options.provider ?? new AntigravityCLIProvider(config);
  const commandRegistry = options.commandRegistry ?? new AntigravityCommandRegistry(config);
  const storageGuardian = options.storageGuardian ?? new StorageGuardian(config, db);

  // Inicialização do módulo de aprovação via Telegram (estilo Muse)
  if (config.TELEGRAM_BOT_TOKEN) {
    process.env.TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN;
  }
  if (config.TELEGRAM_CHAT_ID) {
    process.env.TELEGRAM_CHAT_ID = config.TELEGRAM_CHAT_ID;
  }
  setDatabase(db.getRawDb());
  initTelegramBot(config.TELEGRAM_BOT_TOKEN);
  registerResumptionHandler(async (approval, contextData) => {
    app.log.info({ approvalId: approval.id, action: approval.action }, 'Iniciando retomada de execução Antigravity CLI após aprovação');
    const workingDirectory = (typeof contextData.workingDirectory === 'string' && contextData.workingDirectory)
      ? contextData.workingDirectory
      : files.conversationDirectory(approval.conversationId);
    await fs.mkdir(workingDirectory, { recursive: true, mode: 0o700 });

    const model = (typeof contextData.model === 'string' && contextData.model)
      ? contextData.model
      : config.DEFAULT_MODEL;

    const basePrompt = typeof contextData.prompt === 'string' ? contextData.prompt : '';
    const continuationPrompt = [
      basePrompt,
      '',
      '=== SISTEMA DE APROVAÇÃO HUMANA (ESTILO MUSE VIA TELEGRAM) ===',
      `Ação sensível autorizada: "${approval.action}".`,
      `Parâmetros aprovados pelo usuário: ${approval.details}`,
      'A autorização foi concedida formalmente via Telegram. Prossiga imediatamente com a tarefa, execute a ação aprovada e conclua a resposta final ao usuário.'
    ].join('\n');

    let responseText = '';
    if (provider.sendMessageDetailed) {
      const detailed = await provider.sendMessageDetailed({
        conversationId: approval.conversationId,
        prompt: continuationPrompt,
        model,
        workingDirectory,
        autoApprove: true
      });
      responseText = detailed.text;
    } else {
      responseText = await provider.sendMessage({
        conversationId: approval.conversationId,
        prompt: continuationPrompt,
        model,
        workingDirectory,
        autoApprove: true
      });
    }

    try {
      db.addMessage(approval.conversationId, 'assistant', responseText);
    } catch {
      // Conversa efêmera ou gerada fora do banco
    }

    return responseText;
  });

  registerTelegramPromptHandler(async (prompt, conversationId, _chatId, images = []) => {
    app.log.info({ conversationId, imageCount: images.length }, 'Processando mensagem do Telegram com o Antigravity CLI');
    db.ensureConversation(conversationId, config.DEFAULT_MODEL);
    db.addMessage(conversationId, 'user', prompt);

    const workingDirectory = files.conversationDirectory(conversationId);
    await fs.mkdir(workingDirectory, { recursive: true, mode: 0o700 });

    const savedImagePaths: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img) continue;
      const targetPath = path.join(workingDirectory, `telegram-img-${Date.now()}-${i}-${img.fileName}`);
      await fs.writeFile(targetPath, img.buffer);
      savedImagePaths.push(targetPath);
    }

    let finalPrompt = prompt;
    if (savedImagePaths.length > 0) {
      finalPrompt = await addLocalImageOcr(
        prompt,
        config.DEFAULT_MODEL,
        savedImagePaths,
        config.IMAGE_OCR_TIMEOUT_MS
      );
      finalPrompt += '\n\n' + savedImagePaths.map((p) => `[Imagem anexada: @${p}]`).join('\n');
    }

    let responseText = '';
    if (provider.sendMessageDetailed) {
      const detailed = await provider.sendMessageDetailed({
        conversationId,
        prompt: finalPrompt,
        model: config.DEFAULT_MODEL,
        workingDirectory,
        autoApprove: true
      });
      responseText = detailed.text;
    } else {
      responseText = await provider.sendMessage({
        conversationId,
        prompt: finalPrompt,
        model: config.DEFAULT_MODEL,
        workingDirectory,
        autoApprove: true
      });
    }

    try {
      db.addMessage(conversationId, 'assistant', responseText);
    } catch {
      // Ignora falha de persistência de mensagem
    }
    return responseText;
  });

  provider.onCatalogUpdate?.(() => {
    commandRegistry.invalidate();
  });
  const validateAvailableModel = async (model?: string) => {
    const selected = chats.validateModel(model);
    if (!(await provider.listModels()).includes(selected)) {
      throw new AppError(400, 'MODEL_NOT_AVAILABLE', 'O modelo solicitado não está disponível no Antigravity CLI.');
    }
    return selected;
  };
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
    mcpWorkspaces = new McpWorkspaceService(config, provider, db, storageGuardian);
    await mcpWorkspaces.initialize();
    await registerMcpOAuthRoutes(app, config, mcpAuth);
    mcpResource = mcpPublicUrls(config).resource;
    mcpEndpoint = createWorkspaceMcpEndpoint(
      mcpWorkspaces, provider, commandRegistry, config,
      (error) => app.log.error({ err: error }, 'MCP error')
    );
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
  app.get('/health/live', async () => ({ status: 'ok', uptime: process.uptime() }));
  app.get('/health/ready', async (request, reply) => {
    try {
      db.listConversations();
      const auth = await provider.checkAuthentication().catch(() => ({ available: false, authenticated: false }));
      const storage = await storageGuardian.getStorageStatus().catch(() => null);
      let workerHealth: Record<string, unknown> | null = null;
      if (config.MCP_WORKER_URL && config.MCP_WORKER_TOKEN) {
        try {
          const res = await fetch(`${config.MCP_WORKER_URL}/health`, {
            headers: { authorization: `Bearer ${config.MCP_WORKER_TOKEN}` },
            signal: AbortSignal.timeout(3000)
          });
          if (res.ok) {
            workerHealth = await res.json().catch(() => null) as Record<string, unknown> | null;
          }
        } catch {
          workerHealth = { status: 'unreachable' };
        }
      }

      if (config.MCP_WORKER_ISOLATION === 'strict' && workerHealth && workerHealth.isolation === 'failed') {
        return reply.code(503).send({
          status: 'unhealthy',
          error: 'Mecanismo de sandbox estrito do worker falhou ao inicializar.',
          worker: workerHealth
        });
      }

      if (storage?.status === 'hard_stop') {
        return reply.code(200).send({
          status: 'degraded',
          reason: 'insufficient_storage',
          database: 'ok',
          provider: auth.available ? (auth.authenticated ? 'ok' : 'unauthenticated') : 'unavailable',
          worker: workerHealth ?? 'unconfigured',
          storage: {
            usedPercent: storage.usedPercent,
            freeBytes: storage.freeBytes,
            status: storage.status
          },
          uptime: process.uptime()
        });
      }

      return reply.send({
        status: 'ok',
        database: 'ok',
        provider: auth.available ? (auth.authenticated ? 'ok' : 'unauthenticated') : 'unavailable',
        worker: workerHealth ?? 'unconfigured',
        storage: storage ? {
          usedPercent: storage.usedPercent,
          freeBytes: storage.freeBytes,
          status: storage.status
        } : undefined,
        uptime: process.uptime()
      });
    } catch (error) {
      return reply.code(503).send({ status: 'unhealthy', error: (error as Error).message });
    }
  });

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
      const query = request.query as { expires?: string; sig?: string };

      if (query.expires && query.sig) {
        const verify = verifyArtifactUrl({
          workspaceId: params.workspaceId,
          artifactId: params.artifactId,
          filename: params.name,
          expires: query.expires,
          sig: query.sig,
          secretKey: config.artifactSigningKey
        });
        if (!verify.valid) {
          const status = verify.reason === 'EXPIRED' ? 410 : 403;
          const msg = verify.reason === 'EXPIRED' ? 'Link de download expirado.' : 'Assinatura inválida.';
          return reply.code(status).send({ error: verify.reason, message: msg });
        }
      }

      const filePath = await workspaces.artifactPath(params.workspaceId, params.artifactId, params.name);
      const mime = detectMimeType(params.name);
      reply.header('Cache-Control', 'private, max-age=86400');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`);
      return reply.type(mime).send(createReadStream(filePath));
    });
  }
  app.get('/api/provider/status', async () => provider.checkAuthentication());
  app.get('/api/gemini/status', async () => provider.checkAuthentication());
  app.get('/api/models', async () => ({
    models: await provider.listModels(),
    discovery: config.allowedModels.length > 0 ? 'agy models + allowlist opcional' : 'agy models (catálogo automático)'
  }));
  app.post('/api/models/refresh', async () => ({
    models: provider.refreshModels ? await provider.refreshModels(true) : await provider.listModels(),
    refreshedAt: new Date().toISOString()
  }));
  app.get('/api/usage', async () => {
    if (!provider.getUsage) throw new AppError(501, 'USAGE_UNSUPPORTED', 'O provedor não oferece consulta de uso.');
    return provider.getUsage();
  });
  app.get('/api/provider/maintenance', async () => provider.maintenanceStatus?.() ?? {});
  app.post('/api/provider/update', async () => {
    if (!provider.updateCLI) throw new AppError(501, 'UPDATE_UNSUPPORTED', 'O provedor não oferece atualização automática.');
    return provider.updateCLI();
  });

  app.get('/api/cli/commands', async () => ({
    commands: await commandRegistry.discoverCommands(),
    refreshedAt: commandRegistry.lastRefreshedAt()
  }));
  app.get('/api/cli/help', async () => commandRegistry.getCommandHelp());
  app.get('/api/cli/help/:command', async (request) => {
    const params = request.params as { command: string };
    return commandRegistry.getCommandHelp(params.command);
  });
  app.post('/api/cli/execute', async (request) => {
    const schema = z.object({
      command: z.string().min(1).max(64),
      args: z.array(z.string().min(1).max(500)).max(20).default([]),
      timeout_seconds: z.number().int().min(1).max(120).default(30)
    });
    const body = schema.parse(request.body);
    return commandRegistry.executeCommand(body.command, body.args, body.timeout_seconds);
  });
  app.get('/api/cli/history/:workspaceId', async (request) => {
    if (!mcpWorkspaces) throw new AppError(503, 'MCP_DISABLED', 'MCP workspaces não habilitados.');
    const params = request.params as { workspaceId: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Number(query.limit) : 10;
    return {
      workspaceId: params.workspaceId,
      history: await mcpWorkspaces.getCommandHistory(params.workspaceId, limit)
    };
  });

  const listCompatibleModels = async () => openAIModelList(await provider.listModels());
  app.get('/models', listCompatibleModels);
  app.get('/v1/models', listCompatibleModels);

  async function compatibleChat(body: unknown, request: FastifyRequest, reply: FastifyReply) {
    const prepared = await prepareOpenAIRequest(body, config);
    const requestedModel = chats.validateModel(prepared.input.model);
    const model = prepared.imageCount > 0 && config.VISION_MODEL
      ? await validateAvailableModel(config.visionModel)
      : await validateAvailableModel(requestedModel);
    let preparedPrompt: string;
    try {
      preparedPrompt = await addLocalImageOcr(
        prepared.prompt,
        model,
        prepared.imagePaths,
        config.IMAGE_OCR_TIMEOUT_MS
      );
    } catch (error) {
      await prepared.cleanup();
      throw error;
    }
    request.log.info({ requestedModel, model, imageCount: prepared.imageCount }, 'OpenAI request routed');
    const id = `chatcmpl-${prepared.conversationId}`;
    const created = Math.floor(Date.now() / 1000);
    const requestStartTime = Date.now();

    if (!prepared.input.stream) {
      const controller = new AbortController();
      let finished = false;
      let rawResponseStarted = false;
      const abort = () => { if (!finished) controller.abort(); };
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      const heartbeat = setInterval(() => {
        if (finished || reply.raw.destroyed) return;
        if (!rawResponseStarted) {
          rawResponseStarted = true;
          reply.hijack();
          reply.raw.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
        }
        // JSON permits leading whitespace. Sending a tiny chunk keeps clients
        // such as NumIA from treating a long model generation as a dead socket.
        reply.raw.write(' ');
      }, config.STREAM_HEARTBEAT_MS);
      try {
        let completion: unknown;
        let lastStats: unknown;
        let durationSeconds: number | undefined;

        if (prepared.toolContext) {
          let decision: OpenAIToolDecision | undefined;
          for await (const event of provider.streamMessage({
            conversationId: prepared.conversationId,
            prompt: preparedPrompt,
            model,
            workingDirectory: prepared.workingDirectory,
            autoApprove: prepared.imageCount > 0,
            jsonSchema: prepared.toolContext.outputSchema,
            signal: controller.signal
          })) {
            if (event.type === 'complete') {
              lastStats = event.stats;
              decision = parseOpenAIToolDecision(event.structuredOutput, event.text, prepared.toolContext);
            }
          }
          if (!decision) throw new AppError(502, 'MISSING_TOOL_DECISION', 'O modelo não concluiu a decisão de ferramenta.');

          // Interceptação de ferramentas sensíveis estilo Muse via Telegram
          if (decision.type === 'tool_calls') {
            const sensitiveCall = decision.toolCalls.find((call) =>
              SENSITIVE_TOOLS.some((s) => s.toLowerCase() === call.function.name.toLowerCase())
            );
            if (sensitiveCall) {
              const approvalContext = {
                conversationId: prepared.conversationId,
                model,
                workingDirectory: prepared.workingDirectory,
                prompt: preparedPrompt,
                toolCall: sensitiveCall,
                imageCount: prepared.imageCount,
                id,
                created
              };
              const approvalId = await sendApproval(
                prepared.conversationId,
                sensitiveCall.function.name,
                sensitiveCall.function.arguments,
                approvalContext
              );
              const awaitingResponse = {
                status: 'AWAITING_APPROVAL',
                approvalId,
                message: 'Aguardando aprovação no Telegram'
              };
              if (!rawResponseStarted) return awaitingResponse;
              if (!reply.raw.destroyed) reply.raw.end(JSON.stringify(awaitingResponse));
              return;
            }
          }

          durationSeconds = (Date.now() - requestStartTime) / 1000;
          const usage = formatOpenAIUsage(lastStats, preparedPrompt, decision.type === 'message' ? decision.content : '', durationSeconds);
          completion = openAIToolCompletion(id, created, model, decision, usage);
        } else {
          let text = '';
          if (provider.sendMessageDetailed) {
            const detailed = await provider.sendMessageDetailed({
              conversationId: prepared.conversationId,
              prompt: preparedPrompt,
              model,
              workingDirectory: prepared.workingDirectory,
              autoApprove: prepared.imageCount > 0,
              signal: controller.signal
            });
            text = detailed.text;
            lastStats = detailed.usage;
            durationSeconds = detailed.durationSeconds;
          } else {
            text = await provider.sendMessage({
              conversationId: prepared.conversationId,
              prompt: preparedPrompt,
              model,
              workingDirectory: prepared.workingDirectory,
              autoApprove: prepared.imageCount > 0,
              signal: controller.signal
            });
          }
          if (durationSeconds === undefined) {
            durationSeconds = (Date.now() - requestStartTime) / 1000;
          }
          const usage = formatOpenAIUsage(lastStats, preparedPrompt, text, durationSeconds);
          completion = openAICompletion(id, created, model, text, usage);
        }
        reply.header('openai-processing-ms', Math.round((durationSeconds ?? ((Date.now() - requestStartTime) / 1000)) * 1000));
        if (!rawResponseStarted) return completion;
        if (!reply.raw.destroyed) reply.raw.end(JSON.stringify(completion));
        return;
      } catch (error) {
        if (!rawResponseStarted) throw error;
        const safe = publicError(error);
        if (!reply.raw.destroyed) {
          reply.raw.end(JSON.stringify({ error: { message: safe.message, type: 'server_error', code: safe.code } }));
        }
        return;
      } finally {
        finished = true;
        clearInterval(heartbeat);
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', abort);
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
    const heartbeat = setInterval(() => {
      if (!finished && !reply.raw.destroyed) reply.raw.write(': keep-alive\n\n');
    }, config.STREAM_HEARTBEAT_MS);
    emit(openAIChunk(id, created, model, { role: 'assistant', content: '' }));
    try {
      if (prepared.toolContext) {
        let decision: OpenAIToolDecision | undefined;
        let lastStats: unknown;
        for await (const event of provider.streamMessage({
          conversationId: prepared.conversationId,
          prompt: preparedPrompt,
          model,
          workingDirectory: prepared.workingDirectory,
          autoApprove: prepared.imageCount > 0,
          jsonSchema: prepared.toolContext.outputSchema,
          signal: controller.signal
        })) {
          if (event.type === 'complete') {
            lastStats = event.stats;
            decision = parseOpenAIToolDecision(event.structuredOutput, event.text, prepared.toolContext);
          }
        }
        if (!decision) throw new AppError(502, 'MISSING_TOOL_DECISION', 'O modelo não concluiu a decisão de ferramenta.');

        // Interceptação de ferramentas sensíveis estilo Muse via Telegram em streaming
        if (decision.type === 'tool_calls') {
          const sensitiveCall = decision.toolCalls.find((call) =>
            SENSITIVE_TOOLS.some((s) => s.toLowerCase() === call.function.name.toLowerCase())
          );
          if (sensitiveCall) {
            const approvalContext = {
              conversationId: prepared.conversationId,
              model,
              workingDirectory: prepared.workingDirectory,
              prompt: preparedPrompt,
              toolCall: sensitiveCall,
              imageCount: prepared.imageCount,
              id,
              created
            };
            const approvalId = await sendApproval(
              prepared.conversationId,
              sensitiveCall.function.name,
              sensitiveCall.function.arguments,
              approvalContext
            );
            emit({
              status: 'AWAITING_APPROVAL',
              approvalId,
              message: 'Aguardando aprovação no Telegram'
            });
            reply.raw.write('data: [DONE]\n\n');
            return;
          }
        }

        const durationSeconds = (Date.now() - requestStartTime) / 1000;
        const usage = formatOpenAIUsage(lastStats, preparedPrompt, decision.type === 'message' ? decision.content : '', durationSeconds);
        if (decision.type === 'message') {
          if (decision.content) emit(openAIChunk(id, created, model, { content: decision.content }));
          emit(openAIChunk(id, created, model, {}, 'stop', usage));
        } else {
          decision.toolCalls.forEach((toolCall, index) => emit(openAIChunk(id, created, model, {
            tool_calls: [{ index, ...toolCall }]
          })));
          emit(openAIChunk(id, created, model, {}, 'tool_calls', usage));
        }
        emit(openAIUsageChunk(id, created, model, usage));
        reply.raw.write('data: [DONE]\n\n');
        return;
      }
      let streamResponseText = '';
      let lastStats: unknown;
      for await (const event of provider.streamMessage({
        conversationId: prepared.conversationId,
        prompt: preparedPrompt,
        model,
        workingDirectory: prepared.workingDirectory,
        autoApprove: prepared.imageCount > 0,
        signal: controller.signal
      })) {
        if (event.type === 'delta') {
          streamResponseText += event.text;
          emit(openAIChunk(id, created, model, { content: event.text }));
        }
        if (event.type === 'complete') {
          lastStats = event.stats;
          const durationSeconds = (Date.now() - requestStartTime) / 1000;
          const usage = formatOpenAIUsage(lastStats, preparedPrompt, event.text || streamResponseText, durationSeconds);
          emit(openAIChunk(id, created, model, {}, 'stop', usage));
          emit(openAIUsageChunk(id, created, model, usage));
        }
      }
      reply.raw.write('data: [DONE]\n\n');
    } catch (error) {
      const safe = publicError(error);
      emit({ error: { message: safe.message, type: 'server_error', code: safe.code } });
      reply.raw.write('data: [DONE]\n\n');
    } finally {
      finished = true;
      clearInterval(heartbeat);
      await prepared.cleanup();
      if (!reply.raw.destroyed) reply.raw.end();
    }
  }

  app.post('/chat/completions', async (request, reply) => compatibleChat(request.body, request, reply));
  app.post('/v1/chat/completions', async (request, reply) => compatibleChat(request.body, request, reply));

  // Rota de webhook para receber updates e callbacks inline do Telegram (estilo Muse)
  app.post('/telegram/webhook', async (request, reply) => {
    try {
      const res = await handleTelegramWebhook(request.body);
      return reply.code(200).send(res);
    } catch (error) {
      request.log.error({ err: error }, 'Erro ao processar webhook do Telegram');
      return reply.code(200).send({ ok: false, error: (error as Error).message });
    }
  });

  // Verificação de saúde e configuração do webhook do Telegram
  app.get('/telegram/webhook', async () => ({
    status: 'ok',
    service: 'telegram-approval-webhook',
    configured: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID)
  }));

  // Lista as aprovações registradas no SQLite
  app.get('/api/approvals', async (request) => {
    const query = request.query as { conversationId?: string; limit?: string };
    const limit = query.limit ? Number(query.limit) : 50;
    return { approvals: listApprovals(query.conversationId, limit) };
  });

  // Consulta os detalhes de uma aprovação específica pelo ID
  app.get('/api/approvals/:id', async (request) => {
    const params = request.params as { id: string };
    const approval = getApproval(params.id);
    if (!approval) throw new AppError(404, 'APPROVAL_NOT_FOUND', 'Aprovação não encontrada.');
    return { approval };
  });

  // Dispara a retomada da execução de uma ação aprovada
  app.post('/api/approvals/:id/resume', async (request) => {
    const params = request.params as { id: string };
    const result = await resumeApprovalExecution(params.id);
    return { success: true, result };
  });

  app.post('/api/conversations', async (request, reply) => {
    const body = createConversationSchema.parse(request.body);
    const model = await validateAvailableModel(body.model);
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
    await storageGuardian.ensureWritable();
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
    const model = await validateAvailableModel(input.model ?? db.getConversation(input.conversationId).model);
    const turn = chats.createUserTurn(input.conversationId, input.message, model, input.attachmentIds);
    const workingDirectory = files.conversationDirectory(input.conversationId);
    await fs.mkdir(workingDirectory, { recursive: true, mode: 0o700 });
    const prompt = await addLocalImageOcr(
      turn.prompt,
      model,
      turn.attachments.filter((item) => item.mime_type.startsWith('image/')).map((item) => item.stored_path),
      config.IMAGE_OCR_TIMEOUT_MS
    );
    const startExec = Date.now();
    let text = '';
    let stats: unknown;
    if (provider.sendMessageDetailed) {
      const detailed = await provider.sendMessageDetailed({ conversationId: input.conversationId, prompt, model, workingDirectory, signal });
      text = detailed.text;
      stats = detailed.usage;
    } else {
      text = await provider.sendMessage({ conversationId: input.conversationId, prompt, model, workingDirectory, signal });
    }
    const assistant = db.addMessage(input.conversationId, 'assistant', text);
    const durationSeconds = (Date.now() - startExec) / 1000;
    const usage = formatOpenAIUsage(stats, prompt, text, durationSeconds);
    return { conversationId: input.conversationId, message: assistant, text, usage };
  }

  async function stream(body: unknown, request: FastifyRequest, reply: FastifyReply) {
    const input = chatSchema.parse(body);
    const model = await validateAvailableModel(input.model ?? db.getConversation(input.conversationId).model);
    const turn = chats.createUserTurn(input.conversationId, input.message, model, input.attachmentIds);
    const workingDirectory = files.conversationDirectory(input.conversationId);
    await fs.mkdir(workingDirectory, { recursive: true, mode: 0o700 });
    const prompt = await addLocalImageOcr(
      turn.prompt,
      model,
      turn.attachments.filter((item) => item.mime_type.startsWith('image/')).map((item) => item.stored_path),
      config.IMAGE_OCR_TIMEOUT_MS
    );
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
      for await (const event of provider.streamMessage({ conversationId: input.conversationId, prompt, model, workingDirectory, signal: controller.signal })) {
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
  const modelRefresh = setInterval(() => {
    void provider.refreshModels?.(true).catch((error) => app.log.warn({ err: error }, 'model refresh failed'));
  }, config.MODEL_REFRESH_INTERVAL_MS);
  modelRefresh.unref();
  const cliUpdate = setInterval(() => {
    if (config.AGY_AUTO_UPDATE) void provider.updateCLI?.().catch((error) => app.log.warn({ err: error }, 'CLI update failed'));
  }, config.AGY_UPDATE_INTERVAL_MS);
  cliUpdate.unref();
  const commandRefresh = setInterval(() => {
    void commandRegistry.discoverCommands(true).catch((error) => app.log.warn({ err: error }, 'command refresh failed'));
  }, config.CLI_COMMAND_REFRESH_INTERVAL_MS);
  commandRefresh.unref();
  const startupMaintenance = setTimeout(() => {
    const action = config.AGY_AUTO_UPDATE ? provider.updateCLI?.() : provider.refreshModels?.(true);
    void action?.catch((error) => app.log.warn({ err: error }, 'startup maintenance failed'));
  }, 5_000);
  startupMaintenance.unref();
  if (config.STORAGE_GUARDIAN_ENABLED) {
    storageGuardian.start();
    void storageGuardian.runCleanup().catch((error) => app.log.warn({ err: error }, 'startup storage cleanup failed'));
  }

  app.addHook('onClose', async () => {
    storageGuardian.stop();
    clearInterval(cleanup);
    clearInterval(modelRefresh);
    clearInterval(cliUpdate);
    clearInterval(commandRefresh);
    clearTimeout(startupMaintenance);
    await mcpEndpoint?.handler.close();
    mcpAuth?.close();
    db.close();
  });
  return app;
}
