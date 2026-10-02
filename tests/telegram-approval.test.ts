import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  SENSITIVE_TOOLS,
  sendApproval,
  getApproval,
  listApprovals,
  updateApprovalStatus,
  resumeApprovalExecution,
  handleTelegramWebhook,
  setDatabase,
  registerResumptionHandler,
  registerTelegramPromptHandler,
  ensureApprovalsTable,
  formatMathForTelegram,
  splitMessageChunks
} from '../src/telegram.js';
import type { AIProvider, ProviderEvent, ProviderRequest } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, {
  recursive: true, force: true, maxRetries: 5, retryDelay: 100
})));

const token = 'a'.repeat(64);
function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-approval-test-'));
  dirs.push(dir);
  return loadConfig({
    NODE_ENV: 'test',
    NUMIA_SERVER_TOKEN: token,
    DATA_DIR: dir,
    ALLOWED_MODELS: 'gemini-3.7-flash-low',
    DEFAULT_MODEL: 'gemini-3.7-flash-low',
    TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    TELEGRAM_CHAT_ID: '987654321',
    ...overrides
  });
}

class FakeToolProvider implements AIProvider {
  constructor(
    private readonly structured: unknown[] = [],
    private readonly normalText = 'resposta-normal'
  ) {}

  async sendMessage(request: ProviderRequest): Promise<string> {
    return `Executado: ${request.prompt}`;
  }

