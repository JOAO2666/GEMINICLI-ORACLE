#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
}

function imageMime(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  throw new Error('Use uma imagem JPG, PNG ou WebP.');
}

const localEnv = readEnv(path.resolve('.env'));
const baseUrl = (process.argv[2] || process.env.NUMIA_BASE_URL || localEnv.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const imagePath = process.argv[3] ? path.resolve(process.argv[3]) : '';
const token = process.env.NUMIA_SERVER_TOKEN || localEnv.NUMIA_SERVER_TOKEN;
const timeoutMs = Number(process.env.MODEL_TEST_TIMEOUT_MS || 120_000);
const imagePrompt = process.argv[4] || process.env.MODEL_TEST_IMAGE_PROMPT || 'Leia a imagem anexada e diga, em uma frase curta, o que aparece nela.';
const expectedImageText = process.argv[5] || process.env.MODEL_TEST_EXPECTED || '';

if (!baseUrl || !token || !imagePath) {
  console.error('Uso: node scripts/testar-modelos.mjs URL_PUBLICA CAMINHO_DA_IMAGEM');
  console.error('A chave é lida de NUMIA_SERVER_TOKEN ou do arquivo .env e nunca é exibida.');
  process.exit(2);
}
if (!fs.existsSync(imagePath)) {
  console.error(`Imagem não encontrada: ${imagePath}`);
  process.exit(2);
}

const authorization = `Bearer ${token}`;
const modelResponse = await fetch(`${baseUrl}/v1/models`, {
  headers: { authorization },
  signal: AbortSignal.timeout(timeoutMs)
});
if (!modelResponse.ok) {
  throw new Error(`Falha ao consultar modelos: HTTP ${modelResponse.status}`);
}
const modelPayload = await modelResponse.json();
const modelFilter = process.env.MODEL_TEST_FILTER || '';
const models = (modelPayload.data || []).map((item) => item.id).filter((id) =>
  id && (!modelFilter || id.toLocaleLowerCase().includes(modelFilter.toLocaleLowerCase()))
);
if (models.length === 0) throw new Error('Nenhum modelo corresponde a MODEL_TEST_FILTER.');
const mime = imageMime(imagePath);
const imageDataUrl = `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;

async function run(model, kind) {
  const content = kind === 'text'
    ? 'Responda somente com a palavra OK.'
    : [
        { type: 'text', text: imagePrompt },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ];
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const raw = await response.text();
    let payload = {};
    try { payload = JSON.parse(raw.trim()); } catch { /* reported below */ }
    const answer = payload.choices?.[0]?.message?.content;
    const returnedModel = payload.model || '';
    const evidenceOk = kind === 'text' || !expectedImageText ||
      (typeof answer === 'string' && answer.toLocaleLowerCase().includes(expectedImageText.toLocaleLowerCase()));
    return {
      model,
      kind,
      ok: response.ok && returnedModel === model && typeof answer === 'string' && answer.trim().length > 0 && evidenceOk,
      http: response.status,
      returnedModel,
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      error: payload.error?.code || payload.error || (!raw.trim() ? 'EMPTY_RESPONSE' : (!evidenceOk ? 'IMAGE_EVIDENCE_MISMATCH' : ''))
    };
  } catch (error) {
    return {
      model,
      kind,
      ok: false,
      http: 0,
      returnedModel: '',
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

console.log(`Testando ${models.length} modelos em texto e imagem, um por vez...`);
const results = [];
for (const model of models) {
  for (const kind of ['text', 'image']) {
    const result = await run(model, kind);
    results.push(result);
    console.log(`${result.ok ? 'OK' : 'FALHA'} | ${kind.padEnd(6)} | ${model.padEnd(30)} | HTTP ${result.http} | ${result.seconds}s | retornou ${result.returnedModel || '-'}${result.error ? ` | ${result.error}` : ''}`);
  }
}

const failures = results.filter((result) => !result.ok);
console.log(`Resumo: ${results.length - failures.length}/${results.length} testes passaram.`);
if (failures.length) process.exitCode = 1;
