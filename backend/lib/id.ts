/** ID 与短标识生成 */

import { base32Encode, randomBytes, sha256Hex, utf8 } from './crypto.ts';

export function uuid(): string {
  return crypto.randomUUID();
}

/** 26 位 Crockford Base32（128bit 随机），用于 requestId：可粘贴、可日志检索 */
export function newRequestId(): string {
  return base32Encode(randomBytes(16)).toLowerCase();
}

/** 分享 token 等对外短标识，默认 16 字节 → 26 字符 */
export function shortToken(bytes = 16): string {
  return base32Encode(randomBytes(bytes));
}

/**
 * 由命名串派生的稳定 UUID（v4 形态，与 build-seeds.ts 的 stableId 同一套整形规则）。
 * 用途：没有事务时让批量写入可重放——同一 (愿签, 第几天, 第几条) 永远得到同一个 id，
 * 重试走 insertIfAbsent 就不会插出第二份任务。
 */
export async function derivedUuid(namespace: string): Promise<string> {
  const hex = await sha256Hex(utf8(namespace));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
