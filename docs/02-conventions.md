# 02 全局约定 · 愿TA 后端

所有接口的公共契约。接口清单（[04-api-contract.md](../docs/04-api-contract.md)）只写差异，本文写通用规则。本文已按第 7 轮实现更新：§2/§3/§4/§5/§6/§7/§8/§9/§10/§11/§12 均为**已落地行为**（标注"后续轮"的除外）。

## 1. 基址与路径

| 项 | 规则 |
| --- | --- |
| 逻辑路径 | `/api/<module>/...`（文档、契约、代码常量统一用它） |
| 实际请求 | `https://<site>/functions/v1/app/api/...` |
| Function 内匹配 | `lib/http.ts#logicalPath` 只接受 `^/(?:functions/v1/)?(?:app\|app-d<32hex>)(/…)?$`（网关保留后缀、物理名替换逻辑名、Provider 也可能剥掉 `/functions/v1`），剥掉前缀后才匹配路由表。**裸 `/api/...` 不在白名单内 → 404 `not_found`**；前缀对但路由未登记 → 404 `route_not_found`。禁止用 `endsWith` 猜路径 |
| 小程序基址 | `const API_BASE = 'https://<site>/functions/v1/app'`，路径拼接与 Web 一致 |
| 内容协商 | 请求与响应仅 `application/json; charset=utf-8`（文件字节走签名 URL，不穿 Function） |
| 命名 | JSON 与数据库列同名，一律 snake_case（`access_token`、`wish_type`、`created_at`）。**这是对 PRD 6.2「JSON camelCase」的一处有意偏离**：本项目出入参与列几乎一一对应，加映射层只会让每个 DTO 多一处会漏改的地方；第 1 轮设计的 camelCase + `core/data/mapper.ts` 在第 2 轮实现时取消。前端如需 camelCase，在自己这一侧转，后端不接受也不返回两种写法。唯一例外是响应信封自身的四个键 `code` / `data` / `message` / `requestId`（+ 失败时的 `errorCode` / `details`），沿用 PRD 6.2 的写法，不随业务字段改名 |
| 接口词表 ↔ 库内列 | 第 3 轮起有**多处刻意不同名**，因为产品语言与存储语言不是一回事：`nickname ← wishes.target_name`（不是真实姓名）、`wish_text ← wishes.raw_input`（原文，与展示用 `title` 分列）、`type ← tasks.side`（`for_ta/for_self/money` → `ta/self/money`）、`title ← tasks.text`。第 4 轮再加一处：`proof_id ← checkins.proof_file_id`。第 5 轮账本两处：`type ← ledger_entries.entry_kind`（`expense/earned` → `expense/earning`）、`proof_id ← ledger_entries.proof_file_id`；`task_id` / `week_start` 同名。映射**只允许发生在 DTO 函数里**（`toWishDto` / `toWishSummary` / `toTaskDto` / `toCheckinDto` / `toLedgerEntryDto`），路由与 domain 内部一律用库内列名，禁止第二处映射 |

## 2. 统一响应格式

已实现（`backend/lib/respond.ts`）。成功与失败共用同一个信封，`code` 是数值、`data` 只在成功时非空：

```json
{
  "code": 0,
  "data": { "user": { "id": "…", "nickname": "小满" }, "session": { "access_token": "…", "token_type": "Bearer", "expires_at": "2026-12-21T18:04:00.000Z" } },
  "message": "ok",
  "requestId": "0f6c1c2e9a7d4b1f8e2a5c3d7b9a1f04"
}
```

```json
{
  "code": 400,
  "data": null,
  "message": "再写几个字，让她知道你在想什么。",
  "requestId": "0f6c1c2e9a7d4b1f8e2a5c3d7b9a1f04",
  "errorCode": "invalid_parameter",
  "details": { "fields": { "nickname": "too_short" } }
}
```

规则：

1. **`code` 数值 == HTTP 状态码，成功恒为 0**（第 2 轮约定，PRD 6.2 的 `{ code, message, requestId }` 因此原样保留）。客户端只需要分支两处：`code === 0` 读 `data`，否则展示 `message`。
2. **`errorCode` 是机器可读标识**（snake_case），客户端做逻辑分支用它，不要匹配中文文案；成功响应不带该字段。
3. `message` 是**可直接展示**的产品文案（第二人称、短句），技术细节只在服务端日志里，靠 `requestId` 关联。
4. `details.fields` 仅在校验失败时出现，形状是 `{ 字段名: 规则名 }`；`details.retryAfterSeconds` 仅 429 出现，同时写进 `Retry-After` 响应头。
5. `requestId` 同时出现在信封与 `x-request-id` 响应头，用户报障时只给这一串。
6. 绝不返回：SQL、内部 URL、Secret、签名 URL、原始 Provider 错误、他人 ID、五问密文。数据库原始错误经 `fromDbError()` 映射成 409/422/503，约束名不出网。
7. 首次创建成功返回 201（`respond.ts` 的 `created()`），幂等重放与新号复用仍返回 200，客户端可用状态码区分"新建/重放"。**已实现的 41 条里返回 201 的是**：`POST /api/wishes`（草稿）、`POST /api/uploads/presign`（pending 文件行）、`POST /api/wishes/:id/share`（首次生成；轮换也是 201）、`POST /api/pool/publish`（首次发布；重复发布回 200）、`POST /api/pool/:id/report`、`POST /api/pool/:id/replies`、`POST /api/demo/session`（新建演示账号与基线）。其余写接口用 200：`POST /api/auth/guest` 属"账号即开即用"（演示分支额外带 `is_new`）；立契是"更新愿签 + 派生任务"（首签/重签靠 `first_sign`）；打卡/补卡是状态流转与覆盖更新（重复靠 `already_done`）；账本预算与流水、`POST /api/uploads/complete`、`POST /api/uploads/:id/url`、撤销分享、下架帖子、删除回信、结算重复调用都用 200 + 业务字段区分。**新增的写接口一律支持幂等键（`optional`）**，presign/url 例外（响应含短时签名 URL，不适合存档）。
8. 列表统一 `data: { items, next_cursor, has_more }`（snake_case，见 §1 命名行），可附带 `limit` 回显本次生效的页大小；`total` 只在平台能低成本拿到 exact count 时返回。已落地的列表：`GET /api/wishes`、`GET /api/pool`、`GET /api/pool/:id/replies`（见 §11）。

## 3. 状态码使用

