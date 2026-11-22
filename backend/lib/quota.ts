/**
 * 配额与限流：平台没有 Redis，也没有事务性 INCR，
 * 因此统一用「按索引 count 时间窗」实现——命中 (主体, created_at) 索引，窗口内最多 50 行。
 *
 * 精度取舍：多实例并发下可能少量超额（非原子），限流是兜底防线，不承载业务不变量；
 * 真正不能重复的动作（结算、入账）走 idempotency.ts 的幂等占位，不依赖这里的计数。
 */

import { rateLimited } from './errors.ts';
import type { AppError } from './errors.ts';
import { count } from './db.ts';
import { productDate, dayStartUtc } from './time.ts';
import type { DbClient } from './types.ts';

/** 窗口计数最多扫多少行；`config.ts` 用它作为各项阈值上限，避免「配了但永远判不出超限」 */
export const SCAN_LIMIT = 50;

export interface WindowSpec {
  /** 主体列名与取值；ownerId 为 null 时按 ip_hash 分桶 */
  column: string;
  value: string;
  /** 时间窗起点（含），ISO 字符串 */
  since: string;
  limit: number;
  /** 429 的机器码，如 guest_too_many_registrations */
  errorCode: string;
  message: string;
  /** 窗口重置时刻（ISO），用于 retry-after */
  resetAt: Date;
  /** 请求级时钟，保证 retry-after 与限流判定同源 */
  now: Date;
  /** 额外等值过滤（例如真实注册计数排除 is_demo 账号） */
  equals?: ReadonlyArray<readonly [string, unknown]>;
}

export async function enforceWindow(db: DbClient, table: string, spec: WindowSpec): Promise<void> {
  if (spec.limit <= 0) throw rateLimited(spec.errorCode, spec.message, retryAfter(spec.resetAt, spec.now));
  let chain = db.from(table).select('id').eq(spec.column, spec.value).gte('created_at', spec.since);
  for (const [column, value] of spec.equals ?? []) chain = chain.eq(column, value);
  const hit = await count(chain.limit(SCAN_LIMIT), `count ${table}`);
  if (hit >= spec.limit) throw rateLimited(spec.errorCode, spec.message, retryAfter(spec.resetAt, spec.now));
}

/** 滚动小时窗：起点 = now − hours；resetAt 取 now + hours（窗口真正腾出名额的上界，用于 retry-after） */
export function hourlyWindow(now: Date, hours: number): { since: string; resetAt: Date } {
  const since = new Date(now.getTime() - hours * 3_600_000);
  // 注意不能写 since + hours：那正好等于 now，会让 Retry-After 恒为 1 秒，客户端会一直撞 429。
  return { since: since.toISOString(), resetAt: new Date(now.getTime() + hours * 3_600_000) };
}

/** 滚动分钟窗：打卡限频（CHECKIN_PER_MINUTE 次/分钟） */
export function minuteWindow(now: Date): { since: string; resetAt: Date } {
  return {
    since: new Date(now.getTime() - 60_000).toISOString(),
    resetAt: new Date(now.getTime() + 60_000),
  };
}

/** 产品日窗（04:00 为界），与用户看到的「今天」一致 */
export function dailyWindow(now: Date): { since: string; resetAt: Date } {
  const start = dayStartUtc(productDate(now));
  return { since: start.toISOString(), resetAt: new Date(start.getTime() + 24 * 3_600_000) };
}

function retryAfter(resetAt: Date, now = new Date()): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
}

export function quotaError(spec: Pick<WindowSpec, 'errorCode' | 'message' | 'resetAt'>): AppError {
  return rateLimited(spec.errorCode, spec.message, retryAfter(spec.resetAt));
}
