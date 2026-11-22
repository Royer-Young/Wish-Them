# 迁移脚本执行说明（`database/migrations/`）

7 个批次、22 张表、98 条语句，全部只使用 Qoder Sites 迁移子集
（`CREATE TABLE app.x` / `ALTER TABLE app.x ADD COLUMN` / 普通 `CREATE INDEX`）。
平台**不接受 `CREATE UNIQUE INDEX`**，唯一性一律写进建表期的表级 `UNIQUE (...)`。
本地校验：`node tools/scripts/check-migrations.ts`（校验语句子集、索引引用的列是否存在、索引名重复、LF 换行）。

| 批次 | 表 | 语句 | 大小 | 依赖 |
| --- | --- | --- | --- | --- |
| `0001_identity.sql` | users, auth_tokens, auth_attempts, idempotency_keys | 13 | 5.1 KB | 无 |
| `0002_catalog.sql` | wish_templates, task_templates, rewards, files | 13 | 5.7 KB | 无（配置表，数据走 seed） |
| `0003_wish.sql` | wishes, wish_answers, makeup_tickets | 17 | 6.7 KB | 0001 |
| `0004_task_checkin.sql` | tasks, checkins | 14 | 4.8 KB | 0003 |
| `0005_ledger_settlement.sql` | ledger_entries, ledger_weeks, settlements | 15 | 5.3 KB | 0004 |
| `0006_social_share.sql` | pool_posts, replies, reports, share_links, demo_sessions | 22 | 6.2 KB | 0001、0003 |
| `0007_ai.sql` | ai_suggestions | 4 | 1.8 KB | 0001 |

按编号顺序执行。`0002` 与其他批次无依赖，可提前或并行；但**必须先建表再导入 seed**（见 `../seed/README.md`）。
第 3 轮曾计划的「0007 增量唯一索引」已废弃：平台拒绝 `CREATE UNIQUE INDEX`，`tasks` 的
`UNIQUE (wish_id, text)` 直接写进 `0004_task_checkin.sql` 的建表语句。第 3–7 轮因此没有新表、没有新列；
**第 8 轮新增 `0007_ai.sql`**，只建 `ai_suggestions`（建议缓存 + 额度计数），唯一键
`UNIQUE (user_id, capability, input_hash)` 同样写在建表语句里。**部署含 AI 的 Function 前必须先应用 0007**。

> 每个 `.sql` 文件**必须以换行结尾**：`check-migrations.ts#splitStatements` 按 `/;\s*\n/` 切语句，
> 末行无换行时最后一条语句的分号会留在 chunk 里，被当成「索引尾部不支持的选项」报错。
> 用 Write 类工具落盘后记得确认末尾换行还在。

## 一、执行前提

1. 站点已存在且开通后端能力，`get_site(include: ["backend"])` 返回的 backend 类型为 `function_backend`。
2. Function 打包时声明 `databaseAccess: "read_write"`，并带上一次已验证读取的 `schemaRef`（同一个 projectId）。
3. 每个批次的 SQL 都远小于平台 131072 字符上限；`clientMigrationId`、`displayName` 均 < 128 字符。
4. 迁移里**没有任何 INSERT**：平台只接受 DDL，seed 数据在迁移完成后再导入。

## 二、单批次调用序列

以 `0001_identity.sql` 为例，其余批次只替换 `clientMigrationId` / `displayName` / `sql`。
占位符（`<siteId>`、`<schemaRef>` 等）必须换成真实读取值，不能照抄本文档。

