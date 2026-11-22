/**
 * 用户与登录态仓储：路由层只做参数校验与响应，数据读写集中在这里。
 *
 * 身份模型（对齐 PRD 6.1 users + 平台"不用 Cookie"约束）：
 * - 游客即正式账号：id = UUID，凭 Bearer Token 使用全部功能；
 * - 找回凭证 = 恢复码（唯一、服务端只存 HMAC 摘要），换回新 token 并把旧 token 全部撤销；
 * - 一次登录 = 一行 app.auth_tokens（id 即 JWT 的 jti），撤销靠状态列，不依赖 Redis 黑名单。
 */

import { first, firstAs, rows, write } from '../lib/db.ts';
import { AppError, conflict } from '../lib/errors.ts';
import { hmacHex } from '../lib/crypto.ts';
import { uuid } from '../lib/id.ts';
import { signToken } from '../lib/jwt.ts';
import { generateRecoveryCode, hashRecoveryCode, normalizeRecoveryCode } from '../lib/recovery.ts';
import type { AppConfig, DbClient, DbRow } from '../lib/types.ts';

export type UserRow = DbRow & { id: string };

export interface Session {
  accessToken: string;
  tokenType: 'Bearer';
  /** JWT 过期时刻（UTC ISO），客户端可据此提前续签 */
  expiresAt: string;
  tokenId: string;
}

export interface NewUserInput {
  client: string;
  regChannel: string | null;
  regIpHash: string | null;
  isDemo: boolean;
  nickname?: string;
  avatar?: string;
}

const DEFAULT_NICKNAMES = ['许愿人', '同行者', '搭子', '路人甲', '逐星人'];

/** 昵称只在创建时给默认值，之后由用户自己改；不做重名判定（无唯一索引） */
export function defaultNickname(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `${DEFAULT_NICKNAMES[hash % DEFAULT_NICKNAMES.length]}${String(1000 + (hash % 9000))}`;
}

export async function hashToken(config: AppConfig, signingInput: string): Promise<string> {
  return hmacHex(config.tokenPepper, signingInput);
}

export interface CreatedUser {
  user: UserRow;
  /** 明文只在这一次返回，服务端只留 HMAC 摘要 */
  recoveryCode: string;
}

export async function createUser(db: DbClient, config: AppConfig, input: NewUserInput, now: Date): Promise<CreatedUser> {
  const id = uuid();
  const createdAt = now.toISOString();
  const nickname = input.nickname ?? defaultNickname(id);
  // 恢复码撞唯一索引的概率约 2^-130，仍按可重试处理：换码重来，绝不覆盖他人摘要
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const recoveryCode = generateRecoveryCode();
    const recoveryHash = await hashRecoveryCode(config.recoveryPepper, normalizeRecoveryCode(recoveryCode) as string);
    const values = {
      id,
      nickname,
      avatar: input.avatar ?? 'default_01',
      client: input.client,
      status: 'active',
      is_demo: input.isDemo,
      recovery_code_hash: recoveryHash,
      reg_channel: input.regChannel,
      reg_ip_hash: input.regIpHash,
      // 通知设置本轮只落默认结构（免打扰窗口），后端推送属后续迭代
      settings: { quiet_hours: { start: '23:00', end: '08:00' } },
      created_at: createdAt,
      updated_at: createdAt,
    };
    try {
      const created = await write(db.from('users').insert(values).select('*'), 'create user');
      if (created.length === 1) return { user: created[0] as UserRow, recoveryCode };
      lastError = null;
      break;
    } catch (error) {
      // 唯一冲突只可能来自 recovery_code_hash（id 是新 UUID）
      if (error instanceof AppError && error.errorCode === 'duplicate_record') { lastError = error; continue; }
      throw error;
    }
  }
  if (lastError) throw conflict('recovery_code_collision', '恢复码生成冲突，请稍后重试。');
  throw conflict('user_create_failed', '创建账号失败，请稍后重试。');
}

export async function findUser(db: DbClient, userId: string): Promise<UserRow | null> {
  return firstAs<UserRow>(db.from('users').select('*').eq('id', userId), 'read user');
}

export async function findUserByRecoveryCode(
  db: DbClient,
  config: AppConfig,
  rawCode: string,
): Promise<UserRow | null> {
  const compact = normalizeRecoveryCode(rawCode);
  if (!compact) return null;
  const hash = await hashRecoveryCode(config.recoveryPepper, compact);
  return firstAs<UserRow>(db.from('users').select('*').eq('recovery_code_hash', hash), 'read user by recovery hash');
}

