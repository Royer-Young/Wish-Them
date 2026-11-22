/** 密码学工具：只用 Web Crypto，Deno 与 Node 通用，不引第三方 JWT 库 */

import { internal } from './errors.ts';

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function toBinary(bytes: Uint8Array): string {
  // 分块避免超长字符串拼接
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(toBinary(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const normalized = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Crockford Base32（去掉易混字符 I L O U），适合让用户手输恢复码 */
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', utf8(secret) as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** HMAC-SHA256 原始字节，用于 JWT 签名与恒定时间校验 */
export async function hmacSha256(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), data as unknown as BufferSource);
  return new Uint8Array(signature);
}

export async function hmacHex(secret: string, text: string): Promise<string> {
  const bytes = await hmacSha256(secret, utf8(text));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 恒定时间比较，避免签名/摘要比较被计时攻击 */
export function equalsConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const view = new Uint8Array(digest);
  return [...view].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 字段级加密（五问答案）：AES-256-GCM，密文 `v1:<iv>:<tag>:<ciphertext>`，三段都是 base64url。
 * AAD 绑定 wish_id ⇒ 把 A 契约的密文搬到 B 契约也解不开；密钥由 SHA-256(secret) 派生成 32 字节。
 * Web Crypto 把 16 字节 tag 附在密文尾部，这里拆开存，与 docs/02 §10 的格式一致。
 */
const FIELD_CIPHER_PREFIX = 'v1';
const GCM_TAG_BYTES = 16;

async function fieldKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(secret) as unknown as BufferSource);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptField(secret: string, plaintext: string, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      additionalData: utf8(aad) as unknown as BufferSource,
      tagLength: GCM_TAG_BYTES * 8,
    },
    await fieldKey(secret),
    utf8(plaintext) as unknown as BufferSource,
  ));
  const body = sealed.subarray(0, sealed.length - GCM_TAG_BYTES);
  const tag = sealed.subarray(sealed.length - GCM_TAG_BYTES);
  return `${FIELD_CIPHER_PREFIX}:${base64UrlEncode(iv)}:${base64UrlEncode(tag)}:${base64UrlEncode(body)}`;
}

/** 空串表示「这题还没答」，不是密文；解不开一律 500（密钥轮换或数据损坏，不该让用户重试） */
export async function decryptField(secret: string, stored: string, aad: string): Promise<string> {
  if (stored === '') return '';
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== FIELD_CIPHER_PREFIX) throw internal('字段密文格式不正确');
  const iv = base64UrlDecode(parts[1]);
  const tag = base64UrlDecode(parts[2]);
  const body = base64UrlDecode(parts[3]);
  const sealed = new Uint8Array(body.length + tag.length);
  sealed.set(body, 0);
  sealed.set(tag, body.length);
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        additionalData: utf8(aad) as unknown as BufferSource,
        tagLength: GCM_TAG_BYTES * 8,
      },
      await fieldKey(secret),
      sealed as unknown as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw internal('字段密文校验失败');
  }
}