```js
// 1) 读当前结构与 schemaRef（新库返回空结构也要读，用于确认表确实不存在）
get_database_schema({ siteId: <siteId> })
//   → { schemaRef, tables: [] }

// 2) 创建不可变的受限 DDL 计划（不会自动应用）
create_database_migration({
  siteId: <siteId>,
  requestId: <新 UUID，本次写入意图固定>,
  schemaRef: <上一步返回的 schemaRef>,
  clientMigrationId: "yuan-ta-0001-identity",
  displayName: "0001 身份与会话",
  sql: <0001_identity.sql 全文>,
  accessPolicies: [],            // function_backend：留空，由 AppHub 生成固定私有策略
});
//   → { migration: { migration_id, normalized_sql, changes, access_policies }, plan: { planRef } }

// 3) 人工核对返回的 normalized_sql 与 changes（这一步不能省：平台会改写空白与大小写）
// 4) 应用第 2 步审阅过的那一份计划
apply_database_migration({
  migrationId: <migration.migration_id>,
  requestId: <新的 apply 专用 UUID>,
  planRef: <第 2 步返回的 planRef，原样>,
  confirm: true,
});
// 5) 等待 operation 完成，再读一次 schema 验证列与索引真的存在
get_database_schema({ siteId: <siteId> })
```

建议的 `clientMigrationId` / `displayName`（跨批次固定，方便回查）：

| 批次 | clientMigrationId | displayName |
| --- | --- | --- |
| 0001 | `yuan-ta-0001-identity` | 0001 身份与会话 |
| 0002 | `yuan-ta-0002-catalog` | 0002 配置与文件 |
| 0003 | `yuan-ta-0003-wish` | 0003 愿签与五问 |
| 0004 | `yuan-ta-0004-task-checkin` | 0004 任务与打卡 |
| 0005 | `yuan-ta-0005-ledger-settlement` | 0005 账本与结算 |
| 0006 | `yuan-ta-0006-social-share` | 0006 公开池、分享与演示 |
| 0007 | `yuan-ta-0007-ai` | 0007 AI 建议缓存 |

## 三、参数纪律（出错时靠这个恢复，别靠猜）

- `requestId` 标识**这一次写入意图**：结果未知（超时、连接断）时用**同一个 requestId 和完全相同的参数**重试，
  平台会返回同一结果；换了 requestId 再试就可能建出两份计划。
- `schemaRef` 与 `planRef` 必须原样携带，不能改写、不能跨批次复用。
  schema 在读之后又被别人改过 → 计划冲突 → 需要**重新读 schema、新建一个计划**，不是重放旧计划。
- 明确的拒绝（`sites_migration_rejected`）可以改内容后用**新 requestId** 再来一次；
  结果未知则只能按原始 identity 恢复查询，不能盲目重放。
- `accessPolicies` 描述被触碰表的**完整托管状态**：留空 `[]` = 使用 function_backend 的固定私有策略。
  任何时候都不要给这些表加 `anonymous` + `public` 的读授权：五问答案、账本、恢复码摘要都是私有数据，
  所有权判定在 Function 里做（`backend/lib/auth.ts`），不在 RLS 里做。

## 四、迁移后校验

平台不给 psql，结构落地后用 Owner 侧只读的 `query_database_rows` 抽查（它按表名/列名/过滤条件读，不执行任意 SQL）：

```js
query_database_rows({ siteId, tableName: "users", columns: ["id"], limit: 1, countExact: true })          // 0
query_database_rows({ siteId, tableName: "wish_templates", columns: ["id"], limit: 1, countExact: true }) // 导入 seed 前 0，导入后 72
query_database_rows({ siteId, tableName: "task_templates", columns: ["id"], limit: 1, countExact: true }) // 导入 seed 前 0，导入后 120
query_database_rows({ siteId, tableName: "rewards", columns: ["id"], limit: 1, countExact: true })        // 导入 seed 前 0，导入后 24
query_database_rows({ siteId, tableName: "idempotency_keys", columns: ["id"], limit: 1 })                 // 列名可读即结构正确
```

结构层面的抽查（每张表都该满足）：主键 `id`、`created_at`、`updated_at`；关联列都有索引；
唯一性用建表期表级 `UNIQUE (...)` 表达（约束名由数据库生成，文档里的 `_uidx` 只是逻辑代称），例如
`users.recovery_code_hash`、`idempotency_keys (principal, operation, idempotency_key)`、
`checkins (task_id)`、`wish_answers (wish_id)`、`tasks (wish_id, template_id)`、`tasks (wish_id, text)`、
`makeup_tickets (wish_id, week_start)`。

