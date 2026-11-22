# 05 · 配置、密钥与运行方式

> 第 2 轮建立、第 3–9 轮补充。回答三个问题：密钥从哪来、本地怎么跑起来验证、线上按什么顺序开通。**第 8 轮新增 6 个变量**（演示 TTL、AI 日额度、AI 超时、AI 缓存 TTL、Agents 端点与令牌）；**第 9 轮新增 1 个变量** `API_PER_MINUTE`（全路由兜底限流）。第 5 轮账本与第 6 轮结算没有新增环境变量：预算上限、金额上限、档位映射、结算开放点、差额阈值都是 `domain/ledger.ts` 与 `domain/settlement.ts` 的确定性常量。

## 1. 配置项全表

装载入口 `backend/lib/config.ts`：先读 `Deno.env`（线上），再读 `process.env`（本地）。
**必填项缺失不会用默认值兜底** —— `index.ts` 捕获 `ConfigError` 后只保留 `/api/health`，
其余请求统一返回 `503 / service_not_configured`，避免「用硬编码密钥签了 token」这种静默故障。

| 变量 | 必填 | 默认 | 作用 | 泄露后果 |
| --- | --- | --- | --- | --- |
| `JWT_SIGNING_KEY` | 是 | — | HS256 签发/校验 Bearer Token | 可伪造任意用户身份，必须立刻轮换 |
| `TOKEN_PEPPER` | 是 | — | `auth_tokens.token_hash` 的 HMAC 密钥（存档用） | 已入库的 token 摘要可被离线关联 |
| `RECOVERY_PEPPER` | 是 | — | 恢复码 HMAC 摘要的密钥 | **恢复码可被字典反查**，与 JWT 密钥分开就是为了少换一次 |
| `IP_HASH_SALT` | 是 | — | 注册/找回限流用的 IP 摘要 | 可反推历史 IP；限流本身不是安全边界（见 §4） |
| `IDEM_FINGERPRINT_KEY` | 是 | — | 幂等请求指纹 HMAC | 可伪造「同键同内容」的重放判定 |
| `FIELD_ENCRYPTION_KEY` | **是**（第 3 轮起） | — | 五问答案字段级 AES-256-GCM 的根密钥（`lib/crypto.ts#encryptField`，实际密钥 = SHA-256(本值)，AAD = `wish_id`） | **已入库的五问密文可被解密**；与 JWT 密钥分开，泄露时只需重加密答案而不必踢掉所有会话 |
| `TOKEN_TTL_DAYS` | 否 | 30 | JWT 绝对有效期（PRD A-02 的 30 天），范围 1–60 | 调大等于撤销窗口变长 |
| `GUEST_PER_HOUR` | 否 | 10 | 同 IP 每小时游客注册上限，范围 1–1000 | — |
| `RECOVER_PER_HOUR` | 否 | 12 | 同 IP 每小时找回尝试上限，范围 1–1000 | — |
| `DEMO_PER_HOUR` | 否 | 30 | 同 IP 每小时可开的演示会话上限（`POST /api/demo/session`），范围 1–1000；超限 429 `demo_too_many_sessions` | 调大等于放宽演示刷号成本 |
| `DEMO_TTL_HOURS` | 否 | 24 | 演示会话与演示 token 的有效期，范围 1–72；过期 401 `demo_session_expired` | 调大等于延长过期演示数据的占用窗口 |
| `WISH_CREATE_PER_DAY` | 否 | 20 | **同账号每产品日创建愿签上限**（04:00 为界，草稿也计数），范围 1–1000；超限 429 `wish_create_limited` + `retry-after` | 调大等于放宽刷草稿成本 |
| `CHECKIN_PER_MINUTE` | 否 | 10 | **同账号每分钟打卡上限**（滚动 60s 窗，按 `checkins` 落库行数计），范围 1–600；超限 429 `checkin_rate_limited` + `retryAfterSeconds` | 调大等于放宽刷打卡成本；同一任务重复提交只覆盖同一行、不增加计数 |
| `UPLOAD_PER_HOUR` | 否 | 30 | **同账号每小时 presign 次数上限**（按 `files` 行计，范围 1–50）；超限 429 `upload_rate_limited` | 调大等于放宽占存储/刷 pending 行的成本 |
| `POOL_PUBLISH_PER_DAY` | 否 | 5 | **同账号每产品日发布公开池上限**（范围 1–50）；超限 429 `publish_quota_exceeded` | 调大等于放宽刷公开池成本 |
| `POOL_REPORT_PER_HOUR` | 否 | 20 | **同账号每小时举报上限**（范围 1–50）；超限 429 `report_rate_limited` | 调大等于放宽恶意举报成本 |
| `POOL_REPORT_HIDE_THRESHOLD` | 否 | 3 | **同一帖子自动隐藏的举报人数阈值**（范围 1–20）；达到即 `status='hidden'` | 调低会被少量人合谋下架；调高等于隐藏更难触发 |
| `REPLY_PER_DAY` | 否 | 20 | **同账号每产品日回信总上限**（范围 1–50）；超限 429 `reply_rate_limited`；同帖每天 1 条是独立规则（非环境变量） | 调大等于放宽刷回信成本 |
| `AI_POLISH_PER_DAY` | 否 | 20 | **同账号每产品日 AI 润色调用上限**（范围 1–1000），只数 `ai_suggestions.source='agent'` 的行；额度耗尽回模板并标 `quota_exceeded`，不返回 429 | 调大等于增加模型调用成本 |
| `AI_TIMEOUT_MS` | 否 | 8000 | 调用 Agents 端点的超时（范围 100–60000），超时回模板并标 `timeout` | 调小会让更多请求走模板；调大只影响单请求延迟 |
| `AI_CACHE_TTL_HOURS` | 否 | 72 | 相同输入的建议缓存有效期（范围 1–720）；过期行在下次命中时惰性删除 | 调大等于更久复用旧建议，降低费用但可能过时 |
| `AI_AGENT_ENDPOINT` | 否 | 空 | Agents HTTP 端点；**为空时只用确定性模板**，不发起外部请求 | 填错只会持续回退模板；填成外部恶意地址等于把脱敏输入发出去 |
| `AI_AGENT_TOKEN` | 否 | 空 | 调 Agents 端点时的 `Authorization: Bearer` 令牌；只在配置了端点时使用 | 泄露可被他人冒用模型额度；按 Secret 管理，不要写进仓库 |
| `CORS_ALLOW_ORIGINS` | 否 | 空 | 允许的跨域来源，逗号分隔 | 填 `*` 会让任意站点带 Bearer 读写数据，禁止 |
| `API_PER_MINUTE` | 否 | 1200 | **第 9 轮新增**：单实例全路由兜底限流（每 IP 每分钟，范围 60–100000，固定 60s 窗）；`/api/health*` 不参与；超限 429 `api_rate_limited` + `retry-after` | 调小会误伤正常用户；调大等于放宽单 IP 刷接口与撞库成本。多实例部署时是「每实例」上限，不是全站总量 |
| `SEED_ON_START` | 否 | 0 | **部署兜底**：设为 `1` 时，Function 实例首个请求会用自身的 DB 客户端幂等补齐 `wish_templates` 72 / `task_templates` 120 / `rewards` 24；行数已齐则只读计数、不再写。播种失败只记日志并把状态暴露在 `/api/health/deep`，不影响鉴权接口启动 | 只控制种子补给，不授予额外数据权限；平台批量写工具恢复后应设回 `0` |
| `PORT` | 否 | 8787 | 仅 `tools/local/serve.ts` | 本地 |

