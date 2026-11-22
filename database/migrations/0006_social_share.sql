-- 迁移 0006｜公开池、分享与演示（5 张表）
-- 公开池最简版：发布即公开，只支持举报隐藏，不做人工审核队列（第 1 轮范围约定）。
-- 分享页是公开出口：响应字段必须走白名单投影，五问答案与账本明细永不出现在这张表之外。

CREATE TABLE app.pool_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL,
  -- 作者：允许匿名展示，但归属必须可追溯（举报与自查用）
  author_id uuid NOT NULL,
  -- 愿望类型六类之一（PRD 5.2），公开池按它筛选；'' = 作者未公开该字段
  wish_type text NOT NULL DEFAULT '',
  -- 关系：12 种之一，与 wishes.relation 同源；'' 表示不公开
  relation text NOT NULL DEFAULT '',
  -- 公开摘要 ≤120 字（docs/02 §9）：服务端从 title 派生，剔除真实姓名与联系方式
  excerpt text NOT NULL,
  -- 展示名：匿名时为「TA 的搭子」等确定性昵称，真名永不出现
  display_label text NOT NULL DEFAULT '',
  -- published / hidden / deleted（hidden 由举报阈值自动触发）
  status text NOT NULL DEFAULT 'published',
  is_anonymous boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  report_count integer NOT NULL DEFAULT 0,
  reply_count integer NOT NULL DEFAULT 0,
  fork_count integer NOT NULL DEFAULT 0,
  forked_from_id uuid,
  published_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 一个契约最多一条公开池帖子，重复发布走更新
  UNIQUE (wish_id)
);

-- 公开池主列表：最新优先
CREATE INDEX pool_posts_status_published_at_idx ON app.pool_posts (status, published_at);
CREATE INDEX pool_posts_wish_type_published_at_idx ON app.pool_posts (wish_type, published_at);
-- 「大家都在打气的笨蛋契约」排序
CREATE INDEX pool_posts_status_reply_idx ON app.pool_posts (status, reply_count);
CREATE INDEX pool_posts_author_created_at_idx ON app.pool_posts (author_id, created_at);
CREATE INDEX pool_posts_forked_from_idx ON app.pool_posts (forked_from_id);

CREATE TABLE app.replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  wish_id uuid NOT NULL,
  author_id uuid NOT NULL,
  -- 打气内容 ≤80 字（docs/02 §9），服务端做敏感词与联系方式过滤
  content text NOT NULL,
  -- published / hidden / deleted
  status text NOT NULL DEFAULT 'published',
  is_demo boolean NOT NULL DEFAULT false,
  report_count integer NOT NULL DEFAULT 0,
  -- 作者是否已读（红点）
  read_at timestamptz,
  hidden_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX replies_post_created_at_idx ON app.replies (post_id, created_at);
CREATE INDEX replies_author_created_at_idx ON app.replies (author_id, created_at);
CREATE INDEX replies_status_created_at_idx ON app.replies (status, created_at);
CREATE INDEX replies_wish_created_at_idx ON app.replies (wish_id, created_at);
-- 限流：20 条/天 + 同帖 1 条/天
CREATE INDEX replies_post_author_created_idx ON app.replies (post_id, author_id, created_at);

CREATE TABLE app.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- pool_post / reply / wish
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  reporter_id uuid NOT NULL,
  -- 举报原因码：privacy / harassment / illegal / spam / sexual / other
  reason_code text NOT NULL,
  detail text NOT NULL DEFAULT '',
  -- open / acted / dismissed：本轮只到 acted（自动隐藏），无人工工作台
  status text NOT NULL DEFAULT 'open',
  action_taken text NOT NULL DEFAULT '',
  acted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 同一举报人对同一目标只记一次，重复举报不叠加阈值
  UNIQUE (target_type, target_id, reporter_id)
);

CREATE INDEX reports_target_created_at_idx ON app.reports (target_type, target_id, created_at);
CREATE INDEX reports_reporter_created_at_idx ON app.reports (reporter_id, created_at);
CREATE INDEX reports_status_created_at_idx ON app.reports (status, created_at);

CREATE TABLE app.share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- 对外 token：26 位 Crockford Base32（128bit），URL 里出现，不进日志
  token text NOT NULL,
  -- link_only 仅链接可见 / public 进入公开索引
  visibility text NOT NULL DEFAULT 'link_only',
  -- 公开字段白名单开关：{ tasks, ledger_summary, letter, avatar }，服务端按此投影
  include_flags jsonb,
  -- 访问口令（【加密存储】HMAC-SHA256 摘要，明文只在设置时展示一次）
  passphrase_hash text NOT NULL DEFAULT '',
  share_file_id uuid,
  -- active / revoked / expired
  status text NOT NULL DEFAULT 'active',
  -- 可重算派生列：浏览数只做展示，允许少量丢失，不承载业务判定
  visits integer NOT NULL DEFAULT 0,
  last_visited_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wish_id),
  UNIQUE (token)
);

CREATE INDEX share_links_user_created_at_idx ON app.share_links (user_id, created_at);
CREATE INDEX share_links_status_idx ON app.share_links (status);

CREATE TABLE app.demo_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  scenario text NOT NULL DEFAULT 'mom_knee',
  step integer NOT NULL DEFAULT 1,
  state jsonb,
  -- 【不可逆摘要】按 IP 限演示次数（30 次/小时），可信 client-ip 未验证 ⇒ 阈值从宽
  ip_hash text NOT NULL DEFAULT '',
  is_completed boolean NOT NULL DEFAULT false,
  -- 24 小时后视为过期；无定时任务，读路径判定 + 惰性删除
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX demo_sessions_ip_created_at_idx ON app.demo_sessions (ip_hash, created_at);
CREATE INDEX demo_sessions_expires_at_idx ON app.demo_sessions (expires_at);
