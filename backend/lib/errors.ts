/**
 * 统一错误码：0 成功；其余数值直接等于 HTTP 状态码。
 * 细粒度业务标识放 `errorCode`（客户端分支用），`message` 是可直接展示的中文文案。
 */

export const Code = {
  OK: 0,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  Conflict: 409,
  PayloadTooLarge: 413,
  UnsupportedMediaType: 415,
  Unprocessable: 422,
  TooManyRequests: 429,
  Internal: 500,
  Unavailable: 503,
} as const;

export class AppError extends Error {
  readonly code: number;
  readonly errorCode: string;
  readonly details?: Record<string, unknown>;

  constructor(code: number, errorCode: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.errorCode = errorCode;
    this.details = details;
  }

  get status(): number {
    // code 数值即 HTTP 状态；0 只用于成功响应，不会走到这里
    return this.code === Code.OK ? Code.Internal : this.code;
  }
}

export const badRequest = (errorCode: string, message: string, details?: Record<string, unknown>) =>
  new AppError(Code.BadRequest, errorCode, message, details);

export const unauthorized = (errorCode: string, message: string, details?: Record<string, unknown>) =>
  new AppError(Code.Unauthorized, errorCode, message, details);

export const forbidden = (errorCode: string, message: string, details?: Record<string, unknown>) =>
  new AppError(Code.Forbidden, errorCode, message, details);

export const notFound = (errorCode: string, message: string, details?: Record<string, unknown>) =>
  new AppError(Code.NotFound, errorCode, message, details);

export const conflict = (errorCode: string, message: string, details?: Record<string, unknown>) =>
  new AppError(Code.Conflict, errorCode, message, details);

export const unprocessable = (errorCode: string, message: string, details?: Record<string, unknown>) =>
  new AppError(Code.Unprocessable, errorCode, message, details);

export const tooLarge = (message: string) => new AppError(Code.PayloadTooLarge, 'payload_too_large', message);

export const unsupportedMedia = (message: string) => new AppError(Code.UnsupportedMediaType, 'unsupported_media_type', message);

export const rateLimited = (errorCode: string, message: string, retryAfterSeconds: number) =>
  new AppError(Code.TooManyRequests, errorCode, message, { retryAfterSeconds });

export const internal = (message = '服务开小差了，稍后再试。') => new AppError(Code.Internal, 'internal_error', message);

export const unavailable = (errorCode: string, message: string) => new AppError(Code.Unavailable, errorCode, message);

/** 路由命中路径但没有对应方法：Allow 头由响应层补 */
export const methodNotAllowed = (allowed: readonly string[]) =>
  new AppError(Code.MethodNotAllowed, 'method_not_allowed', `该接口只支持 ${allowed.join(' / ')}。`, { allowed: [...allowed] });

/** 部署期缺密钥等"服务没准备好"的情况，细节只进日志 */
export const serviceUnavailable = (message = '服务尚未就绪，请稍后重试。') =>
  new AppError(Code.Unavailable, 'service_not_configured', message);

/** 数据库错误 → 安全的应用层错误：不外泄 SQL、约束名与原始报错 */
export function fromDbError(error: { code?: string; message?: string }, fallbackMessage = '数据读写失败，请稍后重试。'): AppError {
  const code = error.code ?? '';
  if (code === '23505') return conflict('duplicate_record', '这条记录已经存在了。');
  if (code === '23503') return conflict('reference_missing', '关联的数据还没准备好。');
  if (code === '23514') return unprocessable('validation_failed', '提交的内容不符合规则。');
  if (code === '42501' || code === 'P0001') return unavailable('database_unavailable', '服务正在维护，稍后再试。');
  return unavailable('database_unavailable', fallbackMessage);
}
