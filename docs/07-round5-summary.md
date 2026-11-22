# 07 第 5 轮开发总结・账本模块

> 范围：`GET /api/wishes/:id/ledger`、`PUT /api/ledger/weeks/:weekStart`、`POST /api/ledger/entries`，以及首周预算推算、周预算 CAS、收支流水、读取时聚合与配套测试 / 文档。
> 结论：代码、冒烟与静态校验全绿；**云端第一阶段（真库迁移 / seed / 验证）仍未完成**，原因见 §3.1。

## 1. 实现范围

### 1.1 接口（3 条，累计 18 条）

| 接口 | 关键行为 |
| --- | --- |
| `GET /api/wishes/:id/ledger` | 返回当前周或指定周的预算、支出、收入、结余、累计兑现与进度；同时返回契约内全部 10 个自然周的周视图，便于前端切换；仅作者可见（非作者 403）；草稿/已结束 400 `wish_not_active`；**结算前不含任何礼物名称、价格或匹配结果** |
| `PUT /api/ledger/weeks/:weekStart` | 设置/修改某周预算（0–200,000 分）；只允许当前与未来周，历史周 400 `week_not_editable`；`week_start` 必须是周一且落在契约期；`(wish_id, week_start)` 唯一，预算写入用 `updated_at` 单行 CAS（3 次重试，失败 409 `ledger_week_conflict`）；支持 `Idempotency-Key` |
| `POST /api/ledger/entries` | 追加一条 `expense` 或 `earning`；支出 0–200,000 分、不关联任务；收入 1–100,000 分、必须关联同周 `side='money'` 且 `done/made_up` 的任务，`proof_id` 可选但须为 `ledger_proof`；重复关联同一钱任务 400 `duplicate_earning_link`；只追加不修改；支持 `Idempotency-Key` |

两条写路径都不在 `/api/wishes/:id/...` 下，URL 里没有愿签身份，因此请求体**必须带 `wish_id`**；这是相对"入参不重复传资源 id"惯例的必要偏离，已在 04 §0.1.4 写明。

### 1.2 确定性计算（全部整数、全部读取时现算）

```
周支出   spent_cents  = Σ ledger_entries(entry_kind='expense' AND revoked_at IS NULL AND week_start = W)
周收入   income_cents = Σ ledger_entries(entry_kind='earned'  AND revoked_at IS NULL AND week_start = W)
周结余   balance_cents = max(0, budget_cents − spent_cents)
周超支   over_budget = spent_cents > budget_cents
周进度   progress_bps = budget > 0 ? min(10000, floor(spent × 10000 / budget))
                                    : (spent > 0 ? 10000 : 0)
周计入   counted = 该周任意任务 status ∈ {done, made_up}
累计兑现 realized_cents = Σ(counted 周 balance_cents) + Σ(所有周 income_cents)
```

- `ledger_weeks` **只写 `budget_cents`**；`spent_cents / saved_cents / earned_cents / counted / over_budget` 是迁移期预留列，本轮恒为初始值（冒烟专门断言），不参与任何计算。因此不存在"写流水后重算周表"的崩溃窗口。
- 首周预算：`q4_disposable_band` → `under_100 2000 / 100_299 4000 / 300_599 8000 / 600_999 12000 / 1000_plus 20000`，缺档兜底 5000 分；首签时写入 `wishes.weekly_budget_cents` 与首周 `ledger_weeks`。
- 超预算不拦截提交：流水照常落库，结余记 0、`over_budget:true`，响应带提示文案。
- 金额出参同时给 `*_yuan`（`Math.floor(cents / 100)`），整数运算无浮点。

### 1.3 代码落点

| 文件 | 职责 |
| --- | --- |
| [backend/domain/ledger.ts](../backend/domain/ledger.ts) | 账本全部业务：档位→预算映射、周参数校验、惰性建周行、预算 CAS、流水校验与落库、周/累计聚合、DTO |
| [backend/domain/wish.ts](../backend/domain/wish.ts) | `saveAnswers` 写 `q4_disposable_band`；`signContract` 推算并写入首周预算、建首周账本行 |
| [backend/domain/checkin.ts](../backend/domain/checkin.ts) | `requireProofFile` 支持用途白名单（`checkin_proof` / `ledger_proof`）；导出 `bumpWishVersion` 供账本复用 |
| [backend/api/wishes/_id/ledger/get.ts](../backend/api/wishes/_id/ledger/get.ts) | 账本总览路由（`week_start` 查询参数） |
| [backend/api/ledger/weeks/_weekStart/update.ts](../backend/api/ledger/weeks/_weekStart/update.ts) | 周预算路由与参数校验 |
| [backend/api/ledger/entries/create.ts](../backend/api/ledger/entries/create.ts) | 收支流水路由与参数校验 |
| [backend/api/manifest.ts](../backend/api/manifest.ts) | 注册 3 条新路由（18 条） |
| [tools/local/smoke.ts](../tools/local/smoke.ts) | 第 12 节：73 项新断言（累计 276） |
| [docs/04-api-contract.md](../docs/04-api-contract.md) | 新增 §0.1.4 账本契约与 DTO |
| [docs/03-database.md](../docs/03-database.md) | `ledger_weeks` / `ledger_entries` 接入说明与残余风险 |

