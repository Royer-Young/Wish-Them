# 08 第 6 轮开发总结・结算与彩蛋模块

> 范围：`POST /api/wishes/:id/settle`、`GET /api/wishes/:id/settlement`、`POST /api/wishes/:id/extend`，以及三档结局、礼物匹配、结算快照、续期与配套测试 / 文档。
> 结论：代码、冒烟与静态校验全绿（21 条路由 / 321 项断言）；**云端第一阶段（真库迁移 / seed / 验证）仍未完成**，原因见 §4.1。

## 1. 实现范围

### 1.1 接口（3 条，累计 21 条）

| 接口 | 关键行为 |
| --- | --- |
| `POST /api/wishes/:id/settle` | 仅作者（403）；草稿/非 active 400 `wish_not_active`；截止日次日 04:00 前 400 `settle_too_early`（`details` 带 `end_date` / `settle_open_at` / `seconds_remaining`）；`active→settling→settled` 单行 CAS；已 `settled` 重复调用 200 `already_settled:true` 并返回既有快照；`Idempotency-Key` 可选 |
| `GET /api/wishes/:id/settlement` | 仅作者；未结算 400 `wish_not_settled`，**响应不含任何礼物字段**；已结算返回当前最新版本的两幕结果（第一幕任务明细/盖章/结局，第二幕兑现额/礼物/价格区间/差额档位/文案/信件模板） |
| `POST /api/wishes/:id/extend` | 仅作者；每愿签 1 次（第二次 400 `extend_limit_reached`）；仅 `cyber_only` / `unrealized` 可续（`double_realized` 400 `extend_not_allowed`）；续期后回 `active`、截止日 +7 天、补生成新增任务、补发对应周补卡券；`Idempotency-Key` 可选 |

三条路由均注册于 [backend/api/manifest.ts](../backend/api/manifest.ts)（21 条），`settle` / `extend` 请求体上限 512B 且需 `content-type: application/json`（空对象 `{}`）。

### 1.2 三档结局（确定性，不调 AI）

先 `sweepMissedTasks` 把截止前的 `pending` 惰性扫成 `missed`，再按任务表统计：

```
双重兑现 double_realized = 所有必做任务 done/made_up 且 所有钱任务 done/made_up   → 盖章，完整礼物
赛博实现 cyber_only      = 所有必做 task done/made_up 且 存在钱任务未完成        → 盖章，「未拆的信」+ 差额 + 续期入口
未实现   unrealized      = 存在必做任务未完成（missed）                          → 不盖章，续期/降档提示
```

- 必做任务 = `is_must = true`（`ta` / `self`）；钱任务 = `side = 'money'`。7 天契约即 14 必做 + 2 钱任务，完成率分别给 `must_bps` / `money_bps`（万分比）。
- `must_total = 0` 视为 `unrealized` 防御分支，避免空任务契约被判成双重兑现。
- `stamped` 只在双重兑现 / 赛博实现为 `true`；`settlements.outcome` 与 `wishes.outcome` 同步落库。

### 1.3 金额与礼物匹配

金额完全复用第 5 轮账本，整数分：

```
累计节省 saved   = Σ(计入周 max(0, 周预算 − 周支出))
累计收入 earned  = Σ(未撤销的兼职收入流水)
累计兑现 realized = saved + earned
计入周           = 该周任意任务 done 或 made_up（沿用第 5 轮口径；需求书的"已结算周"按此解释）
```

礼物匹配：

1. **大类**：`wish_type` 兜底映射（body/sleep→health，lonely→company，study/emotion→heart，life→life）+ 解密 q5 关键词计分（health/company/life/heart，同分按该顺序），q5 解不开则退回 `wish_type`，不让结算 500。
2. **候选池**：`rewards.is_active=true` 且 `category` 命中，`min_cents ≤ realized_cents`。
3. **选择**：q5 若点名礼物（标题连续片段或任意二字片段命中，取最长匹配）则优先；否则取**价格上限最高**，同上限取更高下限。
4. **差额**：`median = floor((min+max)/2)`；`gap = max(0, median − realized)`；`bps = floor(gap × 10000 / median)`；`exact ≤ 10%`「刚好够」、`near ≤ 30%`「差一点」、`far > 30%`「未拆的信」。
5. **far 回落**：差额超过 30% 时强制改为该类别**最低价**礼物，档位保持 `far`；候选池为空时同样落到最低价 + `far`。
6. **礼物缺失**：类别内无可用礼物 503 `reward_pool_empty`，提示先导入 seed。