| 状态 | 场景 | 已落地实况 |
| --- | --- | --- |
| 200 | 读、更新、幂等重放命中、新账号签发、立契（含重复立契）、重复结算 | `POST /api/auth/guest`、`GET /api/me`、`PATCH /api/me`、`POST /api/auth/logout`、`GET /api/wishes[/:id]`、`PUT /api/wishes/:id/answers`、`POST /api/wishes/:id/contract`、`GET /api/wishes/:id/ledger`、`PUT /api/ledger/weeks/:weekStart`、`POST /api/ledger/entries`、`POST /api/wishes/:id/settle`（`already_settled:true` 重放）、`GET /api/wishes/:id/settlement`、`POST /api/wishes/:id/extend` |
| 201 | 首次创建业务资源 | `POST /api/wishes`（草稿）、`POST /api/uploads/presign`、`POST /api/wishes/:id/share`、`POST /api/pool/publish`（首次）、`POST /api/pool/:id/report`、`POST /api/pool/:id/replies` |
| 400 | 结构/类型非法：参数校验、非 JSON 请求体、幂等键格式；**以及非法状态流转与内容规则拒绝** | `invalid_parameter` / `invalid_json` / `invalid_body` / `invalid_cursor` / `idempotency_key_required` / `wish_not_draft` / `answers_locked` / `answers_incomplete` / `wish_not_active` / `wish_not_settled` / `settle_too_early` / `extend_not_allowed` / `extend_limit_reached` / `week_not_in_contract` / `week_not_editable` / `week_not_started` / `earning_task_required` / `earning_task_not_done` / `earning_week_mismatch` / `duplicate_earning_link` / `file_too_large` / `mime_type_unsupported` / `purpose_unsupported` / `upload_pending` / `upload_expired` / `verification_failed` / `file_not_ready` / `share_not_before_sign` / `pool_hidden` / `content_too_long` / `sensitive_content` / `replies_disabled` |
| 401 | 无 token、token 无效/过期/已撤销、恢复码不符 | `invalid_token` / `token_expired` / `token_revoked` / `invalid_credentials` / `account_not_found` |
| 403 | 有身份但无权：演示身份写真实数据、账号冻结/注销中、**写别人的愿签、引用别人的任务/图片、操作别人的文件/帖子/回信** | `demo_forbidden` / `demo_required` / `account_unavailable` / `wish_forbidden` / `task_forbidden` / `proof_forbidden` / `file_forbidden` / `not_post_author` / `not_reply_owner` |
| 404 | 路径未登记，或资源不存在（**读路径**同 owner 谓词查空即 404，不区分"无权"与"不存在"） | `route_not_found` / `not_found` / `account_not_found` / `wish_not_found` / `task_not_found` / `file_not_found` / `share_not_found` / `share_revoked` / `pool_not_found` / `reply_not_found`；账本读与结算读按需求例外：非作者 403 而非 404 |
| 405 | 路径存在但方法不允许，`details.allowed` 给出允许的方法 | `method_not_allowed` |
| 409 | **并发**冲突：幂等冲突、单行 CAS 失败、唯一索引撞车、写库未命中、重复举报/同日重复回信 | `duplicate_record` / `idempotency_*` / `recovery_code_collision` / `user_create_failed` / `wish_create_failed` / `wish_state_conflict` / `settlement_in_progress` / `settlement_conflict` / `settlement_missing` / `ledger_week_conflict` / `ledger_entry_failed` / `reference_missing` / `share_conflict` / `pool_conflict` / `report_duplicate` / `reply_daily_limit` / `reply_conflict` |
| 413 | 请求体超过 `route.maxBodyBytes` | `payload_too_large` |
| 415 | Content-Type 非 JSON | `unsupported_media_type` |
| 422 | 业务校验不通过（空改动、DB 规则拒绝） | `no_op` / `validation_failed` |
| 429 | 限流，带 `Retry-After`；服务层兜底限流与业务阈值分开 | `guest_too_many_registrations` / `auth_too_many_attempts` / `demo_too_many_sessions` / `wish_create_limited` / `checkin_rate_limited` / `upload_rate_limited` / `publish_quota_exceeded` / `report_rate_limited` / `reply_rate_limited` / `api_rate_limited` |
| 500 | 未预期异常（固定文案 + requestId，原始错误只进日志） | `internal_error` |
| 503 | 依赖不可用、密钥缺失、**内容库未就绪、对象存储不可用**，不自动重放写 | `database_unavailable` / `service_not_configured` / `task_pool_empty` / `reward_pool_empty` / `storage_unavailable` |

**400 与 409 的分界（第 3 轮定稿）**：客户端"这么调本来就不对"→ 400（状态机非法流转、参数错、五问没答完）；客户端"调得对但撞上了并发/重复"→ 409（CAS 命中 0 行、同键异指纹、唯一索引撞车）。**重复立契不是错误**：`POST /api/wishes/:id/contract` 对已 active 的愿签返回 200 + `first_sign:false`，只补齐缺失任务。

**403 与 404 的分界**：写操作（`PUT .../answers`、`POST .../contract`、`POST /api/tasks/:id/checkin`、`POST /api/tasks/:id/makeup`、`PUT /api/ledger/weeks/:weekStart`、`POST /api/ledger/entries`、`POST /api/wishes/:id/settle`、`POST /api/wishes/:id/extend`）非作者 → 403 `wish_forbidden`，这是第 3–6 轮需求的显式要求；读操作（`GET /api/wishes/:id`、列表）一律带 owner 谓词，查空即 404 `wish_not_found`，不泄露"存在但不是你的"。**账本读与结算读是读路径的显式例外**：需求要求非作者返回 403，因此 `GET /api/wishes/:id/ledger`、`GET /api/wishes/:id/settlement` 与今日页一样走 `requireAuthor`，非作者 403 `wish_forbidden`。打卡/补卡/收入关联对不存在的任务回 404 `task_not_found`，对已存在但非本人的任务回 403 `task_forbidden`；凭据图片同口径（`proof_forbidden`）。第 7 轮延续同一口径：文件操作非归属者 403 `file_forbidden`、文件不存在 404 `file_not_found`；下架别人帖子 403 `not_post_author`、帖子不存在 404 `pool_not_found`；删除别人回信 403 `not_reply_owner`、回信不存在 404 `reply_not_found`；**匿名公开读**查不到（含 hidden/deleted）统一 404 `pool_hidden` 或 `share_not_found`，不泄露存在性。

## 4. 错误码总表

`errorCode` 的唯一登记表。标 ✓ 的是代码里真的会返回的；未标的是后续接口的预留位，客户端按"未知 errorCode 一律展示 `message`"处理即可。

### 4.1 通用（已实现）

| errorCode | HTTP | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| `invalid_parameter` | 400 | 参数结构/类型/长度/枚举非法，明细在 `details.fields` | 定位到字段，不重试 |
| `invalid_json` | 400 | 请求体不是合法 JSON（编码损坏也算） | 检查序列化与 charset |
| `invalid_body` | 400 | 请求体形态不符合该接口约定 | 修正调用 |
| `invalid_cursor` | 400 | 游标不是服务端生成的 base64url | 丢掉本地游标重取首页 |
| `invalid_idempotency_key` | 400 | `Idempotency-Key` 不是 UUID 形状 | 重新生成 key |
| `payload_too_large` | 413 | 超过 `route.maxBodyBytes` | 精简请求体或改走 presign |
| `unsupported_media_type` | 415 | 非 `application/json` | 修正 header |
| `route_not_found` | 404 | 路径未登记 | 上报，多为版本不匹配 |
| `method_not_allowed` | 405 | 方法不符，`details.allowed` 给出可选方法 | 修正调用 |
| `internal_error` | 500 | 未预期异常 | 展示 requestId，读接口可重试 |
| `database_unavailable` | 503 | 数据库读写失败或未开放 | 保留输入，指数退避重试读 |
| `service_not_configured` | 503 | 必需 Secret 缺失（服务不会以"半可用"启动） | 视为部署问题，不重试 |
| `api_rate_limited` | 429 | 服务层兜底限流（`API_PER_MINUTE`，按主体每分钟；健康探针不计），与业务阈值独立 | 按 `Retry-After` 退避，不要并发重试 |

### 4.2 鉴权与账号（已实现）

| errorCode | HTTP | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| `invalid_token` | 401 | 未带 `Authorization: Bearer`（`requirePrincipal` 直接拒绝），或 JWT 签名/`iss`/`aud`/结构不符，或 `jti` 查不到行 | 清除本地 token，重新建号或用恢复码；缺失与伪造同码，客户端不必分支 |
| `token_expired` | 401 | 超过 30 天（`auth_tokens.expires_at`） | 用恢复码 `POST /api/auth/recover` |
| `token_revoked` | 401 | 该 token 已登出或被找回流程作废 | 同上；提示"已在其他设备退出" |
| `invalid_credentials` | 401 | 恢复码不存在（与"已被使用"同答案，不泄露存在性） | 提示核对恢复码，可重新抄写 |
| `account_not_found` | 401 | token 指向的账号已不在 | 恢复码找回或新建 |
| `account_unavailable` | 403 | 账号冻结或注销中 | 只读引导，禁止写 |
| `demo_forbidden` | 403 | 演示身份尝试操作真实数据 | 退出演示模式 |
| `demo_required` | 403 | 真实身份访问了只允许演示的接口 | 换演示会话 |
| `guest_too_many_registrations` | 429 | 建号超过每 IP 10/小时 | 按 `Retry-After` 退避 |
| `auth_too_many_attempts` | 429 | 恢复码尝试超过每 IP 12/小时 | 退避，不要连续试 |
| `demo_too_many_sessions` | 429 | 演示会话超过每 IP 30/小时 | 提示稍后再试 |

### 4.3 幂等与写入（已实现）

