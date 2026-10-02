/**
 * Módulo de Aprovação Humana Estilo Muse via Telegram
 *
 * Permite interceptar ferramentas e ações sensíveis (ex: send_email, purchase, pay_bill, etc.)
 * e solicitar aprovação interativa em tempo real através do Telegram com botões inline [✅ Aprovar] e [❌ Negar].
 * Ao aprovar, o sistema retoma a execução no Antigravity CLI com o contexto original salvo.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Telegraf, Markup, type Context } from 'telegraf';

// Lista de ferramentas/ações consideradas sensíveis que exigem aprovação humana obrigatória
export const SENSITIVE_TOOLS = [
  'send_email',
  'purchase',
  'pay_bill',
  'book_flight',
  'transfer_money'
] as const;

export type SensitiveToolName = (typeof SENSITIVE_TOOLS)[number];

// Tipos de status para o registro de aprovação
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'completed' | 'failed';

// Interface representando a linha da tabela SQLite 'approvals'
export interface ApprovalRecord {
  id: string;
  conversationId: string;
  action: string;
  details: string;
  status: ApprovalStatus;
  created_at: string;
  context_data?: string | null;
  result?: string | null;
  updated_at?: string | null;
}

// Tipo para a função que executa a retomada no Antigravity CLI quando aprovado
export type ResumptionHandler = (
  approval: ApprovalRecord,
  contextData: Record<string, unknown>
) => Promise<string | void>;

// Instância compartilhada do banco SQLite para o módulo
let moduleDb: Database.Database | null = null;

// Instância compartilhada do bot Telegraf
let telegramBot: Telegraf<Context> | null = null;

// Handler registrado para retomar a execução do Antigravity CLI
let registeredResumptionHandler: ResumptionHandler | null = null;

// Estrutura para anexos de imagem recebidos pelo Telegram
export interface TelegramImageAttachment {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}

// Tipo e handler registrado para responder mensagens e imagens diretamente com o Gemini CLI
export type TelegramPromptHandler = (
  prompt: string,
  conversationId: string,
  chatId: number | string,
  images?: TelegramImageAttachment[],
  model?: string
) => Promise<string>;

let registeredTelegramPromptHandler: TelegramPromptHandler | null = null;

export function registerTelegramPromptHandler(handler: TelegramPromptHandler): void {
  registeredTelegramPromptHandler = handler;
}

export type TelegramSessionCleanupHandler = (conversationId: string) => Promise<void>;
let registeredSessionCleanupHandler: TelegramSessionCleanupHandler | null = null;

export function registerTelegramSessionCleanup(handler: TelegramSessionCleanupHandler): void {
  registeredSessionCleanupHandler = handler;
}

interface ChatSessionState {
  conversationId: string;
  lastActive: number;
  model?: string;
}

const chatConversations = new Map<number | string, ChatSessionState>();

export function getChatSession(chatId: number | string): { conversationId: string; isNewSession: boolean; model?: string } {
  const ttlHours = Number(process.env.TELEGRAM_SESSION_TTL_HOURS) || 2;
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const now = Date.now();
  const existing = chatConversations.get(chatId);

  if (existing) {
    if (now - existing.lastActive < ttlMs) {
      existing.lastActive = now;
      return { conversationId: existing.conversationId, isNewSession: false, model: existing.model };
    }
    // Sessão expirou por inatividade: limpa arquivos da conversa antiga
    const expiredId = existing.conversationId;
    if (registeredSessionCleanupHandler) {
      void registeredSessionCleanupHandler(expiredId).catch(() => undefined);
    }
  }

  const newId = crypto.randomUUID();
  chatConversations.set(chatId, { conversationId: newId, lastActive: now, model: existing?.model });
  return { conversationId: newId, isNewSession: Boolean(existing), model: existing?.model };
}

export function setChatModel(chatId: number | string, model: string): void {
  const session = chatConversations.get(chatId);
  if (session) {
    session.model = model;
  } else {
    chatConversations.set(chatId, { conversationId: crypto.randomUUID(), lastActive: Date.now(), model });
  }
}

export function getChatConversationId(chatId: number | string): string {
  return getChatSession(chatId).conversationId;
}

export function resetChatConversationId(chatId: number | string): string {
  const existing = chatConversations.get(chatId);
  if (existing && registeredSessionCleanupHandler) {
    void registeredSessionCleanupHandler(existing.conversationId).catch(() => undefined);
  }
  const newId = crypto.randomUUID();
  chatConversations.set(chatId, { conversationId: newId, lastActive: Date.now(), model: existing?.model });
  return newId;
}

let janitorTimer: NodeJS.Timeout | null = null;

export function startTelegramJanitor(intervalMinutes = 30): void {
  if (janitorTimer) clearInterval(janitorTimer);
  janitorTimer = setInterval(() => {
    void cleanupExpiredTelegramSessions();
  }, intervalMinutes * 60 * 1000);
}

export function stopTelegramJanitor(): void {
  if (janitorTimer) {
    clearInterval(janitorTimer);
    janitorTimer = null;
  }
}

export async function cleanupExpiredTelegramSessions(): Promise<number> {
  const ttlHours = Number(process.env.TELEGRAM_SESSION_TTL_HOURS) || 2;
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const now = Date.now();
  let cleanedCount = 0;

  for (const [chatId, session] of chatConversations.entries()) {
    if (now - session.lastActive >= ttlMs) {
      chatConversations.delete(chatId);
      cleanedCount++;
      if (registeredSessionCleanupHandler) {
        await registeredSessionCleanupHandler(session.conversationId).catch(() => undefined);
      }
    }
  }

  return cleanedCount;
}

/**
 * Garante que a tabela 'approvals' exista no banco SQLite com o esquema requerido:
 * (id TEXT PRIMARY KEY, conversationId TEXT, action TEXT, details TEXT, status TEXT DEFAULT 'pending', created_at DATETIME)
 */