**任务引擎与打卡的两项语义必须实测**（本地 fake 只能模拟，不能证明）：

1. `insertIfAbsent`（`Prefer: resolution=ignore-duplicates`）是否**逐行**跳过冲突并只返回真正插入的行。
   验法：立契后用 Owner 侧 `delete_database_row` 在测试站点删掉一条 `app.tasks` 行，再 `POST /api/wishes/:id/contract` 重签，应当只补回那一条、
   响应 `first_sign=false`、`inserted_tasks=1`。若平台是整批失败，这里会报错而不是补齐。
2. 唯一约束是否允许多个 `NULL`：`tasks (wish_id, template_id)` 靠这条让轮转副本（`template_id=NULL`）共存。
   验法：签一份 30 天契约，检查 `rotation>=1` 的行确实插进去了。
3. 打卡的覆盖语义：同一任务连续提交两次，`checkins` 应始终只有一行、`server_ts` 与 `proof_file_id` 为最后一次。
   验法：`GET /api/wishes/:id/tasks/today` → 对同一任务 `POST /api/tasks/:id/checkin` 两次，再查行数。

## 五、回滚与不可逆

- 平台**不支持** `DROP TABLE` / `DROP COLUMN` / 改列类型 / 触发器 / 自定义函数，所以回滚只有一条路：
  **加性修正 + 代码回退**。
  - 列设计错了：新批次 `ADD COLUMN`（必须可空、无默认值）补正确的列，旧列留着不用；
  - 索引错了：普通索引不能删，只能新建一个更合适的，让规划器改用新索引；
  - 表建错：数据不可信时按站点重建流程走，不要在同一站点里复用错表。
- 因此本项目的惯例是：状态用 `status` 文本列 + `revoked_at/hidden_at/deleted_at` 软删，不靠 CHECK 约束，
  也不用触发器维护派生列（派生列由服务端「重算 + 单行 CAS」维护，见 `docs/03-database.md`）。
- 一旦 `apply_database_migration` 成功，历史数据即刻进入新结构；
  所以**先应用 0001~0002，跑通鉴权与配置读写，再应用 0003 及以后**。

## 六、与第 1 轮 `db/schema.sql` 的偏差

随时可重算：`node tools/scripts/diff-schema.ts`（当前输出：设计稿 24 张 → 迁移 22 张，并多出设计稿没有的 `ai_suggestions`；其余 16 张表存在列级差异）。
第 3–7 轮没有新增迁移，差异与第 2 轮一致；第 8 轮新增 `0007_ai.sql`（该脚本只比列，不比索引/约束）。

**表层面**
- 不建：`ai_jobs`（AI 润色是同步请求，没有排队/重试/后台任务；限额改用 `ai_suggestions` 计数）、
  `events`（埋点表，按范围约定明确不做）、`notifications`（站内信属后续轮）、
  `user_settings`（并入 `users.settings` jsonb）。
- 新增：`auth_attempts`（找回限频需要，PRD 只在 6.1 提过「auth 尝试」）、
  `ai_suggestions`（第 8 轮：建议缓存 + 每日额度计数，设计稿无对应表）。

**词表统一（最容易踩的坑，第 3 轮已按这套落地）**
- `relation_code` → `relation`：PRD 6.1 的英文码表覆盖不了 B-02 的 12 种关系，直接存中文原值；
  `wishes` 与 `pool_posts` 同步，`wishes` 另存 `relation_group`（parent/peer/intimate/mentor/stranger）
  供语气与任务倾向使用（PRD 5.1）。`pool_posts.category`（当时指关系码）拆成 `wish_type` + `relation`。
- `wish_templates.content` 保留 PRD 6.1 列名，新增 `tone`（由关系组派生）。
- `task_templates`：「给谁做 + 什么性质」两列（`relation_group` + `task_type`）合并为 `side`
  （for_ta/for_self/money）；文案列 `title` → `text`；佐证提示 `proof_hint` → `proof_kind`（枚举化）；
  去掉 `self_focus`（`is_for_self` 已表达）与 `min_budget_band`（金额只保留 `min_budget_cents`）。
  `tasks` 表按同一套词表同步（`side/text/proof_kind/time_slot/min_budget_cents`）。
