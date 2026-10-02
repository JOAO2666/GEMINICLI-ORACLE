import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, searchWeb, fetchWebContent } from '../src/services/web-search.js';

describe('Web Search & Browsing Service', () => {
  it('converts HTML into clean Markdown without tags or script blocks', () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Notícias Tecnológicas</title>
          <script>console.log("script block");</script>
          <style>body { color: red; }</style>
        </head>
        <body>
          <nav><a href="/menu">Menu</a></nav>
          <h1>Título Principal</h1>
          <p>Este é um parágrafo com um <a href="https://example.com/link">link importante</a>.</p>
          <ul>
            <li>Item 1</li>
            <li>Item 2</li>
          </ul>
          <footer>Rodapé com direitos autorais</footer>
        </body>
      </html>
    `;

    const parsed = htmlToMarkdown(sampleHtml);
    expect(parsed.title).toBe('Notícias Tecnológicas');
    expect(parsed.text).toContain('# Título Principal');
    expect(parsed.text).toContain('[link importante](https://example.com/link)');
    expect(parsed.text).toContain('* Item 1');
    expect(parsed.text).toContain('* Item 2');
    expect(parsed.text).not.toContain('script block');
    expect(parsed.text).not.toContain('color: red');
    expect(parsed.text).not.toContain('Rodapé com direitos autorais');
  });

  it('rejects invalid or non-http URLs in fetchWebContent', async () => {
    await expect(fetchWebContent('ftp://example.com')).rejects.toThrow('Somente URLs http:// ou https:// são permitidas');
    await expect(fetchWebContent('invalid-url')).rejects.toThrow('URL inválida');
  });

  it('rejects empty queries in searchWeb', async () => {
    await expect(searchWeb('   ')).rejects.toThrow('Termo de pesquisa vazio');
  });
});