export function ensureApprovalsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      conversationId TEXT,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      context_data TEXT,
      result TEXT,
      updated_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_conversation ON approvals(conversationId);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
  `);
}

/**
 * Obtém ou inicializa a conexão com o banco de dados SQLite local
 */
export function getOrCreateDatabase(customDb?: Database.Database): Database.Database {
  if (customDb) {
    moduleDb = customDb;
    ensureApprovalsTable(moduleDb);
    return moduleDb;
  }
  if (!moduleDb) {
    const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve('data');
    moduleDb = new Database(path.join(dataDir, 'numia.sqlite'));
    moduleDb.pragma('journal_mode = WAL');
    ensureApprovalsTable(moduleDb);
  }
  return moduleDb;
}

/**
 * Define explicitamente o banco de dados a ser utilizado pelo módulo Telegram
 */
export function setDatabase(db: Database.Database): void {
  moduleDb = db;
  ensureApprovalsTable(moduleDb);
}

/**
 * Registra o handler responsável por retomar a execução do agente agy
 */
export function registerResumptionHandler(handler: ResumptionHandler): void {
  registeredResumptionHandler = handler;
}

/**
 * Busca uma aprovação pelo ID no SQLite
 */
export function getApproval(id: string): ApprovalRecord | undefined {
  const db = getOrCreateDatabase();
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRecord | undefined;
  return row;
}

/**
 * Atualiza o status e opcionalmente o resultado de uma aprovação no SQLite
 */
export function updateApprovalStatus(
  id: string,
  status: ApprovalStatus,
  result?: string | null
): void {
  const db = getOrCreateDatabase();
  const now = new Date().toISOString();
  if (result !== undefined) {
    db.prepare('UPDATE approvals SET status = ?, result = ?, updated_at = ? WHERE id = ?')
      .run(status, result, now, id);
  } else {
    db.prepare('UPDATE approvals SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id);
  }
}

/**
 * Lista aprovações no SQLite, com filtro opcional por conversa
 */
export function listApprovals(conversationId?: string, limit = 50): ApprovalRecord[] {
  const db = getOrCreateDatabase();
  if (conversationId) {
    return db.prepare('SELECT * FROM approvals WHERE conversationId = ? ORDER BY created_at DESC LIMIT ?')
      .all(conversationId, limit) as ApprovalRecord[];
  }
  return db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?')
    .all(limit) as ApprovalRecord[];
}

/**
 * Executa o mecanismo de retomada do Antigravity CLI com o contexto salvo
 */
export async function resumeApprovalExecution(approvalId: string): Promise<string | void> {
  const approval = getApproval(approvalId);
  if (!approval) {
    throw new Error(`Aprovação ${approvalId} não encontrada para retomada.`);
  }

  if (!registeredResumptionHandler) {
    console.warn(`[Telegram] Nenhum handler de retomada registrado para a aprovação ${approvalId}.`);
    updateApprovalStatus(approvalId, 'approved', 'Aprovado pelo Telegram, aguardando retomada manual.');
    return;
  }

  let parsedContext: Record<string, unknown> = {};
  if (approval.context_data) {
    try {
      parsedContext = JSON.parse(approval.context_data);
    } catch {
      parsedContext = {};
    }
  }

  try {
    updateApprovalStatus(approvalId, 'approved');
    const result = await registeredResumptionHandler(approval, parsedContext);
    const resultString = typeof result === 'string' ? result : 'Execução concluída com sucesso.';
    updateApprovalStatus(approvalId, 'completed', resultString);

    // Notifica no Telegram que a execução foi concluída
    const bot = getTelegramBot();
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (bot && chatId) {
      await bot.telegram.sendMessage(
        chatId,
        [
          '🎉 *Execução Retomada e Concluída com Sucesso!*',
          '',
          `🆔 *Aprovação:* \`${approval.id}\``,
          `⚡ *Ação:* \`${approval.action}\``,
          '',
          '💬 *Resposta Final do Agente:*',
          resultString.slice(0, 3500)
        ].join('\n'),
        { parse_mode: 'Markdown' }
      ).catch((err) => console.warn('[Telegram] Falha ao enviar mensagem de conclusão:', err.message));
    }

    return result;
  } catch (error) {
    const errorMsg = (error as Error).message || 'Erro durante a retomada.';
    updateApprovalStatus(approvalId, 'failed', errorMsg);

    const bot = getTelegramBot();
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (bot && chatId) {
      await bot.telegram.sendMessage(
        chatId,
        [
          '⚠️ *Erro ao Retomar Execução:*',
          '',
          `🆔 *Aprovação:* \`${approval.id}\``,
          `⚡ *Ação:* \`${approval.action}\``,
          '',
          `❌ *Falha:* ${errorMsg}`
        ].join('\n'),
        { parse_mode: 'Markdown' }
      ).catch(() => undefined);
    }

    throw error;
  }
}