**限流阈值不要配到 50 以上**：`lib/quota.ts#SCAN_LIMIT = 50`，`enforceWindow` 靠"按索引扫时间窗内最多 50 行"计数，阈值超过扫描上限就永远判不出超限。第 7 轮新增的四个窗口阈值（`UPLOAD_PER_HOUR` 30、`POOL_PUBLISH_PER_DAY` 5、`POOL_REPORT_PER_HOUR` 20、`REPLY_PER_DAY` 20）在 `config.ts` 里就把范围上限钉在 50；`POOL_REPORT_HIDE_THRESHOLD` 不属于窗口计数，范围 1–20。要调高必须先改 `SCAN_LIMIT`。`AI_POLISH_PER_DAY` 例外：它由 `domain/ai.ts#agentUsedToday` 单独扫描，上限 1000、范围上限也是 1000。

`API_PER_MINUTE` 与上表的账号级窗口限流不同：它由 `lib/rate-limit.ts` 在内存 Map 里按 IP 计数，不查库、不受 `SCAN_LIMIT` 影响，只做「单实例最后的兜底」。因此它不能替代业务限流（重启即清零、多实例各自计数），业务阈值仍以来源表计数为准。

`issuer=yuan-ta`、`audience=yuan-ta-api`、`apiVersion=v1` 写死在 `config.ts`：
它们出现在 JWT 与响应里，改值等于换协议，不该由部署环境漂移。