- `rewards`：`category` 按 PRD 5.4 收敛为四类 `health/company/life/heart`（第 1 轮误按 12 类商品目录建表）；
  `name` → `title`、`price_min_cents/price_max_cents` → `min_cents/max_cents`、
  `wish_types` → `recommend_flags`；去掉 `relation_groups/search_keyword/add_on_hint`，加 `note`、`stock_left`。
- `settlements`：`reward_price_min_cents/max_cents` → `reward_min_cents/reward_max_cents`，
  新增 `checkin_count`、`makeup_count`（结算页要直接显示「几天打卡、几次补卡」）。
- `idempotency_keys`：按第 1 轮文档说的「列名调整」落地——`key` → `idempotency_key`、
  `fingerprint` → `request_fingerprint`、`user_id` → `principal`（游客也有稳定主体）、
  结果改存 `response_code` + `response_body`（重放要能还原状态码与响应体，`status` 只表示处理阶段）、
  去掉 `resource_type/resource_id/expires_at`（过期用 `created_at` + 惰性判定，保留窗口写在代码里）。
- `users`：`display_name` → `nickname`、去掉 `pronoun`（代词属于愿签不属于账号）、
  去掉 `close_requested_at/closed_at`（注销属第 4 轮，先留 `deleted_at`），
  新增 `avatar/client/profile_text/wish_style_tags/share_default_public/settings`。
- `wishes`：`wish_text` 拆成 `title`（≤30 字展示文案，`deriveTitle` 确定性派生）+ `raw_input`
  （**≤120 字**原文，PRD B-08 / docs/02 §9，用于分类与回显；第 1 轮设计稿写的 500 字已收紧），
  新增 `classifier_type/classifier_confidence_bps`（分类结果留痕，置信度用基点整数，numeric 不支持）、
  `five_questions_done`、`source_wish_id`、`forked_from_post_id`、`version`（派生列 CAS）。
  接口词表与列名的映射只在 DTO 函数里：`nickname←target_name`、`wish_text←raw_input`。
- `auth_tokens`：去掉 `label`、`issued_ip_hash`（设备名与 IP 属后台侧需求），加 `status`、`demo`、`updated_at`。
- `checkins`：去掉 `is_duplicate_image`、`duplicate_of`（同图重复只做提示不落列，见 PRD 简化口径），
  加 `checkin_date`（产品日，补卡判定要用）。
- `demo_sessions`：去掉 `token_hash`（演示身份仍走标准 JWT + auth_tokens），加 `last_seen_at`。
- `share_links`：加 `passphrase_hash`（访问口令只存摘要）、`last_visited_at`。

## 七、执行进度

站点已创建（`function_backend`），但**本轮尚未完成一致的云端落地**：迁移批次与 seed 导入依赖部署后的 Function
作为数据库客户端；`prepare_site` 曾被用户拒绝，部署与真库验证需重新授权。云端实际结构请先 `get_database_schema` 核对，
不要按本文档假定「已建齐」。

本地已经验证的（第 9 轮）：`check-migrations.ts` 全绿（**7 文件 / 98 语句 / 22 表**）、
`check-schema-usage.ts` 全绿（代码里的表名/列名/写入键都在 DDL 里）、
`check-routes.ts` 全绿（41 条路由）、`tools/local/smoke.ts` **470 项断言通过**
（含五问加密、立契、任务引擎、崩溃补齐、游标分页、今日任务、打卡覆盖、补卡券、限流、AI 缓存/额度/回退、演示基线/快进/三结局/过期，
以及第 9 轮的上传 2h 失效、本 IP 最早 3 条演示清理、安全响应头、控制字符清洗、405 `Allow`、`API_PER_MINUTE` 兜底）。
**没验证的**：真库对 `insertIfAbsent` 逐行语义、`affected()` 返回行数、唯一约束含 NULL 的行为，以及 0007 建表——见 §四。
