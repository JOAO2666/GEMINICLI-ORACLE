import { describe, expect, it } from 'vitest';
import {
  buildAntigravityArgs,
  formatUsageBars,
  parseAntigravityModels,
  parseAntigravityUsage,
  resolveModelAlias
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

  it('formats visual quota bars with percentages', () => {
    const usage = {
      groups: [{
        name: 'Gemini Models',
        buckets: [{
          name: 'Gemini Flash',
          remainingPercent: 82,
          usedPercent: 18,
          resetTime: '2026-09-03T04:00:00Z'
        }]
      }]
    };
    const formatted = formatUsageBars(usage);
    expect(formatted).toContain('📊 Uso do Antigravity');
    expect(formatted).toContain('### Gemini Models');
    expect(formatted).toContain('Gemini Flash');
    expect(formatted).toContain('████████░░ 82% restante');
    expect(formatted).toContain('Usado: 18%');
    expect(formatted).toContain('Restante: 82%');
    expect(formatted).toContain('Reset:');
  });

  it('resolves model aliases correctly without hardcoded assumptions', () => {
    const available = [
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.1-pro-high',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking'
    ];
    expect(resolveModelAlias('gemini-3.8-flash-high', available)).toEqual({ model: 'gemini-3.8-flash-high' });
    expect(resolveModelAlias('flash', available)).toEqual({ model: 'gemini-3.8-flash-high' });
    expect(resolveModelAlias('pro', available)).toEqual({ model: 'gemini-3.1-pro-high' });
    expect(resolveModelAlias('flash-medium', available)).toEqual({ model: 'gemini-3.8-flash-medium' });
    expect(resolveModelAlias('sonnet', available)).toEqual({ model: 'claude-sonnet-4-6' });
    expect(resolveModelAlias('opus', available)).toEqual({ model: 'claude-opus-4-6-thinking' });
    expect(resolveModelAlias('inexistente', available)).toEqual({});
    const ambiguous = resolveModelAlias('gemini', available);
    expect(ambiguous.ambiguous).toBeDefined();
    expect(ambiguous.ambiguous?.length).toBe(3);
  });
});
