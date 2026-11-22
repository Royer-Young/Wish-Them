# Seed 数据说明（`database/seed/`）

这三份 JSON 是**内容数据**，不是迁移的一部分：平台迁移只允许 DDL（`CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX`），
插数据必须在迁移之后走数据导入。第 2–3 轮交付的是「数据齐备 + 导入路径确定 + 引擎已能消费」，实际写入要在真实站点上执行。

| JSON（产物，勿手改） | 行数 | 对应表 | 内容真源（改文案改这里） |
| --- | --- | --- | --- |
| `wish_templates.json` | 72 | `app.wish_templates` | `wish-templates.ts`：PRD 4.2 B-02 的 12 种关系 × 每关系 6 条 |
| `task_templates.json` | 120 | `app.task_templates` | `tasks.ts`：PRD 5.3「总量 120 条」，6 类型 × 20 条 |
| `rewards.json` | 24 | `app.rewards` | `rewards.ts`：PRD 5.4「24 件礼物，四类」，价格给区间 |

> 同一次生成还会写 `backend/data/seed-rows.ts`：Function 发布包只带 `backend/`，启动播种需要这份自包含数据；它同样是产物，不要手改。

**第 3 轮起 `task_templates` 已被代码真实消费**：`domain/task.ts#loadTaskPool` 读它抽任务，
所以「不导这份 seed 就无法立契」——签署接口会在 CAS 之前返回 503 `task_pool_empty`。
`wish_templates` 与 `rewards` 仍只有种子、没有读接口（分别属后续轮的「换一批」与结算匹配）。

## 一、生成方式（不要手改 JSON）

```bash
node tools/scripts/build-seeds.ts          # 重新生成三份 JSON
node tools/scripts/build-seeds.ts --check  # 只校验形状，不写盘
```

- **内容真源是同目录的 `.ts`**（`wish-templates.ts` / `tasks.ts` / `rewards.ts`），不是 JSON。
  第 2 轮曾放在 `tools/scripts/seed-content.ts`，第 3 轮搬到 `database/seed/`：
  内容与它要导入的表放在一起，且 `tools/` 不进发布包、`database/seed/*.ts` 也不会被 Function 引用（只有构建脚本 import）。
- JSON 每次生成会被覆盖，且**带一层信封**：`{ table, source, note, count, rows: [...] }`。
  导入时取的是 **`rows` 数组**，不是整个文件对象。
- 每行的 `id` 由 `HMAC-SHA256(key = "yuan-ta-seed-v1:<kind>", msg = 业务键)` 取前 32 位 hex，
  整形成 v4 形态的固定 UUID（与 `backend/lib/id.ts#derivedUuid` 同一套整形规则）：
  - `wish_template` → `<relation>|<text>`
  - `task_template` → `<wishType>|<side>|<text>`
  - `reward` → `<category>|<title>`

  **同一行内容永远得到同一个 id**，因此可以先查询已有 id、只补缺失行，实现幂等导入；
  平台 `insert_database_rows` **不支持 upsert / `on_conflict`**，重复插入同一 id 会被当作主键冲突拒绝。
  改文案等于换 id，旧行会留着（`is_active` 置 false 由后续轮的内容管理处理，本轮没有后台）。
- `sort_order` 在分组内从 1 递增（愿望模板按关系、任务模板按类型、礼物按类别），
  引擎的抽牌堆排序键 `(关系专属优先, sort_order, id)` 直接用它。

### `--check` 挡住的形状问题（`assertShape`，全部是会导致线上抽不出任务的硬错误）

| 断言 | 为什么 |
| --- | --- |
| 愿望模板 = 12 × 6 = 72、任务 = 120、礼物 = 24 | PRD 验收项 |
| 每类型任务 ≥ 12 条，且 `for_ta`/`for_self`/`money` 三档都非空 | 缺任一档，每日两张必做或周末钱任务就选不出来 |
| 每类型钱任务 ≤ 4 条 | 多于 4 条容易超出 PRD「每周 1~2 个」 |
| 每类型**通用** `for_ta` ≥ 7、`for_self` ≥ 8 | 默认 7 天契约要能不轮转（关系专属只会让候选更多） |
| 任务文案 ≤ 60 字 | 卡片展示与轮转后缀「（第 N 轮）」都要留位置 |
| 钱任务 `min_budget_cents > 0` 且 `weekend_only = true` | 金额下限是结算输入；钱任务只在周末出现 |
| **必做任务不得标 `weekend_only`** | 引擎只按周末追加钱任务，必做两条不区分工作日；标了就会在工作日抽不到 |
| 三张表每行 `is_active = true` 显式给值 | 线上 Postgres 会补默认值，**本地内存库不补** ⇒ 少写一个就抽不到候选池 |
| 非钱任务 `min_budget_cents = 0`（不是 null） | DDL 是 `NOT NULL DEFAULT 0`，写 null 真实导入会被拒 |
| 礼物 `0 < min_cents ≤ max_cents ≤ 50000` | 价格区间合法 + 单件不超过 500 元 |
| `RELATION_GROUPS` 覆盖全部 12 关系 | 语气派生不能缺项 |
| 216 个 seed id 互不重复 | `stableId` 的命名串不够区分时会撞车 |

