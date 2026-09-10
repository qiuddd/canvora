export type ErrorCategory = 'invalid-key' | 'unreachable' | 'timeout' | 'insufficient-balance' | 'forbidden' | 'invalid-request' | 'provider' | 'internal';

export class AppError extends Error {
  constructor(public readonly category: ErrorCategory, message: string, public readonly detail?: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'AppError';
  }
}

export function classifyProviderError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (code === 'ABORT_ERR' || /timeout|timed out|超时/i.test(message)) return new AppError('timeout', '连接超时，可能是地址填错或网络不通', message, 504);
  if (/401|unauthorized|invalid.*(key|token)|api.?key/i.test(message)) return new AppError('invalid-key', '密钥无效，请检查后重新填写', message, 401);
  if (/402|balance|quota|余额|额度/i.test(message)) return new AppError('insufficient-balance', '接口返回余额不足，请到服务商后台充值', message, 402);
  if (/403|forbidden|permission|权限/i.test(message)) return new AppError('forbidden', '没有权限访问该服务商接口', message, 403);
  return new AppError('unreachable', '地址无法访问，请检查 Base URL 和网络连接', message, 502);
}

export function publicError(error: unknown): { message: string; detail?: string; category?: ErrorCategory } {
  const classified = error instanceof AppError ? error : classifyProviderError(error);
  return { message: classified.message, detail: classified.detail, category: classified.category };
}
