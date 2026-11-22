/**
 * 回信（第 7 轮）：登录用户给公开池帖子打气，≤80 字、敏感内容拦截、同帖每人每天一条。
 *
 * 与既有一致性口径一致：
 * - 同帖每天一条不是数据库唯一约束（时间窗无法建 UNIQUE），用「时间窗查询 + 插入」拦，
 *   并发下可能多一条，属于已知残余竞态；总日限 20 条另有独立限流兜底；
 * - reply_count 是可重算派生列，写后刷新，读详情实时统计；
 * - 删除权限 = 回信作者或帖主，其余 403 not_reply_owner。
 */

import { affected, count, first, firstAs, rowsAs, write } from '../lib/db.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { uuid } from '../lib/id.ts';
import { dailyWindow, enforceWindow } from '../lib/quota.ts';
import { containsSensitive } from '../lib/sensitive.ts';
import { refreshReplyCount, requireVisiblePost } from './pool.ts';
import type { PoolPostRow } from './pool.ts';
import type { AppConfig, DbClient, DbRow, Principal } from '../lib/types.ts';

export type ReplyRow = DbRow & { id: string };

const REPLY_SCAN_LIMIT = 50;

export async function createReply(
  db: DbClient,
  config: AppConfig,
  principal: Principal,
  post: PoolPostRow,
  content: string,
  now: Date,
): Promise<Record<string, unknown>> {
  if (containsSensitive(content)) {
    throw badRequest('sensitive_content', '回信里有联系方式或不适合公开的内容，请修改后再发。');
  }

  const wish = await first(
    db.from('wishes').select('id,replies_enabled').eq('id', String(post.wish_id ?? '')),
    'read reply wish',
  );
  if (wish && wish.replies_enabled === false) {
    throw badRequest('replies_disabled', '作者关闭了这条愿签的回信。');
  }

  const window = dailyWindow(now);
  await enforceWindow(db, 'replies', {
    column: 'author_id',
    value: principal.userId,
    since: window.since,
    limit: config.replyPerDay,
    errorCode: 'reply_rate_limited',
    message: `今天回信已达上限（${config.replyPerDay} 条），明天再来。`,
    resetAt: window.resetAt,
    now,
  });

  const samePost = await count(
    db.from('replies').select('id')
      .eq('post_id', String(post.id)).eq('author_id', principal.userId)
      .gte('created_at', window.since).limit(1),
    'read reply daily slot',
  );
  if (samePost > 0) {
    throw conflict('reply_daily_limit', '同一条帖子每天只能回一条。');
  }

  const timestamp = now.toISOString();
  const values = {
    id: uuid(),
    post_id: String(post.id),
    wish_id: String(post.wish_id ?? ''),
    author_id: principal.userId,
    content,
    status: 'published',
    is_demo: principal.isDemo,
    report_count: 0,
    read_at: null,
    hidden_at: null,
    deleted_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const inserted = await write(db.from('replies').insert(values).select('*'), 'create reply');
  if (inserted.length !== 1) throw conflict('reply_conflict', '回信提交冲突，请重试。');
  const reply = inserted[0] as ReplyRow;

  const postReplyCount = await refreshReplyCount(db, String(post.id), now);
  const usedToday = await count(
    db.from('replies').select('id').eq('author_id', principal.userId).gte('created_at', window.since).limit(REPLY_SCAN_LIMIT),
    'count replies today',
  );
  return {
    reply: toReplyDto(reply),
    post: { reply_count: postReplyCount },
    quota: { daily_remaining: Math.max(0, config.replyPerDay - usedToday) },
  };
}

export interface ReplyPage {
  items: Record<string, unknown>[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}

export async function listReplies(
  db: DbClient,
  postId: string,
  page: { limit: number; cursor: string | null },
): Promise<ReplyPage> {
  await requireVisiblePost(db, postId);
  const limit = Math.min(page.limit, 50);
  let found: ReplyRow[];
  if (page.cursor === null) {
    found = await rowsAs<ReplyRow>(
      db.from('replies').select('*').eq('post_id', postId).eq('status', 'published')
        .order('created_at', { ascending: false }).limit(limit + 1),
      'list replies',
    );
  } else {
    const cursor = decodeCursor(page.cursor);
    const tied = await rowsAs<ReplyRow>(
      db.from('replies').select('*').eq('post_id', postId).eq('status', 'published')
        .eq('created_at', cursor.sortKey).lt('id', cursor.id).limit(limit + 1),
      'list replies at cursor time',
    );
    const older = await rowsAs<ReplyRow>(
      db.from('replies').select('*').eq('post_id', postId).eq('status', 'published')
        .lt('created_at', cursor.sortKey).order('created_at', { ascending: false }).limit(limit + 1),
      'list replies before cursor',
    );
    found = [...tied, ...older];
  }
  found.sort((a, b) => {
    const left = String(a.created_at ?? '');
    const right = String(b.created_at ?? '');
    if (left !== right) return left < right ? 1 : -1;
    return String(a.id) < String(b.id) ? 1 : -1;
  });
  const items = found.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = found.length > limit;
  return {
    items: items.map(toReplyDto),
    next_cursor: hasMore && last ? encodeCursor(String(last.created_at), String(last.id)) : null,
    has_more: hasMore,
    limit,
  };
}

export async function deleteReply(
  db: DbClient,
  principal: Principal,
  replyId: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const reply = await firstAs<ReplyRow>(db.from('replies').select('*').eq('id', replyId), 'read reply for delete');
  if (!reply) throw notFound('reply_not_found', '找不到这条回信。');
  const post = await firstAs<PoolPostRow>(
    db.from('pool_posts').select('*').eq('id', String(reply.post_id ?? '')),
    'read reply post',
  );
  const isReplyAuthor = String(reply.author_id ?? '') === principal.userId;
  const isPostAuthor = post !== null && String(post.author_id ?? '') === principal.userId;
  if (!isReplyAuthor && !isPostAuthor) throw forbidden('not_reply_owner', '只有回信作者或帖主能删除。');

  if (String(reply.status ?? '') === 'deleted') {
    return { reply_id: replyId, status: 'deleted', deleted_at: reply.deleted_at ?? null };
  }
  const timestamp = now.toISOString();
  await affected(
    db.from('replies').update({ status: 'deleted', deleted_at: timestamp, updated_at: timestamp })
      .eq('id', replyId).neq('status', 'deleted'),
    'delete reply',
  );
  if (post) await refreshReplyCount(db, String(post.id), now);
  return { reply_id: replyId, status: 'deleted', deleted_at: timestamp };
}

export function toReplyDto(reply: ReplyRow): Record<string, unknown> {
  return {
    id: reply.id,
    content: String(reply.content ?? ''),
    display_label: '打气搭子',
    created_at: reply.created_at,
  };
}