文案与信件模板由 `gap_band + outcome + 数字` 确定性生成，写入 `self_summary`（含 `weekly_saved_yuan` / `weeks_needed` / `gift_title` / `copy_text` / `letter_template` / `matched_by` / `gift_category`）与 `settlements.letter_text`。

### 1.4 快照、并发与不泄露

- **CAS**：`UPDATE wishes SET status='settling', version=version+1 WHERE id=? AND status='active' AND version=?`，最多 3 次；并发只有一个成功，其余返回 409 `settlement_in_progress` / `wish_state_conflict`。
- **快照**：版本号 = 当前最大版本 + 1；`insertIfAbsent(..., onConflict:'wish_id,version')`，撞唯一约束回读；同一版本只会有一行。
- **先落快照、再收口**：`settling` 状态下若快照已存在，直接补一次 `settling→settled` 并返回（崩溃自愈）；无快照且未满 60 秒 → 409；超过 60 秒且 `updated_at` CAS 成功才允许接管，避免把正常处理中的请求抢走。
- **重复结算**：`settled` 直接读最新快照，不重算、不新增版本、不推进 `version`。
- **两幕读取**：只有 `status='settled'` 才读 `settlements` 与 `rewards`；未结算、草稿、续期后的 `active` 都不会返回礼物名称/价格/差额。
- **续期**：`UPDATE ... WHERE status='settled' AND renew_count=0`，成功后 `end_date+7`、`days` 重算、`renew_count=1`、`extend_mode='extend_7d'`、清空 `outcome/settled_at`、`version+1`；沿用原 `start_date` 调 `planTasks`，派生 id 自动只补新增天数；补卡券按 `weekStartOf(oldEnd+1) … weekStartOf(newEnd)` 逐周 `issueMakeupTicket`。

### 1.5 代码落点

| 文件 | 职责 |
| --- | --- |
| [backend/domain/settlement.ts](../backend/domain/settlement.ts) | 结局判定、完成统计、q5→礼物大类、候选池/差额/文案、结算 CAS 与快照、两幕 DTO、续期 |
| [backend/api/wishes/_id/settle.ts](../backend/api/wishes/_id/settle.ts) | `wish.settle` 路由，`requireAuthor` → `settleWish` |
| [backend/api/wishes/_id/settlement.ts](../backend/api/wishes/_id/settlement.ts) | `wish.settlement` 查询路由，直接返回 `SettlementView` |
| [backend/api/wishes/_id/extend.ts](../backend/api/wishes/_id/extend.ts) | `wish.extend` 路由，返回愿签/新截止日/新增任务/补发券/新结算开放时刻 |
| [backend/api/manifest.ts](../backend/api/manifest.ts) | 注册 3 条新路由（21 条） |
| [tools/local/smoke.ts](../tools/local/smoke.ts) | 第 13 节：45 项新断言（累计 321） |
| [docs/04-api-contract.md](../docs/04-api-contract.md) | 新增 §0.1.5 结算/续期契约与 `SettlementView` |
| [docs/03-database.md](../docs/03-database.md) | `settlements` 表接入说明与写入顺序 |

## 2. 与本轮需求书 / PRD 的对齐

