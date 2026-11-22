-- 迁移 0005｜账本与结算（3 张表）
-- 金额全部整数分；账本汇总不依赖触发器：写流水后重算所在周（可重算派生列），
-- 崩溃窗口内出现的偏差由「读时校验 + 重算」修复，结算快照再固化一次。

CREATE TABLE app.ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- 所属自然周（周一）
  week_start text NOT NULL,
  -- expense 为 TA 花的钱 / saved 为省下的钱 / earned 为给自己的奖励 / self_spend 给自己的花费
  entry_kind text NOT NULL,
  -- 单位：分，恒为正数；方向由 entry_kind 决定（避免符号歧义）
  amount_cents integer NOT NULL,
  note text NOT NULL DEFAULT '',
  proof_file_id uuid,
  -- 由哪次打卡带出的流水；手工记账为 NULL
  task_id uuid,
  checkin_id uuid,
  -- manual / checkin / settlement
  source text NOT NULL DEFAULT 'manual',
  -- 撤销标记：不物理删除，账本要能自证
  revoked_at timestamptz,
  server_ts timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 周汇总重算入口（单条 SQL：按 wish_id + week_start 取未撤销流水）
CREATE INDEX ledger_entries_wish_week_idx ON app.ledger_entries (wish_id, week_start);
CREATE INDEX ledger_entries_user_server_ts_idx ON app.ledger_entries (user_id, server_ts);
CREATE INDEX ledger_entries_task_idx ON app.ledger_entries (task_id);
CREATE INDEX ledger_entries_checkin_idx ON app.ledger_entries (checkin_id);
CREATE INDEX ledger_entries_proof_file_idx ON app.ledger_entries (proof_file_id);
CREATE INDEX ledger_entries_created_at_idx ON app.ledger_entries (created_at);

CREATE TABLE app.ledger_weeks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL,
  user_id uuid NOT NULL,
  week_start text NOT NULL,
  week_index integer NOT NULL DEFAULT 1,
  -- 该周预算（契约预算平摊到周，最后不足一周按剩余天数）
  budget_cents integer NOT NULL DEFAULT 0,
  spent_cents integer NOT NULL DEFAULT 0,
  saved_cents integer NOT NULL DEFAULT 0,
  earned_cents integer NOT NULL DEFAULT 0,
  -- 本周流水是否已计入（重算幂等标记）
  counted boolean NOT NULL DEFAULT false,
  over_budget boolean NOT NULL DEFAULT false,
  -- 超额截图（PRD 3.5：超预算只需上传一张小票截图）
  proof_file_id uuid,
  -- 重算时刻：与 ledger_entries.max(created_at) 比较即可判断是否需要重算
  computed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wish_id, week_start)
);

CREATE INDEX ledger_weeks_user_week_idx ON app.ledger_weeks (user_id, week_start);
CREATE INDEX ledger_weeks_wish_idx ON app.ledger_weeks (wish_id);

CREATE TABLE app.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- 同一契约可重算（封存前），version 递增；UNIQUE 保证并发只有一版成功
  version integer NOT NULL DEFAULT 1,
  -- double_realized 双向奔赴 / cyber_only 电子受难日 / unrealized 未完成
  outcome text NOT NULL DEFAULT '',
  -- 汇总数字（不依赖流水重算即可展示，快照语义）
  must_total integer NOT NULL DEFAULT 0,
  must_done integer NOT NULL DEFAULT 0,
  money_total integer NOT NULL DEFAULT 0,
  money_done integer NOT NULL DEFAULT 0,
  checkin_count integer NOT NULL DEFAULT 0,
  makeup_count integer NOT NULL DEFAULT 0,
  budget_cents integer NOT NULL DEFAULT 0,
  spent_cents integer NOT NULL DEFAULT 0,
  saved_cents integer NOT NULL DEFAULT 0,
  earned_cents integer NOT NULL DEFAULT 0,
  -- 可兑换额度 = saved + earned，礼物匹配的唯一依据
  total_cents integer NOT NULL DEFAULT 0,
  reward_id uuid,
  -- 结算时锁定的礼物价区间快照（rewards 改名或下架也不影响历史结算）
  reward_min_cents integer NOT NULL DEFAULT 0,
  reward_max_cents integer NOT NULL DEFAULT 0,
  -- 缺口 = 礼物价 − 可兑换额度；gap_band: surplus / exact / near / far
  gap_cents integer NOT NULL DEFAULT 0,
  gap_band text NOT NULL DEFAULT '',
  progress_ratio_bps integer NOT NULL DEFAULT 0,
  -- 给自己的总结（确定性文案 + 用户微调），jsonb 无迁移期默认值 ⇒ 服务端写入
  self_summary jsonb,
  -- 信件正文（用户可编辑，72 小时封印期内定稿）
  letter_text text NOT NULL DEFAULT '',
  letter_updated_at timestamptz,
  card_file_id uuid,
  letter_file_id uuid,
  -- 封印发分享：sealed 后内容不可再改
  sealed boolean NOT NULL DEFAULT false,
  sealed_at timestamptz,
  revealed_at timestamptz,
  computed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 同一契约可重算（封存前），version 递增；UNIQUE 保证并发只有一版成功
  UNIQUE (wish_id, version)
);

CREATE INDEX settlements_user_created_at_idx ON app.settlements (user_id, created_at);
-- 封印发分享到期扫描（72 小时窗口，惰性触发）
CREATE INDEX settlements_sealed_sealed_at_idx ON app.settlements (sealed, sealed_at);
CREATE INDEX settlements_reward_idx ON app.settlements (reward_id);
CREATE INDEX settlements_created_at_idx ON app.settlements (created_at);
