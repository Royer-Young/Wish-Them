# 13 · 第 9 轮开发总结（最终收尾）

> 范围：全局校验补漏、安全加固、最终交付文档与部署准备。
> 约束：不新增业务功能、不改变既有接口契约、不执行任何云端写操作。

## 1. 本轮做了什么

### 1.1 全接口巡检（41 条）

按「鉴权 → 归属/403 → 参数/400 → 状态机 → 幂等 → 枚举白名单 → 死代码」逐条检查：

- 7 条账号/系统、5 条愿签、3 条任务、3 条账本、3 条结算、3 条上传、3 条分享、5 条公开池、3 条回信、1 条 AI、5 条演示，共 41 条，全部有 `route` 声明与冒烟覆盖。
- 读路径查不到（含非作者）→ 404；写路径存在但非作者 → 403；非法状态流转 → 400；真并发 → 409。三套口径在所有模块一致。
- 所有写接口按 `route.maxBodyBytes` 限长；枚举、长度、UUID、日期、金额均走 `lib/validate.ts`，错误汇总到 `details.fields`。
- 幂等矩阵与路由声明一致：`wish.create` required，其余写接口 optional，读/凭证/删除 none。没有「声明了 optional 却没走幂等中间件」的路由。
- 未发现未登记路由、重复 `operation`、路径与文件位置不一致；`check-routes.ts` 全绿。

### 1.2 遗留风险修复

| 项 | 本轮处理 | 结果 |
| --- | --- | --- |
| 演示过期会话清理 | 新会话创建时按 `expires_at` 升序，只清**本 IP 最早到期的 3 条**；逐条确认 `is_demo` 后删子表/愿签/文件/token/会话/账号 | `domain/demo.ts#purgeExpiredDemoSessions`；冒烟覆盖「4 条过期只清 3 条」 |
| pending 上传永久占位 | presign 后 **2 小时**未 complete 即失效：`complete` 返回 400 `upload_expired` 并标 `expired`；下一次 presign 惰性批量标记本人过期 pending | `domain/upload.ts`；冒烟覆盖直接过期与惰性清扫两条路径 |
| 重复收入并发边界 | 保留「先查后插」实现，但把边界写进代码注释与文档：两个不同幂等键的并发仍可能各写一行；根治需后续 `earning_task_key` + 表级 `UNIQUE` | 契约 §0.1.12、数据库 §9、部署手册排障表 |
| 演示数据统计污染 | 复核所有列表/公开出口都排除 `is_demo`；真实账号读不到演示愿签 | 既有断言保持通过 |

### 1.3 安全加固

| 项 | 实现 |
| --- | --- |
| 统一安全响应头 | 所有 JSON 响应：`nosniff`、`x-frame-options: DENY`、CSP `default-src 'none'; frame-ancestors 'none'; base-uri 'none'`、`referrer-policy: no-referrer`、`permissions-policy`、HSTS、`cache-control: no-store` |
| 405 `Allow` | 方法不支持时 `Allow` 头与 `details.allowed` 同源；冒烟校验 GET/PATCH 列表 |
| 全路由兜底限流 | 新增 `lib/rate-limit.ts`（实例内存、固定 60s 窗、`MAX_BUCKETS=20_000`），`API_PER_MINUTE` 默认 1200；`/api/health*` 豁免；超限 429 `api_rate_limited` + `Retry-After` |
| 控制字符清洗 | `validate.ts` 去掉 C0/C1 控制字符（保留 `\t \n \r`）再做长度/枚举校验；`PATCH /api/me` 冒烟验证 `阿\u0007甘 → 阿甘` |
| XSS 防御 | 输入按纯文本存储；响应 `application/json` + `nosniff`；冒烟验证 `<img src=x onerror=...>` 原样存储且不渲染 |
| 配置缺失兜底 | `index.ts` 的 `ConfigError` 分支改为统一 `fail(serviceUnavailable(), requestId)`，与正常响应共享安全头，不再手拼 JSON |
| 异常与日志 | 500 固定文案 + `requestId`；堆栈/SQL/约束名/内部路径只进日志；签名 URL 与 token 不入库、不进日志 |
| 加密与私有数据 | 五问 AES-256-GCM（AAD=`wish_id`）、恢复码只存 HMAC；对象存储私有桶 + 600s GET；公开/分享 DTO 白名单不变 |