## 2. 密钥生成与轮换

```bash
# 6 个必填密钥，逐个生成（base64url 43 字符，无斜杠无加号，YAML/Deno.env 都安全）
node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'
```

轮换顺序（每步都要重新部署 Function，平台不支持热更新）：

1. `JWT_SIGNING_KEY`：旧 token 全部失效。先在 `auth_tokens` 里把 `status='active'` 批量置 `revoked`
   会踢掉所有人，所以正确做法是**双密钥过渡**：`verifyToken` 支持 `JWT_SIGNING_KEY_OLD` 时先加旧密钥校验分支
   （**仍未实现**，第 3 轮没做，需要时再加），或选维护窗口公告 + 等 30 天自然过期。
2. `RECOVERY_PEPPER`：摘要无法原地重算 ⇒ 必须「登录态内主动换码」，
   即让在线用户走一次 `rotateRecoveryCode`；离线用户仍能用旧码命中旧摘要，因此**只能在密钥彻底作废时换**。
   结论：这把密钥要在上线前定稿，后续换 = 数据迁移。
3. `FIELD_ENCRYPTION_KEY`：**换密钥 = 全量重加密**。密文头是 `v1:`，`wish_answers.key_version` 记版本，
   所以正确做法是「新密钥写 `v2:`、读路径按 `key_version` 选密钥、后台批量把 `v1` 行解密再加密」——
   本项目范围外没有后台，因此这把密钥同样要**上线前定稿**。泄露时的应急顺序：先换新密钥停止继续泄露，
   再安排重加密；期间旧密文仍可读，不要直接删列。
4. `TOKEN_PEPPER`：只影响存档摘要，不影响鉴权，随时可换（新登录写新摘要）。
5. `IP_HASH_SALT`、`IDEM_FINGERPRINT_KEY`：随时可换；前者会让限流桶错位一次，
   后者会让「同键重放」判定退化为新键（幂等表按 7 天惰性清理，可接受）。

## 3. 本地运行（Node 即可，不需要 Deno）

```bash
node tools/local/serve.ts          # http://127.0.0.1:8787
node tools/local/smoke.ts          # 470 条断言：鉴权/幂等/限流/找回/演示隔离/路由 + 愿签五问/立契/任务引擎/分页/打卡补卡/账本/结算两幕/三档结局/续期 + 上传实测字节/pending 2h 失效/分享轮换撤销/公开池发布举报隐藏/回信 + AI 模板/agent/脱敏/缓存/额度/超时/坏输出 + 演示基线/快进/三结局/重置/过期/限流 + 安全头/控制字符清洗/405 Allow/API_PER_MINUTE 兜底
node tools/local/seed-smoke.ts     # 12 条断言：启动播种首次 72/120/24、重复执行 skipped、部分缺失只补缺
node tools/scripts/check-routes.ts # 路由表自洽（含 route 声明与文件路径一致性）
node tools/scripts/check-migrations.ts
node tools/scripts/check-schema-usage.ts # 代码里的表名/列名/写入键是否真在 DDL 里
node tools/scripts/build-seeds.ts --check
node tools/scripts/diff-schema.ts        # 设计稿与迁移的逐表差异
```

