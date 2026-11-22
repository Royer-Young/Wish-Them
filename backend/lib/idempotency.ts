/**
 * 幂等中间件：平台「多 SDK 调用不构成事务」，写操作的可重复性只能靠 app.idempotency_keys。
 *
 * 状态机：in_progress → succeeded | failed
 * - 首次请求：用 insertIfAbsent 占位（唯一索引 (principal, operation, idempotency_key)）。
 * - 命中已有记录：指纹不同 → 409 key_reuse；succeeded → 重放存档响应；
 *   failed 或 in_progress 超时 → 条件更新换主后重新执行。
 * - 崩溃残留：in_progress 超过 STALE_AFTER_SECONDS 视为失效，允许接管，不会永久卡死。
 * - 存档只放响应 JSON（≤64KB）；含 access_token 的接口不启用幂等（见路由声明 idempotent: 'none'）。
 */

import { badRequest, conflict } from './errors.ts';
import { affected, first, mutate } from './db.ts';
import { hmacHex, sha256Hex, utf8 } from './crypto.ts';
import { uuid } from './id.ts';
import { parseIdempotencyKey } from './validate.ts';
import type { Ctx, DbClient, DbRow, IdempotencyClaim, RouteDef } from './types.ts';

const STALE_AFTER_SECONDS = 60;
const RETENTION_DAYS = 7;
// 签署契约的响应含全部任务（30 天最多 90 条 ≈ 22KB），存档上限要盖住它，否则长契约无法重放
const MAX_STORED_BODY_BYTES = 64 * 1024;
const ON_CONFLICT = 'principal,operation,idempotency_key';

export interface IdempotencyDecision {
  claim: IdempotencyClaim;
  /** 非空表示这是重放，调用方直接返回该响应，业务代码不执行 */
  replay?: Response;
}

/** 请求指纹：方法 + 逻辑路径 + 规范化 body；同一 key 不同内容 → 409 */
export async function fingerprintOf(config: { fingerprintKey: string }, method: string, path: string, body: unknown): Promise<string> {
  const digest = await sha256Hex(utf8(stableStringify(body ?? {})));
  return (await hmacHex(config.fingerprintKey, `${method} ${path} ${digest}`)).slice(0, 64);
}

/** 便捷入口：路由已解析出 body 时直接算指纹 */
export function fingerprint(ctx: Ctx, body: unknown): Promise<string> {
  return fingerprintOf(ctx.config, ctx.request.method, ctx.path, body);
}

export function requiredKey(request: Request): string {
  const key = parseIdempotencyKey(request);
  if (!key) throw badRequest('idempotency_key_required', '缺少 Idempotency-Key 请求头。');
  return key;
}

/**
 * 占位或重放。
 * @param principal 主体标识：已登录 `u:<userId>`，游客 `i:<ipHash>`，演示 `d:<demoId>`，匿名兜底 `a`
 */
export async function claim(
  db: DbClient,
  input: { principal: string; operation: string; key: string; fingerprint: string; now: Date },
): Promise<IdempotencyDecision> {
  const id = uuid();
  const timestamp = input.now.toISOString();
  const inserted = await affected(
    db.from('idempotency_keys').insertIfAbsent({
      id,
      principal: input.principal,
      operation: input.operation,
      idempotency_key: input.key,
      request_fingerprint: input.fingerprint,
      status: 'in_progress',
      response_code: null,
      response_body: null,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
    }, { onConflict: ON_CONFLICT }),
    'claim idempotency slot',
  );
  if (inserted === 1) return { claim: toClaim(input, id) };
  return takeover(db, input, id);
}

