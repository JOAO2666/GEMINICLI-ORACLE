import { execFile } from 'node:child_process';
import { AppError } from '../errors.js';

export type OcrRunner = (imagePath: string, timeoutMs: number) => Promise<string>;

export function requiresLocalImageOcr(model: string): boolean {
  return /^gpt-oss(?:-|$)/i.test(model);
}

const runTesseract: OcrRunner = (imagePath, timeoutMs) => new Promise((resolve, reject) => {
  execFile(
    'tesseract',
    [imagePath, 'stdout', '-l', 'por+eng', '--psm', '6'],
    { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(stdout)
  );
});

export async function addLocalImageOcr(
  prompt: string,
  model: string,
  imagePaths: string[],
  timeoutMs: number,
  runner: OcrRunner = runTesseract
): Promise<string> {
  if (!requiresLocalImageOcr(model) || imagePaths.length === 0) return prompt;

  const extracted: string[] = [];
  try {
    for (const [index, imagePath] of imagePaths.entries()) {
      const text = (await runner(imagePath, timeoutMs)).trim();
      if (text) extracted.push(`[Imagem ${index + 1}]\n${text}`);
    }
  } catch {
    throw new AppError(
      422,
      'IMAGE_OCR_FAILED',
      'O modelo selecionado não possui visão nativa e o OCR local não conseguiu ler a imagem.'
    );
  }

  if (extracted.length === 0) {
    throw new AppError(
      422,
      'IMAGE_OCR_EMPTY',
      'O modelo selecionado não possui visão nativa e o OCR local não encontrou texto legível na imagem.'
    );
  }

  return [
    prompt,
    '',
    'TEXTO EXTRAÍDO LOCALMENTE DAS IMAGENS:',
    'Use este texto como conteúdo das imagens. Ele pode conter pequenos erros de OCR.',
    extracted.join('\n\n')
  ].join('\n');
}
