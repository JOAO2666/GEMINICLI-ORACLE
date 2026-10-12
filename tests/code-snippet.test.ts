import { describe, expect, it } from 'vitest';
import { generateCodeSnippetImage } from '../src/services/code-snippet.js';

describe('generateCodeSnippetImage', () => {
  it('renders a stylized code snippet image from ray.so', async () => {
    const result = await generateCodeSnippetImage({
      code: 'def hello_world():\n    print("Hello from NumIA MCP!")',
      language: 'python',
      title: 'main.py',
      theme: 'candy',
      darkMode: true,
      spacing: '32',
      background: true
    });

    expect(result).toBeDefined();
    expect(result.mimeType).toBe('image/png');
    expect(typeof result.data).toBe('string');
    expect(result.data.length).toBeGreaterThan(1000);
    expect(result.message).toContain('Snippet de código gerado com sucesso via ray.so');
  }, 45_000);
});
