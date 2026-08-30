import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('Remote MCP endpoint', () => {
  it('authenticates, advertises all tools and handles workspace files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-mcp-http-'));
    dirs.push(dir);
    const token = 'a'.repeat(64);
    const app = await buildApp(loadConfig({
      NODE_ENV: 'test', NUMIA_SERVER_TOKEN: token, DATA_DIR: dir,
      PUBLIC_BASE_URL: 'https://example.test', MCP_ENABLED: 'true',
      MCP_WORKSPACES_DIR: path.join(dir, 'workspaces'), MCP_WORKER_TOKEN: 'b'.repeat(64),
      ALLOWED_MODELS: 'gemini-3.7-flash-low', DEFAULT_MODEL: 'gemini-3.7-flash-low'
    }));

    const unauthorized = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['www-authenticate']).toContain('oauth-protected-resource/mcp');
    expect((await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' })).json())
      .toMatchObject({ resource: 'https://example.test/mcp', scopes_supported: ['mcp:tools'] });

    const registration = await app.inject({
      method: 'POST', url: '/oauth/register', payload: {
        client_name: 'Spark Test', redirect_uris: ['http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none'
      }
    });
    expect(registration.statusCode).toBe(201);
    const clientId = String(registration.json().client_id);
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authorization = await app.inject({
      method: 'POST', url: '/oauth/authorize', headers: {
        'content-type': 'application/x-www-form-urlencoded', origin: 'https://example.test'
      },
      payload: new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1/callback',
        state: 'test-state', code_challenge: challenge, code_challenge_method: 'S256',
        resource: 'https://example.test/mcp', scope: 'mcp:tools', access_key: token
      }).toString()
    });
    expect(authorization.statusCode).toBe(302);
    const callback = new URL(String(authorization.headers.location));
    expect(callback.searchParams.get('state')).toBe('test-state');
    expect(callback.searchParams.get('iss')).toBe('https://example.test');
    const tokenResponse = await app.inject({
      method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code', client_id: clientId,
        redirect_uri: 'http://127.0.0.1/callback', code: String(callback.searchParams.get('code')),
        code_verifier: verifier, resource: 'https://example.test/mcp'
      }).toString()
    });
    expect(tokenResponse.statusCode).toBe(200);
    expect(tokenResponse.json()).toMatchObject({ token_type: 'Bearer', scope: 'mcp:tools' });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'numia-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token }
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'artifact_list', 'artifact_publish', 'file_edit', 'file_list', 'file_read', 'file_write',
        'git_clone', 'goal_run', 'shell_execute', 'skill_install', 'skill_list', 'skill_read',
        'skill_resources', 'workspace_create', 'workspace_delete', 'workspace_info'
      ]);
      const created = await client.callTool({ name: 'workspace_create', arguments: { name: 'Integração' } });
      const workspaceId = String((created.structuredContent as Record<string, unknown>).id);
      await client.callTool({
        name: 'file_write', arguments: { workspace_id: workspaceId, path: 'teste.txt', content: 'funcionou' }
      });
      const read = await client.callTool({ name: 'file_read', arguments: { workspace_id: workspaceId, path: 'teste.txt' } });
      expect(read.structuredContent).toMatchObject({ content: 'funcionou' });
    } finally {
      await client.close();
      await app.close();
    }
  }, 20_000);
});
