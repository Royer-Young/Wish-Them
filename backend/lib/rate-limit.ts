/**
 * 服务层兜底限流：每个 Function 实例内存里的固定分钟窗。
 *
 * 定位：业务接口的精确阈值（登录、创建、打卡、AI 等）仍走数据库窗口计数；
 * 这里只兜住「没有被业务限流覆盖的读接口」和异常刷量，不承载业务不变量。
 * 平台多实例部署时各实例独立计数，因此实际总阈值是「API_PER_MINUTE × 实例数」，
 * 属于比 WAF 更弱的最后一道保险；本地与单实例部署按单倍生效。
 */

import { rateLimited } from './errors.ts';

interface Bucket {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 20_000;

export function createApiLimiter(limit: number): (subject: string, now: Date) => void {
  const buckets = new Map<string, Bucket>();

  return function check(subject: string, now: Date): void {
    if (limit <= 0) throw rateLimited('api_rate_limited', '请求太频繁了，请稍后再试。', 60);
    const current = buckets.get(subject);
    if (!current || current.resetAt <= now.getTime()) {
      if (buckets.size >= MAX_BUCKETS) prune(buckets, now.getTime());
      buckets.set(subject, { count: 1, resetAt: now.getTime() + WINDOW_MS });
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now.getTime()) / 1000));
      throw rateLimited('api_rate_limited', '请求太频繁了，请稍后再试。', retryAfter);
    }
  };
}

function prune(buckets: Map<string, Bucket>, now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // 极端情况下仍在窗口内的桶太多：丢弃最早的一批，内存优先于计数精度
  if (buckets.size >= MAX_BUCKETS) {
    const excess = buckets.size - Math.floor(MAX_BUCKETS * 0.8);
    let dropped = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++dropped >= excess) break;
    }
  }
}