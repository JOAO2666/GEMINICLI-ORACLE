import { describe, expect, it } from 'vitest';
import { parseJsonLine } from '../src/services/stream-parser.js';

describe('Antigravity stream-json parser', () => {
  it('parses current CLI step deltas', () => {
    const event = parseJsonLine('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Olá"}}');
    expect(event).toMatchObject({ event: 'step_update' });
  });

  it('ignores startup noise and malformed lines', () => {
    expect(parseJsonLine('Loaded cached credentials.')).toBeNull();
    expect(parseJsonLine('{broken')).toBeNull();
  });
});
