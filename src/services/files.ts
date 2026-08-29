import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import type { MultipartFile } from '@fastify/multipart';
import type { Config } from '../config.js';
import type { AppDatabase, AttachmentRow } from '../database.js';
import { AppError } from '../errors.js';

const binaryMime = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['application/pdf', '.pdf']
]);
const textExtensions = new Set([
  '.txt', '.md', '.markdown', '.json', '.xml', '.yaml', '.yml', '.csv', '.log',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.java', '.kt', '.kts', '.py',
  '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.swift', '.sql',
  '.html', '.css', '.scss', '.sh', '.ps1', '.toml', '.ini', '.gradle'
]);

function cleanOriginalName(input: string): string {
  return path.basename(input).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180) || 'arquivo';
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class FileService {
  private readonly conversationsRoot: string;

  constructor(private readonly config: Config, private readonly db: AppDatabase) {
    this.conversationsRoot = path.join(config.dataDir, 'conversations');
  }

  conversationDirectory(conversationId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new AppError(400, 'INVALID_CONVERSATION_ID', 'ID de conversa inválido.');
    const directory = path.resolve(this.conversationsRoot, conversationId, 'files');
    if (!within(this.conversationsRoot, directory)) throw new AppError(400, 'INVALID_PATH', 'Caminho inválido.');
    return directory;
  }

  async save(part: MultipartFile, conversationId: string): Promise<Omit<AttachmentRow, 'stored_path'> & { storedName: string }> {
    this.db.getConversation(conversationId);
    const buffer = await part.toBuffer();
    if (buffer.length === 0) throw new AppError(400, 'EMPTY_FILE', 'Arquivo vazio.');
    if (buffer.length > this.config.MAX_UPLOAD_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'Arquivo maior que o limite permitido.');

    const originalName = cleanOriginalName(part.filename);
    const originalExt = path.extname(originalName).toLowerCase();
    const detected = await fileTypeFromBuffer(buffer);
    let extension: string;
    let mimeType: string;
    if (detected) {
      extension = binaryMime.get(detected.mime) ?? '';
      if (!extension) throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Tipo de arquivo binário não permitido.');
      mimeType = detected.mime;
    } else {
      if (!textExtensions.has(originalExt)) throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Extensão de arquivo não permitida.');
      if (buffer.includes(0)) throw new AppError(415, 'INVALID_TEXT_FILE', 'O arquivo informado como texto contém dados binários.');
      extension = originalExt;
      mimeType = part.mimetype.startsWith('text/') ? part.mimetype : 'text/plain';
    }

    const directory = this.conversationDirectory(conversationId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const storedName = `${randomUUID()}${extension}`;
    const storedPath = path.join(directory, storedName);
    try {
      await fs.writeFile(storedPath, buffer, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
        throw new AppError(507, 'INSUFFICIENT_STORAGE', 'O servidor está sem espaço para receber o arquivo.');
      }
      throw error;
    }
    const row = this.db.addAttachment({
      conversation_id: conversationId,
      original_name: originalName,
      stored_path: storedPath,
      mime_type: mimeType,
      size: buffer.length
    });
    const { stored_path: _hidden, ...safe } = row;
    return { ...safe, storedName };
  }

  async deleteConversationFiles(conversationId: string): Promise<void> {
    const directory = path.resolve(this.conversationsRoot, conversationId);
    if (!within(this.conversationsRoot, directory)) throw new AppError(400, 'INVALID_PATH', 'Caminho inválido.');
    await fs.rm(directory, { recursive: true, force: true });
  }

  async cleanupExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.FILE_RETENTION_HOURS * 3_600_000).toISOString();
    const expired = this.db.expiredAttachments(cutoff);
    for (const item of expired) {
      await fs.rm(item.stored_path, { force: true }).catch(() => undefined);
      this.db.deleteAttachment(item.id);
    }
    return expired.length;
  }
}