- 本地走 `tools/local/fake-db.ts`（内存 PostgREST 子集），**不是**真库：
  它验证的是路由、校验、封套、CAS 与幂等逻辑；SQL 子集由 `check-migrations.ts` 静态保证。
- 内容库种子由 `tools/local/deps.ts#seedCatalog` **直接读 `database/seed/*.json`**（与线上导入的是同一份数据），
  本地不另写一套文案，否则「线上抽得到、本地抽不到」这类漂移就测不出来。
  内存库不套用列默认值，所以 seed 里 `is_active` / `min_budget_cents` 必须显式给值（`build-seeds.ts` 有断言）。
- 时钟固定起点 `2026-05-20T06:00Z`（产品日 2026-05-20），`deps.clock.advance(ms)` 可推时间，
  所以「次日 04:00 才结算」「30 天 JWT 过期」「周末追加钱任务」这类断言不依赖真实时间。第 6 轮的冒烟正是把时钟推到 `settleOpenAt` 前一毫秒/后一毫秒验证门禁，再验证三档结局、并发 CAS 与续期后的第二版结算。
- 密钥默认值在 `tools/local/deps.ts`（含 `FIELD_ENCRYPTION_KEY`），仅供本地；仓库里没有生产密钥。
- `createLocalDeps(start, overrides)` 可覆盖配置，冒烟用 `{ wishCreatePerDay: 2 }` 起第二个 app 实例来验限流分支。

```bash
# 真实注册一次（注意：channel 必须是 xiaohongshu|douyin|wechat|bilibili|friend|other）
curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/auth/guest \
  -H 'content-type: application/json' -H 'x-forwarded-for: 1.2.3.4' \
  -d '{"channel":"other","nickname":"curl-demo"}'

# 创建愿签草稿（必须带 Idempotency-Key），再答五问、立契
curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/wishes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: $(node -e 'console.log(crypto.randomUUID())')" \
  -d '{"relation":"姥姥","wish_text":"姥姥的腿疼能轻一些，别再一个人在家扛着。"}'

curl -s -X PUT http://127.0.0.1:8787/functions/v1/app/api/wishes/$WISH_ID/answers \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"q1":"最怕她腿疼加重","q2":"基本一个人待着","q3":"三个月没回家","q4":"每月能挤出两百","q5":"想要一副护膝"}'

curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/wishes/$WISH_ID/contract \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"days":7}'

# 账本：读当前周（契约定后自动有首周预算），改下周预算，记一笔支出
curl -s "http://127.0.0.1:8787/functions/v1/app/api/wishes/$WISH_ID/ledger" \
  -H "authorization: Bearer $TOKEN"

curl -s -X PUT "http://127.0.0.1:8787/functions/v1/app/api/ledger/weeks/2026-05-25" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"wish_id\":\"$WISH_ID\",\"budget_cents\":12000}"

curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/ledger/entries \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: $(node -e 'console.log(crypto.randomUUID())')" \
  -d "{\"wish_id\":\"$WISH_ID\",\"week_start\":\"2026-05-18\",\"type\":\"expense\",\"amount_cents\":2580,\"note\":\"晚饭\"}"

# 结算（只有截止日次日 04:00 后才放行；serve 用真实时钟，7 天契约当天会返回 settle_too_early）
curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/wishes/$WISH_ID/settle \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'

curl -s http://127.0.0.1:8787/functions/v1/app/api/wishes/$WISH_ID/settlement \
  -H "authorization: Bearer $TOKEN"

# 续期（仅 cyber_only / unrealized，且每个愿签一次）
curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/wishes/$WISH_ID/extend \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'

# 第 7 轮：申请上传 → 直传对象存储 → 完成校验 → 换 600s 读取 URL
# 本地 FakeStorage 的 PUT 地址可直接 curl -X PUT --data-binary @图片 到 upload_url
curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/uploads/presign \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"purpose":"checkin_proof","mime_type":"image/png","filename":"proof.png","size_bytes":12345}'

curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/uploads/complete \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"file_id\":\"$FILE_ID\"}"

curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/uploads/$FILE_ID/url \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'

# 分享：生成/轮换 → 匿名打开（无需 Token）→ 撤销
curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/wishes/$WISH_ID/share \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'

curl -s http://127.0.0.1:8787/functions/v1/app/api/s/$SHARE_TOKEN
curl -s -X DELETE http://127.0.0.1:8787/functions/v1/app/api/wishes/$WISH_ID/share \
  -H "authorization: Bearer $TOKEN"

# 公开池：发布（需已结算）→ 匿名列表/详情 → 举报 → 作者下架
curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/pool/publish \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"wish_id\":\"$WISH_ID\",\"category\":\"life\",\"is_anonymous\":true,\"excerpt\":\"想陪姥姥去看海\"}"

curl -s "http://127.0.0.1:8787/functions/v1/app/api/pool?category=life&limit=10"
curl -s "http://127.0.0.1:8787/functions/v1/app/api/pool/$POST_ID"
curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/pool/$POST_ID/report \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"reason_code":"spam","detail":"广告"}'
curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/pool/$POST_ID/unpublish \
  -H "authorization: Bearer $TOKEN"

# 回信：发布 → 匿名列表 → 删除（回信作者或帖主）
curl -s -X POST http://127.0.0.1:8787/functions/v1/app/api/pool/$POST_ID/replies \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"content":"你已经做得很好了，慢慢来。"}'

curl -s "http://127.0.0.1:8787/functions/v1/app/api/pool/$POST_ID/replies?limit=10"
curl -s -X DELETE http://127.0.0.1:8787/functions/v1/app/api/replies/$REPLY_ID \
  -H "authorization: Bearer $TOKEN"
```

