import { describe, expect, it } from 'vitest';
import { publicProviderError } from '../src/errors.js';

describe('public provider errors', () => {
  it('classifies invalid model selections as model availability errors', () => {
    const error = publicProviderError('invalid model selection: --model gemini-3.8-flash-high', 1);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('GEMINI_MODEL_UNAVAILABLE');
  });

  it('classifies CLI timeout messages as retryable timeouts', () => {
    const error = publicProviderError('The operation timed out', 1);
    expect(error.statusCode).toBe(504);
    expect(error.code).toBe('AI_TIMEOUT');
  });
});
