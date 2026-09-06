import { describe, expect, it } from 'vitest';
import { ContextWindowManager, type ChatTurn } from '../src/services/context-window.js';

describe('ContextWindowManager', () => {
  it('neutralizes CLI shortcuts @ and !', () => {
    const manager = new ContextWindowManager();
    expect(manager.neutralize('@important !cmd')).toBe('@\u200Bimportant !\u200Bcmd');
  });

  it('keeps system turns and preserves recent turns without string slicing', () => {
    const manager = new ContextWindowManager(100);

    const turns: ChatTurn[] = [
      { role: 'system', text: 'SYSTEM: You are helpful.' },
      { role: 'user', text: 'USER: Message 1 that is quite long and detailed.' },
      { role: 'assistant', text: 'ASSISTANT: Response 1 with explanation.' },
      { role: 'user', text: 'USER: Message 2 recent.' },
      { role: 'assistant', text: 'ASSISTANT: Response 2 recent.' }
    ];

    const result = manager.trimTurns(turns);
    // System message must always be present
    expect(result.some((t) => t.role === 'system')).toBe(true);
    // Most recent turn must be present
    expect(result[result.length - 1]?.text).toBe('ASSISTANT: Response 2 recent.');
    // Oldest user message was dropped as a whole turn, not chopped in half
    expect(result.every((t) => !t.text.includes('Message 1 that is quite'))).toBe(true);
  });

  it('pairs tool calls with tool results atomically', () => {
    const manager = new ContextWindowManager(120);

    const turns: ChatTurn[] = [
      { role: 'system', text: 'SYSTEM: You are helpful.' },
      { role: 'user', text: 'USER: Run test.' },
      { role: 'assistant', text: 'ASSISTANT_TOOL_CALLS: [{"id":"call_1","name":"test"}]' },
      { role: 'tool', text: 'TOOL_RESULT: {"tool_call_id":"call_1","content":"passed"}' }
    ];

    const result = manager.trimTurns(turns);
    const hasCall = result.some((t) => t.text.includes('ASSISTANT_TOOL_CALLS'));
    const hasRes = result.some((t) => t.text.includes('TOOL_RESULT'));
    // Both must be kept together
    expect(hasCall).toBe(hasRes);
  });

  it('trims transcript keeping whole turns intact', () => {
    const manager = new ContextWindowManager();
    const turns = [
      'USUÁRIO: Mensagem 1',
      'ASSISTENTE: Resposta 1',
      'USUÁRIO: Mensagem 2',
      'ASSISTENTE: Resposta 2'
    ];

    const transcript = manager.trimTranscript('HISTÓRICO:', turns, 60);
    expect(transcript).toContain('HISTÓRICO:');
    expect(transcript).toContain('USUÁRIO: Mensagem 2');
    expect(transcript).toContain('ASSISTENTE: Resposta 2');
    // Whole turn 1 was removed cleanly
    expect(transcript).not.toContain('USUÁRIO: Mensagem 1');
  });
});
