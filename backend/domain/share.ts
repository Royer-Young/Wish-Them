/**
 * 分享（第 7 轮）：作者生成只读链接，匿名可看；撤销即失效。
 *
 * 一致性：share_links 的 UNIQUE(wish_id) 决定「一个愿签只有一条当前链接」，
 * 多次生成 = 轮换 token（旧链接立即失效），撤销 = 同一行置 revoked。
 *
 * 隐私红线：公开页只做白名单投影。响应中不存在五问答案、账本、文件/签名 URL、
 * 礼物与金额、昵称、user_id、author_id；结局只给状态与标签。
 */

import { affected, firstAs, write } from '../lib/db.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { shortToken, uuid } from '../lib/id.ts';
import { dayIndexOf, productDate } from '../lib/time.ts';
import { toExcerpt } from '../lib/sensitive.ts';
import { outcomeLabelOf } from './settlement.ts';
import type { WishRow } from './wish.ts';
import type { DbClient, DbRow } from '../lib/types.ts';

export type ShareLinkRow = DbRow & { id: string };

const SHAREABLE_STATUSES = new Set(['active', 'settling', 'settled', 'archived']);
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,32}$/;

export async function createShareLink(db: DbClient, wish: WishRow, now: Date): Promise<ShareLinkRow> {
  const status = String(wish.status ?? '');
  if (!SHAREABLE_STATUSES.has(status)) {
    throw badRequest('share_not_before_sign', '签下契约后才能生成分享链接。', { status });
  }
  const timestamp = now.toISOString();
  const existing = await firstAs<ShareLinkRow>(
    db.from('share_links').select('*').eq('wish_id', String(wish.id)),
    'read share link',
  );
  const token = shortToken(16);

  if (existing) {
    const updated = await write(
      db.from('share_links').update({
        token,
        status: 'active',
        visibility: 'link_only',
        revoked_at: null,
        updated_at: timestamp,
      }).eq('id', String(existing.id)).select('*'),
      'rotate share link',
    );
    if (updated.length === 1) return updated[0] as ShareLinkRow;
    throw conflict('share_conflict', '分享链接刚被更新过，请刷新后重试。');
  }

  const insert = {
    id: uuid(),
    wish_id: String(wish.id),
    user_id: String(wish.user_id ?? ''),
    token,
    visibility: 'link_only',
    include_flags: null,
    passphrase_hash: '',
    share_file_id: null,
    status: 'active',
    visits: 0,
    last_visited_at: null,
    revoked_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const inserted = await write(
    db.from('share_links').insertIfAbsent(insert, { onConflict: 'wish_id' }).select('*'),
    'create share link',
  );
  if (inserted.length === 1) return inserted[0] as ShareLinkRow;

  // 并发首生成：另一条请求先建了行，改为轮换 token（仍保证只有一条链接）
  const raced = await firstAs<ShareLinkRow>(
    db.from('share_links').select('*').eq('wish_id', String(wish.id)),
    'reread share link',
  );
  if (!raced) throw conflict('share_conflict', '分享链接创建冲突，请重试。');
  const rotated = await write(
    db.from('share_links').update({ token, status: 'active', revoked_at: null, updated_at: timestamp })
      .eq('id', String(raced.id)).select('*'),
    'rotate raced share link',
  );
  if (rotated.length !== 1) throw conflict('share_conflict', '分享链接刚被更新过，请刷新后重试。');
  return rotated[0] as ShareLinkRow;
}

export async function revokeShareLink(db: DbClient, wish: WishRow, now: Date): Promise<ShareLinkRow> {
  const row = await firstAs<ShareLinkRow>(
    db.from('share_links').select('*').eq('wish_id', String(wish.id)),
    'read share link for revoke',
  );
  if (!row) throw notFound('share_not_found', '还没有生成过分享链接。');
  if (String(row.status ?? '') === 'revoked') return row;

  const timestamp = now.toISOString();
  const updated = await write(
    db.from('share_links').update({ status: 'revoked', revoked_at: timestamp, updated_at: timestamp })
      .eq('id', String(row.id)).select('*'),
    'revoke share link',
  );
  if (updated.length !== 1) throw conflict('share_conflict', '分享链接刚被更新过，请刷新后重试。');
  return updated[0] as ShareLinkRow;
}

export interface SharedWishView {
  wish: Record<string, unknown>;
  share: Record<string, unknown>;
}

/** 匿名公开页：只按白名单组装，任何内部字段都不透传 */
export async function readSharedWish(db: DbClient, token: string, now: Date): Promise<SharedWishView> {
  if (!SHARE_TOKEN_PATTERN.test(token)) throw notFound('share_not_found', '分享链接不存在或已失效。');
  const row = await firstAs<ShareLinkRow>(db.from('share_links').select('*').eq('token', token), 'read shared link');
  if (!row) throw notFound('share_not_found', '分享链接不存在或已失效。');
  if (String(row.status ?? '') !== 'active') throw notFound('share_revoked', '这个分享链接已失效。');

  const wish = await firstAs<WishRow>(
    db.from('wishes').select('*').eq('id', String(row.wish_id)),
    'read shared wish',
  );
  if (!wish || (wish.deleted_at !== null && wish.deleted_at !== undefined)) {
    throw notFound('share_not_found', '分享链接不存在或已失效。');
  }
  const status = String(wish.status ?? '');
  if (!SHAREABLE_STATUSES.has(status)) throw notFound('share_not_found', '分享链接不存在或已失效。');

  const settled = status === 'settled';
  const outcome = settled ? String(wish.outcome ?? '') : '';
  const visits = Number(row.visits ?? 0) + 1;
  await affected(
    db.from('share_links').update({ visits, last_visited_at: now.toISOString() }).eq('id', String(row.id)),
    'bump share visits',
  );

  return {
    wish: {
      title: String(wish.title ?? ''),
      wish_text: String(wish.raw_input ?? ''),
      summary: toExcerpt(String(wish.title ?? '')),
      relation: String(wish.relation ?? ''),
      relation_group: String(wish.relation_group ?? ''),
      wish_type: String(wish.wish_type ?? ''),
      status,
      outcome,
      outcome_label: settled ? outcomeLabelOf(outcome) : '',
      start_date: String(wish.start_date ?? ''),
      end_date: String(wish.end_date ?? ''),
      day_index: publicDayIndex(wish, status, now),
      settled_at: settled ? wish.settled_at ?? null : null,
    },
    share: { status: 'active', visits },
  };
}

function publicDayIndex(wish: WishRow, status: string, now: Date): number {
  const days = Math.max(0, Math.trunc(Number(wish.days ?? 0)));
  if (status === 'settled' || status === 'archived') return days;
  const startDate = String(wish.start_date ?? '');
  if (startDate === '' || days === 0) return 0;
  const raw = dayIndexOf(startDate, productDate(now)) + 1;
  return Math.min(days, Math.max(1, raw));
}