### 1.4 权限、幂等与一致性

- **读**：`GET .../ledger` 走 `requireAuthor`，需求明确非作者 403；不存在的愿签 404 `wish_not_found`。
- **写**：预算与流水同样先校验作者；关联任务不存在 404 `task_not_found`、存在但属于别的愿签 403 `task_forbidden`、图片属于别人 403 `proof_forbidden`。
- **幂等**：两条写接口 `idempotent: optional`；同键同 body 重放存档响应并带 `x-idempotent-replay: true`，同键异 body 409 `idempotency_key_reuse`。
- **版本**：预算修改与流水写入成功后 `wishes.version + 1`（`bumpWishVersion`，读-改-CAS，3 次），供第 6 轮结算判断账本变化。
- **周行**：`ensureWeekBudgetRow` 走 `insertIfAbsent(..., {onConflict:'wish_id,week_start'})`，撞索引回读；预算 CAS 用 `updated_at` 当令牌，因为该表没有 `version` 列。

## 2. 与 PRD / 本轮需求书的偏差

| 项 | 需求 / 设计 | 本轮落地 | 原因 |
| --- | --- | --- | --- |
| 写接口的资源标识 | 第 1 轮设计是 `/api/wishes/:wishId/ledger/...` | 采用需求书给定的 `/api/ledger/...`，请求体必带 `wish_id` | 需求书显式指定路径；两条写路径无愿签上下文，只能由 body 提供归属 |
| 收入证明 | 第 1 轮设计要求 `proof_file_id` 必填 | **可选**；给了才校验 `ledger_proof` | 第 5 轮需求书明确写"可选 proof_id" |
| 周预算输入范围 | 第 1 轮写 2,000–20,000 分 | 推测区间仍是 2,000–20,000，**用户可改为 0–200,000** | 需求要求"用户可手动修改"且只约束"非负整数"；首周推算值不设上限阻塞 |
| 支出下限 | 第 1 轮写"0–200000，非负" | 保持 0；但 `amount_cents` 为整数，负数无法通过校验 | 与需求一致 |
| 周派生列 | 第 1 轮设计读时按 `computed_at` 重算 `ledger_weeks` | **完全不写派生列**，读取时从流水/任务聚合 | 无事务环境下"先写流水、再重算周表"仍有崩溃窗口；读取时聚合没有不一致可能，代价是每次读 3 条查询 |
| 周计入口径 | 第 1 轮写"存在 done 的任务" | `done` **或** `made_up` | 补卡完成的周同样应计入兑现，否则补卡用户会被双重惩罚 |
| 历史周查询 | 需求"支持按周查询历史" | 返回 `weeks` 全量周视图 + `week` 选中周；`week_start` 可选 | 一次读满足历史切换，避免 N 次请求 |
| 周进度 | 需求"进度说明" | 给 `progress_bps`（万分比）+ `message` 文案，不给百分比浮点 | 整数口径，前后端不会出现 33.3/33.4 的分叉 |
| 流水修改/撤销 | PRD 有账本更正诉求 | 未实现，只追加；`revoked_at` 恒 `null` | 第 5 轮需求明确"不可修改已提交记录"；撤销接口留后续轮 |
| 礼物信息 | 结算前绝不返回名称/价格 | 账本 DTO 无任何 `reward*` 字段；`rewards` 表无读接口 | 按 PRD D-06 与用户强制约定 |

## 3. 注意事项与残余风险

### 3.1 云端仍未闭环