| errorCode | HTTP | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| `idempotency_key_required` | 400 | 接口声明 `idempotent: required` 但没带 key | 生成 key 后重试 |
| `idempotency_key_reuse` | 409 | 同 key 不同请求体（指纹不符） | 视为新意图，换新 key |
| `idempotency_in_progress` | 409 | 同 key 的首次请求还没落定（`in_progress` 且未超 60 秒陈旧窗口） | 按原 key 对账读结果，勿改 key |
| `idempotency_state_invalid` | 500 | 占位行的 status 不在已知取值内 | 上报 requestId |
| `duplicate_record` | 409 | 唯一索引冲突（23505） | 读回现有资源，不当作失败 |
| `reference_missing` | 409 | 关联数据尚未就绪（23503） | 先补前置资源 |
| `validation_failed` | 422 | DB 侧规则拒绝（23514） | 按 `details.fields` 修正 |
| `recovery_code_collision` | 409 | 恢复码连续 3 次撞唯一索引 | 重试建号，极端并发下才会出现 |
| `user_create_failed` | 409 | 建号写库未成功（插入影响 0 行且不是唯一冲突） | 重试建号；同一 `x-demo-session` 重试会复用同一演示账号 |
| `no_op` | 422 | 提交里没有可应用的修改 | 至少改一个字段 |
| `not_found` | 404 | 资源不存在或对当前主体不可见 | 回列表 |
| `demo_session_unavailable` | 409 | 演示会话与演示账号未能同源 | 稍后重试，属演示环境繁忙 |

### 4.4 愿签与任务（第 3 轮已实现）

| errorCode | HTTP | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| `wish_not_found` | 404 | 愿签不存在，或**读路径**下不是当前账号的 | 回列表；不要提示"无权访问" |
| `wish_forbidden` | 403 | **写路径**下愿签属于别人（`requireAuthor`） | 提示只能操作自己的愿签，不重试 |
| `wish_not_draft` | 400 | 对非 draft/active 的愿签立契（`details.status` 给出当前态） | 刷新详情；已 settled/archived 不能再签 |
| `answers_locked` | 400 | 愿签已签署，五问答案不能再改（`details.status`） | 置灰五问入口 |
| `answers_incomplete` | 400 | 五问没答完就立契，`details.missing` 给出缺失字段（如 `["q3","q5"]`） | 跳到第一个缺失的问题 |
| `no_op` | 422 | `PUT .../answers` 一个字段都没提交 | 至少答一题（与 `PATCH /api/me` 同码同义） |
| `wish_create_limited` | 429 | 当日创建愿签数达 `WISH_CREATE_PER_DAY`（默认 20，产品日 04:00 重置） | 按 `Retry-After` 退避，提示明天再来 |
| `wish_create_failed` | 409 | 草稿写库未命中 1 行 | 重试创建（带同一把 key 会走幂等对账） |
| `wish_state_conflict` | 409 | 立契的单行 CAS 命中 0 行且状态已不是 active（并发改成了别的态） | 刷新详情后重试，`details.status` 给出实际态 |
| `task_pool_empty` | 503 | 必做两档（`for_ta`/`for_self`）候选池为空 ⇒ 种子未导入或被整池停用 | 视为部署问题，不重试；**此时愿签仍是 draft，不会留下空契约** |

### 4.5 打卡与补卡（第 4 轮已实现）

| errorCode | HTTP | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| `task_not_found` | 404 | 任务不存在（或任务所属愿签已不可见） | 回今日页重取 |
| `wish_not_active` | 400 | 愿签不在 `active`（`details.status`） | 刷新愿签状态，停止打卡/补卡 |
| `task_not_today` | 400 | 给非今天的任务打卡（`details.task_date/today`） | 昨天的漏卡应走补卡 |
| `makeup_required` | 400 | 打卡时任务已是 `missed` | 引导补卡 |
| `invalid_task_state` | 400 | 当前状态不允许该操作（`details.status`） | 刷新任务 |
| `already_made_up` | 400 | 该任务已补过卡 | 刷新任务，不重试 |
| `task_not_missed` | 400 | 给非 `missed` 任务补卡（`details.status`） | 只有漏卡才能补 |
| `makeup_window_closed` | 400 | 漏卡不在当前自然周（`details.task_week_start/current_week_start`） | 券只覆盖本周，旧的不能再补 |
| `makeup_ticket_unavailable` | 400 | 本周没有可用券 / 已被用掉（`details.week_start`） | 提示本周补卡次数已用完 |
| `makeup_ticket_expired` | 400 | 本周券已过期 | 同上，不重试 |
| `task_state_conflict` | 409 | 补卡时任务状态被并发改过（券已放回） | 刷新后重试 |
| `checkin_conflict` | 409 | 打卡行刚被并发更新 | 刷新后重试 |
| `checkin_rate_limited` | 429 | 每分钟打卡数达 `CHECKIN_PER_MINUTE`（`details.retryAfterSeconds`） | 按退避重试 |
| `proof_not_found` | 400 | `proof_id` 不存在 | 重新上传 |
| `proof_not_ready` | 400 | 图片未 `ready` 或已失效 | 等上传完成 / 重新上传 |
| `proof_forbidden` | 403 | 图片属于别人 | 只能用自己的图片 |
| `proof_purpose_mismatch` | 400 | 图片用途与当前操作不符：打卡/补卡要 `checkin_proof`，账本流水要 `ledger_proof` | 换对应用途的图片 |
| `proof_wish_mismatch` | 400 | 图片绑定的是别的愿签 | 换本愿签的图片 |

打卡对同一任务重复提交**不是错误**：返回 200 + `already_done:true` + `notice`，并覆盖证明/备注。补卡重复提交由幂等键重放或 `already_made_up` 处理。

### 4.6 账本（第 5 轮已实现）

| errorCode | HTTP | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| `week_not_in_contract` | 400 | `week_start` 不在愿签契约期（`details.week_start/start_date/end_date`） | 回到契约区间内选周 |
| `week_not_editable` | 400 | 改历史周预算（早于当前自然周） | 历史周只读，只改当前/未来 |
| `week_not_started` | 400 | 给未来周记流水（`details.week_start/current_week_start`） | 到那一周再记 |
| `wish_not_active` | 400 | 未立契/已结束，账本不可读写（`details.status`） | 先完成立契；已结束看结算 |
| `earning_task_required` | 400 | 收入没带 `task_id`，或关联任务不是 `side='money'` | 选一条已完成的钱任务 |
| `earning_task_not_done` | 400 | 关联钱任务状态不是 `done/made_up`（`details.status`） | 先完成该任务再登记收入 |
| `earning_week_mismatch` | 400 | 收入记在了关联任务之外的周（`details.task_week_start/week_start`） | 改到任务所在周 |
| `duplicate_earning_link` | 400 | 同一条钱任务已登记过收入（`details.task_id`） | 改关联另一条任务；并发残余风险见 03 §9 |
| `ledger_week_conflict` | 409 | 预算 CAS 连续 3 次撞上并发修改 | 刷新账本后重试 |
| `ledger_entry_failed` | 409 | 流水写入未命中 1 行 | 重试；带同一把幂等键会走对账 |

账本读接口按需求对非作者愿签返回 **403 `wish_forbidden`**（与今日页一致，是读路径的显式例外）；写接口对非作者同样 403。

### 4.7 结算与续期（第 6 轮已实现）

| errorCode | HTTP | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| `wish_not_settled` | 400 | 愿签还没结算：`GET .../settlement`、`POST .../extend` 都会拦（`details.status`） | 先调 `POST .../settle`，或等结算窗口开放 |
| `settle_too_early` | 400 | 未到截止日次日 04:00（`details.end_date/settle_open_at/seconds_remaining`） | 按 `seconds_remaining` 倒计时；不要轮询重试 |
| `settlement_in_progress` | 409 | 另一个请求正在结算，且租约未过期（`details.retryAfterSeconds = 2`） | 2 秒后用同一路径刷新结算结果 |
| `settlement_missing` | 409 | 愿签已是 settled 但快照行缺失（数据损坏，不是正常并发） | 上报客服核对，不要反复重试 |
| `settlement_conflict` | 409 | `(wish_id, version)` 唯一索引撞车且回读不到该版本 | 刷新后重试，通常自愈 |
| `extend_not_allowed` | 400 | 结局是 `double_realized`（或未知结局），不需要/不允许续期（`details.outcome`） | 隐藏续期入口 |
| `extend_limit_reached` | 400 | 该愿签已续期过一次（`details.renew_count`） | 隐藏续期入口；判定在状态检查之前，续期后也能给出准确提示 |
| `reward_pool_empty` | 503 | 礼物类别内没有 `is_active` 的礼物 ⇒ 种子未导入 | 视为部署问题，不重试 |
| `wish_not_active` | 400 | 用 draft/archived 等非 active 状态调结算（复用打卡同码，`details.status`） | 刷新愿签状态 |
| `wish_state_conflict` | 409 | 结算 `active→settling`、收尾 `settling→settled` 或续期 CAS 命中 0 行且重读后仍无法收敛 | 刷新后重试 |

