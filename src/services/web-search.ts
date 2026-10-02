import { AppError } from '../errors.js';

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResult {
  query: string;
  count: number;
  results: SearchResultItem[];
}

export interface FetchResult {
  url: string;
  status: number;
  title: string;
  contentType: string;
  contentLength: number;
  text: string;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'");
}

export function htmlToMarkdown(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch && titleMatch[1]) ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim() : '';

  let text = html;
  // Remove non-content elements
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');

  // Convert headings
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    const headingText = decodeHtmlEntities(content.replace(/<[^>]+>/g, '')).trim();
    return headingText ? `\n\n${'#'.repeat(Number(level))} ${headingText}\n\n` : '';
  });

  // Convert links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    const linkText = decodeHtmlEntities(content.replace(/<[^>]+>/g, '')).trim();
    if (!linkText || href.startsWith('#') || href.startsWith('javascript:')) return linkText;
    return `[${linkText}](${href})`;
  });

  // Convert lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => {
    const itemText = decodeHtmlEntities(content.replace(/<[^>]+>/g, '')).trim();
    return itemText ? `\n* ${itemText}` : '';
  });

  // Convert breaks and block elements
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');
  text = text.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n');

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode entities
  text = decodeHtmlEntities(text);

  // Normalize spaces and empty lines
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');

  return { title, text: text.trim() };
}

export async function searchWeb(query: string, limit = 8): Promise<SearchResult> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    throw new AppError(400, 'INVALID_QUERY', 'Termo de pesquisa vazio.');
  }

  const maxResults = Math.min(Math.max(1, limit), 20);
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // Primary: DuckDuckGo HTML
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      signal: AbortSignal.timeout(12_000)
    });

    if (res.ok) {
      const html = await res.text();
      const results: SearchResultItem[] = [];

      const titleRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

      const titles: Array<{ url: string; title: string }> = [];
      let m: RegExpExecArray | null;

      while ((m = titleRegex.exec(html)) !== null) {
        let directUrl = m[1] ?? '';
        if (directUrl.includes('uddg=')) {
          const matchUddg = directUrl.match(/uddg=([^&]+)/);
          if (matchUddg && matchUddg[1]) {
            try {
              directUrl = decodeURIComponent(matchUddg[1]);
            } catch {
              // keep fallback
            }
          }
        }
        const cleanTitle = decodeHtmlEntities((m[2] ?? '').replace(/<[^>]+>/g, '')).trim();
        titles.push({ url: directUrl, title: cleanTitle });
      }

      const snippets: string[] = [];
      while ((m = snippetRegex.exec(html)) !== null) {
        const cleanSnippet = decodeHtmlEntities((m[2] ?? '').replace(/<[^>]+>/g, '')).trim();
        snippets.push(cleanSnippet);
      }

      for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
        const item = titles[i];
        if (!item || !item.url) continue;
        results.push({
          title: item.title,
          url: item.url,
          snippet: snippets[i] || ''
        });
      }

      if (results.length > 0) {
        return { query: cleanQuery, count: results.length, results };
      }
    }
  } catch {
    // Attempt fallback
  }

  // Fallback: DuckDuckGo Lite
  try {
    const liteUrl = 'https://lite.duckduckgo.com/lite/';
    const liteRes = await fetch(liteUrl, {
      method: 'POST',
      headers: {
        'User-Agent': userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html'
      },
      body: `q=${encodeURIComponent(cleanQuery)}`,
      signal: AbortSignal.timeout(10_000)
    });

    if (liteRes.ok) {
      const html = await liteRes.text();
      const results: SearchResultItem[] = [];
      const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

      const links: Array<{ url: string; title: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = linkRegex.exec(html)) !== null) {
        let cleanUrl = m[1] ?? '';
        if (cleanUrl.includes('uddg=')) {
          const matchUddg = cleanUrl.match(/uddg=([^&]+)/);
          if (matchUddg && matchUddg[1]) {
            try {
              cleanUrl = decodeURIComponent(matchUddg[1]);
            } catch {
              // ignore
            }
          }
        }
        links.push({ url: cleanUrl, title: decodeHtmlEntities((m[2] ?? '').replace(/<[^>]+>/g, '')).trim() });
      }

      const snippets: string[] = [];
      while ((m = snippetRegex.exec(html)) !== null) {
        snippets.push(decodeHtmlEntities((m[1] ?? '').replace(/<[^>]+>/g, '')).trim());
      }

      for (let i = 0; i < Math.min(links.length, maxResults); i++) {
        const item = links[i];
        if (!item || !item.url) continue;
        results.push({
          title: item.title,
          url: item.url,
          snippet: snippets[i] || ''
        });
      }

      if (results.length > 0) {
        return { query: cleanQuery, count: results.length, results };
      }
    }
  } catch {
    // ignore
  }

  return { query: cleanQuery, count: 0, results: [] };
}

export async function fetchWebContent(targetUrl: string, maxLength = 30_000): Promise<FetchResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new AppError(400, 'INVALID_URL', 'URL inválida.');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new AppError(400, 'INVALID_PROTOCOL', 'Somente URLs http:// ou https:// são permitidas.');
  }

  const effectiveMax = Math.min(Math.max(500, maxLength), 100_000);
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const res = await fetch(parsedUrl.toString(), {
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.8'
    },
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow'
  });

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const rawBody = await res.text();

  let title = parsedUrl.hostname;
  let text = '';

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(rawBody);
      text = JSON.stringify(parsed, null, 2);
    } catch {
      text = rawBody;
    }
  } else if (contentType.includes('text/html') || rawBody.includes('<html') || rawBody.includes('<body')) {
    const parsed = htmlToMarkdown(rawBody);
    title = parsed.title || title;
    text = parsed.text;
  } else {
    text = rawBody.trim();
  }

  if (text.length > effectiveMax) {
    // Clean truncate at whitespace
    const cut = text.lastIndexOf(' ', effectiveMax);
    text = (cut > effectiveMax * 0.8 ? text.slice(0, cut) : text.slice(0, effectiveMax)) + '\n\n... [conteúdo truncado]';
  }

  return {
    url: res.url || parsedUrl.toString(),
    status: res.status,
    title,
    contentType,
    contentLength: text.length,
    text
  };
}
