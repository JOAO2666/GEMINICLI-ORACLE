import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ArtifactValidationResult {
  valid: boolean;
  mimeType: string;
  size: number;
  sha256: string;
  error?: string;
  pageCount?: number;
}

const MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apkg': 'application/vnd.anki',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.py': 'text/x-python; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.zip': 'application/zip',
  '.xml': 'application/xml; charset=utf-8',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip'
};

export function detectMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

function hasZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (
    (buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[2] === 0x07 && buffer[3] === 0x08)
  );
}

export async function validateArtifactFile(filePath: string, filename: string): Promise<ArtifactValidationResult> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { valid: false, mimeType: 'application/octet-stream', size: 0, sha256: '', error: 'Arquivo não encontrado' };
  }
  if (stat.size === 0) {
    return { valid: false, mimeType: 'application/octet-stream', size: 0, sha256: '', error: 'Arquivo vazio (0 bytes)' };
  }

  const content = await fs.readFile(filePath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const ext = path.extname(filename).toLowerCase();
  const mimeType = detectMimeType(filename);

  if (ext === '.pdf') {
    // Check PDF header
    if (!content.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      return { valid: false, mimeType, size: stat.size, sha256: hash, error: 'Assinatura %PDF- não encontrada' };
    }
    // Check EOF marker
    if (!content.subarray(Math.max(0, content.length - 2048)).includes(Buffer.from('%%EOF'))) {
      return { valid: false, mimeType, size: stat.size, sha256: hash, error: 'Marcador de fim de arquivo %%EOF não encontrado no PDF' };
    }
    // Count pages
    const textContent = content.toString('binary');
    const pageMatches = textContent.match(/\/Type\s*\/Page[^s]/g) || [];
    const countMatch = textContent.match(/\/Count\s+(\d+)/);
    const estimatedPages = countMatch ? parseInt(countMatch[1]!, 10) : pageMatches.length;

    return {
      valid: true,
      mimeType,
      size: stat.size,
      sha256: hash,
      pageCount: Math.max(1, estimatedPages)
    };
  }

  if (['.docx', '.xlsx', '.pptx', '.apkg'].includes(ext)) {
    if (!hasZipMagic(content)) {
      return { valid: false, mimeType, size: stat.size, sha256: hash, error: `Assinatura de contêiner ZIP inválida para arquivo ${ext}` };
    }
    const binary = content.toString('binary');
    if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
      if (!binary.includes('[Content_Types].xml') && !binary.includes('word/') && !binary.includes('xl/') && !binary.includes('ppt/')) {
        return { valid: false, mimeType, size: stat.size, sha256: hash, error: `Estrutura interna inválida para documento Office (${ext})` };
      }
    } else if (ext === '.apkg') {
      if (!binary.includes('collection.anki2') && !binary.includes('collection.anki21') && !binary.includes('media')) {
        return { valid: false, mimeType, size: stat.size, sha256: hash, error: 'Estrutura interna inválida para pacote Anki (.apkg)' };
      }
    }
  }

  return {
    valid: true,
    mimeType,
    size: stat.size,
    sha256: hash
  };
}

export function signArtifactUrl(options: {
  baseUrl: string;
  workspaceId: string;
  artifactId: string;
  filename: string;
  secretKey: string;
  ttlSeconds?: number;
}): { url: string; expiresAt: string; signature: string } {
  const ttl = options.ttlSeconds ?? 86400 * 3; // 3 days default
  const expiresAtMs = Date.now() + ttl * 1000;
  const payload = `${options.workspaceId}:${options.artifactId}:${options.filename}:${expiresAtMs}`;
  const signature = crypto.createHmac('sha256', options.secretKey).update(payload).digest('hex');

  const base = options.baseUrl.trim().replace(/\/$/, '');
  const url = `${base}/artifacts/${options.workspaceId}/${options.artifactId}/${encodeURIComponent(options.filename)}?expires=${expiresAtMs}&sig=${signature}`;

  return {
    url,
    expiresAt: new Date(expiresAtMs).toISOString(),
    signature
  };
}

export function verifyArtifactUrl(options: {
  workspaceId: string;
  artifactId: string;
  filename: string;
  expires: string | number;
  sig: string;
  secretKey: string;
}): { valid: boolean; reason?: 'EXPIRED' | 'INVALID_SIGNATURE' | 'MALFORMED' } {
  const expiresMs = typeof options.expires === 'number' ? options.expires : parseInt(options.expires, 10);
  if (isNaN(expiresMs)) return { valid: false, reason: 'MALFORMED' };
  if (Date.now() > expiresMs) return { valid: false, reason: 'EXPIRED' };

  const payload = `${options.workspaceId}:${options.artifactId}:${options.filename}:${expiresMs}`;
  const expected = crypto.createHmac('sha256', options.secretKey).update(payload).digest('hex');

  const actualBuf = Buffer.from(options.sig);
  const expectedBuf = Buffer.from(expected);

  if (actualBuf.length !== expectedBuf.length) {
    return { valid: false, reason: 'INVALID_SIGNATURE' };
  }

  if (!crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    return { valid: false, reason: 'INVALID_SIGNATURE' };
  }

  return { valid: true };
}
