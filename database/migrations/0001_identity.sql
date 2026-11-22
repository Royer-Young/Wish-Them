-- 迁移 0001｜身份与会话（4 张表）
-- 目标平台：Qoder Sites Database（PostgreSQL 子集）
-- 约束：只用 boolean/integer/bigint/text/uuid/timestamptz/jsonb；
--       不用 date/numeric/varchar(n)/CHECK/触发器/外键；默认值只允许字面量与 gen_random_uuid()/now()。
-- 说明：所有表都有 id 主键 + created_at + updated_at；关联字段只建索引，不建外键。

CREATE TABLE app.users (
  id uuid PRIMARY KEY,
  -- 昵称 1~32 字符，服务端 trim；不做重名判定
  nickname text NOT NULL,
  -- 只允许 default_01..default_12 内置头像，禁止外链
  avatar text NOT NULL DEFAULT 'default_01',
  -- 注册入口：web / mp / app
  client text NOT NULL DEFAULT 'web',
  -- active / frozen / deleted（frozen 与 deleted 由后续运营侧写入，本轮只读判定）
  status text NOT NULL DEFAULT 'active',
  -- 演示身份：true 时该账号及其全部下游数据与真实数据隔离
  is_demo boolean NOT NULL DEFAULT false,
  -- 【加密存储】恢复码 = HMAC-SHA256(RECOVERY_PEPPER, 归一化后的码)，明文永不落库；唯一索引兜底防撞码
  recovery_code_hash text NOT NULL,
  reg_channel text,
  -- 【不可逆摘要】注册 IP 的 HMAC 摘要，仅用于同主体重复注册判定，不作为安全边界
  reg_ip_hash text,
  profile_text text,
  -- 风格标签数组（≤3 项），jsonb 无法在迁移期建默认值 ⇒ 由服务端写入
  wish_style_tags jsonb,
  share_default_public boolean NOT NULL DEFAULT true,
  -- 通知偏好：{ quiet_hours: { start, end } }，推送通道属后续迭代
  settings jsonb,
  last_active_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 平台不接受 CREATE UNIQUE INDEX ⇒ 唯一性一律用建表期表级 UNIQUE 表达（约束名由数据库生成）
  UNIQUE (recovery_code_hash)
);

CREATE INDEX users_status_created_at_idx ON app.users (status, created_at);
-- 同 IP 每小时注册数（lib/quota.ts 时间窗扫描）
CREATE INDEX users_reg_ip_created_at_idx ON app.users (reg_ip_hash, created_at);
CREATE INDEX users_created_at_idx ON app.users (created_at);

CREATE TABLE app.auth_tokens (
  id uuid PRIMARY KEY,
  -- app.auth_tokens.id 即 JWT 的 jti ⇒ 撤销这行就等于让 token 立即失效
  user_id uuid NOT NULL,
  client text NOT NULL DEFAULT 'web',
  -- 冗余 users.is_demo，鉴权时可少一次查询
  demo boolean NOT NULL DEFAULT false,
  -- active / revoked：JWT 无法单方作废，靠这两态实现即时退出
  status text NOT NULL DEFAULT 'active',
  -- 【不可逆摘要】HMAC-SHA256(TOKEN_PEPPER, header.payload)，仅用于审计比对，不参与鉴权
  token_hash text NOT NULL,
  last_seen_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_tokens_user_status_idx ON app.auth_tokens (user_id, status);
CREATE INDEX auth_tokens_status_expires_at_idx ON app.auth_tokens (status, expires_at);
CREATE INDEX auth_tokens_token_hash_idx ON app.auth_tokens (token_hash);

CREATE TABLE app.auth_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- guest / recover：本轮只写 recover 失败与成功计数
  kind text NOT NULL,
  -- 【不可逆摘要】按 IP 摘要限频（12/小时），可信 client-ip 未验证 ⇒ 阈值从宽
  ip_hash text,
  user_id uuid,
  succeeded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_attempts_kind_ip_created_at_idx ON app.auth_attempts (kind, ip_hash, created_at);
CREATE INDEX auth_attempts_created_at_idx ON app.auth_attempts (created_at);

-- 幂等表：平台「多次 SDK 调用不构成事务」，写操作的可重复性全部收敛到这里
CREATE TABLE app.idempotency_keys (
  id uuid PRIMARY KEY,
  -- u:<userId>（已登录）/ i:<ipHash>（游客）/ a:anon（兜底），见 server.ts#idempotencySubject
  principal text NOT NULL,
  -- 与 RouteDef.operation 一一对应，例如 wish.create
  operation text NOT NULL,
  idempotency_key uuid NOT NULL,
  -- 【摘要】HMAC(method + 逻辑路径 + 规范化 body)，同键不同内容 → 409
  request_fingerprint text NOT NULL,
  -- in_progress / succeeded / failed
  status text NOT NULL DEFAULT 'in_progress',
  -- 响应状态码：201 重放不能变 200
  response_code integer,
  -- 重放用响应存档（≤64KB，要盖住 30 天契约的全量任务响应）。含 access_token / 恢复码 的接口一律 idempotent='none'，
  -- 因此本列不会存一次性凭证；后续若要存档敏感字段，改为写 v1:<iv>:<tag>:<ciphertext> 密文。
  response_body text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal, operation, idempotency_key)
);

-- 保留期 7 天：平台没有定时任务，由 Function 实例冷启动时按 created_at 清一次（server.ts）
CREATE INDEX idempotency_keys_created_at_idx ON app.idempotency_keys (created_at);