1. 真库迁移、seed 导入与第 3 轮成果验证仍被阻塞：`prepare_site` 曾被拒绝，seed 导入需要部署后的 Function 作为写客户端。本地绿灯不等于线上绿灯。
2. 第 5 轮没有新增迁移：账本复用 0005 已建的 `ledger_weeks` / `ledger_entries`；`wish_answers.q4_disposable_band` 与 `wishes.weekly_budget_cents` 也是既有列。上线只需部署新代码，但**必须先确认 0005 已在云端执行**。
3. 必须实测的平台语义：`insertIfAbsent` 是否逐行跳过冲突、`affected()` 是否回传真实行数、表级 `UNIQUE` 是否允许多个 `NULL`（`tasks.template_id`）。账本周行与预算 CAS 依赖前两项。

### 3.2 账本特有的风险

1. **收入重复关联没有库级唯一约束**：平台只允许建表期表级 `UNIQUE`，"一条钱任务最多一笔收入"需要部分索引语义。当前用写前读检查（`wish_id + task_id + entry_kind='earned' + revoked_at IS NULL`），并发双写仍可能各插一行，使该周收入重复计入。上线后应按 `ledger_entries (task_id)` 抽查；根治需后续迁移加 `earning_task_key` 列（收入填 `task_id`、支出填 NULL）+ `UNIQUE (wish_id, earning_task_key)`。
2. **`updated_at` 作为 CAS 令牌**：本地 fake 用 ISO 字符串比较，每次写入取严格递增的服务端时间；若真库 `timestamptz` 精度不足或同毫秒并发罕见地撞上，可能误判成功/失败。表现是 409 重试而非数据损坏，但仍需部署后观察。
3. **收入必须与任务同周**：这是本轮的额外约束（需求只写"关联已完成钱任务"）。理由：跨周关联会让"周收入"与"任务完成周"错位，结算时无法解释。若产品希望允许跨周，改 `requireEarningTask` 的一处比较即可。
4. **`proof_id` 语义**：服务端只认 `files` 行，不认对象 key；上传 presign/complete 仍未实现，联调前需手工造 `files` 行（`purpose='ledger_proof'`、`status='ready'`、绑定愿签）。
5. **周视图按契约起止逐周生成**：最长 30 天契约最多跨 6 个自然周，`WEEKS_LIMIT = 10` 只是防呆上限；未来若允许更长契约需同步放宽该常量与 `WEEK_ROW_LIMIT`。
6. **读接口不写库**：与今日页不同，`GET .../ledger` 不会创建缺失的周行（未设置的周按默认预算展示）；只有立契、`PUT` 预算、`POST` 流水会建行。因此"账本行数"不等于"契约周数"，这是刻意设计，避免 GET 产生写放大。

### 3.3 联调提示

1. `week_start` 必须是周一。客户端可用任务返回的 `week_start` 直接回传，不要自行按本地时区算周一。
2. 支出与收入都按"产品日所在自然周"归档；周一 04:00 前的提交仍算上一周。
3. 超预算响应仍是 200：检查 `week.over_budget` 与 `notice`，不要靠 HTTP 状态判断。
4. 幂等键建议客户端在用户点"保存预算/记一笔"时生成一次，重试沿用同一把；不要每次重试换新键。
5. 账本只给金额与进度；前端不要预先内置礼物目录或价格，结算接口才会返回。

## 4. 验证结果

| 检查 | 结果 |
| --- | --- |
| `node tools/local/smoke.ts` | **276 passed / 0 failed**（新增 73 项：默认预算、预算修改与历史锁、超预算边界、收入关联校验、跨周聚合、权限隔离、幂等重放） |
| `node tools/scripts/check-routes.ts` | 18 条路由自洽 |
| `node tools/scripts/check-schema-usage.ts` | 21 张表 / 新增账本表的列与写入键均在 DDL 内 |
| `node tools/scripts/check-migrations.ts` | 6 文件 / 94 语句 / 21 表，全部在平台子集内 |
| `node tools/scripts/build-seeds.ts --check` | 愿望模板 72 / 任务模板 120 / 礼物 24，通过 |
| `npx -y -p typescript@5.6.3 tsc -p .tscheck/tsconfig.json` | 无输出（strict 通过） |
| 真库验证 | **未执行**（见 §3.1） |

## 5. 下一轮建议

1. 结算两幕：`settling/settled` 状态、结算快照、三档结局、礼物匹配（此时才返回礼物名称与价格区间）。
2. 上传两段式（presign→complete）：补齐 `checkin_proof` / `ledger_proof` 的真实上传链路，替换冒烟里的 seed 替身。
3. 五问解密出口 `GET /api/wishes/:id/answers` 与账本导出/撤销流水。
4. 云端部署后补做账本整数复算、预算 CAS 与收入查重三项真库验证。