import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HTTP API', () => {
  it('protects API routes and creates a conversation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-app-'));
    dirs.push(dir);
    const token = 'a'.repeat(64);
    const app = await buildApp(loadConfig({
      NODE_ENV: 'test', NUMIA_SERVER_TOKEN: token, DATA_DIR: dir,
      ALLOWED_MODELS: 'gemini-3.1-pro-high', DEFAULT_MODEL: 'gemini-3.1-pro-high'
    }));

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/models' })).statusCode).toBe(401);
    const models = await app.inject({
      method: 'GET', url: '/models', headers: { authorization: `Bearer ${token}` }
    });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toMatchObject({ object: 'list', data: [{ id: 'gemini-3.1-pro-high' }] });
    const response = await app.inject({
      method: 'POST', url: '/api/conversations',
      headers: { authorization: `Bearer ${token}` }, payload: { model: 'gemini-3.1-pro-high' }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ model: 'gemini-3.1-pro-high' });
    await app.close();
  });
});
