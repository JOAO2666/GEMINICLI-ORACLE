import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectMimeType,
  signArtifactUrl,
  validateArtifactFile,
  verifyArtifactUrl
} from '../src/services/artifact-service.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('Artifact Service', () => {
  it('detects correct MIME types for documents', () => {
    expect(detectMimeType('relatorio.pdf')).toBe('application/pdf');
    expect(detectMimeType('documento.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(detectMimeType('tabela.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(detectMimeType('slides.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(detectMimeType('cartoes.apkg')).toBe('application/vnd.anki');
    expect(detectMimeType('dados.json')).toBe('application/json; charset=utf-8');
  });

  it('validates authentic PDF files and rejects corrupt ones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
    dirs.push(dir);

    const validPdfPath = path.join(dir, 'valid.pdf');
    fs.writeFileSync(validPdfPath, '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page >>\nendobj\nxref\n0 4\ntrailer\n<< /Root 1 0 R >>\nstartxref\n180\n%%EOF');

    const resultValid = await validateArtifactFile(validPdfPath, 'valid.pdf');
    expect(resultValid.valid).toBe(true);
    expect(resultValid.mimeType).toBe('application/pdf');
    expect(resultValid.sha256).toBeDefined();
    expect(resultValid.pageCount).toBe(1);

    const corruptPdfPath = path.join(dir, 'corrupt.pdf');
    fs.writeFileSync(corruptPdfPath, 'not a real pdf content');
    const resultCorrupt = await validateArtifactFile(corruptPdfPath, 'corrupt.pdf');
    expect(resultCorrupt.valid).toBe(false);
    expect(resultCorrupt.error).toContain('%PDF-');

    const emptyPdfPath = path.join(dir, 'empty.pdf');
    fs.writeFileSync(emptyPdfPath, '');
    const resultEmpty = await validateArtifactFile(emptyPdfPath, 'empty.pdf');
    expect(resultEmpty.valid).toBe(false);
    expect(resultEmpty.error).toContain('vazio');
  });

  it('signs artifact URLs and verifies them securely with expiration', () => {
    const secretKey = 'super-secret-key-12345';
    const baseUrl = 'https://api.example.com';
    const workspaceId = 'c6fa3e87-a065-4f4f-b472-35a4d048dc71';
    const artifactId = '2a37f597-e85d-4f39-8669-026da685514f';
    const filename = 'relatorio.pdf';

    const signed = signArtifactUrl({
      baseUrl,
      workspaceId,
      artifactId,
      filename,
      secretKey,
      ttlSeconds: 3600
    });

    expect(signed.url).toContain(`${baseUrl}/artifacts/${workspaceId}/${artifactId}/${filename}`);
    expect(signed.url).toContain('expires=');
    expect(signed.url).toContain('sig=');

    const parsedUrl = new URL(signed.url);
    const expires = parsedUrl.searchParams.get('expires')!;
    const sig = parsedUrl.searchParams.get('sig')!;

    // Valid verification
    const verified = verifyArtifactUrl({
      workspaceId,
      artifactId,
      filename,
      expires,
      sig,
      secretKey
    });
    expect(verified.valid).toBe(true);

    // Tampered filename
    const tampered = verifyArtifactUrl({
      workspaceId,
      artifactId,
      filename: 'outro.pdf',
      expires,
      sig,
      secretKey
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.reason).toBe('INVALID_SIGNATURE');

    // Expired
    const expired = verifyArtifactUrl({
      workspaceId,
      artifactId,
      filename,
      expires: Date.now() - 1000,
      sig,
      secretKey
    });
    expect(expired.valid).toBe(false);
    expect(expired.reason).toBe('EXPIRED');
  });
});