export function setTelegramBot(bot: Telegraf<Context> | null): void {
  telegramBot = bot;
}

/**
 * Converte notações matemáticas LaTeX/MathJax em caracteres Unicode limpos e legíveis no Telegram,
 * removendo cifrões, comandos LaTeX e links internos do sistema.
 */
export function formatMathForTelegram(text: string): string {
  if (!text) return '';

  // 1. Protege blocos de código (``` e `) para não alterar código-fonte
  const codeBlocks: string[] = [];
  let res = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // 2. Remove links para arquivos locais do sistema (file:///)
  res = res.replace(/\[([^\]]+)\]\(file:\/\/\/[^\)]+\)/g, '📄 *$1*');
  res = res.replace(/file:\/\/\/[^\s\)\>]+/g, '');

  // 3. Frações numéricas e gerais
  res = res.replace(/\\frac\{1\}\{2\}/g, '½');
  res = res.replace(/\\frac\{1\}\{4\}/g, '¼');
  res = res.replace(/\\frac\{3\}\{4\}/g, '¾');
  res = res.replace(/\\frac\{1\}\{3\}/g, '⅓');
  res = res.replace(/\\frac\{2\}\{3\}/g, '⅔');
  res = res.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, (_m, num: string, den: string) => {
    const cleanNum = num.trim();
    const cleanDen = den.trim();
    if (/^[a-zA-Z0-9]$/.test(cleanNum) && /^[a-zA-Z0-9]$/.test(cleanDen)) {
      return `${cleanNum}/${cleanDen}`;
    }
    return `(${cleanNum})/(${cleanDen})`;
  });

  // 4. Raízes
  res = res.replace(/\\sqrt\[([^{}]+)\]\{([^{}]+)\}/g, '⁽$1⁾√($2)');
  res = res.replace(/\\sqrt\{([^{}]+)\}/g, '√($1)');

  // 5. Comandos de formatação de texto LaTeX
  res = res.replace(/\\textbf\{([^{}]+)\}/g, '*$1*');
  res = res.replace(/\\textit\{([^{}]+)\}/g, '_$1_');
  res = res.replace(/\\text\{([^{}]+)\}/g, '$1');
  res = res.replace(/\\mathrm\{([^{}]+)\}/g, '$1');
  res = res.replace(/\\mathbf\{([^{}]+)\}/g, '*$1*');
  res = res.replace(/\\mathit\{([^{}]+)\}/g, '_$1_');

  // 6. Símbolos e Operadores
  const mathSymbols: Record<string, string> = {
    '\\approx': '≈',
    '\\sim': '~',
    '\\times': '×',
    '\\cdot': '·',
    '\\div': '÷',
    '\\pm': '±',
    '\\mp': '∓',
    '\\leq': '≤',
    '\\le': '≤',
    '\\geq': '≥',
    '\\ge': '≥',
    '\\neq': '≠',
    '\\ne': '≠',
    '\\infty': '∞',
    '\\degree': '°',
    '^{\\circ}': '°',
    '^\\circ': '°',
    '\\rightarrow': '→',
    '\\to': '→',
    '\\leftarrow': '←',
    '\\Rightarrow': '⇒',
    '\\Leftrightarrow': '⇔',
    '\\parallel': '∥',
    '\\perp': '⊥',
    '\\angle': '∠',
    '\\in': '∈',
    '\\subset': '⊂',
    '\\forall': '∀',
    '\\exists': '∃'
  };
  for (const [tex, uni] of Object.entries(mathSymbols)) {
    res = res.split(tex).join(uni);
  }

  // 7. Letras Gregas
  const greekLetters: Record<string, string> = {
    '\\alpha': 'α',
    '\\beta': 'β',
    '\\gamma': 'γ',
    '\\delta': 'δ',
    '\\epsilon': 'ε',
    '\\theta': 'θ',
    '\\lambda': 'λ',
    '\\mu': 'μ',
    '\\pi': 'π',
    '\\rho': 'ρ',
    '\\sigma': 'σ',
    '\\tau': 'τ',
    '\\phi': 'φ',
    '\\omega': 'ω',
    '\\Delta': 'Δ',
    '\\Gamma': 'Γ',
    '\\Lambda': 'Λ',
    '\\Sigma': 'Σ',
    '\\Omega': 'Ω'
  };
  for (const [tex, uni] of Object.entries(greekLetters)) {
    res = res.split(tex).join(uni);
  }

  // 8. Delimitadores e espaços LaTeX
  res = res.replace(/\\left\(/g, '(');
  res = res.replace(/\\right\)/g, ')');
  res = res.replace(/\\left\[/g, '[');
  res = res.replace(/\\right\]/g, ']');
  res = res.replace(/\\left\\\{/g, '{');
  res = res.replace(/\\right\\\}/g, '}');
  res = res.replace(/\\\{/g, '{');
  res = res.replace(/\\\}/g, '}');
  res = res.replace(/\\quad/g, '  ');
  res = res.replace(/\\qquad/g, '    ');
  res = res.replace(/\\[,;:!]/g, ' ');

  // 9. Sobrescritos e Subscritos
  const superMap: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
    '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
    'n': 'ⁿ', 'i': 'ⁱ', 'x': 'ˣ'
  };
  const subMap: Record<string, string> = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
    '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
    '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
    'a': 'ₐ', 'e': 'ₑ', 'i': 'ᵢ', 'o': 'ₒ', 'r': 'ᵣ', 'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ'
  };

  res = res.replace(/\^\{([^{}]+)\}/g, (_m, content: string) => {
    const chars = content.split('');
    if (chars.every(c => superMap[c])) {
      return chars.map(c => superMap[c]).join('');
    }
    return `^(${content})`;
  });
  res = res.replace(/\^([0-9nix+-])/g, (_m, c: string) => superMap[c] || `^${c}`);

  res = res.replace(/_\{([^{}]+)\}/g, (_m, content: string) => {
    const chars = content.split('');
    if (chars.every(c => subMap[c])) {
      return chars.map(c => subMap[c]).join('');
    }
    return `_(${content})`;
  });
  res = res.replace(/_([0-9+-])/g, (_m, c: string) => subMap[c] || `_${c}`);

  // 10. Blocos de equações $$ ... $$ e \[ ... \]
  res = res.replace(/\$\$([\s\S]*?)\$\$/g, (_m, inner: string) => `\n${inner.trim()}\n`);
  res = res.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => `\n${inner.trim()}\n`);
  res = res.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string) => inner.trim());

  // 11. Remove $ em expressões matemáticas inline simples ($AB$ -> AB, $r > d/2$ -> r > d/2)
  res = res.replace(/\$([^\$\n]+)\$/g, (_m, inner: string) => inner.trim());

  // 12. Corrige vírgula decimal em fórmulas (ex: 2{,}82 -> 2,82)
  res = res.replace(/([0-9])\{,\}([0-9])/g, '$1,$2');

  // 13. Restaura blocos de código originais
  res = res.replace(/__CODE_BLOCK_(\d+)__/g, (_m, idxStr: string) => {
    const idx = Number(idxStr);
    return codeBlocks[idx] ?? '';
  });

  return res.trim();
}

