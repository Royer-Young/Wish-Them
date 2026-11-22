/**
 * 公开池基础版（第 7 轮）：发布即公开，举报满阈值自动隐藏，作者可下架。
 *
 * 红线：帖子只保存脱敏摘要，不保存愿签原文以外的隐私字段；
 * 列表/详情只投影公开 DTO，不返回 author_id/wish_id/五问/账本/文件。
 *
 * 一致性：
 * - UNIQUE(wish_id) 保证一个愿签最多一条帖子；重复发布返回同一帖；
 * - 举报用 UNIQUE(target_type,target_id,reporter_id) 去重，满阈值用状态 CAS 隐藏，
 *   并发举报最多让帖子进入 hidden 一次；
 * - reply_count 是可重算派生列：写时尽力刷新，读详情时实时统计（隐藏/删除的回信不计）。
 */

import { affected, count, firstAs, rowsAs, write } from '../lib/db.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { uuid } from '../lib/id.ts';
import { enforceWindow, dailyWindow, hourlyWindow } from '../lib/quota.ts';
import { toExcerpt } from '../lib/sensitive.ts';
import { WISH_TYPES } from './rules.ts';
import type { WishRow } from './wish.ts';
import type { AppConfig, DbClient, DbRow, Principal } from '../lib/types.ts';

export type PoolPostRow = DbRow & { id: string };

const REPLY_SCAN_LIMIT = 50;
const REPORT_SCAN_LIMIT = 50;
export const REPORT_REASONS = ['privacy', 'harassment', 'illegal', 'spam', 'sexual', 'other'] as const;
export const POOL_CATEGORIES = WISH_TYPES;

export interface PublishInput {
  category: string;
  isAnonymous: boolean;
  excerpt: string | null;
}

export async function publishWish(
  db: DbClient,
  config: AppConfig,
  principal: Principal,
  wish: WishRow,
  input: PublishInput,
  now: Date,
): Promise<{ post: PoolPostRow; created: boolean }> {
  if (String(wish.status ?? '') !== 'settled') {
    throw badRequest('wish_not_settled', '愿签结算后才能发布到公开池。', { status: wish.status });
  }

  const wishId = String(wish.id);
  const existing = await firstAs<PoolPostRow>(
    db.from('pool_posts').select('*').eq('wish_id', wishId),
    'read pool post',
  );
  if (existing && String(existing.status ?? '') === 'published') {
    return { post: existing, created: false };
  }
  if (existing && String(existing.status ?? '') === 'hidden') {
    throw badRequest('pool_hidden', '这条帖子已被举报隐藏，不能重新发布。', { status: 'hidden' });
  }

  const window = dailyWindow(now);
  await enforceWindow(db, 'pool_posts', {
    column: 'author_id',
    value: principal.userId,
    since: window.since,
    limit: config.poolPublishPerDay,
    errorCode: 'publish_quota_exceeded',
    message: `今天发布的公开愿望已达上限（${config.poolPublishPerDay} 条），明天再来。`,
    resetAt: window.resetAt,
    now,
  });

  const timestamp = now.toISOString();
  const category = (POOL_CATEGORIES as readonly string[]).includes(input.category)
    ? input.category
    : String(wish.wish_type ?? 'life');
  const excerpt = publicExcerpt(input.excerpt, String(wish.title ?? ''), String(wish.raw_input ?? ''));
  const values = {
    id: existing && String(existing.status ?? '') === 'deleted' ? String(existing.id) : uuid(),
    wish_id: wishId,
    author_id: principal.userId,
    wish_type: category,
    relation: String(wish.relation ?? ''),
    excerpt,
    display_label: input.isAnonymous ? '匿名搭子' : '许愿人',
    status: 'published',
    is_anonymous: input.isAnonymous,
    is_demo: principal.isDemo,
    report_count: 0,
    reply_count: 0,
    fork_count: 0,
    forked_from_id: null,
    published_at: timestamp,
    hidden_at: null,
    deleted_at: null,
    created_at: existing ? existing.created_at ?? timestamp : timestamp,
    updated_at: timestamp,
  };

  if (existing) {
    const updated = await write(
      db.from('pool_posts').update(values).eq('id', String(existing.id)).neq('status', 'hidden').select('*'),
      'republish pool post',
    );
    if (updated.length === 1) return { post: updated[0] as PoolPostRow, created: false };
    throw badRequest('pool_hidden', '这条帖子已被举报隐藏，不能重新发布。', { status: 'hidden' });
  }

  const inserted = await write(
    db.from('pool_posts').insertIfAbsent(values, { onConflict: 'wish_id' }).select('*'),
    'insert pool post',
  );
  if (inserted.length === 1) return { post: inserted[0] as PoolPostRow, created: true };
  const raced = await firstAs<PoolPostRow>(
    db.from('pool_posts').select('*').eq('wish_id', wishId),
    'reread pool post',
  );
  if (!raced) throw conflict('pool_conflict', '公开发布冲突，请重试。');
  return { post: raced, created: false };
}

