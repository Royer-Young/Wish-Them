/**
 * 客户端 IP：只存 HMAC 摘要，限流按摘要分桶。
 * 注意：平台暂未开放可信 client-ip 头，Edge 前置代理行为未在部署环境验证，
 * 因此本模块只用于"从宽"限流（防误触/脚本刷屏），不作为安全边界。
 * 待部署验证后优先读平台写入的可信转发头（x-forwarded-for 第一跳）。
 */
import { hmacHex } from './crypto.ts';

export async function hashIp(ip: string | null, salt: string): Promise<string | null> {
  if (!ip) return null;
  return (await hmacHex(salt, ip)).slice(0, 32);
}

/** 兜底取 IP；'unknown' 归一为 null，避免所有请求挤在同一个桶里 */
export function clientIp(request: Request): string | null {
  const forHeader = request.headers.get('x-forwarded-for');
  if (forHeader) {
    const first = forHeader.split(',')[0]?.trim();
    if (first && first !== 'unknown') return first;
  }
  const real = request.headers.get('x-real-ip')?.trim();
  if (real && real !== 'unknown') return real;
  const cf = request.headers.get('cf-connecting-ip')?.trim();
  if (cf && cf !== 'unknown') return cf;
  return null;
}

/** user_agent 只留归类结果，原始串不入库存档 */
export function classifyClient(ua: string | null): 'web' | 'mp' | 'app' | 'unknown' {
  const text = (ua ?? '').toLowerCase();
  if (text.includes('miniprogram') || text.includes('wechat')) return 'mp';
  if (text.includes('okhttp') || /\b(android|iphone|ipad)\b/.test(text)) return 'app';
  if (text.length === 0) return 'unknown';
  return /mozilla|chrome|safari|edge|firefox/.test(text) ? 'web' : 'unknown';
}

/** 客户端自报接入端：x-client 白名单优先，缺失时按 UA 归类，未知归 web */
export function requestClient(request: Request): 'web' | 'mp' | 'app' {
  const declared = request.headers.get('x-client')?.trim().toLowerCase();
  if (declared === 'web' || declared === 'mp' || declared === 'app') return declared;
  const guessed = classifyClient(request.headers.get('user-agent'));
  return guessed === 'unknown' ? 'web' : guessed;
}