async function takeover(
  db: DbClient,
  input: { principal: string; operation: string; key: string; fingerprint: string; now: Date },
  newId: string,
): Promise<IdempotencyDecision> {
  const existing = await first(
    db.from('idempotency_keys').select('*')
      .eq('principal', input.principal)
      .eq('operation', input.operation)
      .eq('idempotency_key', input.key),
    'read idempotency slot',
  );
  // 读不到只可能是刚好被清理任务删掉，让客户端重试即可
  if (!existing) throw inProgress();
  if (existing.request_fingerprint !== input.fingerprint) {
    throw conflict('idempotency_key_reuse', '同一 Idempotency-Key 不能用于不同请求。');
  }

  const rowId = String(existing.id ?? newId);
  const status = String(existing.status ?? '');
  if (status === 'succeeded') return { claim: toClaim(input, rowId), replay: replayOf(existing) };

  const canRetry = status === 'failed' || isStale(existing, input.now);
  if (!canRetry) throw inProgress();

  // CAS：只有仍处在同一状态（且仍超时）才换主，避免覆盖并发完成的结果
  const staleBefore = new Date(input.now.getTime() - STALE_AFTER_SECONDS * 1000).toISOString();
  const chain = db.from('idempotency_keys').update({
    status: 'in_progress',
    response_code: null,
    response_body: null,
    updated_at: input.now.toISOString(),
  }).eq('id', rowId).eq('status', status);
  // in_progress 分支额外要求"确实已超时"，避免覆盖刚完成的写入
  const taken = status === 'failed'
    ? await affected(chain, 'reclaim failed idempotency slot')
    : await affected(chain.lte('updated_at', staleBefore), 'reclaim stale idempotency slot');
  if (taken !== 1) throw inProgress();
  return { claim: toClaim(input, rowId) };
}

export async function markSucceeded(
  db: DbClient,
  slot: IdempotencyClaim,
  response: Response,
  now: Date,
): Promise<void> {
  const completedAt = now.toISOString();
  if (!response.ok) {
    await mutate(
      db.from('idempotency_keys').update({
        status: 'failed',
        response_code: response.status,
        response_body: null,
        updated_at: completedAt,
        completed_at: completedAt,
      }).eq('id', slot.id).eq('status', 'in_progress'),
      'fail idempotency slot',
    );
    return;
  }
  const body = await cloneBody(response);
  await mutate(
    db.from('idempotency_keys').update({
      status: body === null ? 'failed' : 'succeeded',
      response_code: response.status,
      response_body: body,
      updated_at: completedAt,
      completed_at: completedAt,
    }).eq('id', slot.id).eq('status', 'in_progress'),
    'complete idempotency slot',
  );
}

/** 业务异常也要落库，否则同键重试会一直卡在 in_progress */
export async function markFailed(db: DbClient, slot: IdempotencyClaim, code: number, now: Date): Promise<void> {
  const completedAt = now.toISOString();
  await mutate(
    db.from('idempotency_keys').update({
      status: 'failed',
      response_code: code,
      response_body: null,
      updated_at: completedAt,
      completed_at: completedAt,
    }).eq('id', slot.id).eq('status', 'in_progress'),
    'fail idempotency slot',
  );
}

/** 路由声明 + 请求头 → 本次是否需要幂等；GET/HEAD 一律不纳入 */
export function needsClaim(route: RouteDef, request: Request): boolean {
  if (route.idempotent === 'none') return false;
  if (request.method === 'GET' || request.method === 'HEAD') return false;
  return route.idempotent === 'required' || request.headers.has('idempotency-key');
}

/** 过期记录清理：随写请求惰性触发，平台没有 cron */
export async function sweepExpired(db: DbClient, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
  await mutate(db.from('idempotency_keys').delete().lte('created_at', cutoff), 'sweep idempotency slots');
}

function replayOf(row: DbRow): Response {
  const body = row.response_body;
  if (typeof body !== 'string') throw conflict('idempotency_state_invalid', '幂等记录缺少响应存档，请重新发起请求。');
  return Response.json(JSON.parse(body) as unknown, {
    status: Number(row.response_code ?? 200),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-idempotent-replay': 'true',
    },
  });
}

function isStale(row: DbRow, now: Date): boolean {
  const startedAt = Date.parse(String(row.updated_at ?? ''));
  return Number.isNaN(startedAt) || now.getTime() - startedAt > STALE_AFTER_SECONDS * 1000;
}

function inProgress(): ReturnType<typeof conflict> {
  return conflict('idempotency_in_progress', '同一请求正在处理中，请稍后重试。', { retryAfterSeconds: 2 });
}

function toClaim(input: { principal: string; operation: string; key: string; fingerprint: string }, id: string): IdempotencyClaim {
  return { id, principal: input.principal, operation: input.operation, key: input.key, fingerprint: input.fingerprint };
}

async function cloneBody(response: Response): Promise<string | null> {
  try {
    const text = await response.clone().text();
    return utf8(text).length > MAX_STORED_BODY_BYTES ? null : text;
  } catch (error) {
    return error instanceof Error ? null : null;
  }
}

/** 键排序后序列化：同一逻辑 body 不因字段顺序不同被判为不同指纹 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
