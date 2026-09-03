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
  | { type: 'complete'; text: string; conversationId: string; sessionId?: string; stats?: unknown; structuredOutput?: unknown }
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
  jsonSchema?: Record<string, unknown>;
}

export interface ProviderStatus {
  available: boolean;
  authenticated: boolean | null;
  version?: string;
  message?: string;
}

export interface ProviderMaintenance {
  previousVersion?: string;
  installedVersion?: string;
  updated?: boolean;
  skipped?: boolean;
  message?: string;
  modelsRefreshedAt?: string;
  modelsUpdated?: boolean;
}

export interface ProviderResult {
  text: string;
  usage?: unknown;
  structuredOutput?: unknown;
  sessionId?: string;
  durationSeconds?: number;
}

export interface AIProvider {
  sendMessage(request: ProviderRequest): Promise<string>;
  sendMessageDetailed?(request: ProviderRequest): Promise<ProviderResult>;
  streamMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent>;
  listModels(): Promise<string[]>;
  refreshModels?(force?: boolean): Promise<string[]>;
  getUsage?(): Promise<unknown>;
  updateCLI?(): Promise<ProviderMaintenance>;
  maintenanceStatus?(): ProviderMaintenance;
  checkAuthentication(): Promise<ProviderStatus>;
  cancel(conversationId: string): boolean;
  supportsFiles(): boolean;
  onCatalogUpdate?(listener: () => void): void;
}