### 4.8 上传与分享（第 7 轮已实现）

| errorCode | HTTP | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| `purpose_unsupported` | 400 | 用途不在 `checkin_proof / ledger_proof / share_image`，`details.allowed` 给出允许值 | 换对应用途 |
| `mime_type_unsupported` | 400 | 不是 `image/jpeg / image/png / image/webp` | 前端先转码/压缩 |
| `file_too_large` | 400 | 声明或实测字节 >200KB（`details.max_bytes`） | 压缩后重传 |
| `upload_rate_limited` | 429 | 每小时申请凭证数达 `UPLOAD_PER_HOUR`（默认 30） | 按 `Retry-After` 退避 |
| `upload_pending` | 400 | `complete` 时对象还没上传（download 不到），或状态刚被别人改过 | 先 PUT 字节再 complete |
| `upload_expired` | 400 | 上传凭证（`files.expires_at`，presign 后 2 小时）已过（`details.expires_at`），行已被标 `expired` | 重新 presign |
| `verification_failed` | 400 | 实测字节为空、文件头与声明 MIME 不一致、读取超时；行会被标 `rejected` | 重新选择图片并重新 presign（同一条不能重试） |
| `file_not_found` | 404 | 文件行不存在 | 重新上传 |
| `file_forbidden` | 403 | 文件属于别人（complete/url 都校验归属） | 只能操作自己的文件 |
| `file_not_ready` | 400 | 文件非 `ready`（pending/rejected/expired/deleted）不能取 URL，或已失效不能 complete | 等校验完成或重新上传 |
| `storage_unavailable` | 503 | 对象存储 SDK 抛错/不可用 | 视为部署问题，稍后重试读 |
| `share_not_before_sign` | 400 | 对 draft（或状态不可分享）的愿签生成链接（`details.status`） | 先立契 |
| `share_conflict` | 409 | 轮换/撤销时同一行被并发更新 | 刷新后重试 |
| `share_not_found` | 404 | token 形状不符/不存在/愿签已删/状态不可分享 | 回首页，不要提示"无权" |
| `share_revoked` | 404 | 链接已撤销或已被新 token 轮换掉 | 请作者重新生成 |

### 4.9 公开池与回信（第 7 轮已实现）

| errorCode | HTTP | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| `wish_not_settled` | 400 | 未结算的愿签不能发布（`details.status`） | 先结算 |
| `pool_hidden` | 400 / 404 | 发布时帖子已被隐藏（400，不可重新发布）；详情/列表/举报/回信读不到 hidden/deleted 帖子（404） | 回列表；隐藏不可申诉 |
| `publish_quota_exceeded` | 429 | 每产品日发布数达 `POOL_PUBLISH_PER_DAY`（默认 5） | 按 `Retry-After` 退避 |
| `pool_conflict` | 409 | 并发首发布时唯一索引撞车且回读不到帖子 | 刷新后重试 |
| `pool_not_found` | 404 | 下架时帖子不存在（与 hidden 的读路径区分） | 回列表 |
| `not_post_author` | 403 | 下架别人的帖子 | 只能下架自己的 |
| `report_duplicate` | 409 | 同一用户已举报过该帖子 | 不重试 |
| `report_rate_limited` | 429 | 每小时举报数达 `POOL_REPORT_PER_HOUR`（默认 20） | 按 `Retry-After` 退避 |
| `content_too_long` | 400 | 回信 >80 字（`details.max_length`） | 截短后重发 |
| `sensitive_content` | 400 | 回信命中手机号/身份证/外链/邮箱/微信号/地址/引流词 | 改内容，不重试 |
| `replies_disabled` | 400 | 作者关闭了该愿签的回信 | 不接受新回信 |
| `reply_daily_limit` | 409 | 同一用户同帖每产品日已回过一条 | 明天再来，不重试 |
| `reply_rate_limited` | 429 | 每产品日回信总数达 `REPLY_PER_DAY`（默认 20） | 按 `Retry-After` 退避 |
| `reply_conflict` | 409 | 回信写入未命中 1 行 | 刷新后重试 |
| `reply_not_found` | 404 | 删除时回信不存在 | 刷新列表 |
| `not_reply_owner` | 403 | 既不是回信作者也不是帖主 | 只能删自己的或自己帖子下的 |

### 4.10 AI 与演示模式（第 8 轮已实现）

| errorCode | HTTP | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| `ai_template_invalid` | 503 | 兜底模板被改坏，无法给出合规建议（代码缺陷） | 展示通用失败，上报 requestId |
| `demo_session_missing` | 404 | 演示 token 有效但会话行已不存在 | 重新创建演示会话 |
| `demo_seed_incomplete` | 409 | 演示基线任务/证明文件未按预期生成（种子或引擎异常） | 调用 `POST /api/demo/reset` 重建，仍失败则上报 |
| `demo_session_expired` | 401 | 演示会话超过 `DEMO_TTL_HOURS` | 重新创建演示会话 |
| `demo_session_busy` | 409 | 快进/切结局/重置的 `updated_at` CAS 未抢到，另一请求正在重建 | 稍后重试 |
| `demo_required` | 403 | 真实 token 访问 `GET /api/demo/state`、fast-forward、scenario、reset | 改用演示 token |
| `demo_forbidden` | 403 | 演示 token 调 AI 润色、生成分享、发布/举报公开池、发回信 | 演示模式不开放该操作 |
| `demo_too_many_sessions` | 429 | 同 IP 每小时创建演示会话超过 `DEMO_PER_HOUR` | 按 `Retry-After` 退避 |

> AI 额度耗尽**不是错误**：接口仍返回 200 + 模板建议 + `fallback_reason:'quota_exceeded'`。`ai_capability_not_implemented`（503）只存在于尚未开放路由的三个占位函数里，不对外暴露。

### 4.11 仍为预留（未实现接口）

`contract_not_signed` · `wish_not_editable` · `already_checked_in` · `wish_type_unclear` · `rate_limited`（通用占位，实际都用具体码） · `file_in_use` · `fork_target_hidden` · `already_active_wish` · `settlement_not_revealed` · `export_unavailable` · `close_already_requested` · `close_window_passed` · `events_batch_too_large`。

第 1 轮设计稿里的 `already_signed` **已废弃**：重复立契改为幂等返回 200 + `first_sign:false`（§3）。`settlement_locked` / `already_settled` / `extend_once_only` 也**不再使用**：提前结算改为 400 `settle_too_early`，重复结算改为 200 + `already_settled:true`，第二次续期改为 400 `extend_limit_reached`。`wish_text_required` / `relation_unsupported` 也废弃，统一走 `invalid_parameter` + `details.fields`。`proof_required` 不再使用——打卡证明由 `proof_not_found` 等具体码表达，账本收入证明按需求为可选。

新增取值必须同时改这张表和 `backend/lib/errors.ts` 的工厂调用，`errorCode` 用 snake_case，不加 HTTP 前缀。

## 5. Bearer Token 鉴权规则

