/** 统一响应封装：{ code, data, message } + requestId + errorCode（机器可读） */

import { AppError, Code } from './errors.ts';

export interface Envelope<T> {
  code: number;
  data: T | null;
  message: string;
  requestId: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // API 一律不缓存；签名 URL 与静态资源不走这里
  'cache-control': 'no-store',
  // API 只返回 JSON；即使被错误地当页面打开，也不允许执行脚本或嵌入框架
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

function headersFor(requestId: string, extra?: Record<string, string>): Record<string, string> {
  return { ...BASE_HEADERS, 'x-request-id': requestId, ...extra };
}

export function ok<T>(data: T, requestId: string, message = 'ok'): Response {
  const body: Envelope<T> = { code: Code.OK, data, message, requestId };
  return Response.json(body, { status: 200, headers: headersFor(requestId) });
}

/** 首次创建成功用 201；幂等重放仍走 ok()，便于客户端区分"新建/重放" */
export function created<T>(data: T, requestId: string, message = 'ok'): Response {
  const body: Envelope<T> = { code: Code.OK, data, message, requestId };
  return Response.json(body, { status: 201, headers: headersFor(requestId) });
}

export function fail(error: AppError, requestId: string): Response {
  const body: Envelope<never> = {
    code: error.code,
    data: null,
    message: error.message,
    requestId,
    errorCode: error.errorCode,
    ...(error.details ? { details: error.details } : {}),
  };
  const extra: Record<string, string> = {};
  const retryAfter = error.details?.retryAfterSeconds;
  if (typeof retryAfter === 'number') extra['retry-after'] = String(Math.max(1, Math.ceil(retryAfter)));
  const allowed = error.details?.allowed;
  if (error.code === 405 && Array.isArray(allowed)) extra.allow = allowed.join(', ');
  return Response.json(body, { status: error.status, headers: headersFor(requestId, extra) });
}

/** 未预期异常：只回固定文案，原始错误由调用方（server.ts）写日志，靠 requestId 关联 */
export function failUnexpected(requestId: string): Response {
  const body: Envelope<never> = {
    code: Code.Internal,
    data: null,
    message: '服务开小差了，稍后再试。',
    requestId,
    errorCode: 'internal_error',
  };
  return Response.json(body, { status: 500, headers: headersFor(requestId) });
}

/**
 * 公开出口字段白名单：分享页/公开池只能用它投影，禁止把整行数据转 JSON。
 * 值类型为 unknown 以支持嵌套对象由调用方自行投影。
 */
export function projectPublic<T extends Record<string, unknown>>(row: T, allow: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allow) if (key in row) out[key] = row[key];
  return out;
}
