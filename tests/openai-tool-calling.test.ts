import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prepareOpenAIRequest } from '../src/openai-compat.js';
import { createOpenAIToolContext, parseOpenAIToolDecision } from '../src/openai-tools.js';
import type { AIProvider, ProviderEvent, ProviderRequest } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, {
  recursive: true, force: true, maxRetries: 5, retryDelay: 100
})));

const token = 'a'.repeat(64);
function testConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-tools-'));
  dirs.push(dir);
  return loadConfig({
    NODE_ENV: 'test', NUMIA_SERVER_TOKEN: token, DATA_DIR: dir,
    ALLOWED_MODELS: 'gemini-3.7-flash-low', DEFAULT_MODEL: 'gemini-3.7-flash-low'
  });
}

class FakeProvider implements AIProvider {
  readonly sent: ProviderRequest[] = [];
  readonly streamed: ProviderRequest[] = [];
  constructor(
    private readonly structured: unknown[] = [],
    private readonly normalText = 'resposta-legada'
  ) {}
  async sendMessage(request: ProviderRequest): Promise<string> {
    this.sent.push(request);
    return this.normalText;
  }
  async *streamMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    this.streamed.push(request);
    yield { type: 'start', conversationId: request.conversationId, model: request.model };
    if (request.jsonSchema) {
      const output = this.structured.shift();
      const text = JSON.stringify(output);
      yield { type: 'delta', text };
      yield { type: 'complete', text, structuredOutput: output, conversationId: request.conversationId };
    } else {
      yield { type: 'delta', text: this.normalText };
      yield { type: 'complete', text: this.normalText, conversationId: request.conversationId };
    }
  }
  async listModels(): Promise<string[]> { return ['gemini-3.7-flash-low']; }
  async checkAuthentication() { return { available: true, authenticated: true }; }
  cancel(): boolean { return false; }
  supportsFiles(): boolean { return true; }
}