| 项 | 规则 | 状态 |
| --- | --- | --- |
| 携带 | `Authorization: Bearer <token>`，全站统一；**不使用 Cookie 会话** | ✓ |
| 格式 | 自签 HS256 JWT：`header.payload.signature`（base64url，无 padding）。`payload = { sub, jti, iss, aud, iat, exp, client, demo }`，`iss=yuan-ta`、`aud=yuan-ta-api` | ✓ |
| 校验 | 验签 → `iss/aud/exp` → 用 `jti` 反查 `auth_tokens`：行存在、`status=active`、`revoked_at IS NULL`、`expires_at` 未过 → 再查 `users.status` → `row.demo` 必须与 `claims.demo` 一致 | ✓ |
| 存库 | `auth_tokens` 存 `jti`（主键）、`user_id`、`expires_at`、`revoked_at`、`demo`；另存 `token_hash = HMAC(TOKEN_PEPPER, header.payload)` 仅供审计比对，**不参与校验** | ✓ |
| 有效期 | 真实会话默认 30 天（`TOKEN_TTL_DAYS`，1–60 可调）；演示会话写死 24 小时（`DEMO_TTL_MS`，签发时作为 `ttlSeconds` 传进 JWT）。两种都按 `exp`（JWT）与 `auth_tokens.expires_at`（DB 行）同时判定 | ✓ |
| 多设备 | 一个用户多 token（`client ∈ web \| mp \| app` + `demo`），互不挤掉 | ✓ |
| 撤销 | `POST /api/auth/logout` 置当前 `jti` 的 `status=revoked` + `revoked_at`，请求体 `{ all_devices: true }` 时连该用户其余 active token 一起撤；`POST /api/auth/recover` 无条件撤销全部并轮换恢复码。撤销即时生效，无需等 `exp` | ✓ |
| 恢复码 | 26 字符 Crockford base32（≈130bit，排除易混字符 i/l/u/o），**只在 `guest` 与 `recover` 的响应里各出现一次**；库中只存 `HMAC(RECOVERY_PEPPER, 归一化后的紧凑大写串)` | ✓ |
| 恢复码归一 | 读取时 `toUpperCase()` + 去掉 `-` 与空白，再判定长度与字符集；因此抄写时多打的连字符、小写、空格都不影响找回 | ✓ |
| 过期后 | 不做滑动续期也不做 refresh：`token_expired` → 客户端用恢复码走 `recover`，得到新 `jti` 与新恢复码 | ✓ |
| 游客 | 无 token 可命中 `GET /api/health`、`GET /api/health/deep`、`POST /api/auth/guest`、`POST /api/auth/recover`，以及第 7 轮的 `GET /api/pool`、`GET /api/pool/:id`、`GET /api/pool/:id/replies`、`GET /api/s/:token`。公开路由若带了 token 会**尽力解析**（`server.ts#resolvePrincipal` 的 `auth=none` 分支解析失败即忽略，不阻断游客请求），但**归属判定只看 `auth=bearer` 路由** | ✓ |
| 平台上下文 | 忽略 `x-qoder-user-context` 与请求体/查询串里的 `userId`，归属只认 token → `sub` | ✓ |
| 小程序注意 | token 存 `wx.setStorageSync`；请求前拼 `Authorization`；401 统一拦截后按 `errorCode` 分支（`token_expired`/`token_revoked` → 恢复码，其余 → 重新匿名建号） | 约定 |
| CSRF | 因无 Cookie 会话，不需要 CSRF Token；仍校验同源 `Origin`，跨源调用需显式配置 `CORS_ALLOW_ORIGINS`（默认空数组＝不发 CORS 头） | ✓ |

## 6. 幂等键规则

| 项 | 规则 | 状态 |
| --- | --- | --- |
| 头 | `Idempotency-Key: <uuid>`，客户端生成（离线队列在入队时生成一次，重试沿用）；服务端 trim + 转小写，形状不是 UUID 直接 400 `invalid_idempotency_key`（校验只到 UUID 形状，不校验版本号） | ✓ |
| 是否必需 | 以路由文件里的 `route.idempotent` 为准（`none` / `optional` / `required`），`check-routes.ts` 校验取值；GET/HEAD 一律不参与。已落地 41 条：`POST /api/wishes` = **required**（没有 key 就无法区分"重试"与"再许一个愿"）；19 条 = `optional`：`PATCH /api/me`、`PUT /api/wishes/:id/answers`、`POST /api/wishes/:id/contract`、`PUT /api/ledger/weeks/:weekStart`、`POST /api/ledger/entries`、`POST /api/tasks/:id/checkin`、`POST /api/tasks/:id/makeup`、`POST /api/wishes/:id/settle`、`POST /api/wishes/:id/extend`、`POST /api/uploads/complete`、`POST /api/wishes/:id/share`、`POST /api/pool/publish`、`POST /api/pool/:id/report`、`POST /api/pool/:id/unpublish`、`POST /api/pool/:id/replies`、`POST /api/ai/polish-wish`、`POST /api/demo/fast-forward`、`POST /api/demo/scenario`、`POST /api/demo/reset`（带了就重放，不带也允许——PUT、重复立契、重复结算、重复发布/下架/删除本身天然收敛，业务码再兜一层；AI 建议与演示重建也按同一输入/同一场景收敛）；其余 21 条 = `none`（`guest`/`recover`/`demo/session` 故意不做——恢复码明文只出现一次，存档重放等于泄露，演示会话响应含短时 token；`uploads/presign` 与 `uploads/:id/url` 的响应含短时签名 URL，同样不适合存档；其余为 GET 读接口或删除接口） | ✓ |
| 触发条件 | `lib/idempotency.ts#needsClaim`：`idempotent !== 'none'` 且方法非 GET/HEAD，且（`required` 或请求带了头）。`required` 而没带 key → 400 `idempotency_key_required` | ✓ |
| 作用域 | `(principal, operation, idempotency_key)` 唯一索引 `idempotency_keys_principal_operation_key_uidx`；`principal` = `u:<userId>`（已登录）/ `i:<ip_hash>`（游客）/ `a:anon`（兜底）；`operation` = `route.operation`（如 `me.update`） | ✓ |
| 指纹 | `HMAC(IDEM_FINGERPRINT_KEY, "<METHOD> <逻辑路径> <sha256(规范化 body)>")` 前 64 位；规范化 = 键升序、剔除 `undefined`、数组保序，因此字段顺序不同不算两次请求，少一个字段算 | ✓ |
| 首次 | `insertIfAbsent` 插 `status = in_progress` 占位；插入影响 1 行才执行业务，0 行走"命中"分支 | ✓ |
| 命中同指纹且已成功 | 直接重放存档的 `response_code` + `response_body`（状态码原样，不重复创建、不重复扣券、不重复计数），并回 `x-idempotent-replay: true` | ✓ |
| 同 key 异指纹 | 409 `idempotency_key_reuse`，视为新意图，要求换 key | ✓ |
| 首次未落定 | 占位仍是 `in_progress` 且 `updated_at` 未超 60 秒（`STALE_AFTER_SECONDS`）→ 409 `idempotency_in_progress` + `details.retryAfterSeconds = 2`，让客户端按原 key 对账 | ✓ |
| 陈旧占位 / 失败重试 | `status = failed` 或 `in_progress` 超 60 秒时后来者接管：`update(...).eq('id', …).eq('status', 旧值)`（`in_progress` 分支再加 `.lte('updated_at', now − 60s)`），`affected() !== 1` 即视为仍在处理 → 409 | ✓ |
| 结果标记 | 响应 `< 500` 才存档：2xx → `succeeded` + 响应体（>**64KB** 或读不出则退化为 `failed`，重放会重新执行）；4xx → `failed` + 状态码。业务抛 `AppError` 也标 `failed`；5xx 与未预期异常**不写库**，占位留在 `in_progress`，60 秒后可被接管。上限定为 64KB 是因为立契响应要装下 30 天契约的全量任务（最多 90 条） | ✓ |
| 网络结果未知 | 客户端**永不自动重放写**；用同 key 重试 → 服务端按占位行对账 | ✓ |
| 保留期 | 7 天。平台没有 cron，`sweepExpired()` 在 Function 实例冷启动后的第一个请求上异步清理 `created_at <= now − 7d`，不阻塞该请求 | ✓ |
| 与业务唯一约束 | 幂等之外仍有 DB 兜底（表级 `UNIQUE`，平台不支持 `CREATE UNIQUE INDEX`）：`tasks (wish_id, template_id)`、`tasks (wish_id, text)`、`wish_answers (wish_id)`、`checkins (task_id)`、`makeup_tickets (wish_id, week_start)`、`ledger_weeks (wish_id, week_start)`、`settlements (wish_id, version)`、`share_links (wish_id)`、`pool_posts (wish_id)`、`reports (target_type, target_id, reporter_id)`、`files (object_key)` + 单行 CAS。**例外**：`ledger_entries` 的"一条钱任务最多一笔收入"与 `replies` 的"同帖每人每天一条"没有库级唯一约束（时间窗无法写进 `UNIQUE`），分别靠写前读检查与窗口查询；并发双写是已记录的残余风险（03 §9） | ✓ |
| 批量写的可重放性 | 派生数据（任务行）的 id 必须由业务主键确定性派生：`tasks.id = derivedUuid("yuan-ta-task-v1:<wishId>:<day_index>:<seq>")`，配 `insertIfAbsent(values, { onConflict: 'id' })`。这样"幂等重放""重复立契""进程崩在批量写中间"三种情况都收敛到同一批行，只补缺的不重复插——**这是无事务环境下批量写唯一可靠的姿势** | ✓ |
| 随机源 | 抽取/洗牌禁止 `Math.random()`：种子 = `sha256("yuan-ta-task-v1:" + wishId)` 前 8 位十六进制 → `mulberry32`。同一愿签重放必须得到同一批任务，否则上一条不成立 | ✓ |

