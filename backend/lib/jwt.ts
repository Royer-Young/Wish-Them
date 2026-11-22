/**
 * JWT（HS256）签发与校验，有效期 30 天。
 * 不依赖平台网关身份：token 是唯一应用身份来源。
 * 撤销靠 jti 反查 app.auth_tokens（JWT 自包含，无法单凭签名失效，必须查一次库）。
 */

import { base64UrlDecode, base64UrlEncode, equalsConstantTime, hmacSha256, utf8 } from './crypto.ts';
import { unauthorized } from './errors.ts';
import type { AppConfig, Principal } from './types.ts';

const HEADER = base64UrlEncode(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

export interface JwtClaims {
  sub: string;
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  client: string;
  demo: 0 | 1;
}

export interface IssuedToken {
  accessToken: string;
  claims: JwtClaims;
  /** 用于写 app.auth_tokens.token_hash，事后不可还原 */
  tokenHashInput: string;
}

function encodeSegment(value: object): string {
  return base64UrlEncode(utf8(JSON.stringify(value)));
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
}

export async function signToken(
  config: AppConfig,
  input: { userId: string; tokenId: string; client: string; isDemo: boolean; now: Date; ttlSeconds?: number },
): Promise<IssuedToken> {
  const iat = Math.floor(input.now.getTime() / 1000);
  const claims: JwtClaims = {
    sub: input.userId,
    jti: input.tokenId,
    iss: config.issuer,
    aud: config.audience,
    iat,
    // 演示身份要短于真实会话：不传就用配置默认值（30 天）
    exp: iat + (input.ttlSeconds ?? config.tokenTtlSeconds),
    client: input.client,
    demo: input.isDemo ? 1 : 0,
  };
  const signingInput = `${HEADER}.${encodeSegment(claims)}`;
  const signature = await hmacSha256(config.jwtSecret, utf8(signingInput));
  return { accessToken: `${signingInput}.${base64UrlEncode(signature)}`, claims, tokenHashInput: signingInput };
}

/**
 * 校验签名与标准声明；抛 401（区分过期与非法），调用方不再重复判断。
 * 只接受 HS256，显式拒绝 alg 混淆（none / RS256 等）。
 */
export async function verifyToken(config: AppConfig, token: string, now: Date): Promise<JwtClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('invalid_token', '登录状态失效了，重新进入就好。');
  const [header, payload, signature] = parts;
  let headerObj: { alg?: string; typ?: string };
  try {
    headerObj = decodeSegment<{ alg?: string; typ?: string }>(header);
  } catch {
    throw unauthorized('invalid_token', '登录状态失效了，重新进入就好。');
  }
  if (headerObj.alg !== 'HS256' || headerObj.typ !== 'JWT') throw unauthorized('invalid_token', '登录状态失效了，重新进入就好。');

  const expected = await hmacSha256(config.jwtSecret, utf8(`${header}.${payload}`));
  let provided: Uint8Array;
  try {
    provided = base64UrlDecode(signature);
  } catch {
    throw unauthorized('invalid_token', '登录状态失效了，重新进入就好。');
  }
  if (!equalsConstantTime(expected, provided)) throw unauthorized('invalid_token', '登录状态失效了，重新进入就好。');

  let claims: JwtClaims;
  try {
    claims = decodeSegment<JwtClaims>(payload);
  } catch {
    throw unauthorized('invalid_token', '登录状态失效了，重新进入就好。');
  }
  if (claims.iss !== config.issuer || claims.aud !== config.audience) throw unauthorized('invalid_token', '登录状态失效了，重新进入就好。');
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') throw unauthorized('invalid_token', '登录状态失效了，重新进入就好。');

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.exp <= nowSeconds) throw unauthorized('token_expired', '登录超过 30 天了，用恢复码找回一下。');
  if (claims.iat > nowSeconds + 60) throw unauthorized('invalid_token', '登录状态异常，请重新进入。');
  if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string') throw unauthorized('invalid_token', '登录状态失效了，重新进入就好。');
  return claims;
}

export function readBearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

/** Principal 只由 token + 数据库共同决定，绝不接受请求体里的 userId */
export function toPrincipal(claims: JwtClaims, tokenRowExpiresAt: string): Principal {
  return {
    userId: claims.sub,
    tokenId: claims.jti,
    client: claims.client,
    isDemo: claims.demo === 1,
    tokenExpiresAt: tokenRowExpiresAt,
  };
}
