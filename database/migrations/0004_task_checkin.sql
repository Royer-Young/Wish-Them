-- 迁移 0004｜任务与打卡（2 张表）
-- 任务由确定性规则生成（seed = SHA-256(wish_id)），模板池只影响候选集，AI 不参与写库。
-- 打卡的重复提交由 checkins 表级 UNIQUE(task_id) 兜底：这是「幂等表之外」的第二道防线，不依赖事务。

CREATE TABLE app.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- 契约内第几天（0 起，与接口 day_index 同口径；展示「第 N 天」时 +1）
  day_index integer NOT NULL,
  -- 计划日期 YYYY-MM-DD（产品日语义，04:00 为界）
  task_date text NOT NULL,
  week_start text NOT NULL DEFAULT '',
  -- for_ta / for_self / money：与 task_templates.side 同域，实例化时复制
  side text NOT NULL DEFAULT 'for_ta',
  -- 同日多任务时的展示顺序（必做在前）
  seq integer NOT NULL DEFAULT 1,
  -- 任务文案：实例化时从模板复制，用户后续改不动（改文案等于换任务）
  -- 候选池耗尽时生成轮转副本，文案追加「（第 N 轮）」⇒ 同一愿签内 text 仍然唯一
  text text NOT NULL,
  -- 需要的佐证：photo / screenshot / voice / none，复制自模板
  proof_kind text NOT NULL DEFAULT 'photo',
  -- 建议时段：morning / daytime / evening / any，复制自模板
  time_slot text NOT NULL DEFAULT 'any',
  -- 钱任务的最低金额（单位：分）；非钱任务为 0
  min_budget_cents integer NOT NULL DEFAULT 0,
  -- 来源模板；长期契约轮转复制出来的副本为 NULL（UNIQUE 允许多个 NULL）
  template_id uuid,
  -- 同一模板的第几轮复制，用于长期契约去重
  rotation integer NOT NULL DEFAULT 0,
  -- 必做任务计入「必做完成率」，可选任务只计入完成数
  is_must boolean NOT NULL DEFAULT false,
  -- 给自己的任务：不计入「替 TA 做」的统计（结算页单独给一段小结）
  is_for_self boolean NOT NULL DEFAULT false,
  -- pending / done / missed / made_up / revoked
  status text NOT NULL DEFAULT 'pending',
  done_at timestamptz,
  missed_at timestamptz,
  made_up_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 一个契约内同一模板只出现一次；轮转副本 template_id 为 NULL，不受此约束（PG 默认 NULLS DISTINCT）
  UNIQUE (wish_id, template_id),
  -- 「同一愿签内任务标题不重复」是 PRD 5.3 的硬要求：生成器自己保证一次，这里再由数据库兜一次
  -- （轮转副本的文案带「（第 N 轮）」后缀，因此 text 也天然唯一）
  UNIQUE (wish_id, text)
);

-- 今日任务列表（主查询：按契约 + 日期）
CREATE INDEX tasks_wish_date_idx ON app.tasks (wish_id, task_date);
CREATE INDEX tasks_wish_day_idx ON app.tasks (wish_id, day_index);
CREATE INDEX tasks_user_status_idx ON app.tasks (user_id, status);
-- 惰性过期：跨过 04:00 后把当天之前的 pending 标成 missed
CREATE INDEX tasks_status_date_idx ON app.tasks (status, task_date);
CREATE INDEX tasks_template_idx ON app.tasks (template_id);
CREATE INDEX tasks_created_at_idx ON app.tasks (created_at);

CREATE TABLE app.checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  wish_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- 证明图片（对象存储只在 files 表记 file_id，本表只存关联与摘要）
  proof_file_id uuid,
  -- 图片内容摘要：同图重复提交检测，不做内容审核（PRD 简化口径）
  proof_sha256 text NOT NULL DEFAULT '',
  -- 可选备注 ≤30 字（docs/02 §9）
  note text NOT NULL DEFAULT '',
  -- 补卡：用 makeup_tickets 换的，计入完成但不计入连续
  is_makeup boolean NOT NULL DEFAULT false,
  -- 线下完成（口头告知 TA）而非线上留痕
  channel text NOT NULL DEFAULT 'online',
  -- 实际打卡的产品日 YYYY-MM-DD（补卡时是补卡当天，任务日期看 tasks.task_date）
  checkin_date text NOT NULL DEFAULT '',
  -- 客户端时间只作参考，一切判定用 server_ts
  client_ts timestamptz,
  server_ts timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 一个任务一条有效打卡；撤销后重新打卡走同一行更新
  UNIQUE (task_id)
);

CREATE INDEX checkins_wish_server_ts_idx ON app.checkins (wish_id, server_ts);
CREATE INDEX checkins_user_server_ts_idx ON app.checkins (user_id, server_ts);
-- 限流（10 次/分钟）与"同图重复"检测
CREATE INDEX checkins_user_created_at_idx ON app.checkins (user_id, created_at);
CREATE INDEX checkins_proof_file_idx ON app.checkins (proof_file_id);
CREATE INDEX checkins_proof_sha_idx ON app.checkins (proof_sha256);
CREATE INDEX checkins_created_at_idx ON app.checkins (created_at);