## 7. 时间与产品日规则

| 项 | 规则 | 状态 |
| --- | --- | --- |
| 存储 | 瞬时用 `timestamptz`（UTC），出参一律 `Date.toISOString()`（带 `Z`）；`backend/lib/time.ts` 的 `toIso()` 是唯一出口 | ✓ |
| 日历字段 | `start_date` / `end_date` / `task_date` / `week_start` 用 `text`（`YYYY-MM-DD`），因平台迁移子集不支持 `date`；`isValidYmd()` 做格式与真实日期校验 | ✓ |
| 时区 | 固定 `Asia/Shanghai`（UTC+8，无夏令时），常量 `TZ_OFFSET_MINUTES = 480`；不用 `Intl` 也不用宿主时区，避免边缘节点本地时区影响结果 | ✓ |
| 产品日 | `productDate(instant) = shanghaiDate(instant − 4h)`，常量 `DAY_BOUNDARY_HOUR = 4`，即 04:00–次日 03:59 归同一天 | ✓ |
| 契约日界 | `dayIndexOf(startDate, date) = date − startDate`，**0 起**（与 `tasks.day_index` 同口径，展示「第 N 天」时前端 +1）；`contractEndDate(startDate, days) = startDate + days − 1`（days ∈ 7/14/30，默认 7） | ✓ |
| 任务日历 | `task_date = addDays(start_date, day_index)`，`week_start = weekStartOf(task_date)`；`start_date = productDate(now)`（立契那一刻的产品日，不是自然日） | ✓ |
| 结算窗口 | `settleOpenAt(endDate)` = `endDate + 1 天` 的 04:00（上海）对应的 UTC 瞬时（即 `<endDate>T20:00:00.000Z`）。未到返回 400 `settle_too_early` + `details.end_date/settle_open_at/seconds_remaining`（PRD 3.4 / D-08）。**不入库**，由 `toWishDto` 现算；结算判定用同一函数 | ✓ 第 6 轮 |
| 自然周 | `weekStartOf(date)` = 该产品日所在周的周一；`isWeekendDate(date)` 判定周六/周日（钱任务只落周末）。业务口径为「周一 04:00 至下周一 03:59」——因为入参先过 `productDate`，04:00 前的瞬间仍归前一天，跨周判定自然不会把周一凌晨算进新周 | ✓ |
| 账本周 | 契约内每自然周一行 `ledger_weeks`；`week_index` 从签约周起算、首周 = 1；只允许当前/未来周改预算，历史周锁定；收支记录的 `week_start` 必须落在契约区间 | ✓ 第 5 轮 |
| 结算与续期 | 结算前先扫一次 `pending AND task_date < today → missed`；`active→settling` 用 `status + version` 单行 CAS，快照 `settlements (wish_id, version)` 先落库再收尾 `settling→settled`；`settling` 租约 60 秒，超时可由下一请求接管（与幂等表同口径）。续期把截止日 +7 天、回到 `active`，新增任务仍走派生 id 自动跳过已有天数。续期时长固定 7 天，不接受入参 | ✓ 第 6 轮 |
| 补卡券 | 每契约周 1 张，`makeupExpiresAt(weekStart) = Shanghai(weekStart + 7 天, 04:00)`，过期后 `status → expired`（惰性判定，无定时任务）；`week_index` 以 `weekStartOf(start_date)` 为基准，首周 = 1 | ✓ 第 4 轮 |
| 惰性日界 | 今日页/打卡/补卡入口执行 `pending AND task_date < today → missed` 的条件批量更新；没有 cron，重复执行无副作用 | ✓ 第 4 轮 |
| 限流窗口 | `hourlyWindow(now, hours)` 滚动小时窗、`dailyWindow(now)` 产品日窗（04:00 为界）；`quota.ts` 用 `created_at >= since` 计数（最多扫 50 行），`resetAt` 换算成 `retryAfterSeconds` | ✓ |
| 免打扰 | `inQuietWindow(instant, '23:00', '08:00')` 判定，默认窗口写在 `users.settings.quiet_hours` | 已实现（函数） |
| 权威时间 | 打卡时间以服务端 `server_ts` 为准；客户端 `client_ts` 恒为 `null`（本轮未开放离线同步），不参与任何判定（PRD C-04） | ✓ 第 4 轮 |
| 定时任务 | 平台侧不依赖 cron：过期、`missed` 标记、demo TTL 均在读写路径惰性触发。**账本不重算周表**：`ledger_weeks` 只存预算，支出/收入/结余/累计全部在读取时从流水与任务聚合，因此没有"定时重算"这件事 | 约定 |
| `missed` | 读取今日/历史任务时，对 `task_date < productDate 且 status = pending` 的任务落 `missed`（自愈式，幂等） | ✓ 第 4 轮 |

## 8. 金额规则

| 项 | 规则 |
| --- | --- |
| 单位 | 一律 **分（integer cents）**，出参同时给 `*_yuan`（`Math.floor(cents / 100)`，与 `domain/ledger.ts#yuan` 一致）供展示 |
| 禁止 | 浮点、`numeric`（平台不支持）、字符串金额、"元"入参；所有加总只用整数 |
| 首周预算（推算） | 由 `q4_disposable_band` 映射：`under_100→2000`、`100_299→4000`、`300_599→8000`、`600_999→12000`、`1000_plus→20000`；档位缺失或无法解析时兜底 5000 分。只在首签时写一次，之后以用户修改为准 |
| 周预算（输入） | `0–200000` 分（0–2000 元），非负整数；历史周不可改，当前/未来周可改，改后当周立即生效 |
| 非必要支出 | `0–200000` 分（≤2000 元），非负整数；直接扣当周结余，不拦截超预算提交 |
| 兼职收入（`entry_kind=earned`） | 必须关联一条已完成（`done/made_up`）的 `side=money` 任务，且与流水同周；单笔 `1–100000` 分（≤1000 元）。**`proof_id` 可选**（需求明确账本证明不强求），给了就必须是当前用户/当前愿签的 `ledger_proof` |
| 结余 | `max(0, 当周预算 − 当周非必要支出)`；`spent > budget` 时同时返回 `over_budget: true` 与 `notice`，不记负数（PRD D-05） |
| 累计兑现 | `realized_cents = Σ(已完成周的 balance_cents) + Σ(全部已确认收入)`；"已完成周"= 该周任意任务状态为 `done/made_up` |
| 读取时计算 | 以上全部由 `GET /api/wishes/:id/ledger` 实时聚合 `ledger_entries` + `tasks`；`ledger_weeks.spent_cents/saved_cents/earned_cents/counted/over_budget` 不参与计算，恒为初始值 |
| 价格区间 | 礼物 `min_cents / max_cents` 成对给出（结算快照另存 `reward_min_cents / reward_max_cents`），不返回单一数字（PRD 5.4）；**结算前任何账本/详情响应都不含礼物名称、价格或匹配结果** |
| 结算金额 | 累计兑现 `realized_cents` = 已计入周结余 + 已确认兼职收入，直接复用第 5 轮 `readLedger` 的 `totals`，结算接口不另写一套加总；快照另存 `saved_cents` 与 `earned_cents` 供追溯 |
| 礼物匹配 | 类别由愿望类型 + q5 解密文本确定（健康/陪伴/生活/心意）；候选 = 该类别 `is_active` 且 `min_cents ≤ realized` 的礼物；q5 点名的礼物在候选内优先，否则取价格上限最高者；差额按**价格中位数** `floor((min+max)/2)` 计算，档位按差额占中位数比例：`≤10%` 刚好够、`10%–30%` 差一点、`>30%` 未拆的信；未拆的信强制落到类别内最低价礼物 |
| 差额档位 | `gap_bps = floor(gap × 10000 / median)`，`exact ≤ 1000`、`near ≤ 3000`、`far > 3000`；`gap_cents` 本身不为负（已足够时记 0） |
| 一致验收 | 账本出参必须满足 `realized_cents = Σ counted 周 balance_cents + Σ income_cents`，且 `weeks` 逐周 `balance_cents = max(0, budget_cents − spent_cents)`；冒烟用整数断言复算 |

## 9. 校验与上限（服务端强制，前端同规则）

