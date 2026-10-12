import fs from 'node:fs';
import puppeteer, { type Browser } from 'puppeteer';

export interface GenerateCodeSnippetOptions {
  code: string;
  language?: string;
  title?: string;
  theme?: 'candy' | 'breeze' | 'crimson' | 'falcon' | 'meadow' | 'midnight' | 'raindrop' | 'sunset' | string;
  darkMode?: boolean;
  spacing?: '16' | '32' | '64' | '128' | number | string;
  background?: boolean;
}

export interface GeneratedSnippetResult {
  data: string;
  mimeType: 'image/png';
  message: string;
}

export async function generateCodeSnippetImage(
  options: GenerateCodeSnippetOptions
): Promise<GeneratedSnippetResult> {
  const {
    code,
    language = 'auto',
    title = '',
    theme = 'candy',
    darkMode = true,
    spacing = '32',
    background = true
  } = options;

  const codeBase64 = Buffer.from(code, 'utf-8').toString('base64');
  const params = new URLSearchParams({
    title,
    theme,
    spacing: String(spacing),
    background: String(background),
    darkMode: String(darkMode),
    language,
    code: codeBase64
  });

  const url = `https://ray.so/?${params.toString()}`;

  // Prioriza binário de sistema caso esteja em ambiente Linux/Docker
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    (process.platform === 'linux' && fs.existsSync('/usr/bin/chromium')
      ? '/usr/bin/chromium'
      : undefined);

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

    try {
      await page.goto(url, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 25000 });
    } catch {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    }

    await page.waitForSelector('#frame', { timeout: 15000 });

    try {
      await page.evaluate(() => document.fonts?.ready);
    } catch {
      // Ignora se document.fonts não estiver disponível
    }

    await new Promise((resolve) => setTimeout(resolve, 800));

    const frameElement = await page.$('#frame');
    if (!frameElement) {
      throw new Error('Elemento #frame do snippet não foi encontrado na página do ray.so.');
    }

    const screenshotBuffer = await frameElement.screenshot({ type: 'png' });
    const base64Data = Buffer.from(screenshotBuffer).toString('base64');

    return {
      data: base64Data,
      mimeType: 'image/png',
      message: `Snippet de código gerado com sucesso via ray.so (${title ? `título: "${title}", ` : ''}tema: ${theme}, linguagem: ${language}).`
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
