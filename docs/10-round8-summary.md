# 第 8 轮开发总结 · AI 辅助与演示模式

> 范围：AI 辅助接口（P0 愿望润色）+ 演示模式模块。
> 约束：复用既有路由/校验/幂等/限流/错误码与全部确定性业务引擎；AI 只出建议、不写业务表；演示数据与真实数据 100% 隔离。
> 结果：新增 6 条路由（AI 1 + 演示 5）、1 个迁移（`0007_ai.sql`）、1 张表（`ai_suggestions`）；累计 **41 条路由 / 7 个迁移 / 98 条语句 / 22 张表 / 461 项冒烟断言**。

---

## 1. 本轮交付

### 1.1 AI 辅助（P0 愿望润色）

| 项 | 实现 |
| --- | --- |
| 路由 | `POST /api/ai/polish-wish`，Bearer + 真实账号，`operation=ai.polish`，`idempotent=optional`，`maxBodyBytes=2048` |
| 入参 | `wish_text`（1–120 字，必填）、`relation`（12 关系枚举，可选）、`wish_type`（六类枚举，可选；缺省由关键词分类器推断） |
| 出参 | `ai_assisted:true`、`ai_label:"AI辅助"`、`label_required:true`、`capability`、3 条 `{id,text,label}`、`source(agent/template)`、`fallback`、`fallback_reason`、`model`、`cached`、`input_redacted`、`quota{daily_limit,used,remaining}`、`notice` |
| 领域层 | [backend/domain/ai.ts](../backend/domain/ai.ts)：模板池、适配器、脱敏、缓存、额度、校验、占位能力 |
| 路由层 | [backend/api/ai/polish-wish.ts](../backend/api/ai/polish-wish.ts) |
| 迁移 | [database/migrations/0007_ai.sql](../database/migrations/0007_ai.sql)：`ai_suggestions` + 唯一键 + 3 个索引 |
| 能力占位 | `suggestTaskCandidates` / `draftReply` / `draftLetter` 已导出，调用即 503 `ai_capability_not_implemented`，不注册路由 |

### 1.2 演示模式

| 路由 | 作用 |
| --- | --- |
| `POST /api/demo/session` | 匿名创建独立演示账号 + 基线数据，返回 24h 演示 token、人设与状态 |
| `GET /api/demo/state` | 演示 token 只读当前进度、今日任务、全部任务、账本与结算 |
| `POST /api/demo/fast-forward` | 用真实引擎补 7 天任务/打卡/账本并结算 |
| `POST /api/demo/scenario` | 切换 `double_realized / cyber_only / failed` 并用真实结算重算 |
| `POST /api/demo/reset` | 清空该演示账号的子数据并重建基线 |

领域层 [backend/domain/demo.ts](../backend/domain/demo.ts)，路由在 [backend/api/demo/](../backend/api/demo/)。

---

## 2. AI 规则

### 2.1 只建议、不代写

- `polishWish` 只读缓存/模板/适配器，**不写 `wishes` 或 `wish_answers`**；用户点选后仍走原有愿签编辑接口。
- 每条建议与顶层都带「AI辅助」标签，且 `label_required=true`；`notice` 明确提示"需要你确认后才会写入"。
- 演示身份调用直接 403 `demo_forbidden`：既不调用模型，也不占真实额度。

### 2.2 适配器与兜底

- 领域层只依赖 `AiAdapter { name, generate(input, signal) }`；解析顺序：测试注入 → `AI_AGENT_ENDPOINT` → 确定性模板。
- 端点调用有 `AI_TIMEOUT_MS`（默认 8s）超时；HTTP 非 2xx、响应缺 `suggestions`、字段类型不对都归为 `agent_error`。
- 四类失败统一回模板并置 `fallback:true`：
  - `timeout`：超时；
  - `agent_error`：调用异常/响应格式坏；
  - `invalid_output`：模型返回的建议没通过校验；
  - `quota_exceeded`：当日 agent 调用额度用尽。
- 模板也是确定性内容，返回前同样过校验；模板被改坏时返回 503 `ai_template_invalid`，不返回脏数据。

### 2.3 脱敏与输出校验