## 二、导入步骤（真实站点）

前提：`database/migrations/0001~0007` 已应用，Function 已带上数据库读写权限
（调用形状见 `../migrations/README.md`）。

### 2.1 首选：Function 启动播种（第 10 轮）

平台 `insert_database_rows` 在本站点持续返回 `sites_request_failed`，因此增加服务端兜底：

1. `tools/scripts/build-seeds.ts` 除了三份 JSON，还会生成 `backend/data/seed-rows.ts`（Function 包内数据，勿手改）。
2. 发布 Function 时配置 `SEED_ON_START=1`；实例首个请求执行 `backend/domain/seed-init.ts`：
   - 先查三张表行数，已等于 72/120/24 则 `skipped`，不写；
   - 部分缺失则按稳定 id `insertIfAbsent(onConflict:"id")` 每 40 行一批补缺；
   - 行数超过期望值则拒绝写入并报 `seed_failed`，不覆盖现有数据。
3. `GET /api/health/deep` 的 `seed` 字段返回状态与每表 existing/inserted/final；原始错误只进日志。
4. 用 Owner 侧 `query_database_rows(... countExact: true)` 复核 72/120/24。

播种是幂等的：稳定 id 保证同一行永远同一个 id，重复执行/多实例并发不会产生副本；部分缺失只补缺。
播种完成后建议把 `SEED_ON_START` 改回 `0`（改值需重新发布），避免每次冷启动都做三次计数探测。

### 2.2 备用：平台批量导入（工具恢复后）

1. 先 `get_database_schema({ siteId })` 取 `schemaRef` 并对齐列名，再用 `query_database_rows` 确认三张表为空或只缺部分 id。
2. 分批插入：`insert_database_rows` 单批 **1–100 行**、同一批的字段集合必须完全一致，三张表依次导入，
   **载荷是 JSON 里的 `rows` 数组**（按工具要求转成 `cells`）。工具**没有 upsert / `on_conflict`**：
   重跑前先用 `query_database_rows` 取已有 `id`（按 `limit/offset` 翻页），只插入缺失行；若某批结果未知，先读回现有 id 再补，**不要盲目重放整批**。
   每批核对返回的 `state`（`succeeded/rejected/unknown`）与 `affected_rows`；`rejected` 时按错误信息修正，不换 requestId 重试未知写入。
3. 复核：用 `query_database_rows(... countExact: true)` 逐表取总数，期望 `72 / 120 / 24`；再按过滤条件做两条形状抽查
   （`query_database_rows` 不支持任意 SQL，用 `tableName` + `filters` + `countExact`）：
   - `task_templates`：`side eq "money"` 且 `weekend_only eq false` → 期望 0；
   - `task_templates`：`side ne "money"` 且 `weekend_only eq true` → 期望 0。
4. 端到端验一次：注册 → 创建愿签 → 答五问 → 立契，应当拿到 `days × 2 + 周末天数` 条任务。
   若返回 503 `task_pool_empty`，就是 seed 未导成功（或 `is_active` 不是 true）。

> 这两条路径都需要真实站点的 Function 与数据库已创建；截至第 9 轮均未在云端执行（需要明确授权）。第 10 轮改用启动播种，具体执行记录见 `docs/11-deployment.md`。

## 三、任务库的构成与轮转（第 3 轮已确认的口径）

每类型 20 条 = **为 TA 10 + 为自己 8 + 钱任务 2**，六类型共 120 条。
关系维度采取「**通用池 114 条（`relation = null`）+ 关系专属 6 条**」：

| 类型 | 为 TA（专属） | 为自己（专属） | 钱任务（专属） |
| --- | --- | --- | --- |
| `body` | 10（3） | 8（0） | 2（0） |
| `lonely` / `study` / `emotion` | 各 10（各 1） | 各 8（0） | 各 2（0） |
| `sleep` / `life` | 各 10（0） | 各 8（0） | 各 2（0） |

专属 6 条覆盖的关系：妈妈、姥姥、爷爷、老师、恋人。
**不变量**：任何关系下通用「为 TA」都 ≥ 7 条、「为自己」8 条 ⇒ 7 天契约绝不轮转。

为什么不按 PRD 字面的「6 类 × 5 关系组 × ≥12 条」铺：那是 360 条，与「总量 120」自相矛盾；
而 6 × 12 = 72 个「类型 × 关系」格子摊到 120 条只有 1.7 条/格，生成器会频繁选不出模板。
所以关系维度用「专属优先 + 通用兜底」，长契约靠**轮转副本**（用户已确认）：