/**
 * Divide respostas longas em blocos que respeitam o limite de 4096 caracteres do Telegram,
 * quebrando preferencialmente em parágrafos ou quebras de linha.
 */
export function splitMessageChunks(text: string, maxLength = 3900): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex <= 0) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  return chunks;
}

/**
 * Envia um trecho formatado para o Telegram com fallback gracioso para texto simples caso haja erro de Markdown
 */
export async function sendTelegramChunk(ctx: Context, chunk: string): Promise<void> {
  const formatted = formatMathForTelegram(chunk);
  try {
    await ctx.replyWithMarkdown(formatted);
  } catch {
    try {
      await ctx.reply(formatted);
    } catch {
      await ctx.reply(chunk);
    }
  }
}

/**
 * Inicializa a instância do bot Telegraf e registra os handlers de callback e comandos
 */
export function initTelegramBot(customToken?: string): Telegraf<Context> | null {
  const token = customToken || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return null;
  }

  if (telegramBot) {
    return telegramBot;
  }

  const bot = new Telegraf(token, {
    handlerTimeout: 900_000
  });

  // Define botInfo inicial para evitar chamada de rede getMe síncrona durante webhook ou testes
  bot.botInfo = {
    id: 0,
    is_bot: true,
    first_name: 'NumIA Approval Bot',
    username: 'numia_approval_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false
  };

  // Atualiza as informações do bot em background se estiver conectado
  bot.telegram.getMe().then((info) => {
    bot.botInfo = info;
  }).catch(() => {
    // Modo offline ou sem conectividade com Telegram no momento
  });

  // Middleware de autorização estrita: garante que apenas o proprietário autorizado possa interagir
  bot.use(async (ctx, next) => {
    const authorizedChatId = process.env.TELEGRAM_CHAT_ID;
    if (authorizedChatId && ctx.from && String(ctx.from.id) !== String(authorizedChatId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('⛔ Não autorizado. Você não tem permissão para aprovar ou negar ações neste bot.', { show_alert: true }).catch(() => undefined);
      } else {
        await ctx.reply('⛔ Acesso restrito. Este bot é privado e exclusivo para aprovações do proprietário do NumIA.').catch(() => undefined);
      }
      return;
    }
    return next();
  });

  // Comando /start: Apresentação do bot de aprovação
  bot.command('start', async (ctx) => {
    await ctx.replyWithMarkdown(
      '🤖 *NumIA - Bot de Aprovação de Ações Sensíveis (Estilo Muse)*\n\n' +
      'Este bot recebe notificações em tempo real sempre que o agente Gemini / Antigravity CLI ' +
      'solicitar ações que envolvem dados ou operações sensíveis (ex: emails, compras, pagamentos).\n\n' +
      'Use os botões inline para autorizar ou recusar as execuções com total segurança.'
    );
  });

  // Comando /status: Exibe status do bot e aprovações
  bot.command('status', async (ctx) => {
    const db = getOrCreateDatabase();
    const pendingCount = (db.prepare("SELECT count(*) as c FROM approvals WHERE status = 'pending'").get() as { c: number })?.c ?? 0;
    const totalCount = (db.prepare('SELECT count(*) as c FROM approvals').get() as { c: number })?.c ?? 0;
    const ttlHours = Number(process.env.TELEGRAM_SESSION_TTL_HOURS) || 2;
    await ctx.replyWithMarkdown(
      `📊 *Status do Sistema de Aprovação e Chat*\n\n` +
      `• *Aprovações Pendentes:* ${pendingCount}\n` +
      `• *Total Registrado:* ${totalCount}\n` +
      `• *Retenção Automática:* Expira e limpa arquivos após ${ttlHours}h de inatividade\n` +
      `• *Servidor:* Online (Oracle Cloud Always Free)`
    );
  });

  // Callback handler para aprovação: 'approve_<approvalId>'
  bot.action(/^approve_(.+)$/, async (ctx) => {
    const approvalId = ctx.match?.[1];
    if (!approvalId) {
      await ctx.answerCbQuery('ID de aprovação inválido.').catch(() => undefined);
      return;
    }
    const approval = getApproval(approvalId);

    if (!approval) {
      await ctx.answerCbQuery('Solicitação não encontrada.').catch(() => undefined);
      return;
    }

    if (approval.status !== 'pending') {
      await ctx.answerCbQuery(`Esta ação já foi processada (${approval.status}).`).catch(() => undefined);
      return;
    }

    // Atualiza status no SQLite para 'approved'
    updateApprovalStatus(approvalId, 'approved');
    await ctx.answerCbQuery('✅ Ação aprovada com sucesso!').catch(() => undefined);

    // Edita a mensagem no Telegram indicando a aprovação
    await ctx.editMessageText(
      [
        '✅ *Ação Aprovada*',
        '',
        `🆔 *ID da Aprovação:* \`${approval.id}\``,
        `⚡ *Ação:* \`${approval.action}\``,
        `👤 *Aprovado por:* ${ctx.from?.first_name || 'Usuário'}`,
        `🕒 *Horário:* ${new Date().toLocaleTimeString('pt-BR')}`,
        '',
        '⏳ *Status:* Retomando execução no Antigravity CLI...'
      ].join('\n'),
      { parse_mode: 'Markdown' }
    ).catch(() => undefined);

    // Dispara a retomada de execução em background
    void resumeApprovalExecution(approvalId).catch((err) => {
      console.error(`[Telegram] Erro ao retomar aprovação ${approvalId}:`, err);
    });
  });

  // Callback handler para negação: 'deny_<approvalId>'
  bot.action(/^deny_(.+)$/, async (ctx) => {
    const approvalId = ctx.match?.[1];
    if (!approvalId) {
      await ctx.answerCbQuery('ID de aprovação inválido.').catch(() => undefined);
      return;
    }
    const approval = getApproval(approvalId);

    if (!approval) {
      await ctx.answerCbQuery('Solicitação não encontrada.').catch(() => undefined);
      return;
    }

    if (approval.status !== 'pending') {
      await ctx.answerCbQuery(`Esta ação já foi processada (${approval.status}).`).catch(() => undefined);
      return;
    }

    // Atualiza status no SQLite para 'denied'
    updateApprovalStatus(approvalId, 'denied', 'Negado pelo usuário via Telegram.');
    await ctx.answerCbQuery('❌ Ação negada.').catch(() => undefined);

    // Edita a mensagem no Telegram indicando que foi negada
    await ctx.editMessageText(
      [
        '❌ *Ação Negada*',
        '',
        `🆔 *ID da Aprovação:* \`${approval.id}\``,
        `⚡ *Ação:* \`${approval.action}\``,
        `👤 *Negado por:* ${ctx.from?.first_name || 'Usuário'}`,
        `🕒 *Horário:* ${new Date().toLocaleTimeString('pt-BR')}`,
        '',
        '🚫 A execução desta ação foi cancelada com segurança.'
      ].join('\n'),
      { parse_mode: 'Markdown' }
    ).catch(() => undefined);
  });

  // Comandos de controle de conversa e ajuda
  bot.command(['reset', 'novo', 'limpar'], async (ctx) => {
    resetChatConversationId(ctx.chat.id);
    await ctx.reply('🧹 *Sessão anterior encerrada e arquivos temporários limpos do servidor!* Espaço liberado na VM.', { parse_mode: 'Markdown' })
      .catch(() => ctx.reply('🧹 Sessão anterior encerrada e arquivos temporários limpos do servidor! Espaço liberado na VM.'));
  });

  bot.command(['model', 'modelo'], async (ctx) => {
    const text = ctx.message.text?.trim() || '';
    const parts = text.split(/\s+/);
    const chosen = parts[1]?.toLowerCase();
    const chatId = ctx.chat.id;
    const session = getChatSession(chatId);

    const availableModels: Record<string, { id: string; label: string; desc: string }> = {
      turbo: {
        id: 'gemini-3.8-flash-low',
        label: '⚡ Flash Turbo (Low)',
        desc: 'Respostas ultra-rápidas em poucos segundos, ideal para conversas dinâmicas.'
      },
      low: {
        id: 'gemini-3.8-flash-low',
        label: '⚡ Flash Turbo (Low)',
        desc: 'Respostas ultra-rápidas em poucos segundos, ideal para conversas dinâmicas.'
      },
      flash: {
        id: 'gemini-3.8-flash-medium',
        label: '🚀 Flash Padrão (Medium)',
        desc: 'Equilíbrio ideal entre velocidade e raciocínio para resolver atividades.'
      },
      medium: {
        id: 'gemini-3.8-flash-medium',
        label: '🚀 Flash Padrão (Medium)',
        desc: 'Equilíbrio ideal entre velocidade e raciocínio para resolver atividades.'
      },
      pensar: {
        id: 'gemini-3.8-flash-high',
        label: '🧠 Flash Raciocínio (High)',
        desc: 'Pensamento analítico detalhado e aprofundado para problemas complexos.'
      },
      high: {
        id: 'gemini-3.8-flash-high',
        label: '🧠 Flash Raciocínio (High)',
        desc: 'Pensamento analítico detalhado e aprofundado para problemas complexos.'
      },
      pro: {
        id: 'gemini-3.1-pro-high',
        label: '💎 Gemini 3.1 Pro (High)',
        desc: 'Modelo mais avançado do Google para tarefas de máxima complexidade técnica.'
      }
    };

    if (!chosen || !availableModels[chosen]) {
      const currentModelId = session.model || process.env.TELEGRAM_MODEL || 'gemini-3.8-flash-medium';
      await ctx.replyWithMarkdown(
        `🤖 *Configuração de Velocidade e Modelo do Gemini*\n\n` +
        `• *Modelo Atual:* \`${currentModelId}\`\n\n` +
        `*Opções para troca rápida:*\n` +
        `• \`/model turbo\` — *Flash Turbo (Low)*: Ultra veloz, resposta imediata.\n` +
        `• \`/model flash\` — *Flash Padrão (Medium)*: Rápido e inteligente (Recomendado).\n` +
        `• \`/model pensar\` — *Flash Raciocínio (High)*: Pensamento estendido em profundidade.\n` +
        `• \`/model pro\` — *Gemini 3.1 Pro*: Alta precisão para tarefas complexas.\n\n` +
        `_Dica: Se quiser o máximo de velocidade, use \`/model flash\` ou \`/model turbo\`._`
      );
      return;
    }

    const selected = availableModels[chosen];
    setChatModel(chatId, selected.id);
    await ctx.replyWithMarkdown(
      `✅ *Modelo alterado com sucesso!*\n\n` +
      `• *Novo Modelo:* ${selected.label} (\`${selected.id}\`)\n` +
      `• *Descrição:* ${selected.desc}`
    );
  });

  bot.command(['help', 'ajuda'], async (ctx) => {
    const ttlHours = Number(process.env.TELEGRAM_SESSION_TTL_HOURS) || 2;
    await ctx.replyWithMarkdown(
      '🤖 *NumIA - Assistente Autônomo e Bot de Aprovação*\n\n' +
      '• *Conversar e Executar:* Envie qualquer mensagem ou dúvida (ex: "resolva essa lista de cálculo", "escreva um código em Python") e o agente Gemini CLI responderá diretamente.\n' +
      '• *Multimodal:* Envie fotos ou documentos de imagens (avulsas ou em álbuns de até 10 imagens) para resolução visual de exercícios e OCR.\n' +
      '• *Fórmulas Matemáticas:* Notação adaptada com caracteres Unicode limpos (ex: x², √x, r > d/2, L₁₁ ≈ 2,82 cm, AB = 10 cm).\n' +
      '• \`/model\`: Escolha a velocidade do Gemini (\`/model turbo\`, \`/model flash\`, \`/model pensar\`, \`/model pro\`).\n' +
      '• \`/status\`: Consulta status do servidor, modelo ativo e retenção de arquivos.\n' +
      `• *Limpeza Automática:* Inatividade maior que ${ttlHours}h limpa arquivos e inicia nova conversa.\n` +
      '• \`/reset\`: Limpa o contexto recente e os arquivos temporários imediatamente.'
    );
  });

  async function downloadTelegramFile(
    botInstance: Telegraf<Context>,
    fileId: string,
    mimeType = 'image/jpeg'
  ): Promise<TelegramImageAttachment | null> {
    try {
      const fileLink = await botInstance.telegram.getFileLink(fileId);
      const res = await fetch(fileLink.href);
      if (!res.ok) throw new Error(`Falha no download da imagem: HTTP ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
      const fileName = `telegram-${crypto.randomUUID().slice(0, 8)}${ext}`;
      return { buffer, fileName, mimeType };
    } catch (err) {
      console.warn('[Telegram] Falha ao baixar arquivo de imagem do Telegram:', (err as Error).message);
      return null;
    }
  }

  const activeChatTurns = new Set<string>();

  async function handleUserChatTurn(
    ctx: Context,
    prompt: string,
    images: TelegramImageAttachment[] = []
  ): Promise<void> {
    if (!registeredTelegramPromptHandler) {
      await ctx.reply('⚠️ O assistente Gemini CLI não está conectado para execução de mensagens no momento.').catch(() => undefined);
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const session = getChatSession(chatId);
    const conversationId = session.conversationId;

    if (activeChatTurns.has(conversationId)) {
      await ctx.reply('⏳ *Aguarde:* O Gemini já está processando sua mensagem anterior. Assim que concluir, envie sua próxima pergunta.', { parse_mode: 'Markdown' })
        .catch(() => ctx.reply('⏳ Aguarde: O Gemini já está processando sua mensagem anterior. Assim que concluir, envie sua próxima pergunta.'));
      return;
    }
    activeChatTurns.add(conversationId);

    if (session.isNewSession) {
      await ctx.reply('ℹ️ *Sessão anterior encerrada por inatividade. Arquivos anteriores apagados para poupar espaço no servidor.*', { parse_mode: 'Markdown' })
        .catch(() => undefined);
    }

    // Envia ação de digitação a cada 4s enquanto o modelo processa
    await ctx.sendChatAction('typing').catch(() => undefined);
    const typingTimer = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => undefined);
    }, 4000);

    try {
      const response = await registeredTelegramPromptHandler(prompt, conversationId, chatId, images, session.model);
      clearInterval(typingTimer);

      if (!response) {
        await ctx.reply('(Sem conteúdo de resposta)').catch(() => undefined);
        return;
      }

      const chunks = splitMessageChunks(response, 3900);
      for (const chunk of chunks) {
        await sendTelegramChunk(ctx, chunk);
      }
    } catch (error) {
      clearInterval(typingTimer);
      const errMsg = (error as Error).message || 'Erro ao processar mensagem.';
      await ctx.reply(`❌ Ocorreu um erro ao processar sua solicitação com o Gemini CLI:\n${errMsg}`).catch(() => undefined);
    } finally {
      clearInterval(typingTimer);
      activeChatTurns.delete(conversationId);
    }
  }

  // Buffer para agrupar álbuns de fotos (Media Groups com até 10 imagens)
  interface MediaGroupBatch {
    ctx: Context;
    items: Array<{ fileId: string; caption?: string; mimeType?: string }>;
    timer: NodeJS.Timeout;
  }
  const mediaGroups = new Map<string, MediaGroupBatch>();

  // Processamento de mensagens de texto regulares enviadas pelo usuário
  bot.on('text', async (ctx) => {
    const text = ctx.message.text?.trim();
    if (!text || text.startsWith('/')) {
      return;
    }
    await handleUserChatTurn(ctx, text, []);
  });

  // Processamento de fotos (individuais ou álbuns de até 10 imagens)
  bot.on('photo', async (ctx) => {
    const photoArray = ctx.message.photo;
    if (!photoArray || !photoArray.length) return;
    const largestPhoto = photoArray[photoArray.length - 1];
    if (!largestPhoto) return;
    const caption = ctx.message.caption?.trim() || '';
    const mediaGroupId = ctx.message.media_group_id;

    if (mediaGroupId) {
      let batch = mediaGroups.get(mediaGroupId);
      if (!batch) {
        batch = {
          ctx,
          items: [],
          timer: setTimeout(async () => {
            mediaGroups.delete(mediaGroupId);
            const collected = batch!.items;
            const finalCaption = collected.find((item) => item.caption)?.caption || 'Analise as imagens enviadas.';
            const downloadedImages: TelegramImageAttachment[] = [];
            for (const item of collected) {
              const img = await downloadTelegramFile(bot, item.fileId, item.mimeType || 'image/jpeg');
              if (img) downloadedImages.push(img);
            }
            await handleUserChatTurn(batch!.ctx, finalCaption, downloadedImages);
          }, 1200)
        };
        mediaGroups.set(mediaGroupId, batch);
      } else {
        clearTimeout(batch.timer);
        batch.timer = setTimeout(async () => {
          mediaGroups.delete(mediaGroupId);
          const collected = batch!.items;
          const finalCaption = collected.find((item) => item.caption)?.caption || 'Analise as imagens enviadas.';
          const downloadedImages: TelegramImageAttachment[] = [];
          for (const item of collected) {
            const img = await downloadTelegramFile(bot, item.fileId, item.mimeType || 'image/jpeg');
            if (img) downloadedImages.push(img);
          }
          await handleUserChatTurn(batch!.ctx, finalCaption, downloadedImages);
        }, 1200);
      }

      batch.items.push({ fileId: largestPhoto.file_id, caption, mimeType: 'image/jpeg' });
    } else {
      const downloaded = await downloadTelegramFile(bot, largestPhoto.file_id, 'image/jpeg');
      const images = downloaded ? [downloaded] : [];
      await handleUserChatTurn(ctx, caption || 'Analise a imagem enviada.', images);
    }
  });

  // Processamento de documentos de imagem
  bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    if (!doc) return;
    const mime = doc.mime_type || '';
    if (!mime.startsWith('image/')) {
      await ctx.reply('📄 Recebi seu documento. Para envio de arquivos no Telegram, utilize imagens (PNG, JPEG, WEBP, etc.).');
      return;
    }
    const caption = ctx.message.caption?.trim() || '';
    const downloaded = await downloadTelegramFile(bot, doc.file_id, mime);
    const images = downloaded ? [downloaded] : [];
    await handleUserChatTurn(ctx, caption || 'Analise a imagem enviada.', images);
  });

  telegramBot = bot;
  return telegramBot;
}

/**
 * Retorna o bot Telegraf inicializado ou nulo se não configurado
 */
export function getTelegramBot(): Telegraf<Context> | null {
  if (!telegramBot) {
    return initTelegramBot();
  }
  return telegramBot;
}

/**
 * Verifica se as variáveis de ambiente necessárias do Telegram estão configuradas
 */
export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/**
 * Envia uma solicitação de aprovação para o Telegram com botões inline [✅ Aprovar] e [❌ Negar].
 * Cria e salva o registro na tabela SQLite 'approvals'.
 *
 * @param conversationId Identificador da conversa
 * @param action Nome da ferramenta ou ação sensível (ex: 'send_email', 'purchase', etc.)
 * @param details Argumentos ou detalhes em formato JSON/texto da ação
 * @param contextData Dados de contexto originais necessários para a retomada (opcional)
 * @returns ID único da aprovação gerada
 */
export async function sendApproval(
  conversationId: string,
  action: string,
  details: string,
  contextData?: unknown
): Promise<string> {
  const db = getOrCreateDatabase();
  const id = `appr_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const now = new Date().toISOString();

  // Salva o registro inicial no SQLite com status 'pending'
  const record: ApprovalRecord = {
    id,
    conversationId,
    action,
    details,
    status: 'pending',
    created_at: now,
    context_data: contextData ? JSON.stringify(contextData) : null,
    result: null,
    updated_at: now
  };

  db.prepare(`
    INSERT INTO approvals (id, conversationId, action, details, status, created_at, context_data, result, updated_at)
    VALUES (@id, @conversationId, @action, @details, @status, @created_at, @context_data, @result, @updated_at)
  `).run(record);

  // Formata os detalhes para exibição legível na mensagem
  let formattedDetails = details;
  try {
    const parsed = typeof details === 'string' ? JSON.parse(details) : details;
    formattedDetails = JSON.stringify(parsed, null, 2);
  } catch {
    formattedDetails = String(details);
  }
  if (formattedDetails.length > 2000) {
    formattedDetails = formattedDetails.slice(0, 1997) + '...';
  }

  const bot = getTelegramBot();
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (bot && chatId) {
    try {
      const messageText = [
        '🛡️ *Solicitação de Aprovação Humana (Estilo Muse)*',
        '',
        `🆔 *ID da Aprovação:* \`${id}\``,
        `💬 *Conversa:* \`${conversationId}\``,
        `⚡ *Ação Sensível:* \`${action}\``,
        '',
        '📋 *Parâmetros da Solicitação:*',
        '```json',
        formattedDetails,
        '```',
        '',
        '⚠️ Esta ferramenta foi classificada como sensível. Você autoriza a sua execução pelo Antigravity CLI?'
      ].join('\n');

      const inlineKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Aprovar', `approve_${id}`),
          Markup.button.callback('❌ Negar', `deny_${id}`)
        ]
      ]);

      await bot.telegram.sendMessage(chatId, messageText, {
        parse_mode: 'Markdown',
        ...inlineKeyboard
      });
    } catch (telegramError) {
      console.warn('[Telegram] Não foi possível enviar mensagem ao chat:', (telegramError as Error).message);
    }
  } else {
    console.info(`[Telegram] Aprovação ${id} registrada no SQLite. (TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não definidos)`);
  }

  return id;
}

const processedUpdates = new Set<number>();

/**
 * Processa uma atualização de webhook recebida do Telegram
 */
export async function handleTelegramWebhook(update: unknown): Promise<{ ok: boolean; message?: string }> {
  const bot = getTelegramBot();
  if (!bot) {
    return { ok: false, message: 'TELEGRAM_BOT_TOKEN não configurado.' };
  }

  if (!update || typeof update !== 'object') {
    return { ok: false, message: 'Corpo da requisição de webhook inválido.' };
  }

  const updateObj = update as { update_id?: number };
  if (typeof updateObj.update_id === 'number') {
    if (processedUpdates.has(updateObj.update_id)) {
      return { ok: true };
    }
    processedUpdates.add(updateObj.update_id);
    if (processedUpdates.size > 2000) {
      const first = processedUpdates.values().next().value;
      if (first !== undefined) processedUpdates.delete(first);
    }
  }

  try {
    await bot.handleUpdate(update as any);
    return { ok: true };
  } catch (error) {
    console.error('[Telegram] Erro ao processar webhook update:', error);
    return { ok: false, message: (error as Error).message };
  }
}
