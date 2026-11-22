-- 迁移 0002｜配置表（4 张表：愿望模板 / 任务模板 / 礼物 / 文件）
-- 配置数据由 database/seed/*.json 经服务端写入，迁移脚本内不含任何 INSERT（平台禁止 DML）。
-- 无外键：引用完整性由「关联列建索引 + 服务端归属校验」保证（平台子集按最小公分母写）。
--
-- 词表与 PRD 保持一致，避免「两套枚举对不上」：
--   relation     = PRD 4.2 B-02 的 12 种关系（直接存中文，见 seed/README.md 的取舍说明）
--   wish_type    = PRD 5.2 的六类：body / sleep / lonely / study / emotion / life
--   side         = PRD 5.3 的三档：for_ta（为 TA）/ for_self（为自己）/ money（钱任务）
--   category     = PRD 5.4 的四类：health / company / life / heart

CREATE TABLE app.wish_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 12 种关系之一；PRD 6.1 记作 relation_code，此处改存中文原值，与 wishes.relation 同域
  relation text NOT NULL,
  -- 六类愿望之一；'' = 该模板不限类型（自定义愿望兜底时用）
  wish_type text NOT NULL DEFAULT '',
  -- 模板文案：第一人称「我想…」，15~60 字，服务端 trim + 长度校验
  content text NOT NULL,
  -- 语气标签：PRD 5.1 的亲近/克制/具体等，仅用于「换一批」时同语气优先
  tone text NOT NULL DEFAULT '',
  -- 批次号：运营换池时递增，旧批次置 is_active = false，历史愿望仍可回显
  batch integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 「某关系可展示的模板」主查询
CREATE INDEX wish_templates_active_relation_idx ON app.wish_templates (is_active, relation);
CREATE INDEX wish_templates_active_type_idx ON app.wish_templates (is_active, wish_type);

CREATE TABLE app.task_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 六类愿望之一；'any' 表示通用（自定义愿望未被关键词命中时的兜底池）
  wish_type text NOT NULL,
  -- 关系专属模板；NULL = 通用池（任何关系都可取），非 NULL = 只有该关系才进候选
  relation text,
  -- for_ta / for_self / money（PRD 5.3：每天一件为 TA、一件为自己；钱任务周末可选）
  side text NOT NULL,
  -- 任务文案：第二人称祈使句，≤60 字
  text text NOT NULL,
  -- 需要的佐证：photo / screenshot / voice / none
  proof_kind text NOT NULL DEFAULT 'photo',
  -- 建议时段：morning / daytime / evening / any，只影响展示顺序，不做校验
  time_slot text NOT NULL DEFAULT 'any',
  -- 只在周末出现：引擎按「周末追加钱任务」调度，因此本列只标在 side='money' 上；
  -- 必做两条不区分工作日，给它们标 true 会让工作日抽不到候选
  weekend_only boolean NOT NULL DEFAULT false,
  -- 钱任务的最低金额（单位：分）；非钱任务恒为 0
  min_budget_cents integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 任务生成主查询：按 (启用, 愿望类型, 档位) 取候选池
CREATE INDEX task_templates_pool_idx ON app.task_templates (is_active, wish_type, side);
-- 关系专属优先、通用兜底：这一步在函数里做，索引只负责定位
CREATE INDEX task_templates_relation_idx ON app.task_templates (relation);

CREATE TABLE app.rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 四类：health 健康 / company 陪伴 / life 生活 / heart 心意（PRD 5.4）
  category text NOT NULL,
  title text NOT NULL,
  -- 展示用的匹配说明，例如「差额不够时加的一件」
  note text NOT NULL DEFAULT '',
  -- 价格区间（单位：分）。PRD：区间在结算前不可见，因此读出接口要按状态过滤
  min_cents integer NOT NULL DEFAULT 0,
  max_cents integer NOT NULL DEFAULT 0,
  -- 适配的愿望类型数组（jsonb 不支持迁移期默认值 ⇒ 服务端必填）
  recommend_flags jsonb NOT NULL,
  -- 库存：NULL = 不限库存；本轮只做展示与计数，不做扣减
  stock_left integer,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 礼物匹配主查询：先按启停与类别筛，再在函数内比较价格区间
CREATE INDEX rewards_active_category_idx ON app.rewards (is_active, category);
CREATE INDEX rewards_price_idx ON app.rewards (min_cents, max_cents);

CREATE TABLE app.files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  wish_id uuid,
  -- checkin_proof / signature / avatar / export
  purpose text NOT NULL,
  -- 对象存储 key：u/<userId>/<purpose>/<fileId>，服务端派生，客户端不可指定
  object_key text NOT NULL,
  -- pending / ready / rejected / deleted
  status text NOT NULL DEFAULT 'pending',
  mime_type text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0,
  width integer NOT NULL DEFAULT 0,
  height integer NOT NULL DEFAULT 0,
  sha256 text NOT NULL DEFAULT '',
  is_public boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_key)
);

CREATE INDEX files_user_created_at_idx ON app.files (user_id, created_at);
CREATE INDEX files_wish_idx ON app.files (wish_id);
-- 惰性清理：过期 pending 与软删文件按此索引扫描
CREATE INDEX files_status_expires_at_idx ON app.files (status, expires_at);
