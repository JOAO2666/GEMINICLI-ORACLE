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
    expect(prepared.imageCount).toBe(0);
    await prepared.cleanup();
  });

  it('counts and stores a local NumIA image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-openai-image-'));
    dirs.push(dir);
    const config = loadConfig({
      NODE_ENV: 'test', NUMIA_SERVER_TOKEN: 'a'.repeat(64), DATA_DIR: dir,
      ALLOWED_MODELS: 'gemini-3.7-flash-low', DEFAULT_MODEL: 'gemini-3.7-flash-low'
    });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const prepared = await prepareOpenAIRequest({
      model: 'gemini-3.7-flash-low',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Descreva.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }
      ] }]
    }, config);
    expect(prepared.imageCount).toBe(1);
    expect(prepared.prompt).toContain(`@${path.join(prepared.workingDirectory, 'numia-image-1.png')}`);
    expect(prepared.prompt).toContain('use view_file no caminho absoluto');
    await prepared.cleanup();
  });

  it('accepts 20 images in the current NumIA message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-openai-many-images-'));
    dirs.push(dir);
    const config = loadConfig({
      NODE_ENV: 'test', NUMIA_SERVER_TOKEN: 'a'.repeat(64), DATA_DIR: dir,
      ALLOWED_MODELS: 'gemini-3.8-flash-high', DEFAULT_MODEL: 'gemini-3.8-flash-high'
    });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const images = Array.from({ length: 20 }, () => ({
      type: 'image_url', image_url: { url: `data:image/png;base64,${png}` }
    }));
    const prepared = await prepareOpenAIRequest({
      model: 'gemini-3.8-flash-high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Resolva.' }, ...images] }]
    }, config);
    expect(prepared.imageCount).toBe(20);
    expect(prepared.imagePaths).toHaveLength(1);
    await prepared.cleanup();
  });

  it('does not reject a new text message because old images exceed the limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-openai-history-images-'));
    dirs.push(dir);
    const config = loadConfig({
      NODE_ENV: 'test', NUMIA_SERVER_TOKEN: 'a'.repeat(64), DATA_DIR: dir,
      ALLOWED_MODELS: 'gemini-3.8-flash-high', DEFAULT_MODEL: 'gemini-3.8-flash-high'
    });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const oldImages = Array.from({ length: 25 }, () => ({
      type: 'image_url', image_url: { url: `data:image/png;base64,${png}` }
    }));
    const prepared = await prepareOpenAIRequest({
      model: 'gemini-3.8-flash-high',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Imagens anteriores.' }, ...oldImages] },
        { role: 'assistant', content: 'Entendido.' },
        { role: 'user', content: 'Oi' }
      ]
    }, config);
    expect(prepared.imageCount).toBe(20);
    expect(prepared.prompt).toContain('USER:\nOi');
    expect(prepared.prompt).toContain('Imagem anterior omitida');
    await prepared.cleanup();
  });

  it('rejects only when the current message exceeds 20 images', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-openai-too-many-images-'));
    dirs.push(dir);
    const config = loadConfig({
      NODE_ENV: 'test', NUMIA_SERVER_TOKEN: 'a'.repeat(64), DATA_DIR: dir,
      ALLOWED_MODELS: 'gemini-3.8-flash-high', DEFAULT_MODEL: 'gemini-3.8-flash-high'
    });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const images = Array.from({ length: 21 }, () => ({
      type: 'image_url', image_url: { url: `data:image/png;base64,${png}` }
    }));
    await expect(prepareOpenAIRequest({
      model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: images }]
    }, config)).rejects.toMatchObject({ statusCode: 413, code: 'TOO_MANY_FILES' });
  });

  it('returns OpenAI-shaped models and stream chunks', () => {
    expect(openAIModelList(['modelo']).data[0]).toMatchObject({ id: 'modelo', object: 'model' });
    expect(openAIChunk('id', 1, 'modelo', { content: 'OK' }).choices[0]).toMatchObject({
      delta: { content: 'OK' }, finish_reason: null
    });
  });
});