### 1.4 边界与异常

- 空数据：空列表、空今日任务、未结算读结算、从未分享撤销，均返回明确 4xx 而不是 500。
- 极端值：愿望 120 字、五问 200 字、回信 80 字、备注 60/30 字、预算/支出 200000 分、收入 100000 分；超长/越界统一 400 + `details`。
- 时间边界：04:00 产品日界、周一换周、结算开放前一毫秒/后一毫秒、30 天 token、24h 演示 TTL、2h 上传 TTL，均有固定时钟断言。
- 跨月/跨年：日期用 TEXT + `addDays`，不依赖数据库日期函数；冒烟覆盖跨周与长契约。
- 特殊字符：控制字符清洗、XSS 串按文本、敏感词/联系方式拦截在 `lib/sensitive.ts`。
- 统一异常：400/401/403/404/405/409/413/415/422/429/500/503 均有稳定 `errorCode`；未知路径 404 `route_not_found`。

### 1.5 限流与配置

- 业务限流 10 个阈值 + 服务层兜底 1 个，全部环境变量化；阈值上限与 `SCAN_LIMIT=50` 的约束写进配置校验与文档。
- 新增 `API_PER_MINUTE`（60–100000），部署时按实例数估算总量；文档明确它不能替代业务限流（重启清零、多实例独立计数）。

### 1.6 文档交付

- `docs/04-api-contract.md`：最终版；41 条已实现接口、全局约定、errorCode 总表、幂等矩阵、限流表、安全与隐私、分模块 curl。
- `docs/02-conventions.md`：补 429 `api_rate_limited`、2h `upload_expired`、安全头与 `Allow`。
- `docs/01-architecture.md`：断言数 470、演示清理口径、上传 2h、风险 13/17 更新。
- `docs/03-database.md`：`files.status=expired`、2h 失效、清理口径。
- `docs/05-environment.md`：新增 `API_PER_MINUTE`、本地断言数、诚实记录未验证项。
- 新增 `docs/11-deployment.md`、`docs/12-frontend-integration.md`、`docs/13-round9-summary.md`、`docs/14-test-report.md`。
- `README.md` 改为最终交付版。

## 2. 与 PRD 的对齐

| PRD 能力 | 状态 |
| --- | --- |
| A 账号与会话（游客、恢复码、多设备、退出） | ✅ 7 条路由；Bearer 30 天、jti 撤销、恢复码只存 HMAC |
| B 愿签与五问（12 关系、六类愿望、五问、立契） | ✅ 确定性分类 + 标题派生；五问部分提交、AES-256-GCM |
| C 每日任务（2 必做 + 周末钱任务、7/14/30 天） | ✅ 确定性抽取、派生 id、崩溃补齐、轮转副本 |
| D 打卡与补卡 | ✅ 提交即完成、覆盖更新、周券、惰性 missed |
| E 账本（预算、支出、兼职收入、实时聚合） | ✅ 整数分、自然周、超预算不拦、收入关联钱任务 |
| F 结算（三档结局、礼物、两幕、续期） | ✅ 确定性判定；差额相对价格中位数；续期 +7 天一次 |
| G AI 辅助（润色、标签、兜底） | ✅ 仅 P0 润色；模板/端点适配器；「AI辅助」强制 |
| H 上传与分享 | ✅ 两段式直传、实测字节、私有桶、600s URL；分享轮换/撤销/白名单 |
| I 公开池与回信 | ✅ 发布即公开、举报自动隐藏、回信日限 |
| J 演示模式 | ✅ 五接口、真实引擎复用、物理隔离、TTL 与限流 |
| K 安全与运营 | ⚠️ 无后台/审核队列/埋点表；举报隐藏替代先审后发；离线清扫待排期 |

