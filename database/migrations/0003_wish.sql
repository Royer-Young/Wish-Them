-- 迁移 0003｜愿望与五问（3 张表：wishes / wish_answers / makeup_tickets）
-- 归属列统一用 user_id（与第 1 轮 db/schema.sql 命名一致），所有关联列都建索引，不建外键。
-- 日期一律 text(YYYY-MM-DD)、金额一律整数分：平台不支持 date/numeric。

CREATE TABLE app.wishes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- draft → active → settling → settled → archived（PRD 3.3；另有 deleted 软删）
  -- settling 由第 5 轮结算两幕写入，第 3 轮只走 draft → active；settled 后进入 72 小时封印发分享期
  status text NOT NULL DEFAULT 'draft',
  -- 结算三选一：double_realized / cyber_only / unrealized；未结算为 ''
  outcome text NOT NULL DEFAULT '',
  -- 关系：PRD 4.2 B-02 的 12 种之一（妈妈/爸爸/奶奶/爷爷/姥姥/姥爷/室友/闺蜜/兄弟/恋人/老师/一个陌生人）
  -- 与 wish_templates.relation 同域，直接存中文，不引英文码表（避免两套枚举对不上）
  relation text NOT NULL DEFAULT '',
  -- 关系组（PRD 5.1）：parent / peer / intimate / mentor / stranger，决定文案语气与任务倾向
  relation_group text NOT NULL DEFAULT '',
  -- 替 TA 许愿时的对象称呼（不是真实姓名，前端只留昵称，≤8 字）
  target_name text NOT NULL DEFAULT '',
  -- 代词：she / he / they（PRD B-05，默认 TA，可改）
  pronoun text NOT NULL DEFAULT 'they',
  -- 愿望标题 ≤30 字（确定性清洗后的展示文案）
  title text NOT NULL DEFAULT '',
  -- 用户自由输入原文 ≤120 字（PRD B-08 / docs/02 §9），用于分类与回显；不含五问答案
  raw_input text NOT NULL DEFAULT '',
  wish_type text NOT NULL DEFAULT '',
  -- 分类器判定的类型与置信度（basis points，0~10000；numeric 不支持 ⇒ 整数存基点）
  classifier_type text NOT NULL DEFAULT '',
  classifier_confidence_bps integer NOT NULL DEFAULT 0,
  wish_template_id uuid,
  -- 五道种子题展示过的模板 id 数组（用于"换一句"不重复）
  shown_template_ids jsonb,
  -- 五问是否答完（PRD 3.1 完成判定：5 题都选完才生成任务池）
  five_questions_done boolean NOT NULL DEFAULT false,
  days integer NOT NULL DEFAULT 7,
  start_date text NOT NULL DEFAULT '',
  end_date text NOT NULL DEFAULT '',
  weekly_budget_cents integer NOT NULL DEFAULT 0,
  -- 立契方式：typed / drawn / typed_and_drawn / demo
  sign_method text NOT NULL DEFAULT '',
  signature_file_id uuid,
  signed_at timestamptz,
  -- 续愿链：source_wish_id 指向上一个契约，renew_count 记录第几次续
  source_wish_id uuid,
  renew_count integer NOT NULL DEFAULT 0,
  extend_mode text NOT NULL DEFAULT '',
  -- 公开池同款许愿：记录来源帖子，用于"我也许愿"去重与统计
  forked_from_post_id uuid,
  is_public boolean NOT NULL DEFAULT false,
  replies_enabled boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  demo_session_id uuid,
  settled_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  -- 派生列一致性判定用：任何改变任务/打卡/账本的写操作都 +1（单行 CAS）
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 我的契约列表：status + 时间倒序（游标分页取 created_at）
CREATE INDEX wishes_user_status_created_at_idx ON app.wishes (user_id, status, created_at);
-- 结算/提醒扫描：按截止日找待结算契约（惰性结算的主查询）
CREATE INDEX wishes_status_end_date_idx ON app.wishes (status, end_date);
CREATE INDEX wishes_user_created_at_idx ON app.wishes (user_id, created_at);
CREATE INDEX wishes_template_idx ON app.wishes (wish_template_id);
CREATE INDEX wishes_signature_file_idx ON app.wishes (signature_file_id);
CREATE INDEX wishes_source_wish_idx ON app.wishes (source_wish_id);
CREATE INDEX wishes_forked_post_idx ON app.wishes (forked_from_post_id);
CREATE INDEX wishes_demo_session_idx ON app.wishes (demo_session_id);
CREATE INDEX wishes_created_at_idx ON app.wishes (created_at);

CREATE TABLE app.wish_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL,
  user_id uuid NOT NULL,
-- 【加密存储】五问答案全部以 v1:<iv>:<tag>:<ciphertext>（AES-256-GCM，AAD = wish_id）写入 *_enc 列，
  -- 明文只存在于单次请求内存。密钥 FIELD_ENCRYPTION_KEY（Sites Secret），轮换靠 key_version 判定重加密。
  q1_worry_enc text NOT NULL DEFAULT '',
  -- 粗粒度明文档位只保留确定性规则需要的分类信息，不含原话
  q1_gift_category text NOT NULL DEFAULT '',
  q2_alone_enc text NOT NULL DEFAULT '',
  q2_alone_level text NOT NULL DEFAULT '',
  q3_home_enc text NOT NULL DEFAULT '',
  q3_last_home text NOT NULL DEFAULT '',
  q3_travel_band text NOT NULL DEFAULT '',
  q3_cost_band text NOT NULL DEFAULT '',
  q4_disposable_enc text NOT NULL DEFAULT '',
  q4_disposable_band text NOT NULL DEFAULT '',
  q5_gift_enc text NOT NULL DEFAULT '',
  q5_reward_id uuid,
  -- 跳过的题目编号数组（PRD 允许跳过，跳过项按默认档处理）
  skipped jsonb,
  -- 加密密钥版本，便于轮换后判断哪条需要重加密
  key_version text NOT NULL DEFAULT 'v1',
  -- 涉及自伤等敏感表述时用户是否确认「我已看过求助提示」
  health_consent boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 一个契约一份五问；重复提交走幂等重放而不是插第二行
  UNIQUE (wish_id)
);

-- 一个用户可有多个契约 ⇒ 每个契约一份五问，user_id 只建普通索引
CREATE INDEX wish_answers_user_idx ON app.wish_answers (user_id);
CREATE INDEX wish_answers_reward_idx ON app.wish_answers (q5_reward_id);

CREATE TABLE app.makeup_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- 券所属自然周（周一），补卡只能补本周内的漏卡
  week_start text NOT NULL,
  week_index integer NOT NULL DEFAULT 1,
  -- available / used / expired：过期由读路径按 expires_at 判定，无定时任务
  status text NOT NULL DEFAULT 'available',
  task_id uuid,
  used_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 一周最多一张补卡券
  UNIQUE (wish_id, week_start)
);

CREATE INDEX makeup_tickets_wish_status_idx ON app.makeup_tickets (wish_id, status);
CREATE INDEX makeup_tickets_status_expires_at_idx ON app.makeup_tickets (status, expires_at);
CREATE INDEX makeup_tickets_task_idx ON app.makeup_tickets (task_id);
