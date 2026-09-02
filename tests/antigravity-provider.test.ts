import { describe, expect, it } from 'vitest';
import {
  buildAntigravityArgs,
  parseAntigravityModels,
  parseAntigravityUsage
} from '../src/services/antigravity-provider.js';
import type { ProviderRequest } from '../src/types.js';

const baseRequest: ProviderRequest = {
  conversationId: 'conversation',
  prompt: 'prompt original',
  model: 'gemini-3.7-flash-high',
  workingDirectory: '/tmp/workspace'
};

describe('Antigravity CLI arguments', () => {
  it('keeps every legacy flag unchanged without Tool Calling', () => {
    expect(buildAntigravityArgs(baseRequest, 300_000)).toEqual([
      '--prompt', 'prompt original',
      '--model', 'gemini-3.7-flash-high',
      '--output-format', 'stream-json',
      '--mode', 'plan',
      '--sandbox',
      '--print-timeout', '300s'
    ]);
  });

  it('adds only --json-schema for a structured Tool Calling request', () => {
    const schema = { type: 'object', properties: { type: { type: 'string' } } };
    expect(buildAntigravityArgs({ ...baseRequest, jsonSchema: schema }, 300_000)).toEqual([
      '--prompt', 'prompt original',
      '--model', 'gemini-3.7-flash-high',
      '--output-format', 'stream-json',
      '--mode', 'plan',
      '--sandbox',
      '--print-timeout', '300s',
      '--json-schema', JSON.stringify(schema)
    ]);
  });
});

describe('dynamic Antigravity discovery', () => {
  it('discovers new Gemini, Claude and GPT models without a hard-coded catalog', () => {
    expect(parseAntigravityModels([
      'Fetching available models...',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6',
      'gpt-oss-120b-medium\tGPT-OSS 120B'
    ].join('\n'))).toEqual([
      'gemini-3.8-flash-high',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium'
    ]);
  });

  it('converts remaining quota to used percentage', () => {
    const parsed = parseAntigravityUsage(JSON.stringify({
      command: { data: { groups: [{ name: 'Gemini Models', buckets: [{
        id: 'gemini-weekly', name: 'Weekly', window: 'weekly',
        remaining_fraction: 0.875, reset_time: '2026-09-05T00:00:00Z'
      }] }] } }
    }));
    expect(parsed).toMatchObject({
      groups: [{ name: 'Gemini Models', buckets: [{
        remainingPercent: 87.5, usedPercent: 12.5
      }] }]
    });
  });
});
