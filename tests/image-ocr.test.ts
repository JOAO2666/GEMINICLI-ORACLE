import { describe, expect, it, vi } from 'vitest';
import { addLocalImageOcr, requiresLocalImageOcr } from '../src/services/image-ocr.js';

describe('image OCR fallback', () => {
  it('applies only to GPT-OSS models', () => {
    expect(requiresLocalImageOcr('gpt-oss-120b-medium')).toBe(true);
    expect(requiresLocalImageOcr('gemini-3.1-pro-high')).toBe(false);
    expect(requiresLocalImageOcr('claude-sonnet-4-6')).toBe(false);
  });

  it('keeps native multimodal prompts unchanged', async () => {
    const runner = vi.fn();
    await expect(addLocalImageOcr('prompt', 'gemini-3.1-pro-high', ['photo.jpg'], 1000, runner))
      .resolves.toBe('prompt');
    expect(runner).not.toHaveBeenCalled();
  });

  it('adds locally extracted text while preserving the selected GPT-OSS model', async () => {
    const runner = vi.fn().mockResolvedValue('19:46');
    const prompt = await addLocalImageOcr('pergunta', 'gpt-oss-120b-medium', ['photo.jpg'], 1000, runner);
    expect(prompt).toContain('TEXTO EXTRAÍDO LOCALMENTE');
    expect(prompt).toContain('[Imagem 1]\n19:46');
  });

  it('fails clearly when no text can be extracted', async () => {
    await expect(addLocalImageOcr('prompt', 'gpt-oss-120b-medium', ['photo.jpg'], 1000, async () => ''))
      .rejects.toMatchObject({ statusCode: 422, code: 'IMAGE_OCR_EMPTY' });
  });
});