/** 轮换恢复码：找回账号成功后旧码立即失效（覆盖同一行的摘要） */
export async function rotateRecoveryCode(
  db: DbClient,
  config: AppConfig,
  userId: string,
  now: Date,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateRecoveryCode();
    const hash = await hashRecoveryCode(config.recoveryPepper, normalizeRecoveryCode(code) as string);
    try {
      const updated = await write(
        db.from('users').update({ recovery_code_hash: hash, updated_at: now.toISOString() }).eq('id', userId).select('id'),
        'rotate recovery code',
      );
      if (updated.length === 1) return code;
      throw conflict('account_unavailable', '账号当前不可用，请联系开发者。');
    } catch (error) {
      if (error instanceof AppError && error.errorCode === 'duplicate_record') continue;
      throw error;
    }
  }
  throw conflict('recovery_code_collision', '恢复码生成冲突，请稍后重试。');
}

export async function updateProfile(
  db: DbClient,
  userId: string,
  patch: Record<string, unknown>,
  now: Date,
): Promise<UserRow | null> {
  if (Object.keys(patch).length === 0) return findUser(db, userId);
  const updated = await write(
    db.from('users').update({ ...patch, updated_at: now.toISOString() }).eq('id', userId).eq('status', 'active').select('*'),
    'update profile',
  );
  return (updated[0] as UserRow | undefined) ?? null;
}

/**
 * 签发一次登录态：写 auth_tokens + 更新 last_active_at。
 * 两次写入之间崩溃的后果只是"多一条已失效记录"或"时间戳旧一点"，不影响可用性，
 * 所以这里不需要事务（平台也不提供）。
 */
export async function issueSession(
  db: DbClient,
  config: AppConfig,
  user: UserRow,
  input: { client: string; isDemo: boolean; ttlSeconds?: number },
  now: Date,
): Promise<Session> {
  const tokenId = uuid();
  const issued = await signToken(config, {
    userId: user.id,
    tokenId,
    client: input.client,
    isDemo: input.isDemo,
    now,
    ttlSeconds: input.ttlSeconds,
  });
  const expiresAt = new Date(issued.claims.exp * 1000).toISOString();
  await write(
    db.from('auth_tokens').insert({
      id: tokenId,
      user_id: user.id,
      token_hash: await hashToken(config, issued.tokenHashInput),
      client: input.client,
      demo: input.isDemo,
      status: 'active',
      last_seen_at: now.toISOString(),
      expires_at: expiresAt,
      revoked_at: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).select('id'),
    'insert auth token',
  );
  await write(
    db.from('users').update({ last_active_at: now.toISOString(), updated_at: now.toISOString() }).eq('id', user.id).select('id'),
    'touch user activity',
  );
  return { accessToken: issued.accessToken, tokenType: 'Bearer', expiresAt, tokenId };
}

/** 撤销当前 token；命中 0 行说明已撤销，返回 false 让路由决定文案 */
export async function revokeToken(db: DbClient, tokenId: string, now: Date): Promise<boolean> {
  const updated = await write(
    db.from('auth_tokens').update({ status: 'revoked', revoked_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('id', tokenId).eq('status', 'active').select('id'),
    'revoke token',
  );
  return updated.length === 1;
}

/** 找回账号＝换发新凭证：旧 token 全撤销，恢复码轮换，避免"两个人各自持有同一账号" */
export async function revokeAllTokens(db: DbClient, userId: string, now: Date): Promise<number> {
  const updated = await write(
    db.from('auth_tokens').update({ status: 'revoked', revoked_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('user_id', userId).eq('status', 'active').select('id'),
    'revoke all tokens',
  );
  return updated.length;
}

/** 有效 token 数（/api/me 用来提示"在几个设备上登录"） */
export async function countActiveTokens(db: DbClient, userId: string, now: Date): Promise<number> {
  const found = await rows(
    db.from('auth_tokens').select('id').eq('user_id', userId).eq('status', 'active').gt('expires_at', now.toISOString()).limit(20),
    'count active tokens',
  );
  return found.length;
}

/** 账号状态对外只暴露必要字段，恢复码摘要、IP 哈希与 token 记录永不出网 */
export function toUserDto(user: UserRow): Record<string, unknown> {
  const settings = (user.settings ?? {}) as Record<string, unknown>;
  return {
    id: user.id,
    nickname: user.nickname,
    avatar: user.avatar,
    client: user.client,
    is_demo: user.is_demo === true,
    profile_text: user.profile_text ?? '',
    wish_style_tags: asTagList(user.wish_style_tags),
    share_default_public: user.share_default_public === true,
    settings,
    created_at: user.created_at,
  };
}

/** jsonb 里存的可能是非数组（历史数据或手写迁移），出网前收窄成字符串数组 */
function asTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
