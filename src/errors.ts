export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function publicProviderError(stderr: string, exitCode: number | null): AppError {
  const text = stderr.toLowerCase();
  if (/auth|login|credential|oauth|invalid_grant/.test(text)) {
    return new AppError(503, 'GEMINI_AUTH_REQUIRED', 'O Antigravity CLI precisa ser autenticado novamente no servidor.');
  }
  if (/invalid model|model.*(not found|unavailable|unsupported|invalid)/.test(text)) {
    return new AppError(400, 'GEMINI_MODEL_UNAVAILABLE', 'O modelo solicitado não está disponível para esta conta ou versão do CLI.');
  }
  if (/timeout|timed out|time limit exceeded/.test(text)) {
    return new AppError(504, 'AI_TIMEOUT', 'O modelo demorou mais que o limite permitido para responder. Tente o Gemini Flash para respostas mais rápidas.');
  }
  if (/quota|rate.?limit|resource.?exhausted|429/.test(text)) {
    return new AppError(429, 'GEMINI_QUOTA_EXCEEDED', 'O limite de uso do Gemini foi atingido. Tente novamente mais tarde.');
  }
  return new AppError(502, 'GEMINI_PROCESS_FAILED', `O Antigravity CLI terminou inesperadamente (código ${exitCode ?? 'desconhecido'}).`);
}
