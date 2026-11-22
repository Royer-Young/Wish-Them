/**
 * 结构化日志：只允许白名单字段。
 * 禁止输出 access_token / 恢复码 / signedUrl / 五问答案 / provider 原始错误体。
 */

export type LogLevel = 'info' | 'warn' | 'error';

const SENSITIVE_KEY = /(token|secret|key|code|password|answer|proof|signedurl|authorization|cookie|body)/i;

export interface LogFields {
  requestId?: string;
  route?: string;
  userId?: string;
  [field: string]: unknown;
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const safe: Record<string, unknown> = { level, event, at: new Date().toISOString() };
  for (const [name, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(name)) continue;
    safe[name] = typeof value === 'object' && value !== null ? '[object]' : value;
  }
  // Function 运行时把 stdout 收集为调用日志，单行 JSON 便于检索
  const line = JSON.stringify(safe);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** 未知异常只记录 name/message，堆栈里可能带路径与上游信息 */
export function logError(requestId: string, route: string | undefined, error: unknown): void {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log('error', 'unhandled_error', { requestId, route, reason: reason.slice(0, 300) });
}
