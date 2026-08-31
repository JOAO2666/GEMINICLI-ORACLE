import { describe, expect, it } from 'vitest';
import { buildAntigravityArgs } from '../src/services/antigravity-provider.js';
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
