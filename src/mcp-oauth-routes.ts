import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { McpAuthStore } from './mcp-auth.js';

function constantTokenMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character] ?? character);
}

function redirectAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export function mcpPublicUrls(config: Config) {
  const base = (config.PUBLIC_BASE_URL || (config.DOMAIN ? `https://${config.DOMAIN}` : '')).replace(/\/$/, '');
  if (!base) throw new Error('PUBLIC_BASE_URL ou DOMAIN precisa ser configurado para o MCP.');
  return {
    base,
    issuer: base,
    resource: `${base}/mcp`,
    protectedMetadata: `${base}/.well-known/oauth-protected-resource/mcp`
  };
}

export async function registerMcpOAuthRoutes(app: FastifyInstance, config: Config, store: McpAuthStore): Promise<void> {
  const urls = mcpPublicUrls(config);
  const metadata = {
    issuer: urls.issuer,
    authorization_endpoint: `${urls.base}/oauth/authorize`,
    token_endpoint: `${urls.base}/oauth/token`,
    registration_endpoint: `${urls.base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp:tools'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false
  };
  const protectedResource = {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp:tools']
  };

  app.get('/.well-known/oauth-authorization-server', async () => metadata);
  app.get('/.well-known/oauth-protected-resource', async () => protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', async () => protectedResource);

  app.post('/oauth/register', async (request, reply) => {
    const input = z.object({
      client_name: z.string().min(1).max(200).default('Gemini Spark'),
      redirect_uris: z.array(z.string()).min(1).max(10),
      grant_types: z.array(z.string()).optional(),
      response_types: z.array(z.string()).optional(),
      token_endpoint_auth_method: z.string().optional()
    }).passthrough().parse(request.body);
    if (!input.redirect_uris.every(redirectAllowed)) return reply.code(400).send({ error: 'invalid_redirect_uri' });
    if (input.grant_types?.some((value) => value !== 'authorization_code' && value !== 'refresh_token')) {
      return reply.code(400).send({ error: 'invalid_client_metadata' });
    }
    const client = store.registerClient(input.client_name, input.redirect_uris);
    return reply.code(201).send({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });
  });

  const authorizationSchema = z.object({
    response_type: z.literal('code'),
    client_id: z.string().min(1),
    redirect_uri: z.string().min(1),
    state: z.string().default(''),
    code_challenge: z.string().min(43).max(128),
    code_challenge_method: z.literal('S256'),
    resource: z.string().default(urls.resource),
    scope: z.string().default('mcp:tools')
  });

  const validateAuthorization = (raw: unknown) => {
    const input = authorizationSchema.parse(raw);
    const client = store.getClient(input.client_id);
    if (!client || !client.redirectUris.includes(input.redirect_uri)) throw new AppError(400, 'invalid_request', 'Cliente ou retorno inválido.');
    if (input.resource !== urls.resource) throw new AppError(400, 'invalid_target', 'Resource inválido.');
    if (!input.scope.split(/\s+/).includes('mcp:tools')) throw new AppError(400, 'invalid_scope', 'Escopo mcp:tools obrigatório.');
    return { input, client };
  };

  // The consent page is a normal browser navigation/form POST. CORS does not
  // protect HTML forms and must not prevent OAuth clients from completing the
  // redirect flow. The access key, registered redirect URI and PKCE still
  // protect authorization.
  app.get('/oauth/authorize', { config: { cors: { origin: false } } }, async (request, reply) => {
    const { input, client } = validateAuthorization(request.query);
    const hidden = Object.entries(input).map(([key, value]) =>
      `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value))}">`).join('');
    reply.header('Cache-Control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar NumIA Workspace</title><style>body{font:16px system-ui;background:#101418;color:#eef;margin:0;padding:24px}.box{max-width:520px;margin:8vh auto;background:#1d242b;padding:28px;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:13px;margin-top:12px;border-radius:9px;border:1px solid #59636e}button{background:#35b9e8;color:#07131a;font-weight:700}small{color:#b8c2ca}</style></head>
<body><main class="box"><h1>Autorizar conexão MCP</h1><p><strong>${escapeHtml(client.clientName)}</strong> deseja usar ferramentas de workspace, arquivos, terminal isolado e automação.</p><p><small>O Gemini pedirá confirmação antes de ações de escrita. Só autorize uma conexão iniciada por você.</small></p><form method="post" action="/oauth/authorize">${hidden}<label>Código de acesso do servidor<input type="password" name="access_key" required autocomplete="off"></label><button type="submit">Autorizar</button></form></main></body></html>`);
  });

  app.post('/oauth/authorize', { config: { cors: { origin: false } } }, async (request, reply) => {
    const raw = z.record(z.string(), z.unknown()).parse(request.body);
    const { input } = validateAuthorization(raw);
    const accessKey = typeof raw.access_key === 'string' ? raw.access_key : '';
    if (!constantTokenMatch(accessKey, config.NUMIA_SERVER_TOKEN)) {
      return reply.code(401).type('text/html; charset=utf-8').send('<h1>Acesso negado</h1><p>Código de acesso incorreto.</p>');
    }
    const code = store.createAuthorizationCode({
      clientId: input.client_id,
      redirectUri: input.redirect_uri,
      codeChallenge: input.code_challenge,
      resource: input.resource,
      scope: input.scope
    });
    const redirect = new URL(input.redirect_uri);
    redirect.searchParams.set('code', code);
    if (input.state) redirect.searchParams.set('state', input.state);
    redirect.searchParams.set('iss', urls.issuer);
    return reply.redirect(redirect.toString());
  });

  app.post('/oauth/token', async (request, reply) => {
    const raw = z.record(z.string(), z.unknown()).parse(request.body);
    const grantType = typeof raw.grant_type === 'string' ? raw.grant_type : '';
    const clientId = typeof raw.client_id === 'string' ? raw.client_id : '';
    const resource = typeof raw.resource === 'string' ? raw.resource : urls.resource;
    try {
      let result;
      if (grantType === 'authorization_code') {
        result = store.exchangeCode(
          String(raw.code ?? ''), clientId, String(raw.redirect_uri ?? ''), String(raw.code_verifier ?? ''), resource
        );
      } else if (grantType === 'refresh_token') {
        result = store.refresh(String(raw.refresh_token ?? ''), clientId, resource);
      } else {
        return reply.code(400).send({ error: 'unsupported_grant_type' });
      }
      reply.header('Cache-Control', 'no-store');
      return reply.send(result);
    } catch (error) {
      const description = error instanceof Error ? error.message : 'Falha de autorização.';
      return reply.code(400).send({ error: error instanceof AppError ? error.code : 'invalid_grant', error_description: description });
    }
  });
}