## 4. 限流与「IP 不可信」这件事

平台文档没有提供可信客户端 IP 头，Edge 前置链路的 `x-forwarded-for` 在第一跳之后即可被客户端伪造。
因此 `lib/ip.ts` 取到的 IP 只用于：

- 同主体重复注册判定（`users.reg_ip_hash`）；
- 找回接口的尝试次数窗口（`auth_attempts`）。

这两处都是**从宽的兜底**，不是安全边界。真正的硬约束是：恢复码本身 26 个 Crockford 字符（≈130 bit 熵）
+ 服务端只存 HMAC 摘要 + 找回成功后旧码立刻轮换、旧 token 全撤。
后续若平台提供可信 IP，改 `ip.ts` 的取值顺序即可，判定代码不用动。

## 5. 线上开通顺序

| 步骤 | 动作 | 说明 |
| --- | --- | --- |
| 1 | 创建/确认站点，开通后端能力 `function_backend` | `get_site(include:["backend"])` 确认类型 |
| 2 | 写入 §1 的 **6 个必填 Secrets** | Function Secrets，部署时注入 `Deno.env`；缺一个就整体 503 `service_not_configured`（只留 `/api/health`）。`AI_AGENT_ENDPOINT` / `AI_AGENT_TOKEN` 可选：不配就只用模板，配了建议同样按 Secret 管理 |
| 3 | 执行 **7 个迁移批次**（0001→0007，顺序不可换） | 调用形状见 `database/migrations/README.md`；唯一性用建表期表级 `UNIQUE`（平台不接受 `CREATE UNIQUE INDEX`）。**先执行 0007 再部署含 AI 的 Function**，否则 AI 润色写缓存会因缺表失败 |
| 4 | 导入 seed 三份 JSON（72 / 120 / 24 行） | 见 `database/seed/README.md`。`insert_database_rows` **不支持 upsert**；先查已有 id、只补缺失行。**不导 `task_templates` 就无法立契**（503 `task_pool_empty`）；**不导 `rewards` 就无法结算**（503 `reward_pool_empty`） |
| 5 | 打包部署 Function（源码根 = `backend/`，入口 `index.ts`） | 不能带 `_qoder/`，`Deno.serve` 保留 |
| 6 | 打开 `/functions/v1/app/api/health/deep` 验证数据库连通 | 不通会返回 `database_unavailable` |
| 7 | 跑一次真实注册 + 找回 + 撤销 | 覆盖本地拿不到的真库行为 |
| 8 | 跑一次真实"创建草稿 → 答五问 → 立契 → 重签 → 读账本 → 改预算 → 记支出 → 结算 → 读两幕 → 续期" | **重点复验 `insertIfAbsent` 的逐行忽略冲突语义**：删掉一条 `tasks` 行再重签，应当只补回那一条（docs/03 §9）；同时确认 `ledger_weeks` 首周预算已随立契写入、`realized_cents` 与整数复算一致；结算需把时间推到截止日次日 04:00 后（或用一个已到期的测试愿签），并发打两次 settle 只应产生一版快照，`settlements` 行先于 `settled` 状态落库 |
| 9 | 跑一次真实"presign → 直传 → complete → 取 URL → 记打卡证明" | 重点验证对象存储：桶为私有、PUT 必须带 `content-type`、`download` 能在 15 秒内读回、600s GET URL 到期后 403；`complete` 重放返回同一 `ready` 行，文件头与声明 MIME 不符时行变 `rejected` |
| 10 | 跑一次"结算 → 发布公开池 → 匿名列表/详情 → 三人举报自动隐藏 → 回信 → 删除" | 验证匿名出口不含 `author_id/wish_id/五问/账本/文件`，隐藏后列表/详情/回信统一 404 `pool_hidden`，同一用户重复举报 409，回信同帖日限 409 |
| 11 | 跑一次 AI 润色（先不配端点，再配端点） | 不配端点应返回 3 条模板建议、`source=template`、每条带「AI辅助」且不写愿签；配端点后同一输入第二次应 `cached=true`、`quota.used` 不再增长。若真实端点返回格式不符，应看到 `invalid_output` 而非 500 |
| 12 | 跑一次演示全流程：session → state → fast-forward → 三种 scenario → reset | 验证演示 token 不能写真实数据（分享/公开池/AI 均 403 `demo_forbidden`），快进结算统计与 `tasks` 行一致、`realized_cents = saved + income`，真实账号列表看不到演示愿签；把时钟推过 `DEMO_TTL_HOURS` 后应 401 `demo_session_expired` |