- 进入模型前用 `redactSensitive` 替换联系方式与长数字；缓存键只使用脱敏文本 + 关系 + 类型 + 提示词版本，不存原文。
- 输出必须**恰好 3 条**、每条 **1–60 字**、互不重复、不含联系方式/URL；任一条不合格整包丢弃并回退模板。
- 响应只回 `input_redacted` 布尔，不回脱敏前后文本；五问答案从不进入提示词。

### 2.4 额度与缓存

- `AI_POLISH_PER_DAY` 默认 20/产品日，只统计 `ai_suggestions.source='agent'` 的行；模板兜底不消耗额度。
- 相同用户 + 相同能力 + 相同输入命中 `(user_id, capability, input_hash)` 唯一缓存，返回 `cached:true`，不重复调用、不重复计费。
- 缓存 TTL 由 `AI_CACHE_TTL_HOURS`（默认 72h）控制；过期或内容损坏在下次命中时删除并重算。
- 并发首写用 `insertIfAbsent`；落败请求回读胜者结果。额度耗尽时同一输入仍返回已缓存的模板结果。

---

## 3. 演示模式与隔离

### 3.1 基线数据

- 新建 `users.is_demo=true` 账号 + `demo_sessions` 行，会话 id 由服务端生成。
- 人设：异地大三学生，替妈妈许愿膝盖疼；契约开始于 2 天前，今天第 3 天；2 条打卡；首周支出 32 元，账本累计 168 元。
- 生成路径全部复用真实引擎：`createWish → saveAnswers → signContract → checkinTask → addLedgerEntry → sweepMissedTasks`，没有 fixture。

### 3.2 快进与三结局

- 快进把时间锚点回拨 8 天（契约结束于 2 天前），逐日调用真实打卡引擎补齐 7 天，按周写支出 32 元与钱任务收入，再调真实 `settleWish`。
- 结局不另写算法，只构造真实判定所需的任务完成形态：
  - `double_realized`：必做与钱任务全部完成；
  - `cyber_only`：必做完成、钱任务未完成；
  - `failed`：必做未完成。
- 冒烟断言结算统计与 `tasks` 行逐项一致，且 `realized_cents = saved_cents + income_cents`，证明演示不是平行实现。

### 3.3 隔离

- **数据隔离**：所有演示行挂在 `is_demo=true` 账号下；真实查询按 `user_id` 过滤，`wishes/pool_posts/replies` 另有 `is_demo` 标记，公开池强制 `is_demo=false`。
- **身份闸门**：演示接口 `requireDemoUser`（真实 token 403 `demo_required`）；AI、分享生成、公开池发布/举报/回信 `requireRealUser`（演示 token 403 `demo_forbidden`）。
- **功能隔离**：演示不能绑定真实账号、不能生成真实分享链、不能发布公开池、不能触发真实 AI。
- **可见性**：真实用户列表、分享页、公开池都读不到演示数据；演示计数不进入任何业务统计。
- **并发**：fast-forward / scenario / reset 先对 `demo_sessions.updated_at` 做单行 CAS，抢不到 409 `demo_session_busy`。
- **TTL**：`DEMO_TTL_HOURS` 默认 24h，过期 401 `demo_session_expired`；新会话创建时惰性清理最多 3 条过期会话（第 9 轮细化为「本 IP 最早到期的 3 条」）。
- **限流**：每 IP `DEMO_PER_HOUR`（默认 30），超限 429 `demo_too_many_sessions`。

---

## 4. 与 PRD / 需求的对照

| 要求 | 落地 |
| --- | --- |
| AI 只做建议、用户确认才写入（G-04） | ✅ 接口不写愿签；点选后走原编辑接口 |
| 全程保留「AI辅助」标签 | ✅ 顶层与每条建议都带；`label_required=true` |
| 失败/超时不阻塞主流程（G-03） | ✅ 四类失败均回模板，HTTP 200 |
| 输入脱敏、输出合规 | ✅ 脱敏后才调模型；输出校验不合格整包丢弃 |
| 每日额度可配置 | ✅ `AI_POLISH_PER_DAY`，只数 agent 行 |
| 相同输入不重复调用/计费 | ✅ 唯一缓存键 + `cached` 标记 |
| 演示模式比赛刚需、与真实数据隔离 | ✅ 独立账号/会话/token，真实接口闸门 + `is_demo` 过滤 |
| 演示逻辑与真实一致 | ✅ 基线、快进、三结局全部复用真实引擎 |
| 演示不可见、不可污染业务表 | ✅ 真实列表/公开池/分享不可见；无全站统计接口 |
| 演示 TTL 24h、按 IP 限流 | ✅ 环境变量控制，惰性清理 |

