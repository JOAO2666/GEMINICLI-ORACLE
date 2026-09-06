export interface ChatTurn {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  text: string;
  isSystemLike?: boolean;
  toolCallId?: string;
  pairedIndex?: number;
}

export class ContextWindowManager {
  constructor(private readonly maxChars: number = 120_000) {}

  neutralize(text: string): string {
    return text.replaceAll('@', '@\u200B').replaceAll('!', '!\u200B');
  }

  trimTurns(turns: ChatTurn[]): ChatTurn[] {
    if (turns.length === 0) return [];

    let totalChars = turns.reduce((acc, t) => acc + t.text.length, 0);
    if (totalChars <= this.maxChars) return [...turns];

    // System/developer turns must never be dropped
    const systemTurns: ChatTurn[] = turns.filter((t) => t.isSystemLike || t.role === 'system' || t.role === 'developer');
    const nonSystemTurns: ChatTurn[] = turns.filter((t) => !t.isSystemLike && t.role !== 'system' && t.role !== 'developer');

    let currentChars = systemTurns.reduce((acc, t) => acc + t.text.length, 0);
    const keptNonSystem: ChatTurn[] = [];

    // Walk backwards from newest to oldest
    for (let i = nonSystemTurns.length - 1; i >= 0; i--) {
      const turn = nonSystemTurns[i]!;
      // If it's a tool_result or assistant with tool_calls, ensure we pair them
      if (turn.role === 'tool' && i > 0 && nonSystemTurns[i - 1]?.role === 'assistant') {
        const pairTurn = nonSystemTurns[i - 1]!;
        const combinedLength = turn.text.length + pairTurn.text.length;
        if (currentChars + combinedLength <= this.maxChars || keptNonSystem.length === 0) {
          keptNonSystem.unshift(turn);
          keptNonSystem.unshift(pairTurn);
          currentChars += combinedLength;
          i--; // Skip pair
          continue;
        } else {
          break; // Stop including older turns
        }
      }

      if (currentChars + turn.text.length <= this.maxChars || keptNonSystem.length === 0) {
        keptNonSystem.unshift(turn);
        currentChars += turn.text.length;
      } else {
        break;
      }
    }

    // Return in original chronological order: system first, then kept non-system
    return [...systemTurns, ...keptNonSystem];
  }

  trimTranscript(header: string, turns: string[], maxChars = this.maxChars): string {
    if (turns.length === 0) return header;
    let joined = turns.join('\n\n');
    if (joined.length <= maxChars) return `${header}\n${joined}`;

    // Remove older turns from the beginning until it fits
    const kept = [...turns];
    while (kept.length > 1 && kept.join('\n\n').length > maxChars) {
      kept.shift();
    }
    return `${header}\n${kept.join('\n\n')}`;
  }
}