## 6. 本轮未验证的清单（诚实记录）

| 项 | 状态 |
| --- | --- |
| 7 个迁移在真实平台被接受 | **未验证**：只做了 SQL 子集静态校验（98 条语句 / 22 张表），云资源创建需要授权；0007 `ai_suggestions` 尚未上云 |
| AI 真实端点 | 未验证：本地只覆盖模板、注入适配器、超时与坏输出回退；`AI_AGENT_ENDPOINT` 的返回结构、限流、计费与真实延迟需部署后联调。端点失败会稳定回退模板，但「AI辅助」标签是否被前端原样展示不在服务端可控范围 |
| 演示数据清理 | 未验证：过期会话只在下次 `POST /api/demo/session` 时惰性清理**本 IP 最早到期的 3 条**，且删除跨多张表依赖平台写权限；长时间无人创建演示会留下过期账号与子表 |
| `insert_database_rows` 导入 seed | 未验证（同上） |
| 真库 `insertIfAbsent(onConflict)` 返回语义 | 未验证：本地 fake 按 PostgREST 语义模拟「**逐行**跳过冲突、返回真正插入的行」。**第 3 轮的崩溃补齐与重复立契完全依赖这一语义**，若平台实际是整批失败，重签会报错而不是补齐 |
| 真库唯一索引含 NULL 的行为 | 未验证：轮转副本靠 `tasks_wish_template_uidx` 允许多个 `template_id = NULL`，这是 PostgreSQL 标准语义，但平台子集需实测 |
| `x-forwarded-for` 在实际部署里是否有值 | 未验证：见 §4 |
| 对象存储（两段式上传） | **接口已实现、真实存储未验证**：第 7 轮补齐 presign/complete/url，本地用内存 FakeStorage 覆盖了「PUT → download 实测字节 → magic bytes → CAS ready → 600s URL」。云端需验证私有桶、PUT 的 content-type 约束、15 秒超时与 GET URL 到期行为；`complete` 失败一律 503 `storage_unavailable`，不会误标 ready |
| pending 文件清理 | **第 9 轮已实现、真库未验证**：presign 后 2 小时未 `complete` 即失效——`complete` 对过期行返回 400 `upload_expired` 并把状态改 `expired`；同账号下一次 `presign` 时再按 `expires_at` 惰性批量标记过期。孤儿对象仍需离线按 `files (status, expires_at)` 清扫 |
| 回信同帖日限 | 未验证且无库级约束：`replies` 没有「(post_id, author_id, 日期)」唯一索引，「同帖每天一条」是窗口查询 + 插入，同一用户并发双请求可能多一条；全站 `REPLY_PER_DAY` 仍是独立兜底（docs/03 §9） |
| 公开池/回信计数上限 | 未验证：`reply_count` 与 `report_count` 的统计都带 `limit 50`，超过 50 条回信时展示值停在 50；隐藏阈值 3 远低于 50，判定不受影响 |
| 打卡/补卡的真实时间语义 | 未验证：日界扫描是条件批量 `update`（`pending + task_date < today`），真库 `affected()` 行数与并发下的重复扫描需部署后观察；本地用固定时钟覆盖了 04:00 边界、跨周与券过期 |
| 账本 `updated_at` CAS | 未验证：本地 fake 用 ISO 字符串比较，预算修改以严格递增的 `updated_at` 为令牌。若真库 `timestamptz` 精度或 `now()` 在同一毫秒内不够区分，需改为显式递增计数器列 |
| 账本收入重复关联 | 未验证且无库级约束：并发双写同一 `task_id` 的两笔收入可能都成功，读取时会重复计入。上线后按 `ledger_entries (task_id)` 抽查；根治需后续迁移加唯一列（docs/03 §9） |
| `update().eq()` 的真实返回行数 | 未验证：`affected()` 依赖平台 SDK 回传行数组长度（写请求一律带 `select`），本地 fake 直接数内存行。**立契的单行 CAS、账本预算 CAS 与结算 `active→settling` / 续期 CAS 判定都靠它** |
| 结算快照与状态收尾顺序 | 未验证：本地按"快照先 `insertIfAbsent`、再 `settling→settled`"验证，崩溃窗口靠租约接管。真库需确认 `settlements` 行落库后 `wishes` 收尾 0 行时能被下一次调用补齐，且并发只产生一版 |
| 结算租约 60 秒 | 未验证：`settling` 无快照时按 `updated_at` CAS 接管，依赖真库时间精度足以区分首写与接管写；若同毫秒不可区分，接管会持续 409（docs/01 §14） |
| 礼物类别与 q5 解密 | 未验证：结算在 Deno edge 解密 q5 定类别；本地已覆盖"q5 命中护膝 → 168 元刚好够"，但真实 Web Crypto 的 IV/tag 切分需部署后再验一次。解密失败会退回 `wish_type` 映射，不阻断结算 |
| 冷启动清理幂等占位 | 未验证：`sweepExpired()` 挂在实例第一个请求上异步执行，删除是否被 `function_backend` 策略允许需部署后看一次日志 |
| Deno 类型检查 | 未执行：本机没有 Deno、也无网络安装；第 9 轮跑了 Node 侧四个校验器 + 470 项冒烟断言（type-stripping 不做类型检查）。第 8 轮曾在有缓存的机器上跑过 `tsc --strict`（`.tscheck/`），第 9 轮改动未再跑 tsc，需在有 Deno 的环境补一次 `deno task verify` |
| 全路由兜底限流 | 未验证：`API_PER_MINUTE` 是进程内 Map（`lib/rate-limit.ts`），本地已覆盖健康探针豁免与 429 `retry-after`；真机多实例部署时每个实例独立计数，冷启动清零，不构成全站配额 |
| AES-256-GCM 在 Deno edge 的 Web Crypto 行为 | 未验证：本地 Node 与线上 Deno 都用 `crypto.subtle`，但 IV/tag 切分与 base64url 编码需部署后解一次密文确认 |