| 需求 | 落地 |
| --- | --- |
| 仅作者触发/查看，非作者 403 | `requireAuthor`；读结算同样 403（读操作的例外，因结算含私人金额与礼物） |
| 仅 active 可结算、未到期拦截 | 400 `wish_not_active` / 400 `settle_too_early`，剩余秒数为整数 |
| 重复结算幂等、不重复计算 | 200 `already_settled:true`，返回既有快照；同 `Idempotency-Key` 字节级重放 |
| `active→settling→settled` 单行 CAS | `status + version` 双谓词；快照 `UNIQUE(wish_id,version)` |
| 三档结局严格按任务状态 | 见 §1.2；`unrealized` 只看必做任务，`cyber_only` 只看钱任务缺口 |
| 金额复用账本、整数分 | 直接调 `readLedger(db, asActive(wish), null, now)`，`saved + earned` |
| 四类礼物、24 件种子、价格上限最高 | 类别过滤 → `min ≤ realized` → q5 点名优先 → 上限最高 |
| 差额 ≤10% / 10–30% / >30% | `exact` / `near` / `far`；>30% 回落类别最低价 |
| 续期仅赛博/未实现、仅 1 次、+7 天、补券 | 次数先判 → 结局判定 → 状态 CAS → 任务/券补齐 |
| 两幕结构、未结算不泄露礼物 | 单次 GET 返回 `first_act` / `second_act` / `extension`；未结算响应无礼物字段 |

## 3. 与需求书 / 第 1 轮设计的偏差

| 项 | 需求 / 设计 | 本轮落地 | 原因 |
| --- | --- | --- | --- |
| 结算记录数量 | "同一愿签只有一条结算记录" | 每个版本一行，`UNIQUE(wish_id,version)`，读取最新版；续期后为 v2，同时保留 v1 | 续期后必须重算结局，又要保留历史快照；"一条记录"按"一条当前有效结算"落地 |
| 差额基数 | 需求写"与礼物价格中位数的差额" | 以中位数为分母算万分比，`gap` 以中位数为基准 | 与需求一致；仅把"10%/30%"明确为相对中位数 |
| 30% 边界 | "10% ~ 30% 显示差额，>30% 未拆的信" | `near` 含 30%（`bps ≤ 3000`），31% 起进入 `far` | 边界含端点，避免 30.0% 与 30.1% 文案跳变 |
| `surplus` 档 | 第 1 轮设计有"超额"档 | 不实现；兑现额超过中位数时 `gap=0`，档位 `exact` | 本轮需求只定义三档；"刚好够"已覆盖超出情形 |
| 两幕获取 | 第 1 轮设计有 ACK / 72 小时封印 / 分享 | 一个 GET 同时返回两幕；`sealed=false`、`sealed_at/revealed_at/card_file_id/letter_file_id` 暂不写 | 本轮需求只要求"返回结构区分两幕"，封印与分享留后续轮 |
| 信件编辑 | PRD 允许 72 小时内微调 | 只写入确定性模板；没有编辑接口，`letter_updated_at` 恒 `null` | 本轮未列入信件编辑/兑现卡图 |
| "降档提示" | 未实现结局给续期或降档提示 | `extension.reason`/文案给出提示；没有独立降档接口 | 需求未定义降档后的契约形态，避免臆造 |
| 续期补券数 | "补发对应周的补卡券" | 从 `oldEnd+1` 所在周补到 `newEnd` 所在周；7 天续期通常补 1–2 张（跨周时含旧截止周） | 与第 4 轮"每自然周一张"保持一致；`issueMakeupTicket` 幂等，不重复发 |
| 礼物选择细化 | 第 1 轮只写"上限最高" | 在可负担池内先看 q5 是否直接点名（标题片段/二字片段），未点名才按上限最高 | "愿望类型 + 五问答案"需要 q5 参与；价格过滤与 far 回落规则不变 |
| 续期后的记录可读性 | 未明确 | 续期回到 `active` 后旧结算不可再读（400 `wish_not_settled`），但快照仍在库中 | 避免 `active` 状态泄露"上一次结算的礼物"；历史快照供再次结算/审计 |

## 4. 注意事项与残余风险

### 4.1 云端仍未闭环

1. 真库迁移、seed 导入与第 3 轮成果验证仍被阻塞：`prepare_site` 曾被拒绝，seed 导入需要部署后的 Function 作为写客户端。本地绿灯不等于线上绿灯。
2. 第 6 轮没有新增迁移：结算复用 0005 已建的 `settlements`，`wishes.status/version/renew_count/extend_mode/outcome/settled_at` 与 `wishes.days` 均为既有列。上线只需部署新代码，但**必须先确认 0005 已在云端执行**。
3. 必须实测的平台语义：`insertIfAbsent` 逐行忽略冲突、`affected()` 真实行数、`updated_at` 精度（60 秒租约）、表级 `UNIQUE` 对 `settlements(wish_id,version)` 的生效方式。快照写入与续期 CAS 都依赖前两项。

