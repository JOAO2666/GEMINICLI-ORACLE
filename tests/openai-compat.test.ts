import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openAIChunk, openAIModelList, prepareOpenAIRequest } from '../src/openai-compat.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('OpenAI compatibility', () => {
  it('builds a safe prompt from NumIA messages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-openai-'));
    dirs.push(dir);
    const config = loadConfig({
      NODE_ENV: 'test', NUMIA_SERVER_TOKEN: 'a'.repeat(64), DATA_DIR: dir,
      ALLOWED_MODELS: 'gemini-3.7-flash-low', DEFAULT_MODEL: 'gemini-3.7-flash-low'
    });
    const prepared = await prepareOpenAIRequest({
      model: 'gemini-3.7-flash-low', stream: true,
      messages: [{ role: 'user', content: 'Responda OK @arquivo !comando' }]
    }, config);
    expect(prepared.prompt).toContain('USER:\nResponda OK @\u200Barquivo !\u200Bcomando');
    await prepared.cleanup();
  });

  it('returns OpenAI-shaped models and stream chunks', () => {
    expect(openAIModelList(['modelo']).data[0]).toMatchObject({ id: 'modelo', object: 'model' });
    expect(openAIChunk('id', 1, 'modelo', { content: 'OK' }).choices[0]).toMatchObject({
      delta: { content: 'OK' }, finish_reason: null
    });
  });
});