export interface PoolPage {
  items: Record<string, unknown>[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}

export async function listPoolPosts(
  db: DbClient,
  page: { limit: number; cursor: string | null; category: string | null },
): Promise<PoolPage> {
  const limit = Math.min(page.limit, 50);
  let found: PoolPostRow[];
  if (page.cursor === null) {
    const chain = db.from('pool_posts').select('*').eq('status', 'published').eq('is_demo', false);
    const filtered = page.category ? chain.eq('wish_type', page.category) : chain;
    found = await rowsAs<PoolPostRow>(filtered.order('published_at', { ascending: false }).limit(limit + 1), 'list pool posts');
  } else {
    const cursor = decodeCursor(page.cursor);
    const tiedChain = db.from('pool_posts').select('*').eq('status', 'published').eq('is_demo', false)
      .eq('published_at', cursor.sortKey).lt('id', cursor.id);
    const olderChain = db.from('pool_posts').select('*').eq('status', 'published').eq('is_demo', false)
      .lt('published_at', cursor.sortKey);
    const tied = await rowsAs<PoolPostRow>(
      (page.category ? tiedChain.eq('wish_type', page.category) : tiedChain).limit(limit + 1),
      'list pool posts at cursor time',
    );
    const older = await rowsAs<PoolPostRow>(
      (page.category ? olderChain.eq('wish_type', page.category) : olderChain)
        .order('published_at', { ascending: false }).limit(limit + 1),
      'list pool posts before cursor',
    );
    found = [...tied, ...older];
  }

  found.sort((a, b) => {
    const left = String(a.published_at ?? '');
    const right = String(b.published_at ?? '');
    if (left !== right) return left < right ? 1 : -1;
    return String(a.id) < String(b.id) ? 1 : -1;
  });
  const items = found.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = found.length > limit;
  return {
    items: items.map(toPoolPostDto),
    next_cursor: hasMore && last ? encodeCursor(String(last.published_at), String(last.id)) : null,
    has_more: hasMore,
    limit,
  };
}

export async function readPoolPost(db: DbClient, postId: string): Promise<Record<string, unknown>> {
  const post = await requireVisiblePost(db, postId);
  const replyCount = await countPublishedReplies(db, postId);
  return { post: { ...toPoolPostDto(post), reply_count: replyCount } };
}

export async function reportPoolPost(
  db: DbClient,
  config: AppConfig,
  principal: Principal,
  postId: string,
  input: { reasonCode: string; detail: string },
  now: Date,
): Promise<Record<string, unknown>> {
  const post = await requireVisiblePost(db, postId);
  const window = hourlyWindow(now, 1);
  await enforceWindow(db, 'reports', {
    column: 'reporter_id',
    value: principal.userId,
    since: window.since,
    limit: config.poolReportPerHour,
    errorCode: 'report_rate_limited',
    message: '举报太频繁了，请稍后再试。',
    resetAt: window.resetAt,
    now,
  });

  const timestamp = now.toISOString();
  const reportValues = {
    id: uuid(),
    target_type: 'pool_post',
    target_id: postId,
    reporter_id: principal.userId,
    reason_code: input.reasonCode,
    detail: input.detail,
    status: 'open',
    action_taken: '',
    acted_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const inserted = await write(
    db.from('reports').insertIfAbsent(reportValues, { onConflict: 'target_type,target_id,reporter_id' }).select('*'),
    'insert pool report',
  );
  if (inserted.length !== 1) {
    throw conflict('report_duplicate', '你已经举报过这条帖子了。');
  }
  const report = inserted[0];

  const reportCount = await count(
    db.from('reports').select('id').eq('target_type', 'pool_post').eq('target_id', postId).limit(REPORT_SCAN_LIMIT),
    'count pool reports',
  );
  let hidden = String(post.status ?? '') !== 'published';
  if (reportCount >= config.poolReportHideThreshold) {
    const hid = await affected(
      db.from('pool_posts').update({ status: 'hidden', hidden_at: timestamp, report_count: reportCount, updated_at: timestamp })
        .eq('id', postId).eq('status', 'published'),
      'hide reported pool post',
    );
    hidden = hid === 1 || hidden;
    if (hid === 1) {
      await affected(
        db.from('reports').update({ status: 'acted', action_taken: 'auto_hidden', acted_at: timestamp })
          .eq('target_type', 'pool_post').eq('target_id', postId).eq('status', 'open'),
        'mark reports acted',
      );
    }
  } else {
    await affected(
      db.from('pool_posts').update({ report_count: reportCount, updated_at: timestamp })
        .eq('id', postId).eq('status', 'published'),
      'update pool report count',
    );
  }

  return {
    report: {
      id: report.id,
      status: hidden ? 'acted' : String(report.status ?? 'open'),
      reason_code: report.reason_code,
      created_at: report.created_at,
    },
    target: { hidden, report_count: reportCount },
  };
}

export async function unpublishPoolPost(
  db: DbClient,
  principal: Principal,
  postId: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const post = await firstAs<PoolPostRow>(db.from('pool_posts').select('*').eq('id', postId), 'read pool post for unpublish');
  if (!post) throw notFound('pool_not_found', '找不到这条公开帖子。');
  if (String(post.author_id ?? '') !== principal.userId) {
    throw forbidden('not_post_author', '只有作者能下架这条帖子。');
  }
  if (String(post.status ?? '') === 'deleted') {
    return { post: { id: post.id, status: 'deleted', deleted_at: post.deleted_at ?? null } };
  }
  const timestamp = now.toISOString();
  await affected(
    db.from('pool_posts').update({ status: 'deleted', deleted_at: timestamp, updated_at: timestamp })
      .eq('id', postId).neq('status', 'deleted'),
    'unpublish pool post',
  );
  return { post: { id: postId, status: 'deleted', deleted_at: timestamp } };
}

export async function requireVisiblePost(db: DbClient, postId: string): Promise<PoolPostRow> {
  const post = await firstAs<PoolPostRow>(db.from('pool_posts').select('*').eq('id', postId), 'read pool post');
  if (!post || String(post.status ?? '') !== 'published') {
    throw notFound('pool_hidden', '这条公开帖子已不可见。');
  }
  return post;
}

export async function countPublishedReplies(db: DbClient, postId: string): Promise<number> {
  return count(
    db.from('replies').select('id').eq('post_id', postId).eq('status', 'published').limit(REPLY_SCAN_LIMIT),
    'count published replies',
  );
}

/** 可重算派生列：读详情实时数，写回信/删回信后尽力刷新，不作为业务判定依据 */
export async function refreshReplyCount(db: DbClient, postId: string, now: Date): Promise<number> {
  const total = await countPublishedReplies(db, postId);
  await affected(
    db.from('pool_posts').update({ reply_count: total, updated_at: now.toISOString() }).eq('id', postId),
    'refresh reply count',
  );
  return total;
}

export function toPoolPostDto(post: PoolPostRow): Record<string, unknown> {
  return {
    id: post.id,
    status: post.status,
    category: post.wish_type,
    wish_type: post.wish_type,
    relation: post.relation,
    excerpt: post.excerpt,
    display_label: post.display_label,
    is_anonymous: post.is_anonymous === true,
    reply_count: Number(post.reply_count ?? 0),
    published_at: post.published_at,
  };
}

function publicExcerpt(explicit: string | null, title: string, raw: string): string {
  const source = (explicit && explicit.trim()) || title || raw;
  const excerpt = toExcerpt(source, 120);
  return excerpt === '' ? '一个没有说出口的愿望' : excerpt;
}

