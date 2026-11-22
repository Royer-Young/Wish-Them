/**
 * 恢复码：一次性展示给用户，服务端只存 HMAC 摘要，明文不落库、不写日志。
 * 唯一性由 users.recovery_code_hash 的唯一索引兜底。
 */
import { base32Encode, hmacHex, randomBytes } from './crypto.ts';
import { BASE32_ALPHABET as ALPHABET } from './patterns.ts';

// 26 个 Crockford 字符 ≈ 130 bit 熵：可手抄、可截图，且在线撞码被 auth_attempts 限频挡住
const RAW_LENGTH = 26;
const GROUP_SIZE = 5;

export function generateRecoveryCode(): string {
  // 26 个 Crockford 字符 ≈ 130 bit 熵；多编出的尾部字符丢弃
  const compact = base32Encode(randomBytes(Math.ceil((RAW_LENGTH * 5) / 8))).slice(0, RAW_LENGTH);
  return formatRecoveryCode(compact);
}

export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/I|L/g, '1');
  if (compact.length !== RAW_LENGTH) return null;
  for (const ch of compact) if (!ALPHABET.includes(ch)) return null;
  return compact;
}

export function hashRecoveryCode(pepper: string, code: string): Promise<string> {
  return hmacHex(pepper, code);
}

/** 用户输入允许任意分组，展示统一用短横线分组 */
export function formatRecoveryCode(compact: string): string {
  return group(compact);
}

function group(value: string): string {
  return value.replace(new RegExp(`(.{${GROUP_SIZE}})`, 'g'), '$1-').replace(/-$/, '');
}