const auth = { authorization: `Bearer ${token}` };
const timeTool = {
  type: 'function' as const,
  function: {
    name: 'get_current_time',
    description: 'Returns the current time',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
};

function ssePayloads(body: string): Array<Record<string, unknown>> {
  return body.split(/\r?\n/)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe('OpenAI Tool Calling', { timeout: 20_000 }, () => {
  it('keeps non-streaming requests without tools on the legacy path', async () => {
    const provider = new FakeProvider();
    const app = await buildApp(testConfig(), { provider });
    try {
      const response = await app.inject({
        method: 'POST', url: '/chat/completions', headers: auth,
        payload: {
          model: 'gemini-3.7-flash-low', messages: [{ role: 'user', content: 'Olá' }],
          tool_choice: 123, parallel_tool_calls: 'valor-legado-ignorado'
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().choices[0]).toMatchObject({
        message: { role: 'assistant', content: 'resposta-legada' }, finish_reason: 'stop'
      });
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]?.jsonSchema).toBeUndefined();
      expect(provider.streamed).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('keeps streaming requests without tools on the legacy delta path', async () => {
    const provider = new FakeProvider([], 'delta-legado');
    const app = await buildApp(testConfig(), { provider });
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/chat/completions', headers: auth,
        payload: { model: 'gemini-3.7-flash-low', stream: true, messages: [{ role: 'user', content: 'Olá' }] }
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"content":"delta-legado"');
      expect(response.body).toContain('"finish_reason":"stop"');
      expect(response.body).toContain('data: [DONE]');
      expect(provider.streamed[0]?.jsonSchema).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('returns a real get_current_time tool_call without executing it', async () => {
    const provider = new FakeProvider([{
      type: 'tool_calls', tool_calls: [{ name: 'get_current_time', arguments: {} }]
    }]);
    const app = await buildApp(testConfig(), { provider });
    try {
      const response = await app.inject({
        method: 'POST', url: '/chat/completions', headers: auth,
        payload: {
          model: 'gemini-3.7-flash-low',
          messages: [{ role: 'user', content: 'Qual é a hora atual? Use a ferramenta.' }],
          tools: [timeTool]
        }
      });
      expect(response.statusCode).toBe(200);
      const choice = response.json().choices[0];
      expect(choice.finish_reason).toBe('tool_calls');
      expect(choice.message.content).toBeNull();
      expect(choice.message.tool_calls[0]).toMatchObject({
        type: 'function', function: { name: 'get_current_time', arguments: '{}' }
      });
      expect(choice.message.tool_calls[0].id).toMatch(/^call_[0-9a-f]{32}$/);
      expect(provider.sent).toHaveLength(0);
      expect(provider.streamed[0]?.jsonSchema).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('preserves assistant tool_calls and role=tool as structured context', async () => {
    const provider = new FakeProvider([{ type: 'message', content: 'A criação foi confirmada.' }]);
    const app = await buildApp(testConfig(), { provider });
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/chat/completions', headers: auth,
        payload: {
          model: 'gemini-3.7-flash-low',
          messages: [
            { role: 'user', content: 'Crie o workspace.' },
            { role: 'assistant', content: null, tool_calls: [{
              id: 'call_previous', type: 'function',
              function: { name: 'workspace_create', arguments: '{"name":"teste"}' }
            }] },
            { role: 'tool', tool_call_id: 'call_previous', content: 'Workspace teste criado com sucesso' }
          ],
          tools: [{ type: 'function', function: {
            name: 'workspace_create', parameters: {
              type: 'object', properties: { name: { type: 'string' } }, required: ['name']
            }
          } }]
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().choices[0]).toMatchObject({
        message: { content: 'A criação foi confirmada.' }, finish_reason: 'stop'
      });
      const prompt = provider.streamed[0]?.prompt ?? '';
      expect(prompt).toContain('ASSISTANT_TOOL_CALLS:');
      expect(prompt).toContain('TOOL_RESULT:');
      expect(prompt).toContain('call_previous');
      expect(prompt).toContain('Workspace teste criado com sucesso');
    } finally {
      await app.close();
    }
  });

  it('supports a second tool round and multiple calls with unique IDs', async () => {
    const provider = new FakeProvider([{
      type: 'tool_calls',
      tool_calls: [
        { name: 'git_clone', arguments: { repo_url: 'https://github.com/example/repo.git' } },
        { name: 'file_list', arguments: { path: '.' } }
      ]
    }]);
    const app = await buildApp(testConfig(), { provider });
    const tools = [
      { type: 'function', function: { name: 'workspace_create', parameters: {
        type: 'object', properties: { name: { type: 'string' } }, required: ['name']
      } } },
      { type: 'function', function: { name: 'git_clone', parameters: {
        type: 'object', properties: { repo_url: { type: 'string' } }, required: ['repo_url']
      } } },
      { type: 'function', function: { name: 'file_list', parameters: {
        type: 'object', properties: { path: { type: 'string' } }, required: ['path']
      } } }
    ];
    try {
      const response = await app.inject({
        method: 'POST', url: '/chat/completions', headers: auth,
        payload: {
          model: 'gemini-3.7-flash-low',
          messages: [
            { role: 'user', content: 'Prepare o projeto.' },
            { role: 'assistant', content: null, tool_calls: [{
              id: 'call_workspace', type: 'function',
              function: { name: 'workspace_create', arguments: '{"name":"teste"}' }
            }] },
            { role: 'tool', tool_call_id: 'call_workspace', content: '{"id":"workspace-1"}' }
          ],
          tools
        }
      });
      const calls = response.json().choices[0].message.tool_calls;
      expect(calls.map((call: { function: { name: string } }) => call.function.name)).toEqual(['git_clone', 'file_list']);
      expect(new Set(calls.map((call: { id: string }) => call.id)).size).toBe(2);
      calls.forEach((call: { function: { arguments: string } }) => expect(() => JSON.parse(call.function.arguments)).not.toThrow());
    } finally {
      await app.close();
    }
  });

  it('returns normal content when the model decides no tool is needed', async () => {
    const provider = new FakeProvider([{ type: 'message', content: 'Não preciso usar uma ferramenta.' }]);
    const app = await buildApp(testConfig(), { provider });
    try {
      const response = await app.inject({
        method: 'POST', url: '/chat/completions', headers: auth,
        payload: { model: 'gemini-3.7-flash-low', messages: [{ role: 'user', content: 'Diga oi.' }], tools: [timeTool] }
      });
      expect(response.json().choices[0]).toMatchObject({
        message: { role: 'assistant', content: 'Não preciso usar uma ferramenta.' }, finish_reason: 'stop'
      });
    } finally {
      await app.close();
    }
  });

  it('normalizes harmless inactive fields emitted by structured output', () => {
    const context = createOpenAIToolContext([timeTool], 'auto');
    expect(parseOpenAIToolDecision({
      type: 'message', content: 'Workspace criado.', tool_calls: []
    }, '', context!)).toEqual({ type: 'message', content: 'Workspace criado.' });

    const call = parseOpenAIToolDecision({
      type: 'tool_calls', content: null,
      tool_calls: [{ name: 'get_current_time', arguments: '{}' }]
    }, '', context!);
    expect(call.type).toBe('tool_calls');
    if (call.type === 'tool_calls') {
      expect(call.toolCalls[0]?.function).toMatchObject({
        name: 'get_current_time', arguments: '{}'
      });
    }
  });

  it('rejects nonexistent tools and arguments that violate JSON Schema', () => {
    const context = createOpenAIToolContext([{
      type: 'function', function: {
        name: 'workspace_create',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }
      }
    }], undefined);
    expect(context).toBeDefined();
    expect(() => parseOpenAIToolDecision({
      type: 'tool_calls', tool_calls: [{ name: 'not_provided', arguments: {} }]
    }, '', context!)).toThrow(/não permitida/);
    expect(() => parseOpenAIToolDecision({
      type: 'tool_calls', tool_calls: [{ name: 'workspace_create', arguments: { wrong: true } }]
    }, '', context!)).toThrow(/argumentos inválidos/);
  });

  it('enforces tool_choice and parallel_tool_calls policies in the backend', () => {
    const tools = [timeTool, {
      type: 'function', function: {
        name: 'other_tool', parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    }];
    const required = createOpenAIToolContext(tools, 'required');
    expect(() => parseOpenAIToolDecision({ type: 'message', content: 'texto' }, '', required!))
      .toThrow(/obrigatória/);
    const selected = createOpenAIToolContext(tools, {
      type: 'function', function: { name: 'get_current_time' }
    });
    expect(() => parseOpenAIToolDecision({
      type: 'tool_calls', tool_calls: [{ name: 'other_tool', arguments: {} }]
    }, '', selected!)).toThrow(/não permitida/);
    const serial = createOpenAIToolContext(tools, 'auto', false);
    expect(() => parseOpenAIToolDecision({
      type: 'tool_calls', tool_calls: [
        { name: 'get_current_time', arguments: {} }, { name: 'other_tool', arguments: {} }
      ]
    }, '', serial!)).toThrow(/paralelas/);
  });

  it('streams delta.tool_calls and finishes with tool_calls', async () => {
    const provider = new FakeProvider([{
      type: 'tool_calls', tool_calls: [{ name: 'get_current_time', arguments: {} }]
    }]);
    const app = await buildApp(testConfig(), { provider });
    try {
      const response = await app.inject({
        method: 'POST', url: '/v1/chat/completions', headers: auth,
        payload: {
          model: 'gemini-3.7-flash-low', stream: true,
          messages: [{ role: 'user', content: 'Use a ferramenta de hora.' }], tools: [timeTool]
        }
      });
      const payloads = ssePayloads(response.body);
      const toolChunk = payloads.find((payload) => JSON.stringify(payload).includes('get_current_time')) as any;
      expect(toolChunk.choices[0].delta.tool_calls[0]).toMatchObject({
        index: 0, type: 'function', function: { name: 'get_current_time', arguments: '{}' }
      });
      expect(payloads.some((payload) => JSON.stringify(payload).includes('"finish_reason":"tool_calls"'))).toBe(true);
      expect(response.body).toContain('data: [DONE]');
    } finally {
      await app.close();
    }
  });

  it('keeps multimodal image handling active when tools are present', async () => {
    const config = testConfig();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const prepared = await prepareOpenAIRequest({
      model: 'gemini-3.7-flash-low', tools: [timeTool],
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Leia a imagem e decida se precisa da ferramenta.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }
      ] }]
    }, config);
    try {
      expect(prepared.imageCount).toBe(1);
      expect(prepared.toolContext).toBeDefined();
      expect(prepared.prompt).toContain(`@${path.join(prepared.workingDirectory, 'numia-image-1.png')}`);
      expect(prepared.prompt).toContain('MODO OPENAI TOOL CALLING');
    } finally {
      await prepared.cleanup();
    }

    const routedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-tools-vision-'));
    dirs.push(routedDir);
    const routedConfig = loadConfig({
      NODE_ENV: 'test', NUMIA_SERVER_TOKEN: token, DATA_DIR: routedDir,
      ALLOWED_MODELS: 'gemini-3.1-pro-high,gemini-3.7-flash-low',
      DEFAULT_MODEL: 'gemini-3.1-pro-high', VISION_MODEL: 'gemini-3.7-flash-low'
    });
    const provider = new FakeProvider([{ type: 'message', content: 'Imagem recebida.' }]);
    const app = await buildApp(routedConfig, { provider });
    try {
      const response = await app.inject({
        method: 'POST', url: '/chat/completions', headers: auth,
        payload: {
          model: 'gemini-3.1-pro-high', tools: [timeTool],
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'Descreva.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }
          ] }]
        }
      });
      expect(response.statusCode).toBe(200);
      expect(provider.streamed[0]).toMatchObject({ model: 'gemini-3.7-flash-low', autoApprove: true });
    } finally {
      await app.close();
    }
  });
});
