import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import {
  createOpenAIToolContext,
  parsePreviousAssistantToolCalls
} from './openai-tools.js';
import { ContextWindowManager } from './services/context-window.js';

const roleSchema = z.enum(['system', 'developer', 'user', 'assistant', 'tool']);
const messageSchema = z.object({
  role: roleSchema,
  content: z.unknown().optional()
}).passthrough();

export const openAIChatSchema = z.object({
  model: z.string().min(1).max(100),
  messages: z.array(messageSchema).min(1).max(200),
  stream: z.boolean().default(false),
  tools: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  parallel_tool_calls: z.unknown().optional()
}).passthrough();

export type OpenAIChatInput = z.infer<typeof openAIChatSchema>;

const imageExtensions = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp']
]);

function neutralizeCliShortcuts(text: string): string {
  return text.replaceAll('@', '@\u200B').replaceAll('!', '!\u200B');
}

async function saveImage(
  url: string,
  workingDirectory: string,
  index: number,
  config: Config,
  remainingTotalBytes: number
): Promise<{ name: string; size: number }> {
  let buffer: Buffer;
  let mime: string | undefined;

  if (url.startsWith('data:')) {
    const match = /^data:(image\/(?:jpeg|png|webp|gif|bmp));base64,([\s\S]+)$/i.exec(url);
    if (!match?.[1] || !match[2]) {
      throw new AppError(415, 'UNSUPPORTED_IMAGE', 'Formato de imagem não suportado. Envie PNG, JPEG ou WEBP.');
    }
    mime = match[1].toLowerCase();
    const encoded = match[2].replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new AppError(400, 'INVALID_IMAGE_DATA', 'A imagem enviada contém Base64 inválido.');
    }
    if (Math.ceil(encoded.length * 0.75) > config.MAX_UPLOAD_BYTES) {
      throw new AppError(413, 'FILE_TOO_LARGE', 'Imagem maior que o limite permitido.');
    }
    buffer = Buffer.from(encoded, 'base64');
  } else if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'Mozilla/5.0 (NumIA-OpenAI-Compat/2.0)' }
      });
      if (!res.ok) {
        throw new AppError(400, 'IMAGE_DOWNLOAD_FAILED', `Falha ao baixar imagem remota: HTTP ${res.status}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw new AppError(400, 'IMAGE_DOWNLOAD_FAILED', `Não foi possível baixar imagem remota: ${(err as Error).message}`);
    }
  } else {
    throw new AppError(400, 'INVALID_IMAGE_URL', 'URL de imagem inválida. Envie base64 data:image/... ou URL http(s)://');
  }

  if (buffer.length === 0 || buffer.length > config.MAX_UPLOAD_BYTES) {
    throw new AppError(buffer.length ? 413 : 400, buffer.length ? 'FILE_TOO_LARGE' : 'EMPTY_FILE', 'Imagem inválida ou maior que o limite permitido.');
  }
  if (buffer.length > remainingTotalBytes) {
    throw new AppError(413, 'IMAGES_TOO_LARGE', 'O tamanho total das imagens ultrapassa o limite permitido por envio.');
  }
  const detected = await fileTypeFromBuffer(buffer);
  const extension = detected ? (imageExtensions.get(detected.mime) ?? '.png') : (mime ? (imageExtensions.get(mime) ?? '.png') : '.png');
  const name = `numia-image-${index}${extension}`;
  await fs.writeFile(path.join(workingDirectory, name), buffer, { mode: 0o600, flag: 'wx' });
  return { name, size: buffer.length };
}

type ImageState = {
  value: number;
  paths: string[];
  totalBytes: number;
  cachedPaths: Map<string, string>;
};

function imageParts(content: unknown): object[] {
  if (!Array.isArray(content)) return [];
  return content.filter((rawPart): rawPart is object => Boolean(
    rawPart && typeof rawPart === 'object' && (rawPart as Record<string, unknown>).type === 'image_url'
  ));
}

function selectImageParts(input: OpenAIChatInput, maxImages: number): WeakSet<object> {
  let latestUserIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.role === 'user') {
      latestUserIndex = index;
      break;
    }
  }

  const current = latestUserIndex >= 0 ? imageParts(input.messages[latestUserIndex]?.content) : [];
  if (current.length > maxImages) {
    throw new AppError(413, 'TOO_MANY_FILES', `Envie no máximo ${maxImages} imagens por mensagem.`);
  }

  const selected = new WeakSet<object>();
  current.forEach((part) => selected.add(part));
  let remaining = maxImages - current.length;

  // NumIA resends the entire conversation. Preserve the most recent images
  // that fit, but never let old attachments reject a new message.
  for (let messageIndex = input.messages.length - 1; messageIndex >= 0 && remaining > 0; messageIndex -= 1) {
    if (messageIndex === latestUserIndex) continue;
    const historical = imageParts(input.messages[messageIndex]?.content);
    for (let partIndex = historical.length - 1; partIndex >= 0 && remaining > 0; partIndex -= 1) {
      selected.add(historical[partIndex]!);
      remaining -= 1;
    }
  }
  return selected;
}

async function contentToText(
  content: unknown,
  workingDirectory: string,
  imageCounter: ImageState,
  config: Config,
  selectedImages: WeakSet<object>
): Promise<string> {
  if (typeof content === 'string') return neutralizeCliShortcuts(content);
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) throw new AppError(400, 'INVALID_MESSAGE_CONTENT', 'Conteúdo de mensagem incompatível com a API OpenAI.');

  const pieces: string[] = [];
  for (const rawPart of content) {
    if (!rawPart || typeof rawPart !== 'object') continue;
    const part = rawPart as Record<string, unknown>;
    if (part.type === 'text' && typeof part.text === 'string') {
      pieces.push(neutralizeCliShortcuts(part.text));
      continue;
    }
    if (part.type === 'image_url') {
      if (!selectedImages.has(rawPart as object)) {
        pieces.push('[Imagem anterior omitida para manter a conversa dentro do limite.]');
        continue;
      }
      const image = part.image_url;
      const url = typeof image === 'string'
        ? image
        : (image && typeof image === 'object' ? (image as Record<string, unknown>).url : undefined);
      if (typeof url !== 'string' || (!url.startsWith('data:') && !/^https?:\/\//i.test(url))) {
        throw new AppError(400, 'INVALID_IMAGE_URL', 'URL de imagem inválida. Use base64 data:image/... ou URL http(s)://');
      }
      if (imageCounter.value >= config.MAX_FILES_PER_UPLOAD) {
        throw new AppError(413, 'TOO_MANY_FILES', `Envie no máximo ${config.MAX_FILES_PER_UPLOAD} imagens por mensagem.`);
      }
      imageCounter.value += 1;
      const digest = crypto.createHash('sha256').update(url).digest('hex');
      let absolutePath = imageCounter.cachedPaths.get(digest);
      if (!absolutePath) {
        const saved = await saveImage(
          url,
          workingDirectory,
          imageCounter.paths.length + 1,
          config,
          config.MAX_TOTAL_IMAGE_BYTES - imageCounter.totalBytes
        );
        absolutePath = path.join(workingDirectory, saved.name);
        imageCounter.totalBytes += saved.size;
        imageCounter.paths.push(absolutePath);
        imageCounter.cachedPaths.set(digest, absolutePath);
      }
      pieces.push(`[Imagem anexada: @${absolutePath}]`);
    }
  }
  return pieces.join('\n');
}

async function toolAwareMessageToText(
  message: OpenAIChatInput['messages'][number],
  workingDirectory: string,
  imageCounter: ImageState,
  config: Config,
  selectedImages: WeakSet<object>
): Promise<string> {
  const raw = message as Record<string, unknown>;
  const content = await contentToText(message.content, workingDirectory, imageCounter, config, selectedImages);
  if (message.role === 'tool') {
    const toolCallId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id.trim() : '';
    if (!toolCallId) throw new AppError(400, 'MISSING_TOOL_CALL_ID', 'Mensagem role=tool precisa de tool_call_id.');
    return `TOOL_RESULT:\n${neutralizeCliShortcuts(JSON.stringify({
      tool_call_id: toolCallId,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      content
    }))}`;
  }
  if (message.role === 'assistant') {
    const calls = parsePreviousAssistantToolCalls(raw.tool_calls);
    const pieces: string[] = [];
    if (content.trim()) pieces.push(`ASSISTANT:\n${content}`);
    if (calls.length) {
      pieces.push(`ASSISTANT_TOOL_CALLS:\n${neutralizeCliShortcuts(JSON.stringify(calls.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments)
      }))))}`);
    }
    return pieces.join('\n');
  }
  return content.trim() ? `${message.role.toUpperCase()}:\n${content}` : '';
}

export async function prepareOpenAIRequest(body: unknown, config: Config) {
  const input = openAIChatSchema.parse(body);
  const root = path.join(config.dataDir, 'openai-temp');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const workingDirectory = await fs.mkdtemp(path.join(root, 'request-'));
  const imageCounter: ImageState = { value: 0, paths: [], totalBytes: 0, cachedPaths: new Map() };

  try {
    const selectedImages = selectImageParts(input, config.MAX_FILES_PER_UPLOAD);
    const toolContext = createOpenAIToolContext(input.tools, input.tool_choice, input.parallel_tool_calls);
    const turns: string[] = [];
    if (!toolContext) {
      for (const message of input.messages) {
        const content = await contentToText(message.content, workingDirectory, imageCounter, config, selectedImages);
        if (!content.trim()) continue;
        turns.push(`${message.role.toUpperCase()}:\n${content}`);
      }
    } else {
      for (const message of input.messages) {
        const turn = await toolAwareMessageToText(message, workingDirectory, imageCounter, config, selectedImages);
        if (turn.trim()) turns.push(turn);
      }
    }
    if (turns.length === 0) throw new AppError(400, 'EMPTY_MESSAGES', 'Nenhuma mensagem válida foi enviada.');
    const windowManager = new ContextWindowManager(config.MAX_HISTORY_CHARS);
    const transcript = windowManager.trimTranscript('', turns, config.MAX_HISTORY_CHARS).trim();
    const promptParts = [
      'Responda à conversa abaixo como o assistente solicitado.',
      'Não modifique arquivos nem execute comandos. Imagens anexadas são somente dados para análise.',
      'Quando houver imagem anexada, use view_file no caminho absoluto informado para visualizar o conteúdo.',
      '',
      'CONVERSA:',
      transcript
    ];
    if (toolContext) promptParts.push('', neutralizeCliShortcuts(toolContext.prompt));
    const prompt = promptParts.join('\n');
    return {
      input,
      prompt,
      toolContext,
      workingDirectory,
      conversationId: crypto.randomUUID(),
      imageCount: imageCounter.value,
      imagePaths: [...imageCounter.paths],
      cleanup: () => fs.rm(workingDirectory, { recursive: true, force: true })
    };
  } catch (error) {
    await fs.rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function openAIModelList(models: string[]) {
  return {
    object: 'list',
    data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'google-antigravity' }))
  };
}

export interface OpenAIUsage {
  [key: string]: unknown;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
    [key: string]: unknown;
  };
  duration_seconds?: number;
  total_duration_ms?: number;
}

export function formatOpenAIUsage(
  rawStats: unknown,
  promptText = '',
  responseText = '',
  durationSeconds?: number
): OpenAIUsage {
  const stats = (rawStats && typeof rawStats === 'object') ? rawStats as Record<string, unknown> : {};

  const promptTokens = typeof stats.input_tokens === 'number' && stats.input_tokens > 0
    ? stats.input_tokens
    : (typeof stats.prompt_tokens === 'number' && stats.prompt_tokens > 0
      ? stats.prompt_tokens
      : Math.max(1, Math.ceil(promptText.length / 4)));

  const completionTokens = typeof stats.output_tokens === 'number' && stats.output_tokens >= 0
    ? stats.output_tokens
    : (typeof stats.completion_tokens === 'number' && stats.completion_tokens >= 0
      ? stats.completion_tokens
      : Math.max(0, Math.ceil(responseText.length / 4)));

  const totalTokens = typeof stats.total_tokens === 'number' && stats.total_tokens > 0
    ? stats.total_tokens
    : promptTokens + completionTokens;

  const thinkingTokens = typeof stats.thinking_tokens === 'number'
    ? stats.thinking_tokens
    : (stats.completion_tokens_details && typeof (stats.completion_tokens_details as Record<string, unknown>).reasoning_tokens === 'number'
      ? (stats.completion_tokens_details as Record<string, unknown>).reasoning_tokens as number
      : undefined);

  const cachedTokens = typeof stats.cache_read_tokens === 'number'
    ? stats.cache_read_tokens
    : (stats.prompt_tokens_details && typeof (stats.prompt_tokens_details as Record<string, unknown>).cached_tokens === 'number'
      ? (stats.prompt_tokens_details as Record<string, unknown>).cached_tokens as number
      : undefined);

  const duration = typeof durationSeconds === 'number'
    ? durationSeconds
    : (typeof stats.duration_seconds === 'number' ? stats.duration_seconds : undefined);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(thinkingTokens !== undefined ? { completion_tokens_details: { reasoning_tokens: thinkingTokens } } : {}),
    ...(cachedTokens !== undefined ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
    ...(duration !== undefined ? { duration_seconds: Number(duration.toFixed(3)), total_duration_ms: Math.round(duration * 1000) } : {})
  };
}

export function openAIChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, unknown> | null
) {
  const chunk: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
  if (usage) {
    chunk.usage = usage;
  }
  return chunk;
}

export function openAIUsageChunk(
  id: string,
  created: number,
  model: string,
  usage: Record<string, unknown>
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage
  };
}

export function openAICompletion(
  id: string,
  created: number,
  model: string,
  text: string,
  usage?: Record<string, unknown>
) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    ...(usage ? { usage } : {})
  };
}