  async *streamMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
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

describe('Aprovação Estilo Muse via Telegram', () => {
  let db: Database.Database;
  let testDbDir: string;

  beforeEach(() => {
    testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-db-'));
    dirs.push(testDbDir);
    db = new Database(path.join(testDbDir, 'test-approvals.sqlite'));
    setDatabase(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it('cria a tabela approvals no SQLite e registra nova solicitação pendente', async () => {
    ensureApprovalsTable(db);

    const approvalId = await sendApproval(
      'conv-123',
      'send_email',
      JSON.stringify({ to: 'chefe@empresa.com', subject: 'Relatório' })
    );

    expect(approvalId).toBeDefined();
    expect(approvalId.startsWith('appr_')).toBe(true);

    const record = getApproval(approvalId);
    expect(record).toBeDefined();
    expect(record?.id).toBe(approvalId);
    expect(record?.conversationId).toBe('conv-123');
    expect(record?.action).toBe('send_email');
    expect(record?.status).toBe('pending');
    expect(record?.created_at).toBeDefined();

    const list = listApprovals('conv-123');
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(approvalId);
  });

  it('atualiza status da aprovação no SQLite', async () => {
    const approvalId = await sendApproval(
      'conv-456',
      'transfer_money',
      JSON.stringify({ amount: 500, to: 'fornecedor' })
    );

    updateApprovalStatus(approvalId, 'approved');
    let record = getApproval(approvalId);
    expect(record?.status).toBe('approved');

    updateApprovalStatus(approvalId, 'denied', 'Recusado pelo usuário');
    record = getApproval(approvalId);
    expect(record?.status).toBe('denied');
    expect(record?.result).toBe('Recusado pelo usuário');
  });

  it('intercepta tool sensível send_email em requisição não-streaming (/v1/chat/completions)', async () => {
    const config = testConfig();
    const fakeProvider = new FakeToolProvider([
      {
        type: 'tool_calls',
        tool_calls: [{
          name: 'send_email',
          arguments: { to: 'alvo@teste.com', body: 'Olá' }
        }]
      }
    ]);

    const app = await buildApp(config, { provider: fakeProvider });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        payload: {
          model: 'gemini-3.7-flash-low',
          messages: [{ role: 'user', content: 'Envie um email para alvo@teste.com' }],
          tools: [{
            type: 'function',
            function: {
              name: 'send_email',
              description: 'Envia email',
              parameters: {
                type: 'object',
                properties: {
                  to: { type: 'string' },
                  body: { type: 'string' }
                },
                required: ['to', 'body']
              }
            }
          }],
          stream: false
        }
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.status).toBe('AWAITING_APPROVAL');
      expect(data.message).toBe('Aguardando aprovação no Telegram');
      expect(data.approvalId).toBeDefined();

      const approval = getApproval(data.approvalId);
      expect(approval).toBeDefined();
      expect(approval?.action).toBe('send_email');
      expect(approval?.status).toBe('pending');
    } finally {
      await app.close();
    }
  });

  it('intercepta tool sensível purchase em requisição streaming (/v1/chat/completions)', async () => {
    const config = testConfig();
    const fakeProvider = new FakeToolProvider([
      {
        type: 'tool_calls',
        tool_calls: [{
          name: 'purchase',
          arguments: { item: 'Notebook', price: 5000 }
        }]
      }
    ]);

    const app = await buildApp(config, { provider: fakeProvider });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        payload: {
          model: 'gemini-3.7-flash-low',
          messages: [{ role: 'user', content: 'Compre o notebook' }],
          tools: [{
            type: 'function',
            function: {
              name: 'purchase',
              description: 'Realiza compra',
              parameters: {
                type: 'object',
                properties: {
                  item: { type: 'string' },
                  price: { type: 'number' }
                },
                required: ['item', 'price']
              }
            }
          }],
          stream: true
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('AWAITING_APPROVAL');
      expect(res.body).toContain('Aguardando aprovação no Telegram');
    } finally {
      await app.close();
    }
  });

  it('não intercepta ferramentas não-sensíveis (ex: get_weather)', async () => {
    const config = testConfig();
    const fakeProvider = new FakeToolProvider([
      {
        type: 'tool_calls',
        tool_calls: [{
          name: 'get_weather',
          arguments: { city: 'São Paulo' }
        }]
      }
    ]);

    const app = await buildApp(config, { provider: fakeProvider });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        payload: {
          model: 'gemini-3.7-flash-low',
          messages: [{ role: 'user', content: 'Como está o tempo em SP?' }],
          tools: [{
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Consulta o clima',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string' }
                },
                required: ['city']
              }
            }
          }],
          stream: false
        }
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
      expect(data.status).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('recebe update via POST /telegram/webhook com sucesso', async () => {
    const config = testConfig();
    const app = await buildApp(config);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'content-type': 'application/json' },
        payload: {
          update_id: 10001,
          message: {
            message_id: 1,
            from: { id: 123, is_bot: false, first_name: 'João' },
            chat: { id: 123, type: 'private' },
            date: 1600000000,
            text: '/status'
          }
        }
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('processa callback approve_ e retoma execução via Antigravity CLI', async () => {
    let resumed = false;
    let resumedAction = '';

    registerResumptionHandler(async (approval, context) => {
      resumed = true;
      resumedAction = approval.action;
      return `Ação ${approval.action} executada com sucesso com parâmetros ${approval.details}`;
    });

    const approvalId = await sendApproval(
      'conv-retomada',
      'pay_bill',
      JSON.stringify({ boleto: '123456789', valor: 150 })
    );

    // Simula o callback query enviado pelo Telegram ao clicar no botão [✅ Aprovar]
    const webhookRes = await handleTelegramWebhook({
      update_id: 10002,
      callback_query: {
        id: 'cb-1',
        from: { id: 987654321, is_bot: false, first_name: 'João' },
        message: {
          message_id: 42,
          date: 1600000000,
          chat: { id: 987654321, type: 'private' }
        },
        data: `approve_${approvalId}`
      }
    });

    expect(webhookRes.ok).toBe(true);

    const record = getApproval(approvalId);
    expect(record?.status).toBe('completed');
    expect(record?.result).toContain('pay_bill');
    expect(resumed).toBe(true);
    expect(resumedAction).toBe('pay_bill');
  });

  it('processa callback deny_ e marca como negado no SQLite', async () => {
    const approvalId = await sendApproval(
      'conv-negada',
      'book_flight',
      JSON.stringify({ destino: 'Paris', data: '2026-12-01' })
    );

    // Simula o callback query enviado pelo Telegram ao clicar no botão [❌ Negar]
    const webhookRes = await handleTelegramWebhook({
      update_id: 10003,
      callback_query: {
        id: 'cb-2',
        from: { id: 987654321, is_bot: false, first_name: 'João' },
        message: {
          message_id: 43,
          date: 1600000000,
          chat: { id: 987654321, type: 'private' }
        },
        data: `deny_${approvalId}`
      }
    });

    expect(webhookRes.ok).toBe(true);

    const record = getApproval(approvalId);
    expect(record?.status).toBe('denied');
  });

  it('fornece endpoints /api/approvals para consulta e retomada', async () => {
    const config = testConfig();
    const app = await buildApp(config);
    try {
      const approvalId = await sendApproval(
        'conv-api',
        'transfer_money',
        JSON.stringify({ chave_pix: 'joao@pix.com', valor: 200 })
      );

      // Consulta lista de aprovações
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/approvals',
        headers: { authorization: `Bearer ${token}` }
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().approvals.length).toBeGreaterThan(0);

      // Consulta detalhe da aprovação
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/approvals/${approvalId}`,
        headers: { authorization: `Bearer ${token}` }
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().approval.action).toBe('transfer_money');
      expect(getRes.json().approval.status).toBe('pending');

      // Dispara retomada manual
      registerResumptionHandler(async (appr) => `Transferência de R$ 200 concluída.`);
      const resumeRes = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approvalId}/resume`,
        headers: { authorization: `Bearer ${token}` }
      });
      expect(resumeRes.statusCode).toBe(200);
      expect(resumeRes.json().success).toBe(true);

      const updated = getApproval(approvalId);
      expect(updated?.status).toBe('completed');
    } finally {
      await app.close();
    }
  });

  it('responde mensagens de texto diretamente com o Gemini CLI via Telegram', async () => {
    let capturedPrompt = '';
    registerTelegramPromptHandler(async (prompt) => {
      capturedPrompt = prompt;
      return `Resposta do Gemini para: ${prompt}`;
    });

    const webhookRes = await handleTelegramWebhook({
      update_id: 10004,
      message: {
        message_id: 99,
        from: { id: 987654321, is_bot: false, first_name: 'João' },
        chat: { id: 987654321, type: 'private' },
        date: 1600000000,
        text: 'Olá Gemini, faça um resumo das notícias de tecnologia.'
      }
    });

    expect(webhookRes.ok).toBe(true);
    expect(capturedPrompt).toBe('Olá Gemini, faça um resumo das notícias de tecnologia.');
  });

  it('formata fórmulas matemáticas LaTeX para Unicode legível no Telegram', () => {
    const rawOutput = [
      'Na reta $AB$, a mediatriz passa pelo ponto médio.',
      'Arcos congruentes de raio $r > \\frac{d}{2}$ com centros nos extremos geram $P_1$ e $P_2$.',
      'A corda vale $L_{11} \\approx 2{,}82\\text{ cm}$ com raio $R = 2\\text{ cm}$.',
      'Consulte o arquivo [walkthrough.md](file:///home/node/walkthrough.md).'
    ].join('\n');

    const formatted = formatMathForTelegram(rawOutput);

    expect(formatted).not.toContain('$AB$');
    expect(formatted).toContain('Na reta AB');
    expect(formatted).toContain('r > d/2');
    expect(formatted).toContain('P₁ e P₂');
    expect(formatted).toContain('L₁₁ ≈ 2,82 cm');
    expect(formatted).toContain('R = 2 cm');
    expect(formatted).not.toContain('file:///home/node/walkthrough.md');
    expect(formatted).toContain('📄 *walkthrough.md*');
  });

  it('divide mensagens longas respeitando limites do Telegram sem quebrar palavras', () => {
    const paragraph1 = 'A'.repeat(2000);
    const paragraph2 = 'B'.repeat(2500);
    const longMessage = `${paragraph1}\n\n${paragraph2}`;

    const chunks = splitMessageChunks(longMessage, 3900);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBeLessThanOrEqual(3900);
    expect(chunks[1]?.length).toBeLessThanOrEqual(3900);
    expect(chunks[0]).toBe(paragraph1);
    expect(chunks[1]).toBe(paragraph2);
  });
});