**偏差**：
1. AI 只落 P0 润色，任务候选/回信草稿/信件草稿仅留 503 占位。
2. 未配置 Agents 端点时一律走模板；真实端点协议未联调。
3. 演示只做 5 条接口，未做 `GET /api/demo/scenario?static=1` 与六步逐步 ACK。
4. 快进固定 7 天契约、起始回拨 8 天，不支持任意时长。
5. 演示人设与金额由服务端固定文案 + 真实引擎推算，不是可配置剧本。
6. 演示数据写真实业务表，靠 `is_demo` 过滤；过期清理惰性且每次最多 3 条（第 9 轮限定为本 IP 最早到期的 3 条）。

---

## 5. 测试与验证

| 项 | 结果 |
| --- | --- |
| `tools/local/smoke.ts` | **461 passed / 0 failed** |
| `check-routes.ts` | 41 条路由自洽，operation 不重复 |
| `check-migrations.ts` | 7 文件 / 98 语句 / 22 表，全部在平台子集 |
| `check-schema-usage.ts` | 代码表名/列名/写入键均在 DDL 中 |
| `build-seeds.ts --check` | 72 / 120 / 24，形状不变 |
| `tsc --strict` | 退出码 0（`.tscheck/`） |
| Deno `deno task verify` | **未执行**：本机未安装 Deno |

**AI 用例**：模板 3 条带标签、≤60 字；未写愿签；401/400；手机号脱敏；agent `used=1`；同输入缓存且模型只调一次；额度 1 时第二个输入回模板 + `quota_exceeded`；幂等键重放；超时 → `timeout`；抛错 → `agent_error`；坏输出 → `invalid_output`；全部 HTTP 200 且仍有 3 条标签。

**演示用例**：会话 201、24h TTL、`is_demo`；人设与 168 元基线；今日任务；真实 token 403 `demo_required`；演示分享/公开池/AI 403 `demo_forbidden`；真实列表不含演示愿签；快进结算统计与任务行一致；`realized = saved + income`；三结局形态正确；重复快进不重复生成；非法场景 400；重置回基线；25h 后 401；新会话清理旧会话；`DEMO_PER_HOUR=1` 第二会话 429。

---

## 6. 残余风险

1. **AI 真实端点未联调**：返回结构、限流、计费、真实延迟均未在云端验证；失败会稳定回退模板。
2. **标签展示不可控**：服务端强制返回「AI辅助」，前端是否原样展示需客户端联调。
3. **演示数据长期残留**：过期会话只在下次创建时清 3 条；无人再创建演示会留下过期账号与子表。
4. **0007 未上云**：`ai_suggestions` 仅在本地 FakeDb 验证；未执行 0007 前 AI 接口会因缺表失败。
5. **统计口径**：当前无全站统计接口；将来加运营报表必须排除 `is_demo`。
6. **AI 缓存堆积**：不同输入产生的过期缓存无人再次请求时不会主动清理，需要离线清扫。
7. **演示继承结算并发风险**：快进/切结局调用真实 `settleWish`，同样受结算 60 秒陈旧租约与 `updated_at` 精度影响。

---

## 7. 文件清单

- 新增：`backend/domain/ai.ts`、`backend/api/ai/polish-wish.ts`、`backend/domain/demo.ts`、`backend/api/demo/{session,state,fast-forward,scenario,reset}.ts`、`database/migrations/0007_ai.sql`、`docs/10-round8-summary.md`
- 修改：`backend/api/manifest.ts`（注册 6 条）、`backend/lib/types.ts`（`AiAdapter` 等）、`backend/lib/config.ts`（AI/演示变量）、`backend/index.ts` / `backend/server.ts`（注入适配器）、`tools/local/fake-db.ts`（`ai_suggestions` 唯一键）、`tools/local/smoke.ts`（第 15 节）、`README.md`、`docs/01`、`docs/03`、`docs/04`、`docs/05`、`database/migrations/README.md`

## 8. 下一轮建议

结算后续（ACK/信件定稿/兑现卡图）、AI 其余三种能力与真实 Agents 联调、演示静态兜底、公开池接力与"我的发布/回信"、端到端验收与上云真库复验。云端迁移（含 0007）与 seed 导入仍待授权。