- 牌堆取完一轮 → `rotation += 1` 从头再取，文案追加「（第 N 轮）」、`template_id` 置 NULL；
- 于是 `tasks_wish_template_uidx`（多个 NULL 互不冲突）与 `tasks_wish_text_uidx`（0007，文案带轮次天然唯一）都仍成立；
- 触发点：30 天契约的 `for_ta`（10 条 < 30 天）、**14 天起的 `money`**（2 条 < 4 个周末日）。
  7 天契约三档都不轮转。

## 四、与 PRD 的已知偏差

1. **愿望模板 40 → 72**：PRD B-03/B-04 写「40 条」「12 关系每种 4–6 条」，
   但 12 × 4~6 = 48~72，**算不出 40**。落地取每关系 6 条 = 72 条（满足「同关系至少 6 条」这条硬要求）。
2. **任务库 120 条的铺法**：见 §三，「6 类 × 5 组 × ≥12」与「总量 120」不可兼得，取 6 × 20 + 专属/通用 + 轮转。
3. **文案未经人工审核**：分类与措辞是确定性生成的初稿，需要运营复核后替换对应 `.ts` 重跑
   `build-seeds.ts`（id 规则不变，改文案即换 id）。
4. **礼物数量口径**：产品方案写「15 件左右」，PRD 5.4 写「24 件」，本 seed 取 24；
   单件上限 500 元（`max_cents ≤ 50000`），与 PRD 5.4「价格区间」一致，超出部分留给后续扩展。
5. **`recommend_flags`**：PRD 没有这个列，是为结算匹配加的
   （结算时按愿望类型过滤候选礼物，避免给用户推「护膝」这种类型错位的兑现）。
6. **词表统一到 PRD 5.x，不用 PRD 6.1 草表的英文码**：
   - `wish_templates.relation` / `task_templates.relation` / `wishes.relation` 直接存 PRD 4.2 B-02 的
     12 种中文关系，而不是 6.1 里的 `relation_code`（friend/colleague/…）。
     理由：6.1 的英文码只有 4~8 个值，覆盖不了 12 种关系，再维护一张码表反而容易和文案脱节。
   - `wish_templates.wish_type` / `task_templates.wish_type` 用 PRD 5.2 六类
     （`body/sleep/lonely/study/emotion/life`），替换 6.1 草表里的 `category` 与
     第 1 轮 `db/schema.sql` 里的 `care/growth/accompaniment/freedom/healing/company`。
     任务模板的 `wish_type` 列另允许 `any`（跨类型通用兜底池，`loadTaskPool` 用 `.in('wish_type',[type,'any'])` 一起取），
     但**当前 120 条种子全是六类之一，没有 `any` 行**——留给后续内容扩充，引擎已经支持。
   - `task_templates.side`（`for_ta/for_self/money`）替换第 1 轮的 `relation_group` + `task_type` 两列，
     后者把「给谁做」和「什么性质」混在一起，生成器判「每天两件必做」时只能靠字符串猜。
     **接口出参叫 `type`（`ta/self/money`）**，映射只在 `rules.ts#SIDE_TO_TYPE` 与 `toTaskDto` 里定义一次。
   - `rewards.category` 用 PRD 5.4 的四类（`health/company/life/heart`），第 1 轮误按 12 类商品目录建表。
7. **`wish_templates.tone`**：内容 `.ts` 里不维护语气，由 `build-seeds.ts` 从
   `RELATION_GROUPS`（`backend/domain/rules.ts`，PRD 5.1 关系组语气）派生后写进 JSON 的 `tone` 列。
   这样语气只有一处真源，任务生成与模板展示不会漂移。
8. **`wish_templates.content`**：列名沿用 PRD 6.1 的 `content`（不叫 `text`），
   与 `task_templates.text` 刻意不同名——两张表的文案用途与长度约束不一样：
   任务文案有硬断言 ≤60 字（要给轮转后缀「（第 N 轮）」留位置），愿望模板没有长度断言，
   当前 72 条最长 26 字（它只作「换一批」的候选文案，不参与任务标题唯一性）。

## 五、还缺的 seed（预留，未生成）

- `files.json`：演示用图片（PRD I-04 的预置人设需要 2 条记录的照片），依赖对象存储真实上传，
  放到第 4 轮上传两段式落地后做，届时 `file_id` 才有效。
- 演示剧本 `demo_sessions` 的初始状态：由 `POST /api/demo/session`（**第 6 轮**）在请求里生成，不写 seed。
- 五问答案粗粒度档位（`q1_gift_category` / `q2_alone_level` / `q4_disposable_band` 等）不是 seed，
  是第 5 轮结算时由确定性规则从密文推算后写入的派生列。