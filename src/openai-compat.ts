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
  ['image/webp', '.webp']
]);

function neutralizeCliShortcuts(text: string): string {
  return text.replaceAll('@', '@\u200B').replaceAll('!', '!\u200B');
}

async function saveDataImage(
  url: string,
  workingDirectory: string,
  index: number,
  config: Config
): Promise<string> {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/i.exec(url);
  if (!match?.[1] || !match[2]) {
    throw new AppError(415, 'UNSUPPORTED_IMAGE', 'O NumIA enviou uma imagem em formato não suportado.');
  }
  const mime = match[1].toLowerCase();
  const encoded = match[2].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new AppError(400, 'INVALID_IMAGE_DATA', 'A imagem enviada pelo NumIA contém Base64 inválido.');
  }
  if (Math.ceil(encoded.length * 0.75) > config.MAX_UPLOAD_BYTES) {
    throw new AppError(413, 'FILE_TOO_LARGE', 'Imagem maior que o limite permitido.');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 0 || buffer.length > config.MAX_UPLOAD_BYTES) {
    throw new AppError(buffer.length ? 413 : 400, buffer.length ? 'FILE_TOO_LARGE' : 'EMPTY_FILE', 'Imagem inválida ou maior que o limite permitido.');
  }
  const detected = await fileTypeFromBuffer(buffer);
  const extension = detected ? imageExtensions.get(detected.mime) : undefined;
  if (!extension || detected?.mime !== mime) {
    throw new AppError(415, 'INVALID_IMAGE_TYPE', 'O conteúdo da imagem não corresponde ao tipo informado.');
  }
  const name = `numia-image-${index}${extension}`;
  await fs.writeFile(path.join(workingDirectory, name), buffer, { mode: 0o600, flag: 'wx' });
  return name;
}

async function contentToText(
  content: unknown,
  workingDirectory: string,
  imageCounter: { value: number },
  config: Config
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
      if (imageCounter.value >= config.MAX_FILES_PER_UPLOAD) {
        throw new AppError(413, 'TOO_MANY_FILES', 'Quantidade de imagens maior que o limite permitido.');
      }
      const image = part.image_url;
      const url = image && typeof image === 'object' ? (image as Record<string, unknown>).url : undefined;
      if (typeof url !== 'string' || !url.startsWith('data:')) {
        throw new AppError(400, 'REMOTE_IMAGE_NOT_ALLOWED', 'Use imagens locais no NumIA; URLs remotas não são aceitas pelo servidor.');
      }
      imageCounter.value += 1;
      const name = await saveDataImage(url, workingDirectory, imageCounter.value, config);
      const absolutePath = path.join(workingDirectory, name);
      pieces.push(`[Imagem anexada: @${absolutePath}]`);
    }
  }
  return pieces.join('\n');
}

async function toolAwareMessageToText(
  message: OpenAIChatInput['messages'][number],
  workingDirectory: string,
  imageCounter: { value: number },
  config: Config
): Promise<string> {
  const raw = message as Record<string, unknown>;
  const content = await contentToText(message.content, workingDirectory, imageCounter, config);
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
  const imageCounter = { value: 0 };

  try {
    const toolContext = createOpenAIToolContext(input.tools, input.tool_choice, input.parallel_tool_calls);
    const turns: string[] = [];
    if (!toolContext) {
      for (const message of input.messages) {
        const content = await contentToText(message.content, workingDirectory, imageCounter, config);
        if (!content.trim()) continue;
        turns.push(`${message.role.toUpperCase()}:\n${content}`);
      }
    } else {
      for (const message of input.messages) {
        const turn = await toolAwareMessageToText(message, workingDirectory, imageCounter, config);
        if (turn.trim()) turns.push(turn);
      }
    }
    if (turns.length === 0) throw new AppError(400, 'EMPTY_MESSAGES', 'Nenhuma mensagem válida foi enviada.');
    let transcript = turns.join('\n\n');
    if (transcript.length > config.MAX_HISTORY_CHARS) transcript = transcript.slice(-config.MAX_HISTORY_CHARS);
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

export function openAIChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

export function openAICompletion(id: string, created: number, model: string, text: string) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
  };
}
