-- 迁移 0007｜AI 辅助建议缓存（1 张表）
-- 目的：相同用户 + 相同能力 + 相同输入只调用一次模型，重复请求直接回放建议，避免重复计费。
-- 只缓存建议文本，不缓存愿签内容；AI 结果永远只是建议，写入愿签必须由用户再次确认。
-- 过期行惰性清理（读路径判定 expires_at），无定时任务与触发器。

CREATE TABLE app.ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- 能力位：本轮只有 polish_wish；任务候选/回信草稿/信件草稿预留同一张缓存表
  capability text NOT NULL,
  -- SHA-256(能力 + 提示词版本 + 脱敏输入 + 关系 + 愿望类型)，同一输入稳定命中
  input_hash text NOT NULL,
  -- 脱敏后的输入留痕（不含联系方式与长数字），便于排查而不泄露原文
  input_redacted text NOT NULL DEFAULT '',
  -- 建议数组（3 条以内、单条 ≤60 字由 Function 校验），只存文本
  suggestions jsonb,
  -- agent / template：模板兜底不消耗额度
  source text NOT NULL DEFAULT 'template',
  -- timeout / agent_error / invalid_output / quota_exceeded，成功时为空串
  fallback_reason text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 同一用户同一能力的同一输入只有一条缓存
  UNIQUE (user_id, capability, input_hash)
);

-- 日额度计数：只看 agent 来源
CREATE INDEX ai_suggestions_user_source_created_at_idx ON app.ai_suggestions (user_id, source, created_at);
CREATE INDEX ai_suggestions_user_created_at_idx ON app.ai_suggestions (user_id, created_at);
CREATE INDEX ai_suggestions_expires_at_idx ON app.ai_suggestions (expires_at);