| 字段 | 上限/规则 | 状态 |
| --- | --- | --- |
| `nickname` | 1–32 字符，去首尾空白，禁控制字符 | ✓ `POST /api/auth/guest`、`PATCH /api/me` |
| `avatar` | 枚举 `default_01…default_12`，禁外链 | ✓ 同上 |
| `profile_text` | ≤100 字符（`type: 'text'`，允许换行） | ✓ `PATCH /api/me` |
| `wish_style_tags` | ≤3 项、单项 ≤12 字符（数组条数与单项长度分开校验） | ✓ `PATCH /api/me` |
| `channel` | 枚举 `xiaohongshu/douyin/wechat/bilibili/friend/other` | ✓ `POST /api/auth/guest` |
| `recovery_code` | 26 位 Crockford base32（分组后 31 字符），入参 ≤200 字符再归一 | ✓ `POST /api/auth/recover` |
| `nickname`（愿签称呼，库内 `target_name`） | 1–8 字符，去首尾空白（`type: 'string'`，按 trim 后长度判）；缺省 = `relation` 本身 | ✓ `POST /api/wishes` |
| `pronoun` | `she \| he \| they`（渲染为她/他/TA），缺省 `they` | ✓ `POST /api/wishes` |
| `wish_text` | 1–120 字符，去首尾空白；展示标题由 `deriveTitle` 折叠空白 + 去尾随标点 + 截断 ≤30 字 | ✓ `POST /api/wishes` |
| `relation` | 12 种中文原值枚举（PRD B-02，`domain/rules.ts#RELATIONS`），不做英文码表；`relation_group` 由服务端派生 | ✓ `POST /api/wishes` |
| `q1…q5`（五问答案） | 每项 `type: 'text'` 1–200 字符，允许换行；**部分提交**，未提交的保持原值；一个都没提交 → 422 `no_op` | ✓ `PUT /api/wishes/:id/answers` |
| `days` | 整数 `7 \| 14 \| 30`，默认 7；字符串 `"7"` 也判 400（`type: 'int'` 不做隐式转换） | ✓ `POST /api/wishes/:id/contract` |
| 回信 `content` | ≤80 字符，非空，敏感词规则通过；`type:'text'` 先按 ≤200 接住再判 80，超出统一 400 `content_too_long` | ✓ 第 7 轮 |
| 打卡 `note` | ≤30 字符，可选；补卡同口径 | ✓ 第 4 轮 |
| 账本 `week_start` | 路径/请求体都必须是合法 `YYYY-MM-DD` 且为周一（`parseWeekStart` → 400 `invalid_parameter`）；路径参数不校验时同样 400 | ✓ 第 5 轮 |
| 账本 `budget_cents` | 整数 `0–200000`，必填；非整数/负数/超上限 → 400 `invalid_parameter` | ✓ 第 5 轮 |
| 账本 `amount_cents` | 整数；支出 `0–200000`、收入 `1–100000`；越界 → 400 `invalid_parameter` | ✓ 第 5 轮 |
| 账本 `type` | 枚举 `expense \| earning`，未知值 400 `invalid_parameter` | ✓ 第 5 轮 |
| 账本 `note` | ≤60 字符，可选 | ✓ 第 5 轮 |
| 账本 `proof_id` / `task_id` | 可选 UUID；收入必带 `task_id`，支出带了 `task_id` → 400 `invalid_parameter` | ✓ 第 5 轮 |
| 信件 `letter_text` | ≤500 字符 | 后续轮 |
| 公开池 `excerpt` | 入参 ≤120 字符、可选；不传时取标题/原文。落库前统一 `redactSensitive`（联系方式→`***`、抹掉 ≥6 位数字、折叠空白）再截 120；空串兜底「一个没有说出口的愿望」 | ✓ 第 7 轮 |
| 上传图片 | `image/jpeg\|png\|webp`，**统一 ≤200KB**（三种用途同口径，含 `share_image`）；presign 声明大小只做早退，`complete` 以实测字节为准；`filename` ≤128 字符 | ✓ 第 7 轮 |
| 分享图 / 信件图 | 设计稿的 5MB 上限**未采用**：当前上传层统一 200KB，`share_image` 走同一通道；信件图 purpose 未开放 | ✓ 第 7 轮 |
| 请求体 | 每条路由自己声明 `maxBodyBytes`：`guest` 2048、`logout` 256、`recover` 1024、`PATCH /api/me` 4096、`POST /api/wishes` 4096、`PUT .../answers` 4096、`POST .../contract` 1024、`PUT /api/ledger/weeks/:weekStart` 1024、`POST /api/ledger/entries` 2048、打卡/补卡 1024、结算/续期 512、`uploads/presign` 1024、`uploads/complete` 512、`uploads/:id/url` 256、`wishes/:id/share` 256 / 撤销 0、`pool/publish` 1024、`pool/:id/report` 1024、`pool/:id/unpublish` 256、`pool/:id/replies` 512、删除回信 0、GET 0；超限 413 | ✓ |
| ID | UUID（校验到形状，不校验版本号）；路径参数走 `parseUuidParam`，形状不符 400 `invalid_parameter`；分享 token 为 `shortToken(16)` 生成的 Crockford base32（26 字符、128bit），形状 `[A-Za-z0-9_-]{16,32}`，形状不符按 404 `share_not_found` 处理 | ✓ 第 7 轮 |
| 日期串 | `YYYY-MM-DD` 且在 `2020-01-01…2035-12-31`（`isValidYmd`）；契约区间由服务端派生，不接受客户端传日期。账本只额外接受一个由客户端指定的 `week_start`，且必须同时满足"周一 + 契约区间" | ✓ |
| 枚举 | 未知枚举值一律 400 `invalid_parameter` + `details.fields`，不做静默降级（唯一例外：愿望分类零命中兜底为 `life`） | ✓ |
| 分页 | `limit` 默认 20、范围 1–100（`validate.ts#parsePage`，超出 400 `invalid_parameter`）；公开池与回信列表在 domain 层再钳到 **≤50**；`cursor` 非空且 ≤128 字符，解不开 → 400 `invalid_cursor` | ✓ `GET /api/wishes`、`GET /api/pool`、`GET /api/pool/:id/replies` |

## 10. 加密、脱敏与字段白名单

| 项 | 规则 |
| --- | --- |
| 加密范围 | `wish_answers` 全部 `*_enc` 字段（五问原文答案）。密文格式 `v1:<ivb64url>:<tagb64url>:<ctb64url>`，AES-256-GCM，12 字节随机 IV、16 字节 tag 从 Web Crypto 输出尾部切出，**AAD = `wishId`**（密文搬到别的愿签上解不开）。实际密钥 = `SHA-256(FIELD_ENCRYPTION_KEY)` 的原始字节，`key_version='v1'`。**✓ 第 3 轮已落地**（`lib/crypto.ts#encryptField`） |
| 明文可存 | 由答案推算出的**粗粒度枚举**（`q2_alone_level`、`q4_disposable_band`、`q1_gift_category` 等），用于确定性规则，避免每次解密。**第 5 轮起 `q4_disposable_band` 会在保存五问时写入**（`disposableBandOf(q4)`），首签据此推算首周预算；第 6 轮结算会解密 q5 做礼物类别细化，但不把 q5 的衍生档位另落一列 |
| 解密时机 | 仅 `GET /api/wishes/:id/answers`（本人，**后续轮实现**）与内部规则计算（第 6 轮：结算礼物类别，解密失败退回愿签类型对应的类别）；分享、公开池、回信、导出接口**一律不解密**。已落地的出口（愿签详情/列表/立契响应/幂等存档/结算响应）都不含答案明文与密文 |
| 导出 | `GET /api/me/export` 输出脱敏 JSON：不含五问原文、不含照片字节与签名 URL（PRD H-04/A-04） |
| 公开池摘要 | **✓ 第 7 轮**：`lib/sensitive.ts#toExcerpt` 把联系方式替换为 `***`、抹掉 ≥6 位连续数字、折叠空白后截 ≤120；`relation` 保留，昵称一律用 `display_label`（默认「匿名搭子」），不输出 `target_name` |
| 分享白名单 | **✓ 第 7 轮实际字段**：`wish.title / wish.wish_text / wish.summary / wish.relation / wish.relation_group / wish.wish_type / wish.status / wish.outcome / wish.outcome_label / wish.start_date / wish.end_date / wish.day_index / wish.settled_at` + `share.status / share.visits`。**明确禁止**：`*_enc`、`q*_*`、`ledger*`、`proof*`、`files*`、`object_key`、`letter_text`、`nickname`、`user_id`、`author_id`、礼物/`reward*`、任何 `*_cents` 或价格（彩蛋在分享页不剧透） |
| 文件 DTO | `toFileDto` 只回 `id / purpose / status / mime_type / size_bytes / wish_id / created_at / verified_at`；`sha256` 与 `object_key` 只在库内，不出接口；上传/完成/取 URL 三个响应的签名 URL 均不落库 |
| 作者视角白名单 | `toWishDto` / `toWishSummary` / `toTaskDto` 是唯一投影点：**永不外发** `user_id`、`version`、`outcome`（未结算）、`*_enc`、`recovery_code_hash`、`reg_ip_hash`、`template_id`。列表项比详情更少（不含 `wish_text` 原文与分类留痕） |
| 照片访问 | **✓ 第 7 轮**：私有桶 + `POST /api/uploads/:id/url` 换 600s 签名 GET URL，先过归属校验且只对 `ready` 文件签发；签名 URL 不入库、不入日志、不进分享正文 |
| 敏感词规则 | **✓ 第 7 轮** `lib/sensitive.ts`：手机号、身份证号、HTTP/www 外链、邮箱、微信/QQ 样式、带门牌号的地址、`加微信/代购/博彩/赌博/贷款/裸聊/约炮/私聊我` 等引流词；回信命中返回 400 `sensitive_content`，公开摘要走脱敏替换而不是拒绝 |
| 日志脱敏 | 只记 `requestId`、路由、主体哈希前 8 位、耗时、错误码；禁记 token、密钥、签名 URL、答案明文、原始 Provider 错误 |
| 合规 | 最小必要收集（PRD 5.3 不问病情细节/收入/地址）、可删除（15 天宽限）、可导出、健康信息单独同意并加密 |