## 3. 本轮的边界与未做

- **没有新增业务功能、没有新增路由、没有新增迁移**；所有改动向后兼容。
- **没有执行云端写操作**：迁移、seed 导入、Function 部署、站点发布均未在本轮执行；云端真实状态以 `get_database_schema` 与站点后台为准。
- **没有真实 AI 联调**：未配置 `AI_AGENT_ENDPOINT`，只验证模板、注入适配器、超时/坏输出回退。
- **没有真实对象存储验证**：本地 `FakeStorage` 只模拟形状；私有桶、PUT content-type、download 实测、600s 过期需部署后复验。
- **没有类型检查**：本机无 Deno、无网络安装；本轮跑了 Node 冒烟与四个结构校验器，`deno check` / `tsc --strict` 未执行。
- 未做：后台管理、审核队列、埋点、通知、注销与数据导出、分享出图/短链、公开池接力、撤销打卡、AI 其余三能力、`DELETE /api/uploads/:id`、`GET /api/wishes/:id/answers`。
- 已知并发残余：重复收入、回信同帖日限、结算 60 秒租约、`insertIfAbsent` 逐行语义、`affected()` 行数——均已在文档标注，需真库复验或后续迁移根治。

## 4. 验证结果

```
node tools/local/smoke.ts               470 passed, 0 failed
node tools/scripts/check-routes.ts      41 条路由，✓ 路由表自洽
node tools/scripts/check-migrations.ts  7 文件 / 98 语句 / 22 表，✓ 平台子集
node tools/scripts/check-schema-usage.ts 22 表 / 349 列 / 78 源文件，✓
node tools/scripts/build-seeds.ts --check 72 / 120 / 24，✓
```

详细分组、覆盖矩阵与未验证项见 [14-test-report.md](../docs/14-test-report.md)。

## 5. 上线前最终待办

1. 在部署窗口授权后执行：迁移 0001–0007 → 核对 22 表 → 导入 72/120/24 → 部署 Function → 发布 → 真库冒烟（见 11 §7）。
2. 复验五个平台语义：`insertIfAbsent` 逐行冲突、`affected()` 行数、唯一约束含 NULL、`updated_at` 微秒精度、私有桶直连阻断。
3. 配置 6 个必填 Secrets 与 `CORS_ALLOW_ORIGINS`、`API_PER_MINUTE`；`FIELD_ENCRYPTION_KEY` / `RECOVERY_PEPPER` 上线前定稿。
4. 前端按 12 的清单联调，重点验「AI辅助」标签、两段式上传、错误码分支。
5. 制定离线清扫任务：`idempotency_keys`、`files` expired 与残留对象、`ai_suggestions`、`demo_sessions` 及其子表。
6. 若后续要接运营报表，所有统计必须排除 `is_demo=true`。

## 6. 文件清单（本轮新增/修改）

| 文件 | 变化 |
| --- | --- |
| `backend/server.ts`、`backend/lib/config.ts`、`backend/lib/rate-limit.ts` | 全路由兜底限流与配置 |
| `backend/index.ts` | 配置缺失统一 503 封套 |
| `backend/lib/respond.ts` | 安全头、405 `Allow`（复核/固化） |
| `backend/lib/validate.ts` | 控制字符清洗 |
| `backend/domain/upload.ts` | 2h pending 失效 + 惰性清扫 |
| `backend/domain/demo.ts` | 本 IP 最早 3 条过期清理 |
| `backend/domain/ledger.ts` | 重复收入并发边界注释 |
| `tools/local/smoke.ts` | 新增 9 项第 9 轮断言，总数 461→470 |
| `docs/01,02,03,04,05` | 同步最终口径 |
| `docs/11,12,13,14`、`README.md` | 新增/重写交付文档 |