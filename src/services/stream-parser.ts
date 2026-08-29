export interface CLIWireEvent { [key: string]: unknown; event?: string }

export function parseJsonLine(line: string): CLIWireEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' ? value as CLIWireEvent : null;
  } catch {
    return null;
  }
}
