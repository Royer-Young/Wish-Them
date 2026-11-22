/**
 * 全局鉴权中间件：Bearer Token → Principal。
 *
 * 平台约束：
 * - 完全不使用网关注入的身份（x-qoder-user-context 等），应用只认自建 JWT；
 * - JWT 自包含、无法单方作废，因此每次请求都要用 jti 反查 app.auth_tokens，
 *   命中且 revoked_at IS NULL 才算有效，退出登录/找回账号后旧 token 立即失效；
 * - demo token 不能访问真实数据接口，反之亦然（principal.isDemo 由服务端声明判定）。
 */

import { first } from './db.ts';
import { forbidden, unauthorized } from './errors.ts';
import { readBearer, toPrincipal, verifyToken, type JwtClaims } from './jwt.ts';
import type { AppConfig, DbClient, Principal } from './types.ts';

/** auth=none 的路由也会带 Token（例如"我是不是已登录"），失败不阻断请求 */
export async function authenticate(
  db: DbClient,
  config: AppConfig,
  request: Request,
  now: Date,
): Promise<Principal | null> {
  const token = readBearer(request);
  if (!token) return null;
  const claims = await verifyToken(config, token, now);
  return withTokenRow(db, claims, now);
}

/** auth=bearer 的路由入口：缺失或失效一律 401 */
export async function requirePrincipal(
  db: DbClient,
  config: AppConfig,
  request: Request,
  now: Date,
): Promise<Principal> {
  const principal = await authenticate(db, config, request, now);
  if (!principal) throw unauthorized('invalid_token', '请先登录。');
  return principal;
}

/** 演示接口专用：必须是 demo token */
export function requireRealUser(principal: Principal): void {
  if (principal.isDemo) throw forbidden('demo_forbidden', '演示身份不能操作真实数据。');
}

export function requireDemoUser(principal: Principal): void {
  if (!principal.isDemo) throw forbidden('demo_required', '该接口只允许演示身份访问。');
}

async function withTokenRow(db: DbClient, claims: JwtClaims, now: Date): Promise<Principal> {
  const tokenNow = now.toISOString();
  const row = await first(
    db.from('auth_tokens').select('id,user_id,status,expires_at,revoked_at,demo').eq('id', claims.jti),
    'read auth token',
  );
  if (!row) throw unauthorized('invalid_token', '登录状态失效了，重新进入就好。');
  if (row.status !== 'active' || typeof row.revoked_at === 'string') {
    throw unauthorized('token_revoked', '登录已在其他设备退出，重新进入就好。');
  }
  const expiresAt = String(row.expires_at ?? '');
  if (!expiresAt || expiresAt <= tokenNow) throw unauthorized('token_expired', '登录超过 30 天了，用恢复码找回一下。');

  const user = await first(
    db.from('users').select('id,status').eq('id', claims.sub),
    'read user status',
  );
  if (!user) throw unauthorized('account_not_found', '找不到这个账号，用恢复码找回一下。');
  if (user.status !== 'active') {
    throw forbidden(user.status === 'frozen' ? 'account_frozen' : 'account_deleted', '账号当前不可用，请联系开发者。');
  }
  // claims.demo 与 token 行必须一致，防止手改 payload 跨身份串数据
  if (row.demo !== (claims.demo === 1)) throw unauthorized('invalid_token', '登录状态异常，请重新进入。');
  return toPrincipal(claims, expiresAt);
}
