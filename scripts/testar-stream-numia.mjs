#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

const localEnv = readEnv(path.resolve('.env'));
const baseUrl = (process.argv[2] || localEnv.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const imagePath = process.argv[3] ? path.resolve(process.argv[3]) : '';
const model = process.argv[4] || 'gemini-3.1-pro-high';
const token = process.env.NUMIA_SERVER_TOKEN || localEnv.NUMIA_SERVER_TOKEN;
const imageCount = Number(process.env.NUMIA_STREAM_IMAGE_COUNT || 2);
const timeoutMs = Number(process.env.NUMIA_STREAM_TIMEOUT_MS || 180_000);

if (!baseUrl || !imagePath || !token || !fs.existsSync(imagePath)) {
  console.error('Uso: node scripts/testar-stream-numia.mjs URL IMAGEM [MODELO]');
  process.exit(2);
}

const extension = path.extname(imagePath).toLowerCase();
const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
const dataUrl = `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
const content = [{
  type: 'text',
  text: 'Analise cuidadosamente todas as imagens e explique detalhadamente o conteúdo visível, sem trocar de modelo.'
}];
for (let index = 0; index < imageCount; index += 1) {
  content.push({ type: 'image_url', image_url: { url: dataUrl } });
}

const started = Date.now();
const response = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content }] }),
  signal: AbortSignal.timeout(timeoutMs)
});
if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

const decoder = new TextDecoder();
let body = '';
let previousAt = Date.now();
let largestGapMs = 0;
for await (const chunk of response.body) {
  const now = Date.now();
  const gapMs = now - previousAt;
  previousAt = now;
  largestGapMs = Math.max(largestGapMs, gapMs);
  const text = decoder.decode(chunk, { stream: true });
  body += text;
  const kind = text.includes(': keep-alive') ? 'heartbeat' : 'dados';
  console.log(`${kind} em ${((now - started) / 1000).toFixed(1)}s (intervalo ${(gapMs / 1000).toFixed(1)}s)`);
}
body += decoder.decode();

const complete = body.includes('data: [DONE]') && body.includes(`"model":"${model}"`);
console.log(`Resultado: ${complete ? 'OK' : 'FALHA'}; maior intervalo ${(largestGapMs / 1000).toFixed(1)}s; modelo ${model}.`);
if (!complete || largestGapMs >= 40_000) process.exitCode = 1;
