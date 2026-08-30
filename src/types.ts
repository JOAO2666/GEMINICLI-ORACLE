export type ChatRole = 'user' | 'assistant';

export interface ChatRequest {
  conversationId: string;
  message: string;
  model?: string;
  attachmentIds?: string[];
}

export type ProviderEvent =
  | { type: 'start'; conversationId: string; model?: string; sessionId?: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'success' | 'error' }
  | { type: 'complete'; text: string; conversationId: string; sessionId?: string; stats?: unknown }
  | { type: 'error'; code: string; message: string };

export interface ProviderRequest {
  conversationId: string;
  prompt: string;
  model: string;
  workingDirectory: string;
  signal?: AbortSignal;
  executionMode?: 'plan' | 'accept-edits';
  effort?: 'low' | 'medium' | 'high';
  autoApprove?: boolean;
}

export interface ProviderStatus {
  available: boolean;
  authenticated: boolean | null;
  version?: string;
  message?: string;
}

export interface AIProvider {
  sendMessage(request: ProviderRequest): Promise<string>;
  streamMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent>;
  listModels(): Promise<string[]>;
  checkAuthentication(): Promise<ProviderStatus>;
  cancel(conversationId: string): boolean;
  supportsFiles(): boolean;
}
