/**
 * HTTP 读入与路径归一。
 * 物理路径 = {origin}/functions/v1/{app|app-d<32hex>}/api/...：
 * 网关保留后缀但把逻辑名 app 换成部署名，Provider 也可能剥掉 /functions/v1，
 * 因此只允许"白名单前缀 + 已注册路由"命中，其余 404，禁止用 endsWith 猜测。
 */
import { AppError, badRequest, notFound, tooLarge, unsupportedMedia } from './errors.ts';

const PREFIX_PATTERN = /^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/;
const MAX_JSON_BYTES = 256 * 1024;

/** 归一化后的逻辑路径；非本应用前缀直接 404 */
export function logicalPath(url: URL): string {
  const match = url.pathname.match(PREFIX_PATTERN);
  if (!match) throw notFound('not_found', '接口不存在。');
  return match[1] ?? '/';
}

/**
 * 流式限长读取 JSON。
 * Content-Length 可缺失也可谎报，只用于早退；真实上限按已读字节数判定。
 */
export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw unsupportedMedia('unsupported_media_type：Content-Type 必须是 application/json。');
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(`请求体超过 ${maxBytes} 字节上限。`);
  }
  const reader = request.body?.getReader();
  if (!reader) return {};

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge(`请求体超过 ${maxBytes} 字节上限。`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('invalid_body', '请求体必须是 JSON 对象。');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw badRequest('invalid_json', '请求体不是合法 JSON。');
  }
}

export function queryOf(request: Request): URL {
  return new URL(request.url);
}

/** CORS：仅在显式允许的来源回显，默认同源部署不需要 */
export function corsHeaders(request: Request, allowlist: string[] = []): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin || allowlist.length === 0 || !allowlist.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'false',
    'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-client, x-demo-session',
    // 跨域脚本读不到非 safelisted 响应头；Retry-After 不暴露的话前端拿不到 429 的等待秒数
    'access-control-expose-headers': 'retry-after, x-request-id, x-idempotent-replay',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

export function preflightResponse(request: Request, allowlist: string[]): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, allowlist) });
}