### 4.2 一致性窗口

- **快照先行**：CAS 到 `settling` 后若进程崩溃，快照未落库时愿签会停在 `settling`；60 秒后下一次 `settle` 用 `updated_at` CAS 接管重试。快照已落库但状态未收口时，下一次调用直接补 `settled` 并返回，不会重复计算。
- **并发**：两个请求同时结算，CAS 只有一个能推进到 `settling`；另一个可能读到 `settling` 并得到 409 `settlement_in_progress`（冒烟允许 200/409 组合），但最终只有一条快照、状态收口为 `settled`。
- **版本号**：`max(version)+1` 是读后写，依赖状态 CAS 把并发串行化；续期后再次结算自然得到 v2。
- **任务明细与快照计数**：两幕里的 `tasks` 计数取快照列，`task_details` 读当前任务表。结算后任务不应再被修改（打卡/补卡都要求愿签 `active`），若未来开放"结算后补打卡"，需改为读快照明细或冻结任务。
- **礼物快照**：结算时把 `reward_min_cents/max_cents` 与文案写入快照，礼物后续改名/下架不影响历史金额与文案；读取时若 `rewards` 行已不存在，标题回落到 `self_summary.gift_title`。

### 4.3 业务边界

- `settle_too_early` 是 400（不是 409），因为它是可预期的时间未到，不是并发冲突；`settlement_in_progress` / `settlement_conflict` / `wish_state_conflict` 才是 409。
- `settled` 但快照缺失返回 409 `settlement_missing`（数据异常，不静默重算）；`settling` 但快照缺失且未满 60 秒返回 409。
- `extend` 先判 `renew_count` 再判状态：第一次续期后回到 `active`，第二次调用必须得到 `extend_limit_reached`，而不是 `wish_not_settled`。
- 未结算、草稿、续期后的 `active` 都不可读结算结果；错误响应与详情页均不含礼物字段。
- 金额全部整数分；`*_yuan` 用 `floor(cents/100)`，仅作展示，不参与判断。

## 5. 测试与验证

- **冒烟**：`node tools/local/smoke.ts` → **321 passed, 0 failed**，第 13 节新增 45 项，覆盖：
  - 时间闸门：开放前 1ms 拦截、正好到点成功、剩余秒数；草稿/未结算/非作者/未登录。
  - 三档结局：双重兑现（14/14 + 2/2，盖章）、赛博实现（钱任务 1/2，盖章、可续期）、未实现（必做 missed，不盖章、可续期）。
  - 经典金额：两周预算 100 + 68 元 → 累计 168 元 → 护膝热敷仪、差额 0、「刚好够」；统计 15 打卡 + 1 补卡。
  - 差额档位：20% → 一顿火锅、「差一点」、攒钱建议；>30% → 类别最低价、「未拆的信」。
  - 幂等/并发：同键重放字节级一致；换键重复结算 200 `already_settled` 且不新增快照；双请求并发只有一次生效、一条快照。
  - 续期：赛博/未实现各续期一次成功（+7 天、新增 16 条任务、补 2 张券）、第二次 `extend_limit_reached`、双重兑现 `extend_not_allowed`、续期后旧结果不可读、再结算得到 v2。
  - 泄露检查：未结算、未到期、续期后的响应均不含礼物名称/价格/差额字段。
- **静态校验**：`check-routes.ts` 21 条；`check-migrations.ts` 6 文件 / 94 语句 / 21 表；`check-schema-usage.ts` 全绿（3 处静态跳过）；`build-seeds.ts --check` 72/120/24；`tsc --strict` exit 0。
- **未执行**：Deno 类型检查（本机未安装）、云端真库 SQL、真实并发压测。

## 6. 后续

1. 上云（需授权）：补齐/核对迁移 → 导入 seed → 部署 → 用真实并发复验结算 CAS、快照唯一约束、60 秒租约与续期补券。
2. 产品侧确认差额边界（30% 归 `near`）与"一条结算记录"的历史版本展示方式。
3. 后续轮次：仪式化 ACK、72 小时信件编辑与封印分享、兑现卡图/分享短链、上传两段式、公开池与回信。