## 11. 分页、排序与游标

- 游标（**✓ 已落地** `lib/cursor.ts`）：`cursor = base64url(json([sort_key, id]))`，`next_cursor` 由服务端生成，客户端不构造、不解析；解不开或形状不对 → 400 `invalid_cursor`。
- 取页方式：查 `limit + 1` 行，多出来那一行只用来判 `has_more`，返回前裁掉；`has_more=false` 时 `next_cursor=null`。
- **客户端没有 `or()`**：复合游标条件「`sort_key` 相同但 `id` 更大」**或**「`sort_key` 更小」必须拆成两条查询再合并（`listWishes` 就是这么做的），合并后在代码里重排。不能指望一条 SDK 查询表达析取。
- 排序白名单：`published_at|reply_count|fork_count`（公开池）、`created_at|start_date`（愿签）、`server_ts`（打卡）、`day_index`（任务）。
- **已落地的排序**：`GET /api/wishes` = `created_at desc`；`GET /api/pool` = `published_at desc`（`sort` 只接受 `latest`，其余值 400 `invalid_param`）；`GET /api/pool/:id/replies` = `created_at desc`；三个列表都带 `id desc` 二级键。
- 稳定次序：所有列表二级排序键固定为 `id desc`（与主键单调性一致），避免并发下翻页重复/漏项；平台不支持表达式索引，排序列必须有普通复合索引支撑（见 03 索引设计）。
- 次级排序在**代码里**做，不依赖数据库返回顺序：本地内存库只支持单列 `order()`，线上也不该把正确性押在返回顺序上（`listTasks` 的 `day_index → seq → id` 同理）。
- 公开池"最新"用 `published_at desc`，分类页用 `(wish_type, published_at desc)`——对应真实索引 `pool_posts_wish_type_published_at_idx`；回信用 `replies(post_id, status, created_at)` 支撑按帖翻页。
- 回信列表 `limit` 上限 50（`Math.min(limit, 50)`），公开池列表同样 50；`parsePage` 全局只校验 1–100，域名自己再收紧。

## 12. 响应头与缓存

已实现的 41 条接口实际发出的头（`backend/lib/respond.ts` + `backend/lib/http.ts`）：

```
content-type: application/json; charset=utf-8
cache-control: no-store                 # 所有接口；签名 URL 与静态资源不走这里
x-content-type-options: nosniff
x-frame-options: DENY
content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'
referrer-policy: no-referrer
permissions-policy: camera=(), microphone=(), geolocation=()
strict-transport-security: max-age=31536000; includeSubDomains
x-request-id: <requestId>               # 所有响应，与信封里的 requestId 同一个值
allow: GET, PATCH                       # 仅 405，由 details.allowed 拼接
retry-after: <seconds>                  # 429 与 409 idempotency_in_progress，由 details.retryAfterSeconds 换算
x-idempotent-replay: true               # 仅幂等重放响应（lib/idempotency.ts#replayOf）
access-control-allow-origin: <origin>   # 仅当 Origin 命中 CORS_ALLOW_ORIGINS（默认空 ⇒ 不发）
access-control-allow-credentials: false # 没有 Cookie 会话，明确不给
access-control-allow-headers: authorization, content-type, idempotency-key, x-client, x-demo-session
access-control-expose-headers: retry-after, x-request-id, x-idempotent-replay
access-control-allow-methods: GET, POST, PATCH, DELETE, OPTIONS
access-control-max-age: 600
vary: Origin                            # 与上一条同源：CORS 头随 Origin 变化
```

后续轮再加：`cache-control: public, max-age=30`（`GET /api/pool`、`GET /api/pool/:id`、`GET /api/s/:token`）与 `X-RateLimit-Remaining`。OPTIONS 预检由 `http.ts` 直接回 204，不进路由表。

## 13. 兼容与版本

- `meta.apiVersion = "v1"`；字段只增不减，客户端必须忽略未知字段。
- 破坏性变更走 `/api/v2/...` 并保留 v1 一个版本周期（≥30 天）。
- 枚举新增视为非破坏；枚举移除视为破坏性变更。
- 状态机取值（与迁移注释逐字一致，PRD 3.4）：
  - `Wish draft→active→settling→settled→archived`，另有 `deleted` 软删（`deleted_at`）。**第 3 轮实现 `draft→active`；第 6 轮实现 `active→settling→settled`**（结算两幕），以及仅 `cyber_only/unrealized` 可用的 `settled→active`（续期）。签署接口遇到 settling/settled 一律 400 `wish_not_draft`。
  - `Task pending→done/missed→made_up→revoked`。**第 4 轮实现 `pending→done`（打卡）、`pending→missed`（惰性日界）、`missed→made_up`（补卡）**；`revoked` 属撤销接口，尚未实现。
  - `LedgerEntry` 无状态机：只追加，不修改；`revoked_at` 留给后续撤销接口，第 5 轮恒 `null`。
  - `PoolPost published→hidden/deleted`（发布即公开，无人工审核态）。**第 7 轮实现**：`published` 发布即公开；`hidden` 由举报满阈值 CAS 自动写入（`hidden_at`）；`deleted` 由作者 `POST /api/pool/:id/unpublish` 写入。`hidden` 不可重新发布（400 `pool_hidden`），`deleted` 可重复发布（同一行复位为 `published`）。
  - `Reply published→deleted`。**第 7 轮实现**：创建即 `published`；`DELETE /api/replies/:id` 写 `deleted`+`deleted_at`（作者或帖主）；列表/详情只统计 `published`。
  - `Report open→acted`。**第 7 轮实现**：举报即 `open`；帖子被自动隐藏时同批把 `open` 报告改为 `acted`+`action_taken='auto_hidden'`（无人工处置态）。
  - `ShareLink active→revoked`。**第 7 轮实现**：创建/重复生成只保留一行（`UNIQUE(wish_id)`），重新生成即轮换 `token`；`DELETE /api/wishes/:id/share` 写 `revoked`，再生成会得到新 token 并复位 `active`。
  - `File pending→ready/rejected/deleted`。**第 7 轮实现**：`presign` 写 `pending`；`complete` 校验对象存在、格式/大小后 CAS `pending→ready`，格式不符写 `rejected`；**第 9 轮补 `pending→expired`**：`files.expires_at` 为 presign 后 2 小时，`complete` 遇过期先标 `expired` 再 400 `upload_expired`；每次新 presign 也会在限流计数前把本人已超时的 `pending` 行批量标 `expired`（惰性清扫，不依赖 cron）。
- 枚举落地纪律：状态词表只写在**迁移注释 + `domain/` 常量**两处，接口层不另抄一份；`ai_jobs` 不建表（AI 辅助只出建议、由用户点选写入，见 01 §9）。
